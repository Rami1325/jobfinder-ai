"""Google OAuth — the Gmail connect (Phase 29 / B2) and Continue with Google
(Phase 30 / E) — and the one door to Google.

Every call this app makes to Google goes through `_http` below: both code
exchanges, the refresh, the revoke, and every Gmail API read (`gmail_api` builds
its requests and hands them here). The properties that make that door safe live
in that one function, so no caller can forget one: https only, the host must be
in `_HOSTS`, a redirect is an error rather than something followed, a 20-second
timeout, and a JSON answer.

THIS IS NOT THE SSRF DOOR, and the distinction is deliberate. CLAUDE.md's rule
that every outbound fetch goes through `job_match._http_get` exists because two
routes fetch a URL the CALLER supplies and hand the body back, so that function
must resolve the host and refuse private addresses on every redirect hop.
Nothing here takes a URL from anyone: every URL is a constant naming one of four
Google hosts, and the only variable parts are a message id Google itself
returned and query parameters. For that shape a fixed allowlist asserted on
every call is the stronger guard — `net_guard` can only prove an address is
public, while `_HOSTS` proves it is Google. The smoke test pins both halves:
every URL literal in this module names an allowed host, and the network is
opened nowhere but inside `_http`.

TWO OAuth clients, in two Google Cloud projects, and neither ever stands in for
the other. GOOGLE_CLIENT_* is the Gmail project: Testing, gmail.readonly, a
refresh token, revoked on Disconnect. GOOGLE_SIGNIN_CLIENT_* is the sign-in
project: basic scopes, no refresh token, never revoked. Revocation is
project-wide, so a single project would let a Gmail Disconnect end the sign-in
grant too, and there is no fallback from one pair to the other, because a
fallback would silently put sign-in on the Gmail project.

`_transport` is None in production. The smoke test swaps in a fake so the
connect, a refused refresh, the Gmail reads and every sign-in run offline.

Redirect URIs are built from APP_BASE_URL, never `request.url_for`: behind
Vercel's /api mount and the Vite proxy the app does not see the /api prefix the
browser used, so a derived URI would never match the one registered with Google.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import re
import secrets
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urlencode, urlsplit

from app.config import get_settings

_HOSTS = frozenset({
    "accounts.google.com",
    "oauth2.googleapis.com",
    "gmail.googleapis.com",
    "openidconnect.googleapis.com",
})
AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1/users/me"
# A scope is an identifier, not an address anything here fetches — which is why
# the host-allowlist pin skips the names ending in _SCOPE.
GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
SCOPES = ("openid", "email", GMAIL_SCOPE)
CALLBACK_PATH = "/api/inbox/google/callback"
# Continue with Google (Phase 30 / E1): basic scopes only, on the sign-in client.
SIGNIN_SCOPES = ("openid", "email", "profile")
SIGNIN_CALLBACK_PATH = "/api/auth/google/callback"
TIMEOUT_S = 20.0
# A Gmail message read is capped at 12 KB of text downstream; the raw JSON of a
# `format=full` read can still be large (base64 parts), so the read is bounded
# here too rather than trusting the server.
_MAX_RESPONSE_BYTES = 8_000_000
# What an id_token must say (`_signin_claims`): one of the two issuer spellings
# Google documents, and the clock skew allowed on each side.
_ISSUERS = frozenset({"https://accounts.google.com", "accounts.google.com"})
_EXP_SKEW_S = 60
_IAT_SKEW_S = 300
_B64URL = re.compile(r"[A-Za-z0-9_-]+")

# (method, url, headers, body, timeout) -> (status, raw body)
Transport = Callable[[str, str, dict[str, str], "bytes | None", float], "tuple[int, bytes]"]
_transport: Transport | None = None


class GoogleAuthError(Exception):
    """Google refused, or did not answer, or sent something we will not accept.

    `code` is Google's own `error` string when it sent one — `invalid_grant` is
    the one that means the user's grant is gone and only a reconnect helps —
    else `http_<status>`, `network`, `host_not_allowed`, or `token_invalid` for
    an id_token that fails `_signin_claims`. Keyed on the code, never the
    human-readable description, which Google rewords at will.
    """

    def __init__(self, code: str, status: int = 0) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A Google API that answers with a redirect is not something to follow:
    returning None turns every 3xx into an HTTPError, which `_http` reports."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, D102
        return None


def _error_code(data: dict[str, Any], status: int) -> str:
    err = data.get("error")
    if isinstance(err, str) and err.strip():
        return err.strip()[:64]
    return f"http_{status}"


def _http(
    method: str,
    url: str,
    *,
    params: Any = None,
    form: dict[str, str] | None = None,
    bearer: str = "",
    timeout: float = TIMEOUT_S,
) -> dict[str, Any]:
    """The only function in the app that talks to Google."""
    parts = urlsplit(url)
    if parts.scheme != "https" or (parts.hostname or "") not in _HOSTS:
        raise GoogleAuthError("host_not_allowed")
    if params:
        url = url + ("&" if "?" in url else "?") + urlencode(params, doseq=True)
    headers = {"Accept": "application/json"}
    body: bytes | None = None
    if form is not None:
        body = urlencode(form).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    if _transport is not None:
        status, raw = _transport(method, url, headers, body, timeout)
    else:
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        opener = urllib.request.build_opener(_NoRedirect)
        try:
            with opener.open(request, timeout=timeout) as resp:  # noqa: S310 - host allowlisted above
                status, raw = resp.status, resp.read(_MAX_RESPONSE_BYTES)
        except urllib.error.HTTPError as e:
            status, raw = e.code, (e.read(_MAX_RESPONSE_BYTES) if e.fp is not None else b"")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise GoogleAuthError("network") from e
    try:
        data = json.loads(raw.decode("utf-8")) if raw else {}
    except (ValueError, UnicodeDecodeError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    if not 200 <= status < 300:
        raise GoogleAuthError(_error_code(data, status), status)
    return data


# --- the connect flow ------------------------------------------------------------
def configured() -> bool:
    """A Google client exists AND the app knows its own public address — without
    APP_BASE_URL there is no redirect URI Google could have registered."""
    s = get_settings()
    return bool(s.google_client_id and s.google_client_secret and (s.app_base_url or "").strip())


def redirect_uri(path: str = CALLBACK_PATH) -> str:
    """APP_BASE_URL + a callback path: the Gmail callback by default, the sign-in
    callback when `SIGNIN_CALLBACK_PATH` is passed."""
    return (get_settings().app_base_url or "").strip().rstrip("/") + path


def pkce_pair() -> tuple[str, str]:
    """(verifier, S256 challenge). The verifier is 64 characters of the
    base64url alphabet, inside RFC 7636's 43-128 and its allowed set."""
    verifier = secrets.token_urlsafe(48)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return verifier, base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def authorize_url(*, state: str, code_challenge: str, login_hint: str = "") -> str:
    """Google's consent page for gmail.readonly.

    `access_type=offline` + `prompt=consent` on EVERY connect: Google returns a
    refresh token only on a consent it considers first, so a reconnect without
    `prompt=consent` would come back with none and leave the sync dead.
    """
    s = get_settings()
    params = {
        "client_id": s.google_client_id,
        "redirect_uri": redirect_uri(),
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "state": state,
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "true",
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    if login_hint:
        params["login_hint"] = login_hint
    return AUTHORIZE_URL + "?" + urlencode(params)


def exchange_code(code: str, code_verifier: str) -> dict[str, Any]:
    s = get_settings()
    return _http("POST", TOKEN_URL, form={
        "code": code,
        "client_id": s.google_client_id,
        "client_secret": s.google_client_secret,
        "redirect_uri": redirect_uri(),
        "grant_type": "authorization_code",
        "code_verifier": code_verifier,
    })


def grants_gmail(token_response: dict[str, Any]) -> bool:
    """Whether the user actually granted gmail.readonly. Google's consent screen
    lets them untick it and the flow still "succeeds", so the granted `scope`
    field is the only honest answer."""
    return GMAIL_SCOPE in str(token_response.get("scope") or "").split()


def refresh(refresh_token: str) -> dict[str, Any]:
    """A fresh access token. Raises GoogleAuthError — `invalid_grant` when the
    grant is gone (revoked, expired in Testing mode, password changed)."""
    s = get_settings()
    data = _http("POST", TOKEN_URL, form={
        "client_id": s.google_client_id,
        "client_secret": s.google_client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    })
    if not data.get("access_token"):
        raise GoogleAuthError("no_access_token")
    return data


def revoke(token: str) -> bool:
    """Hand a grant back to Google. Best effort and never raises: a disconnect or
    a privacy wipe must complete whether or not Google answers, because deleting
    our copy of the token is the part that is ours to guarantee.

    Revocation is PROJECT-wide: it ends every scope the Google Cloud project holds
    for the account, across all of its clients. That is why Continue with Google
    lives in a separate project with a client of its own — a Gmail Disconnect or
    a privacy wipe hands back the Gmail grant and signs nobody out of Google
    sign-in — and why sign-in code never calls this (smoke-pinned through the
    AST)."""
    if not token:
        return False
    try:
        _http("POST", REVOKE_URL, form={"token": token})
    except Exception:  # noqa: BLE001 - best effort by contract
        return False
    return True


# --- Continue with Google (Phase 30 / E) ------------------------------------------
def signin_configured() -> bool:
    """The sign-in client's id AND secret AND the app's public address are set.

    Never the Gmail pair: a fallback would silently put sign-in on the Gmail
    project, where revocation and the restricted-scope user cap are shared.
    `accounts.me()` reports this as `google_enabled` on both of its returns."""
    s = get_settings()
    return bool(s.google_signin_client_id and s.google_signin_client_secret and (s.app_base_url or "").strip())


def signin_authorize_url(*, state: str, code_challenge: str, nonce: str, login_hint: str = "") -> str:
    """Google's account chooser for a sign-in: the sign-in client, basic scopes, a
    nonce the id_token must echo, and PKCE.

    Never `access_type` (sign-in keeps no refresh token), never
    `include_granted_scopes` (it would pull a Gmail grant into a sign-in and lose
    the basic-scope exemption) and never `prompt=consent`. `select_account`, so a
    browser signed in to several Google accounts is asked which one. The smoke
    test parses this query and pins all of it.
    """
    s = get_settings()
    params = {
        "client_id": s.google_signin_client_id,
        "redirect_uri": redirect_uri(SIGNIN_CALLBACK_PATH),
        "response_type": "code",
        "scope": " ".join(SIGNIN_SCOPES),
        "state": state,
        "nonce": nonce,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "prompt": "select_account",
    }
    if login_hint:
        params["login_hint"] = login_hint
    return AUTHORIZE_URL + "?" + urlencode(params)


def exchange_signin_code(code: str, verifier: str) -> dict[str, Any]:
    """The sign-in client's code exchange, with its own id, secret and redirect.
    The answer's id_token is read by `_signin_claims`; nothing else in it is kept."""
    s = get_settings()
    return _http("POST", TOKEN_URL, form={
        "code": code,
        "client_id": s.google_signin_client_id,
        "client_secret": s.google_signin_client_secret,
        "redirect_uri": redirect_uri(SIGNIN_CALLBACK_PATH),
        "grant_type": "authorization_code",
        "code_verifier": verifier,
    })


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _signin_claims(token_response: dict[str, Any], *, client_id: str, nonce: str, now: datetime) -> dict[str, Any]:
    """The claims of the id_token a sign-in exchange returned, or
    GoogleAuthError("token_invalid").

    Each of these is a refusal: no id_token; an iss that is not one of Google's
    two spellings; an aud that is not the sign-in client (a string, or a list
    holding it), or an azp present and different; exp at or before now minus
    60 s, or iat after now plus 300 s; a nonce other than the one this browser's
    start issued (compared in constant time); a sub that is not a string of
    1-255 characters; an email that is not a non-empty string; email_verified
    anything but the boolean true (the string "false" is not); an hd that is not
    a string.

    THERE IS NO SIGNATURE CHECK, and that is sound only because of where this
    token comes from: straight from Google's token endpoint, over TLS, in answer
    to a request that carried the client secret — the case Google's guidance and
    OpenID Connect Core 3.1.3.7 both allow. The JWKS host is not in `_HOSTS` for
    exactly that reason. A credential that reaches the app any other way (through
    the browser, a One Tap response, a query string) must verify its RS256
    signature through a deliberate `_HOSTS` change and must NEVER be passed here.
    That is why this function is private and AST-pinned to one caller: the
    sign-in callback, right after `exchange_signin_code`.
    """
    def invalid() -> GoogleAuthError:
        return GoogleAuthError("token_invalid")

    token = token_response.get("id_token") if isinstance(token_response, dict) else None
    parts = token.split(".") if isinstance(token, str) else []
    if len(parts) != 3 or not _B64URL.fullmatch(parts[1]):
        raise invalid()
    try:
        claims = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):  # binascii.Error is a ValueError
        raise invalid() from None
    if not isinstance(claims, dict) or not isinstance(now, datetime):
        raise invalid()
    moment = (now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)).timestamp()
    iss = claims.get("iss")
    if not isinstance(iss, str) or iss not in _ISSUERS:
        raise invalid()
    aud = claims.get("aud")
    audiences = [aud] if isinstance(aud, str) else aud if isinstance(aud, list) else []
    if not client_id or client_id not in [a for a in audiences if isinstance(a, str)]:
        raise invalid()
    if "azp" in claims and claims.get("azp") != client_id:
        raise invalid()
    exp, iat = claims.get("exp"), claims.get("iat")
    if not (_number(exp) and _number(iat)) or not exp > moment - _EXP_SKEW_S or not iat <= moment + _IAT_SKEW_S:
        raise invalid()
    echoed = claims.get("nonce")
    if not (isinstance(nonce, str) and nonce and isinstance(echoed, str)
            and hmac.compare_digest(echoed.encode("utf-8"), nonce.encode("utf-8"))):
        raise invalid()
    sub = claims.get("sub")
    if not (isinstance(sub, str) and 1 <= len(sub) <= 255):
        raise invalid()
    email = claims.get("email")
    if not (isinstance(email, str) and email.strip()):
        raise invalid()
    if claims.get("email_verified") is not True:
        raise invalid()
    if "hd" in claims and not isinstance(claims["hd"], str):
        raise invalid()
    return claims
