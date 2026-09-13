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
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.core import accounts
from app.core.sessions import clear_session_cookie, set_session_cookie
from app.db.database import get_db
from app.db.models import User
from app.models import (
    AuthMe,
    ChangeEmailIn,
    ExtensionKeyOut,
    ForgotIn,
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
    """Always {ok}: whether a mail went out is not something this route says."""
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
