"""Self-service accounts (Phase 29 / B1): signup, login, verification, reset.

The flows behind app/api/auth_routes.py, which stays a thin door. Every refusal
is an `AuthError` carrying a CODE the frontend translates (`invalid_credentials`,
`too_many_attempts`, ...), never an English sentence — and never a 401: the
frontend reads any 401 as "your session is gone, go log in", which is exactly
wrong for "that password was wrong".

Invite codes are untouched. A user the admin minted has `signup_source ""`,
holds no login row, and is verified by construction (`is_verified`), so the
friends beta keeps working without anyone verifying anything.

Four rules carry the security; each closes an attack the Phase 29 design
critique found in the first draft:

- **A mailed token is bound to the address it was sent to** (A1). Its payload
  records that address; consuming it requires the address to still be the
  account's, and issuing a token consumes every earlier one of the same purpose.
  Without this, "sign up as me@, change the address to victim@, type the code I
  got at me@" verified an address nobody proved.
- **A reset on an UNVERIFIED account is a safe takeover** (A2), because such an
  account can only be an email signup holding no other credential. The reset
  revokes every session AND rotates the extension key, so whoever registered the
  address before its owner keeps nothing. Since the Phase 29 review (FIXB B1)
  the key is rotated on EVERY reset, password change and "sign out other
  devices" of a self-registered account, verified or not: the key is a full
  credential with no expiry, so a squatter who got an account verified, or
  anyone who held a session once, otherwise kept it through all three. And a
  verify LINK only verifies from a live session of the SAME account, so a
  victim clicking "Confirm" on a squatter's signup proves nothing.
- **Signup never merges** (A3). An unverified login with the same password is a
  sign-in; any other password is `email_taken`.
- **Brute-force limits survive closing the account** (A7) — see auth_throttle.

Google sign-in, `/auth/claim` and the per-device sessions list are deferred
(amendment S1). With them gone, the only unverified logins that can exist belong
to email signups — which is exactly what makes the A2 takeover safe.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import secrets
import unicodedata
from datetime import datetime, timedelta
from email.utils import parseaddr

from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.requests import Request

from app.config import get_settings
from app.core import auth_email
from app.core import auth_throttle as throttle
from app.core import quota
from app.core.passwords import (
    MAX_BYTES,
    dummy_hash,
    hash_password,
    validate_password,
    verify_password,
)
from app.core.sessions import (
    as_utc,
    auth_key,
    client_ip,
    create_session,
    naive_utc,
    revoke_all,
    revoke_session,
    token_hash,
    utc_now,
)
from app.db.models import AuthEvent, AuthSession, AuthToken, User, UserLogin
from app.db.users import ensure_admin, new_invite_code
from app.models import AuthMe, AuthUser, UsageOut

logger = logging.getLogger(__name__)

VERIFY = "verify_email"
RESET = "reset_password"
_TOKEN_MAX_LEN = 128
# A plausible address, not RFC 5322: one @, no whitespace, a dotted domain with
# a tail of 2+ characters. Whether it is DELIVERABLE is what the code proves.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s.]{2,}$")
# FIXB B7: any of these makes the string something other than ONE plain
# addr-spec — a display name (`x<victim@y.com>`), a list (`a,b@y.com`), a quoted
# local part, a comment or a domain literal. Each is a different string to the
# unique index and the per-address budgets while SMTP delivers it to the same
# inbox, so none of them may be an account's address.
_EMAIL_FORBIDDEN = frozenset('<>()[],;:"\\')
_EMAIL_MAX = 254


class AuthError(Exception):
    """A refusal the frontend can translate: an HTTP status, a code, and extras
    such as `retry_after`. Rendered by the handler in app/main.py."""

    def __init__(self, status: int, code: str, **extra: object) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.extra = extra

    @property
    def detail(self) -> dict[str, object]:
        return {"code": self.code, **self.extra}


# --- identity ------------------------------------------------------------------
def normalize_email(email: str | None) -> str:
    """NFKC, stripped, lower-cased — the one spelling `user_logins.email` stores."""
    return unicodedata.normalize("NFKC", email or "").strip().lower()


def valid_email(email: str) -> bool:
    """Exactly one plain addr-spec: at most 254 characters, one @, no whitespace
    or structural punctuation, and `parseaddr` reading back the same string."""
    if not email or len(email) > _EMAIL_MAX or email.count("@") != 1:
        return False
    if any(ch.isspace() or ch in _EMAIL_FORBIDDEN or ord(ch) < 0x20 or ord(ch) == 0x7F for ch in email):
        return False
    return parseaddr(email)[1] == email and bool(_EMAIL_RE.match(email))


def signup_open() -> bool:
    return (get_settings().signup_mode or "").strip().lower() != "closed"


def _locale(locale: str | None) -> str:
    value = (locale or "").strip().lower()
    return "he" if value.startswith("he") else "en" if value.startswith("en") else ""


def login_for(db: Session, user_id: int) -> UserLogin | None:
    return db.execute(select(UserLogin).where(UserLogin.user_id == user_id)).scalars().first()


def login_by_email(db: Session, email: str) -> UserLogin | None:
    return db.execute(select(UserLogin).where(UserLogin.email == email)).scalars().first()


def is_verified(is_admin: bool, signup_source: str | None, email_verified_at: datetime | None) -> bool:
    """THE definition — the gate enforces it and /auth/me reports it.

    An admin, and every account with no signup source (an invite code the admin
    minted), is verified by construction: that credential was handed over, not
    claimed. Only an email signup has an address left to prove.
    """
    return bool(is_admin) or not (signup_source or "") or email_verified_at is not None


def whoami(db: Session, request: Request) -> tuple[User | None, str, int | None]:
    """(user, auth method, session id) for this request, from what the gate
    resolved — or the dev admin when the gate is off, the same fallback
    `current_user` makes. (None, "", None) for an anonymous caller."""
    user_id = getattr(request.state, "user_id", None)
    if user_id is not None:
        user = db.get(User, user_id)
        if user is not None and user.is_active:
            method = getattr(request.state, "auth_method", "") or "invite_code"
            return user, method, getattr(request.state, "session_id", None)
        return None, "", None
    if not get_settings().app_access_code:
        return ensure_admin(db), "dev", None
    return None, "", None


def me(db: Session, user: User | None, method: str) -> AuthMe:
    """The /auth/me payload. `google_enabled` and `google_linked` stay False:
    Google sign-in is deferred (amendment S1).

    `usage` is this month's uses (Phase 30 / B7) for a signed-in caller and None
    for an anonymous one. Every sign-in response is built here, so reading the
    pool is best effort: a failure reports usage as unknown (None), never a
    login that succeeded answering 500."""
    if user is None:
        return AuthMe(signup_open=signup_open())
    login = login_for(db, user.id)
    return AuthMe(
        authenticated=True,
        verified=is_verified(user.is_admin, user.signup_source, login.email_verified_at if login else None),
        method=method,
        signup_open=signup_open(),
        google_enabled=False,
        user=AuthUser(
            id=user.id,
            name=user.name or "",
            email=(login.email if login is not None else user.email) or "",
            is_admin=bool(user.is_admin),
            has_password=bool(login is not None and login.password_hash),
            google_linked=False,
            signup_source=user.signup_source or "",
        ),
        usage=_usage(db, user),
    )


def _usage(db: Session, user: User) -> UsageOut | None:
    user_id = user.id
    try:
        return quota.snapshot(db, user, quota.utc_now())
    except Exception:  # noqa: BLE001 - unknown usage is honest; a 500 on sign-in is not
        db.rollback()
        logger.warning("could not read this month's uses for user %s", user_id, exc_info=True)
        return None


# --- mailed tokens -----------------------------------------------------------------
def _code_hash(link_hash: str, code: str) -> str:
    """Keyed, and salted by its own token: with a million possible codes an
    unkeyed hash would just be a lookup table."""
    return hmac.new(auth_key(), f"code|{link_hash}|{code}".encode("utf-8"), hashlib.sha256).hexdigest()


def _payload_email(row: AuthToken) -> str:
    try:
        return str(json.loads(row.payload or "{}").get("email", ""))
    except (ValueError, AttributeError):
        return ""


def consume_tokens(db: Session, user_id: int, purposes: tuple[str, ...], now: datetime) -> None:
    """Kill every live token of these purposes for a user (no commit)."""
    db.execute(
        update(AuthToken)
        .where(
            AuthToken.user_id == user_id,
            AuthToken.purpose.in_(purposes),
            AuthToken.consumed_at.is_(None),
        )
        .values(consumed_at=now)
        .execution_options(synchronize_session=False)
    )


def _issue(
    db: Session, user_id: int, purpose: str, email: str, ttl_min: int, *, with_code: bool, now: datetime
) -> tuple[str, str]:
    """Mint a token bound to `email`, consuming every earlier one of its purpose
    (A1). Returns (raw link token, 6-digit code or ""). No commit."""
    consume_tokens(db, user_id, (purpose,), now)
    db.execute(
        delete(AuthToken)
        .where(AuthToken.expires_at < naive_utc(now - throttle.RETENTION))
        .execution_options(synchronize_session=False)
    )
    raw = secrets.token_urlsafe(32)
    link_hash = token_hash(raw)
    code = f"{secrets.randbelow(10**6):06d}" if with_code else ""
    db.add(
        AuthToken(
            user_id=user_id,
            purpose=purpose,
            token_hash=link_hash,
            code_hash=_code_hash(link_hash, code) if code else "",
            payload=json.dumps({"email": email}),
            attempts=0,
            expires_at=now + timedelta(minutes=max(1, ttl_min)),
            created_at=now,
        )
    )
    return raw, code


def _token_by_raw(db: Session, raw: str, purpose: str) -> AuthToken | None:
    if not raw or len(raw) > _TOKEN_MAX_LEN:
        return None
    return db.execute(
        select(AuthToken).where(AuthToken.token_hash == token_hash(raw), AuthToken.purpose == purpose)
    ).scalars().first()


def _account_for(db: Session, row: AuthToken | None) -> tuple[UserLogin, User]:
    login = login_for(db, row.user_id) if row is not None and row.user_id is not None else None
    user = db.get(User, login.user_id) if login is not None else None
    if row is None or login is None or user is None or not user.is_active:
        # An unknown link reads exactly like a spent one: nothing to act on either way.
        raise AuthError(400, "used")
    return login, user


def _token_state(row: AuthToken, login: UserLogin, now: datetime) -> str | None:
    """None when the token may be used, else the refusal. A token sent to an
    address the account no longer has is `used`, the same as a consumed one."""
    if row.consumed_at is not None or _payload_email(row) != login.email:
        return "used"
    if as_utc(row.expires_at) <= now:
        return "expired"
    return None


def _claim(db: Session, token_id: int, now: datetime) -> bool:
    """Consume exactly this token, atomically: False when a concurrent request
    got there first, which is what makes a link genuinely single-use."""
    result = db.execute(
        update(AuthToken)
        .where(AuthToken.id == token_id, AuthToken.consumed_at.is_(None))
        .values(consumed_at=now)
        .execution_options(synchronize_session=False)
    )
    return bool(result.rowcount)


def _mark_verified(db: Session, user_id: int, now: datetime) -> None:
    login = login_for(db, user_id)
    if login is not None and login.email_verified_at is None:
        login.email_verified_at = now
    consume_tokens(db, user_id, (VERIFY,), now)


# --- throttle helpers --------------------------------------------------------------
def _password_attempt(db: Session, email: str, request: Request, now: datetime) -> list[int | None]:
    """Count one password attempt against the address AND the network BEFORE the
    password is looked at — throttling after checking it would tell a guesser
    which guess was right by which one got through. Returns the event ids to
    forget if the password turns out to be correct."""
    by_email = throttle.hit(db, "login_fail", throttle.email_key(email), *throttle.LOGIN_FAIL_PER_EMAIL, now=now)
    if by_email.retry_after:
        raise AuthError(429, "too_many_attempts", retry_after=by_email.retry_after)
    by_ip = throttle.hit(
        db, "login_fail", throttle.ip_key(client_ip(request)), *throttle.LOGIN_FAIL_PER_IP, now=now
    )
    if by_ip.retry_after:
        throttle.forget(db, by_email.event_id)
        raise AuthError(429, "too_many_attempts", retry_after=by_ip.retry_after)
    return [by_email.event_id, by_ip.event_id]


def _forget_all(db: Session, event_ids: list[int | None]) -> None:
    for event_id in event_ids:
        throttle.forget(db, event_id)


def _verify_mail_slot(
    db: Session, email: str, user_id: int, now: datetime, *, raise_on_limit: bool = True
) -> bool:
    """Room for one more verification mail to `email`: a minute since the last,
    and six an hour. Keyed on the ADDRESS, so neither limit resets when the
    account behind it is closed and opened again."""
    key = throttle.email_key(email)
    wait = throttle.cooldown_left(db, "verify_mail", key, throttle.VERIFY_MAIL_COOLDOWN_S, now)
    if not wait:
        slot = throttle.hit(db, "verify_mail", key, *throttle.VERIFY_MAIL_PER_EMAIL, user_id=user_id, now=now)
        if not slot.retry_after:
            return True
        wait = slot.retry_after
    if raise_on_limit:
        raise AuthError(429, "too_many_attempts", retry_after=wait)
    return False


def _notify_password_changed(
    db: Session, request: Request, email: str, locale: str, user_id: int, *, key_rotated: bool = False
) -> None:
    try:
        auth_email.send_password_changed(db, request, email, locale=locale, user_id=user_id,
                                         key_rotated=key_rotated)
    except auth_email.EmailUnavailable:
        pass  # a notice is best-effort: the change it describes has already happened


def _rotate_extension_key(user: User | None) -> bool:
    """Replace a self-registered account's extension key (no commit). True when
    it was replaced.

    FIXB B1: the key IS `users.invite_code`, a full X-App-Key credential with no
    expiry, so ending sessions alone leaves anyone who once read it holding the
    account. An invite-code account (signup_source "") is exempt — that code was
    handed over by the admin and is the user's only way in — and so is the admin,
    whose code `ensure_admin` rewrites from APP_ACCESS_CODE on every cold start."""
    if user is None or user.is_admin or not (user.signup_source or ""):
        return False
    user.invite_code = new_invite_code()
    return True


# --- flows -------------------------------------------------------------------------
def signup(
    db: Session, request: Request, *, name: str, email: str, password: str, locale: str = ""
) -> tuple[User, str]:
    """Create an account, sign it in UNVERIFIED, mail the code. Returns (user, raw session token)."""
    s = get_settings()
    if not signup_open():
        raise AuthError(403, "signup_closed")
    name = (name or "").strip()[:255]
    if not name:
        raise AuthError(400, "name_required")
    email = normalize_email(email)
    if not valid_email(email):
        raise AuthError(400, "invalid_email")
    reason = validate_password(password, email)
    if reason:
        raise AuthError(400, "weak_password", reason=reason)
    now = utc_now()
    attempt = throttle.hit(db, "signup", throttle.ip_key(client_ip(request)), *throttle.SIGNUP_PER_IP, now=now)
    if attempt.retry_after:
        raise AuthError(429, "too_many_attempts", retry_after=attempt.retry_after)
    existing = login_by_email(db, email)
    if existing is not None:
        return _signup_over_existing(db, request, existing, password, now)
    if not auth_email.mail_ready(db, email):
        # Refused BEFORE anything is created: an account whose code can never
        # arrive is a dead end.
        raise AuthError(503, "email_unavailable")
    # Hashed before the first write, so ~0.3 s of scrypt never holds a lock.
    password_hash = hash_password(password, s.auth_scrypt_n)
    user = User(
        name=name,
        email=email,
        invite_code=new_invite_code(),
        signup_source="email",
        locale=_locale(locale),
        created_at=now,
    )
    db.add(user)
    try:
        db.flush()
        db.add(UserLogin(user_id=user.id, email=email, password_hash=password_hash, created_at=now))
        db.flush()
    except IntegrityError:
        # A concurrent signup won the unique address between the lookup and here.
        db.rollback()
        raise AuthError(409, "email_taken") from None
    user_id = user.id
    token, code = _issue(db, user_id, VERIFY, email, s.verify_ttl_min, with_code=True, now=now)
    raw_session = create_session(db, user_id, request, now)
    db.commit()
    throttle.record(db, "verify_mail", throttle.email_key(email), user_id, now)
    try:
        auth_email.send_verify(db, request, email, code, token, locale=_locale(locale), user_id=user_id)
    except auth_email.EmailUnavailable:
        # The account stands but no cookie is handed out. Signing up again with
        # the same password is the way back: A3 treats it as a sign-in and mails
        # a fresh code.
        raise AuthError(503, "email_unavailable") from None
    return db.get(User, user_id), raw_session


def _signup_over_existing(
    db: Session, request: Request, login: UserLogin, password: str, now: datetime
) -> tuple[User, str]:
    """Signup for an address that already has a login (A3)."""
    s = get_settings()
    user = db.get(User, login.user_id)
    if user is None or not user.is_active or login.email_verified_at is not None:
        raise AuthError(409, "email_taken")
    email, user_id, stored = login.email, user.id, login.password_hash
    events = _password_attempt(db, email, request, now)
    ok, rehash = verify_password(password, stored, s.auth_scrypt_n)
    if not ok:
        # Never a merge: that login already holds someone's password and
        # pending session, and a second signup may not inherit or replace them.
        raise AuthError(409, "email_taken")
    _forget_all(db, events)
    if rehash:
        login_for(db, user_id).password_hash = hash_password(password, s.auth_scrypt_n)
    raw_session = create_session(db, user_id, request, now)
    db.commit()
    # A fresh code — unless the resend limits say not yet, in which case the code
    # already in their inbox stays live instead of being consumed by a new one
    # that never gets sent.
    if auth_email.mail_ready(db, email) and _verify_mail_slot(db, email, user_id, now, raise_on_limit=False):
        token, code = _issue(db, user_id, VERIFY, email, s.verify_ttl_min, with_code=True, now=now)
        db.commit()
        try:
            auth_email.send_verify(db, request, email, code, token, locale=db.get(User, user_id).locale,
                                   user_id=user_id)
        except auth_email.EmailUnavailable:
            pass  # signed in regardless; Resend is on the verify page
    return db.get(User, user_id), raw_session


def login(db: Session, request: Request, *, email: str, password: str) -> tuple[User, str]:
    """Sign in with a password. An unknown address, a wrong password and a
    deactivated account are one identical `invalid_credentials`, and each spends
    the same scrypt (`dummy_hash`)."""
    s = get_settings()
    now = utc_now()
    email = normalize_email(email)
    password = password or ""
    events = _password_attempt(db, email, request, now)
    row = login_by_email(db, email) if valid_email(email) else None
    user = db.get(User, row.user_id) if row is not None else None
    usable = row is not None and user is not None and bool(user.is_active) and bool(row.password_hash)
    if len(password.encode("utf-8", "surrogatepass")) > MAX_BYTES:
        # Signup never accepts one this long, so it cannot match — but spend the
        # same scrypt anyway, or an over-long password becomes a timing probe.
        verify_password("", dummy_hash(s.auth_scrypt_n), s.auth_scrypt_n)
        raise AuthError(400, "invalid_credentials")
    stored = row.password_hash if usable else dummy_hash(s.auth_scrypt_n)
    ok, rehash = verify_password(password, stored, s.auth_scrypt_n)
    if not (ok and usable):
        raise AuthError(400, "invalid_credentials")
    user_id = user.id
    _forget_all(db, events)
    if rehash:
        login_for(db, user_id).password_hash = hash_password(password, s.auth_scrypt_n)
    raw_session = create_session(db, user_id, request, now)
    db.commit()
    throttle.record(db, "login", throttle.ip_key(client_ip(request)), user_id, now)
    return db.get(User, user_id), raw_session


def logout(db: Session, request: Request) -> None:
    session_id = getattr(request.state, "session_id", None)
    if session_id is not None:
        revoke_session(db, session_id)
        db.commit()


def verify(db: Session, request: Request, *, token: str = "", code: str = "") -> tuple[bool, bool]:
    """(verified, signed_in).

    A LINK never mints a session: mail security scanners open links before the
    owner does, so a link that signed its opener in would hand the account to
    the scanner. And since FIXB B1 a link verifies ONLY from a live session of
    the same account: otherwise a squatter who signs up with someone else's
    address has that person's click on "Confirm my email" verify the squatter's
    account. Opened anywhere else it is 400 session_required, and the page tells
    the reader to enter the 6-digit code on the device where they signed up. A
    CODE needs that pending session too.
    """
    now = utc_now()
    if token:
        return _verify_link(db, request, token, now)
    if code:
        return _verify_code(db, request, code, now)
    raise AuthError(400, "invalid_code")


def _verify_link(db: Session, request: Request, raw: str, now: datetime) -> tuple[bool, bool]:
    row = _token_by_raw(db, raw, VERIFY)
    login, user = _account_for(db, row)
    user_id = user.id
    if getattr(request.state, "user_id", None) != user_id:
        raise AuthError(400, "session_required")
    state = _token_state(row, login, now)
    if state:
        raise AuthError(400, state)
    if not _claim(db, row.id, now):
        raise AuthError(400, "used")
    _mark_verified(db, user_id, now)
    db.commit()
    return True, True


def _verify_code(db: Session, request: Request, code: str, now: datetime) -> tuple[bool, bool]:
    user_id = getattr(request.state, "user_id", None)
    user = db.get(User, user_id) if user_id is not None else None
    if user is None:
        raise AuthError(400, "session_required")
    login = login_for(db, user_id)
    if login is None or is_verified(user.is_admin, user.signup_source, login.email_verified_at):
        return True, True
    digits = re.sub(r"\s+", "", code or "")
    if not re.fullmatch(r"\d{6}", digits):
        raise AuthError(400, "invalid_code")
    email = login.email
    ceiling = throttle.hit(
        db, "verify_fail", throttle.email_key(email), *throttle.VERIFY_FAIL_PER_EMAIL, user_id=user_id, now=now
    )
    if ceiling.retry_after:
        raise AuthError(429, "too_many_attempts", retry_after=ceiling.retry_after)
    row = _live_verify_token(db, user_id, email, now)
    if row is None:
        throttle.forget(db, ceiling.event_id)  # nothing live to guess against, so not a guess
        raise AuthError(400, "used" if _stale_code(db, user_id, email, digits) else "expired")
    token_id = row.id
    # The attempt is counted BEFORE the comparison, atomically, so a parallel
    # burst cannot put more than TOKEN_ATTEMPTS guesses against one code.
    counted = db.execute(
        update(AuthToken)
        .where(AuthToken.id == token_id, AuthToken.attempts < throttle.TOKEN_ATTEMPTS)
        .values(attempts=AuthToken.attempts + 1)
        .execution_options(synchronize_session=False)
    ).rowcount
    db.commit()
    if not counted:
        throttle.forget(db, ceiling.event_id)  # a locked token tests nothing either
        wait = throttle.cooldown_left(
            db, "verify_mail", throttle.email_key(email), throttle.VERIFY_MAIL_COOLDOWN_S, now
        )
        raise AuthError(429, "too_many_attempts", retry_after=wait)
    row = db.get(AuthToken, token_id)
    db.refresh(row)
    if hmac.compare_digest(row.code_hash, _code_hash(row.token_hash, digits)):
        throttle.forget(db, ceiling.event_id)
        if not _claim(db, token_id, now):
            raise AuthError(400, "used")
        _mark_verified(db, user_id, now)
        db.commit()
        return True, True
    if _stale_code(db, user_id, email, digits):
        raise AuthError(400, "used")
    raise AuthError(400, "invalid_code", attempts_left=max(0, throttle.TOKEN_ATTEMPTS - row.attempts))


def _live_verify_token(db: Session, user_id: int, email: str, now: datetime) -> AuthToken | None:
    rows = db.execute(
        select(AuthToken)
        .where(
            AuthToken.user_id == user_id,
            AuthToken.purpose == VERIFY,
            AuthToken.consumed_at.is_(None),
            AuthToken.expires_at > naive_utc(now),
        )
        .order_by(AuthToken.id.desc())
    ).scalars().all()
    return next((r for r in rows if _payload_email(r) == email), None)


def _stale_code(db: Session, user_id: int, email: str, digits: str) -> bool:
    """Was this code real once — superseded by a newer one, or sent to an
    address the account no longer has? Then the honest refusal is `used`, not
    "wrong code". Only DEAD tokens count: a code matching a merely expired one
    is `expired`, which the caller already says."""
    rows = db.execute(
        select(AuthToken).where(
            AuthToken.user_id == user_id, AuthToken.purpose == VERIFY, AuthToken.code_hash != ""
        )
    ).scalars().all()
    return any(
        (r.consumed_at is not None or _payload_email(r) != email)
        and hmac.compare_digest(r.code_hash, _code_hash(r.token_hash, digits))
        for r in rows
    )


def resend(db: Session, request: Request, user: User) -> int:
    """Mail a fresh code. Returns the cooldown before the next one; 0 means there
    was nothing to send (already verified, or no email sign-in)."""
    login = login_for(db, user.id)
    if login is None or is_verified(user.is_admin, user.signup_source, login.email_verified_at):
        return 0
    s = get_settings()
    now = utc_now()
    email, user_id, locale = login.email, user.id, user.locale
    # The resend slot is spent BEFORE the mail budget is asked (FIXB B4): a 503
    # that cost nothing let a squatter poll every second and take each freed
    # slot the instant it appeared. Now a refused attempt still counts.
    _verify_mail_slot(db, email, user_id, now)
    if not auth_email.mail_ready(db, email):
        raise AuthError(503, "email_unavailable")
    token, code = _issue(db, user_id, VERIFY, email, s.verify_ttl_min, with_code=True, now=now)
    db.commit()
    try:
        auth_email.send_verify(db, request, email, code, token, locale=locale, user_id=user_id)
    except auth_email.EmailUnavailable:
        raise AuthError(503, "email_unavailable") from None
    return throttle.VERIFY_MAIL_COOLDOWN_S


def change_email(db: Session, request: Request, user: User, new_email: str) -> None:
    """Fix a mistyped address BEFORE it is verified — never after: a verified
    address is proven, and moving it would need a flow this phase does not build.

    No notice goes to the old address, deliberately: it was never proven to be
    the account holder's, so a "your address changed" mail there has no security
    value and is mail to a possible stranger.
    """
    s = get_settings()
    now = utc_now()
    login = login_for(db, user.id)
    if login is None:
        raise AuthError(400, "no_login")
    if login.email_verified_at is not None:
        raise AuthError(400, "already_verified")
    email = normalize_email(new_email)
    if not valid_email(email):
        raise AuthError(400, "invalid_email")
    user_id, locale = user.id, user.locale
    attempt = throttle.hit(
        db, "change_email", throttle.user_key(user_id), *throttle.CHANGE_EMAIL_PER_USER, user_id=user_id, now=now
    )
    if attempt.retry_after:
        raise AuthError(429, "too_many_attempts", retry_after=attempt.retry_after)
    other = login_by_email(db, email)
    if other is not None and other.user_id != user_id:
        raise AuthError(409, "email_taken")
    if not auth_email.mail_ready(db, email):
        raise AuthError(503, "email_unavailable")
    row = login_for(db, user_id)
    account = db.get(User, user_id)
    row.email = email
    account.email = email
    # Every code and link sent so far named the OLD address; none may verify the new one (A1).
    consume_tokens(db, user_id, (VERIFY, RESET), now)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise AuthError(409, "email_taken") from None
    token, code = _issue(db, user_id, VERIFY, email, s.verify_ttl_min, with_code=True, now=now)
    db.commit()
    throttle.record(db, "verify_mail", throttle.email_key(email), user_id, now)
    try:
        auth_email.send_verify(db, request, email, code, token, locale=locale, user_id=user_id)
    except auth_email.EmailUnavailable:
        raise AuthError(503, "email_unavailable") from None


def forgot(db: Session, request: Request, email: str) -> None:
    """Mail a reset link if — and only if — an active account has this address.
    The route answers {ok} whatever happens here: throttled, unknown, over budget
    or sent all look the same from outside, so it cannot say who has an account."""
    s = get_settings()
    now = utc_now()
    email = normalize_email(email)
    if not valid_email(email):
        return
    by_email = throttle.hit(db, "forgot", throttle.email_key(email), *throttle.FORGOT_PER_EMAIL, now=now)
    by_ip = throttle.hit(db, "forgot", throttle.ip_key(client_ip(request)), *throttle.FORGOT_PER_IP, now=now)
    if by_email.retry_after or by_ip.retry_after:
        return
    login = login_by_email(db, email)
    user = db.get(User, login.user_id) if login is not None else None
    if login is None or user is None or not user.is_active:
        return
    # A reset mail with no link has nothing in it to act on; don't consume the
    # previous link for one, or for a mail the budget would refuse.
    if not auth_email.link_base(request) or not auth_email.mail_ready(db, email, purpose="reset"):
        return
    user_id, locale = user.id, user.locale
    token, _ = _issue(db, user_id, RESET, email, s.reset_ttl_min, with_code=False, now=now)
    db.commit()
    try:
        auth_email.send_reset(db, request, email, token, locale=locale, user_id=user_id)
    except auth_email.EmailUnavailable:
        pass  # silent by contract


def reset(db: Session, request: Request, *, token: str, password: str) -> tuple[User, str, bool]:
    """Set a new password from a reset link, then sign this browser in. Returns
    (user, raw session token, whether the extension key was replaced).

    EVERY session is revoked first — including any the account's owner never
    made — and one fresh session is minted. The link proves the address, so an
    unverified account becomes verified. The extension key is rotated on every
    reset (A2, widened by FIXB B1 to verified accounts too).
    """
    s = get_settings()
    now = utc_now()
    row = _token_by_raw(db, token, RESET)
    login, user = _account_for(db, row)
    state = _token_state(row, login, now)
    if state:
        raise AuthError(400, state)
    reason = validate_password(password, login.email)
    if reason:
        raise AuthError(400, "weak_password", reason=reason)
    user_id, email, locale, token_id = user.id, login.email, user.locale, row.id
    was_unverified = login.email_verified_at is None
    password_hash = hash_password(password, s.auth_scrypt_n)
    if not _claim(db, token_id, now):
        raise AuthError(400, "used")
    login.password_hash = password_hash
    login.password_changed_at = now
    if was_unverified:
        login.email_verified_at = now
    # Whoever registered this address before its owner, or held a session on it
    # at any point, may hold a session and the extension key. The sessions die
    # below; the key dies here — verified or not (FIXB B1).
    rotated = _rotate_extension_key(user)
    consume_tokens(db, user_id, (VERIFY, RESET), now)
    revoke_all(db, user_id, now=now)
    raw_session = create_session(db, user_id, request, now)
    db.commit()
    throttle.record(db, "password_reset", throttle.email_key(email), user_id, now)
    _notify_password_changed(db, request, email, locale, user_id, key_rotated=rotated)
    return db.get(User, user_id), raw_session, rotated


def change_password(db: Session, request: Request, user: User, *, current: str, new: str) -> bool:
    """Change the password from Settings. The current one is required whenever
    one is set (and throttled like a login, or a stolen session could grind it);
    every OTHER session is signed out and the extension key is replaced (FIXB
    B1). Returns whether the key was replaced."""
    s = get_settings()
    now = utc_now()
    login = login_for(db, user.id)
    if login is None:
        raise AuthError(400, "no_login")
    user_id, email, locale, stored = user.id, login.email, user.locale, login.password_hash
    if stored:
        events = _password_attempt(db, email, request, now)
        ok, _ = verify_password(current or "", stored, s.auth_scrypt_n)
        if not ok:
            raise AuthError(400, "invalid_credentials")
        _forget_all(db, events)
    reason = validate_password(new, email)
    if reason:
        raise AuthError(400, "weak_password", reason=reason)
    password_hash = hash_password(new, s.auth_scrypt_n)
    row = login_for(db, user_id)
    row.password_hash = password_hash
    row.password_changed_at = now
    rotated = _rotate_extension_key(db.get(User, user_id))
    consume_tokens(db, user_id, (VERIFY, RESET), now)
    revoke_all(db, user_id, except_id=getattr(request.state, "session_id", None), now=now)
    db.commit()
    throttle.record(db, "password_changed", throttle.email_key(email), user_id, now)
    _notify_password_changed(db, request, email, locale, user_id, key_rotated=rotated)
    return rotated


def logout_others(db: Session, request: Request, user: User) -> tuple[int, bool]:
    """Sign out every session but this one, and replace the extension key — a
    key someone read earlier is a device too (FIXB B1). Returns (sessions
    ended, whether the key was replaced)."""
    user_id = user.id
    revoked = revoke_all(db, user_id, except_id=getattr(request.state, "session_id", None))
    rotated = _rotate_extension_key(db.get(User, user_id))
    db.commit()
    return revoked, rotated


def extension_key(db: Session, user: User) -> str:
    """The browser-extension key, which IS the account's invite code — the
    extension only ever sends X-App-Key. Verified accounts only: an unproven
    signup must not walk away with a credential that skips the cookie."""
    login = login_for(db, user.id)
    if not is_verified(user.is_admin, user.signup_source, login.email_verified_at if login else None):
        raise AuthError(403, "email_unverified")
    return user.invite_code


def rotate_extension_key(db: Session, user: User) -> str:
    if user.is_admin:
        # `ensure_admin` rewrites the admin's code from APP_ACCESS_CODE on every
        # cold start, so a rotation here would silently undo itself.
        raise AuthError(400, "admin_key_from_env")
    extension_key(db, user)  # the same verified-only rule as reading it
    user.invite_code = new_invite_code()
    db.commit()
    return user.invite_code


def purge_on_close(db: Session, user_id: int) -> None:
    """The account half of DELETE /profile/account, in the caller's transaction.

    Logins, tokens and sessions go: the address is free to register again and
    every cookie dies with the account. Events do NOT go — only their `user_id`
    is cleared — because they are keyed on an email or a network, and deleting
    them would make "close the account" a way to reset every brute-force limit
    on that address (A7).
    """
    for model in (UserLogin, AuthToken, AuthSession):
        db.execute(
            delete(model).where(model.user_id == user_id).execution_options(synchronize_session=False)
        )
    db.execute(
        update(AuthEvent)
        .where(AuthEvent.user_id == user_id)
        .values(user_id=None)
        .execution_options(synchronize_session=False)
    )
