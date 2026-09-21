"""Account routes (Phase 29 / B1): the thin door onto app/core/accounts.py.

Each handler parses, calls one flow, and sets or clears the `jf_session`
cookie. Refusals are `AuthError`s, rendered as structured JSON by the handler in
app/main.py. Rules every route here keeps:

- **Settings are read per request**, never captured at import. The smoke test
  flips SIGNUP_MODE and AUTH_SCRYPT_N mid-suite; a module-level `settings` would
  pin both to whatever they were when this file loaded.
- **Nothing here writes `usage_log`** or takes `llm_user`/`metered_user`. No
  route reaches a model, and a daily cap on signing in would be theatre that
  also broke the friend's pinned usage count.
- **Which routes answer an anonymous caller is the gate's decision**
  (`_AUTH_OPTIONAL` in app/main.py). The ones that need a signed-in caller take
  `Depends(current_user)` like every other route in the app.

Continue with Google (Phase 30 / E2) is the two routes at the bottom. Its
callback is the one route here that never answers JSON: Google sent a browser,
so every outcome, each refusal included, is a redirect to a page that can say
what happened (`?google=<code>`).
"""
from __future__ import annotations

import hmac
import json
import secrets
from datetime import timedelta
from urllib.parse import quote, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import RedirectResponse
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.config import get_settings
from app.core import accounts, auth_throttle, google_oauth
from app.core.sessions import (
    as_utc,
    clear_session_cookie,
    client_ip,
    cookie_path,
    hkey,
    is_https,
    naive_utc,
    safe_next,
    set_session_cookie,
    token_hash,
    utc_now,
)
from app.db.database import get_db
from app.db.models import AuthToken, User
from app.models import (
    AuthMe,
    ChangeEmailIn,
    ExtensionKeyOut,
    ForgotIn,
    GoogleStartIn,
    GoogleStartOut,
    LoginIn,
    LogoutOthersOut,
    OkOut,
    PasswordChangeIn,
    PasswordChangeOut,
    ResendOut,
    ResetIn,
    ResetOut,
    SignupIn,
    VerifyIn,
    VerifyOut,
)

router = APIRouter()

# Continue with Google (Phase 30 / E2).
GOOGLE_SIGNIN = "google_signin"  # auth_tokens.purpose of a sign-in's state row
# Binds the Google round trip to the browser that started it. Named apart from
# the Gmail connect's jf_oauth, so a sign-in and a connect in one browser never
# overwrite each other's binding.
GSI_COOKIE = "jf_gsi"
GSI_TTL = timedelta(minutes=10)
_PAGES = ("login", "signup")
_GOOGLE_ISS = "https://accounts.google.com"


def _private(response: Response) -> None:
    # Every answer here describes one account, and one of them carries its key.
    # No shared cache may ever hand it to the next person.
    response.headers["Cache-Control"] = "no-store"


@router.get("/auth/me", response_model=AuthMe)
def auth_me(request: Request, response: Response, db: Session = Depends(get_db)) -> AuthMe:
    """Who this request is. Always 200, anonymous callers included — the
    frontend's one "am I signed in, and verified?" question."""
    _private(response)
    user, method, _ = accounts.whoami(db, request)
    return accounts.me(db, user, method)


@router.post("/auth/signup", response_model=AuthMe)
def auth_signup(
    body: SignupIn, request: Request, response: Response, db: Session = Depends(get_db)
) -> AuthMe:
    """Create an account, sign it in UNVERIFIED, and mail the code."""
    _private(response)
    user, raw = accounts.signup(
        db, request, name=body.name, email=body.email, password=body.password, locale=body.locale
    )
    set_session_cookie(response, request, raw)
    return accounts.me(db, user, "session")


@router.post("/auth/login", response_model=AuthMe)
def auth_login(
    body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)
) -> AuthMe:
    _private(response)
    user, raw = accounts.login(db, request, email=body.email, password=body.password)
    set_session_cookie(response, request, raw)
    return accounts.me(db, user, "session")


@router.post("/auth/logout", response_model=OkOut)
def auth_logout(request: Request, response: Response, db: Session = Depends(get_db)) -> OkOut:
    """End this session. Always 200 — signing out must work even from a session
    that has already expired."""
    accounts.logout(db, request)
    clear_session_cookie(response, request)
    return OkOut()


@router.post("/auth/verify", response_model=VerifyOut)
def auth_verify(body: VerifyIn, request: Request, db: Session = Depends(get_db)) -> VerifyOut:
    verified, signed_in = accounts.verify(db, request, token=body.token, code=body.code)
    return VerifyOut(verified=verified, signed_in=signed_in)


@router.post("/auth/resend", response_model=ResendOut)
def auth_resend(
    request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> ResendOut:
    cooldown = accounts.resend(db, request, user)
    return ResendOut(sent=cooldown > 0, cooldown_s=cooldown)


@router.post("/auth/change-email", response_model=AuthMe)
def auth_change_email(
    body: ChangeEmailIn,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> AuthMe:
    """Fix a mistyped address while it is still unverified; mails a new code."""
    _private(response)
    accounts.change_email(db, request, user, body.email)
    account, method, _ = accounts.whoami(db, request)
    return accounts.me(db, account, method)


@router.post("/auth/forgot", response_model=OkOut)
def auth_forgot(body: ForgotIn, request: Request, db: Session = Depends(get_db)) -> OkOut:
    """Always {ok}: whether a mail went out is not something this route says.
    Nor, up to AUTH_FORGOT_FLOOR_MS, does how long it took (`accounts.forgot`)."""
    accounts.forgot(db, request, body.email)
    return OkOut()


@router.post("/auth/reset", response_model=ResetOut)
def auth_reset(
    body: ResetIn, request: Request, response: Response, db: Session = Depends(get_db)
) -> ResetOut:
    """The /auth/me answer for the fresh session, plus `extension_key_rotated`
    so the page can tell the reader the extension needs its new key (FIXB B1)."""
    _private(response)
    user, raw, rotated = accounts.reset(db, request, token=body.token, password=body.password)
    set_session_cookie(response, request, raw)
    return ResetOut(**accounts.me(db, user, "session").model_dump(), extension_key_rotated=rotated)


@router.post("/auth/password", response_model=PasswordChangeOut)
def auth_password(
    body: PasswordChangeIn,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> PasswordChangeOut:
    rotated = accounts.change_password(
        db, request, user, current=body.current_password, new=body.new_password
    )
    return PasswordChangeOut(extension_key_rotated=rotated)


@router.post("/auth/logout-others", response_model=LogoutOthersOut)
def auth_logout_others(
    request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> LogoutOthersOut:
    revoked, rotated = accounts.logout_others(db, request, user)
    return LogoutOthersOut(revoked=revoked, extension_key_rotated=rotated)


@router.get("/auth/extension-key", response_model=ExtensionKeyOut)
def auth_extension_key(
    response: Response, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> ExtensionKeyOut:
    _private(response)
    return ExtensionKeyOut(key=accounts.extension_key(db, user))


@router.post("/auth/extension-key/rotate", response_model=ExtensionKeyOut)
def auth_rotate_extension_key(
    response: Response, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> ExtensionKeyOut:
    """A new key; the old one stops opening the gate the moment this commits."""
    _private(response)
    return ExtensionKeyOut(key=accounts.rotate_extension_key(db, user))


# --- Continue with Google (Phase 30 / E2) -----------------------------------------------
@router.post("/auth/google/start", response_model=GoogleStartOut)
def auth_google_start(
    request: Request,
    response: Response,
    body: GoogleStartIn | None = None,
    db: Session = Depends(get_db),
) -> GoogleStartOut:
    """Google's account chooser URL, and a short-lived `jf_gsi` cookie binding the
    round trip to THIS browser: the state row keeps only an HMAC of the cookie,
    so the URL is useless in any other browser.

    404 google_disabled until the sign-in client is configured; 30 starts an
    hour per network. The state row is minted here directly rather than through
    `accounts._issue`, whose pruning runs only when an account's token is minted,
    so this route prunes old sign-in rows itself — past the security log's
    RETENTION, not past now, so a row that expired a minute ago is still found and
    its callback can say `expired` rather than `state_invalid`.
    """
    _private(response)
    if not google_oauth.signin_configured():
        raise accounts.AuthError(404, "google_disabled")
    body = body or GoogleStartIn()
    now = utc_now()
    attempt = auth_throttle.hit(
        db, "google_start", auth_throttle.ip_key(client_ip(request)), *auth_throttle.GOOGLE_START_PER_IP, now=now
    )
    if attempt.retry_after:
        raise accounts.AuthError(429, "too_many_attempts", retry_after=attempt.retry_after)
    db.execute(
        delete(AuthToken)
        .where(AuthToken.purpose == GOOGLE_SIGNIN, AuthToken.expires_at < naive_utc(now - auth_throttle.RETENTION))
        .execution_options(synchronize_session=False)
    )
    verifier, challenge = google_oauth.pkce_pair()
    state, nonce, binding = secrets.token_urlsafe(32), secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    db.add(AuthToken(
        user_id=None,
        purpose=GOOGLE_SIGNIN,
        token_hash=token_hash(state),
        payload=json.dumps({
            "verifier": verifier,
            "nonce": nonce,
            "binding": hkey("google-signin", binding),
            "next": safe_next(body.next),
            "locale": (body.locale or "")[:16],
            "page": body.page if body.page in _PAGES else "login",
        }),
        expires_at=now + GSI_TTL,
        created_at=now,
    ))
    db.commit()
    response.set_cookie(
        GSI_COOKIE, binding, max_age=int(GSI_TTL.total_seconds()), path=cookie_path(request),
        secure=is_https(request), httponly=True, samesite="lax",
    )
    return GoogleStartOut(url=google_oauth.signin_authorize_url(state=state, code_challenge=challenge, nonce=nonce))


def _with_query(target: str, key: str, value: str) -> str:
    """`target` with one more query parameter; its own query and fragment are kept
    byte for byte."""
    parts = urlsplit(target)
    extra = urlencode({key: value})
    return urlunsplit(("", "", parts.path, f"{parts.query}&{extra}" if parts.query else extra, parts.fragment))


def _payload(row: AuthToken) -> dict:
    try:
        value = json.loads(row.payload or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


@router.get("/auth/google/callback")
def auth_google_callback(
    request: Request,
    db: Session = Depends(get_db),
    code: str = "",
    state: str = "",
    error: str = "",
    iss: str = "",
) -> RedirectResponse:
    """Google sends the browser back here, and it ALWAYS leaves with a redirect.
    An AuthError would render as JSON, so every refusal is caught here, and any
    other exception becomes `try_again`.

    In order: sign-in configured (disabled); the state row, by hash and purpose
    (state_invalid), still live (expired); the jf_gsi cookie matching the row's
    binding, in constant time (state_mismatch); Google's `iss` when present
    (state_invalid); an atomic single-use claim of the row (state_invalid);
    Google's `error` (cancelled for access_denied, else google_error) or no code
    (state_invalid); the code exchange (exchange_failed); the id_token's claims
    (token_invalid); and the account itself (`accounts.google_sign_in`, whose
    refusals keep their own codes).

    A refusal before the binding matches goes to /login with no next: nothing
    yet proves the state belongs to this browser, so nothing in it is used. From
    the iss check on, a refusal goes back to the page the flow started from, with
    its next (left out when it is /app).

    Every failure is recorded per network under `GOOGLE_FAIL_PER_IP`, and that
    limit bounds the ROWS rather than the sign-in (Phase 30 review, SEC-1):
    guessing a 256-bit state is hopeless whatever the limit, but this route is
    anonymous and reaches `fail` before it has looked anything up, so one log row
    per request was an unbounded write for anyone who found the URL. Over the
    allowance the row is taken back and this redirect is exactly the same.
    """
    dest = {"page": "", "next": ""}

    def leave(target: str) -> RedirectResponse:
        out = RedirectResponse(target, status_code=302)
        out.headers["Cache-Control"] = "no-store"
        out.delete_cookie(GSI_COOKIE, path=cookie_path(request), secure=is_https(request), httponly=True,
                          samesite="lax")
        return out

    def fail(reason: str) -> RedirectResponse:
        try:
            # `hit`, never `record`: over the allowance it takes its own row back,
            # which is the whole of what bounds an anonymous caller here. The Hit
            # is deliberately ignored — being over the limit costs a log row,
            # never the sign-in.
            auth_throttle.hit(db, "google_fail", auth_throttle.ip_key(client_ip(request)),
                              *auth_throttle.GOOGLE_FAIL_PER_IP)
        except Exception:  # noqa: BLE001 - the security log may never cost the redirect
            db.rollback()
        if not dest["page"]:
            return leave("/login?google=" + quote(reason, safe=""))
        target = f"/{dest['page']}?google={quote(reason, safe='')}"
        if dest["next"] != "/app":
            target += "&next=" + quote(dest["next"], safe="")
        return leave(target)

    try:
        if not google_oauth.signin_configured():
            return fail("disabled")
        now = utc_now()
        row = None
        if state and len(state) <= 128:
            row = db.execute(
                select(AuthToken).where(AuthToken.token_hash == token_hash(state), AuthToken.purpose == GOOGLE_SIGNIN)
            ).scalars().first()
        if row is None:
            return fail("state_invalid")
        if (as_utc(row.expires_at) or now) <= now:
            return fail("expired")
        row_id, payload = row.id, _payload(row)
        binding = request.cookies.get(GSI_COOKIE, "")
        expected = str(payload.get("binding") or "")
        if not binding or not expected or not hmac.compare_digest(hkey("google-signin", binding), expected):
            return fail("state_mismatch")
        page = payload.get("page")
        dest["page"] = page if page in _PAGES else "login"
        dest["next"] = safe_next(str(payload.get("next") or ""))
        if iss and iss != _GOOGLE_ISS:
            return fail("state_invalid")
        claimed = db.execute(
            update(AuthToken)
            .where(AuthToken.id == row_id, AuthToken.consumed_at.is_(None))
            .values(consumed_at=now)
            .execution_options(synchronize_session=False)
        ).rowcount
        db.commit()
        if not claimed:
            return fail("state_invalid")
        if error:
            return fail("cancelled" if error == "access_denied" else "google_error")
        if not code:
            return fail("state_invalid")
        try:
            tokens = google_oauth.exchange_signin_code(code, str(payload.get("verifier") or ""))
        except google_oauth.GoogleAuthError:
            return fail("exchange_failed")
        try:
            claims = google_oauth._signin_claims(
                tokens,
                client_id=get_settings().google_signin_client_id,
                nonce=str(payload.get("nonce") or ""),
                now=utc_now(),
            )
        except google_oauth.GoogleAuthError:
            return fail("token_invalid")
        try:
            user_id, raw_session, outcome = accounts.google_sign_in(
                db, request, claims, str(payload.get("locale") or "")
            )
        except accounts.AuthError as exc:
            return fail(exc.code)
        target = dest["next"]
        if outcome == "supersede":
            target = _with_query(target, "google", "superseded")
        out = leave(target)
        set_session_cookie(out, request, raw_session)
        try:
            auth_throttle.record(db, f"google_{outcome}", auth_throttle.ip_key(client_ip(request)), user_id)
        except Exception:  # noqa: BLE001 - the security log may never cost the sign-in
            db.rollback()
        return out
    except Exception:  # noqa: BLE001 - a redirect is the only answer this route has
        db.rollback()
        return fail("try_again")
