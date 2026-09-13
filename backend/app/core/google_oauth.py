"""Google OAuth for the Gmail connect (Phase 29 / B2) — the one door to Google.

Every call this app makes to Google goes through `_http` below: the code
exchange, the refresh, the revoke, and every Gmail API read (`gmail_api` builds
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

`_transport` is None in production. The smoke test swaps in a fake so the
connect, a refused refresh and the Gmail reads all run offline.

Redirect URIs are built from APP_BASE_URL, never `request.url_for`: behind
Vercel's /api mount and the Vite proxy the app does not see the /api prefix the
browser used, so a derived URI would never match the one registered with Google.
"""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import urllib.error
import urllib.request
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
TIMEOUT_S = 20.0
# A Gmail message read is capped at 12 KB of text downstream; the raw JSON of a
# `format=full` read can still be large (base64 parts), so the read is bounded
# here too rather than trusting the server.
_MAX_RESPONSE_BYTES = 8_000_000

# (method, url, headers, body, timeout) -> (status, raw body)
Transport = Callable[[str, str, dict[str, str], "bytes | None", float], "tuple[int, bytes]"]
_transport: Transport | None = None


class GoogleAuthError(Exception):
    """Google refused, or did not answer.

    `code` is Google's own `error` string when it sent one — `invalid_grant` is
    the one that means the user's grant is gone and only a reconnect helps —
    else `http_<status>`, `network`, or `host_not_allowed`. Keyed on the code,
    never the human-readable description, which Google rewords at will.
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


def redirect_uri() -> str:
    return (get_settings().app_base_url or "").strip().rstrip("/") + CALLBACK_PATH


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

    Revoking also ends any other Google access this OAuth client holds for the
    account (one combined grant) — which today is nothing, since Google sign-in
    is deferred."""
    if not token:
        return False
    try:
        _http("POST", REVOKE_URL, form={"token": token})
    except Exception:  # noqa: BLE001 - best effort by contract
        return False
    return True
