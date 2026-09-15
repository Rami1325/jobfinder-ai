"""Web sessions, and the request facts every auth decision reads (Phase 29 / B1).

A session is an OPAQUE random token — 256 bits from `secrets`, carried in the
`jf_session` cookie, stored only as its sha256 — never a JWT. Every request
already reads the database in the access gate, so a signed token would save
nothing, and an opaque one can be revoked: logout, "sign out of other devices",
a password reset and an account close each end sessions by writing one column.

The cookie is HttpOnly (page script cannot read it, so an XSS cannot lift it),
SameSite=Lax, and Secure whenever the request arrived over https. CSRF is the
gate's job, not the cookie's: see `access_gate` in app/main.py.

Also here, because the gate and the account routes must agree on each of them:
where the client address comes from (`client_ip`), whether the request was https
(`is_https`), the cookie's Path (`cookie_path`), the HMAC that keys every
throttle (`hkey`), and the one validator for a post-login redirect (`safe_next`).
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import NamedTuple
from urllib.parse import unquote, urljoin, urlsplit

from sqlalchemy import delete, or_, select, update
from sqlalchemy.orm import Session
from starlette.requests import Request
from starlette.responses import Response

from app.config import Settings, get_settings
from app.db.models import AuthSession, User

COOKIE_NAME = "jf_session"
# How often a live session may write its own renewal. One page load fires
# several API calls, and without this each one would be a write to Neon — the
# `users.SEEN_THROTTLE` reasoning, at the granularity a 30-day lifetime needs.
RENEW_EVERY = timedelta(hours=12)
# Revoked and expired session rows are kept this long, then pruned. They carry
# a device string and a coarse address, i.e. they are a sign-in log, and the
# privacy page promises that log does not outlive 30 days.
RETENTION = timedelta(days=30)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(dt: datetime | None) -> datetime | None:
    """A DateTime column reads back NAIVE from SQLite and Postgres alike, so
    comparing one against an aware clock raises TypeError — users.py:78-83
    learned that inside a try, where it looked like a check that never fired."""
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def naive_utc(dt: datetime) -> datetime:
    """The form a SQL comparison against those naive columns needs — the
    `db.sightings` / `db.history` precedent."""
    return dt.astimezone(timezone.utc).replace(tzinfo=None) if dt.tzinfo is not None else dt


def token_hash(raw: str) -> str:
    """How a session or mailed token is stored: sha256, hex. A random 256-bit
    secret needs no salt and no work factor — nothing about it is guessable."""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# --- keys --------------------------------------------------------------------
def auth_key() -> bytes:
    """The server secret every auth HMAC is keyed with (Phase 29 amendment A6)."""
    s = get_settings()
    secret = s.auth_secret or s.cron_secret or s.app_access_code or "dev-only"
    return hashlib.sha256(("jf-auth|" + secret).encode("utf-8")).digest()


def hkey(*parts: str) -> str:
    """HMAC-SHA256(auth_key, parts), 32 hex characters.

    Never a plain sha256: there are only 2**32 IPv4 addresses, so an unkeyed
    hash of one is a lookup table away from the address itself.
    """
    return hmac.new(auth_key(), "|".join(parts).encode("utf-8"), hashlib.sha256).hexdigest()[:32]


# --- the request ---------------------------------------------------------------
def client_ip(request: Request) -> str:
    """The caller's address, from the one source that cannot be forged here.

    On Vercel (the `VERCEL` env var is set on every function) the edge
    OVERWRITES x-forwarded-for with the real client, so its first hop is the
    truth. Anywhere else — uvicorn directly, the Vite proxy, any other host —
    that header is whatever the client chose to send, and trusting it would hand
    every per-IP throttle to anyone who sends a fresh value per request. There
    it is ignored.
    """
    if os.environ.get("VERCEL"):
        first = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        if first:
            return first
    return request.client.host if request.client else ""


def ip_bucket(ip: str) -> str:
    """The unit a per-IP limit counts in. IPv6 collapses to its /64, because a
    single subscriber is handed the whole /64 — 2**64 addresses — and a limit
    per address would be a limit per request. Anything unparseable is used
    as-is (TestClient's "testclient", say)."""
    raw = (ip or "").strip()
    try:
        addr = ipaddress.ip_address(raw.split("%")[0])
    except ValueError:
        return raw
    if addr.version == 6 and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    if addr.version == 6:
        return str(ipaddress.ip_network(f"{addr}/64", strict=False))
    return str(addr)


def ip_hint(ip: str) -> str:
    """A deliberately coarse label for a session row (FIXB B19): the /24 of an
    IPv4 address as "a.b.c.x", the /48 of an IPv6 one, "" for anything that is
    not an address. Never the full address, and the row itself is deleted 30
    days after the session ends (`prune_sessions`, run on sign-in AND by the
    inbox cron)."""
    try:
        addr = ipaddress.ip_address((ip or "").strip().split("%")[0])
    except ValueError:
        return ""
    if addr.version == 6 and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    if addr.version == 4:
        a, b, c = str(addr).split(".")[:3]
        return f"{a}.{b}.{c}.x"
    groups = addr.exploded.split(":")
    return f"{groups[0]}:{groups[1]}:{groups[2]}::/48"


def is_https(request: Request) -> bool:
    """The first x-forwarded-proto hop when a proxy set one (Vercel's edge
    terminates TLS, so the function itself sees plain http), else the scheme.
    A client forging this can only make its own cookie Secure."""
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    if proto:
        return proto == "https"
    return request.url.scheme == "https"


def cookie_path(request: Request) -> str:
    """The Path the browser sends the cookie back on.

    `root_path` is "/api" under Vercel's mount (vercel_app.py) and "" when this
    app is served directly — uvicorn behind the Vite proxy, or the smoke
    TestClient — so the one expression is right in all three, and the smoke
    client gets its cookie back without pretending to be https.
    """
    return request.scope.get("root_path") or "/"


def session_ttl(s: Settings) -> timedelta:
    return timedelta(days=max(1, min(s.session_ttl_days, s.session_max_days)))


def set_session_cookie(
    response: Response, request: Request, raw: str, expires_at: datetime | None = None
) -> None:
    """Hand the browser its session. `expires_at` re-issues a renewed session
    with a lifetime that matches the row; omitted, the cookie lives one TTL."""
    if expires_at is None:
        max_age = int(session_ttl(get_settings()).total_seconds())
    else:
        max_age = max(0, int((as_utc(expires_at) - utc_now()).total_seconds()))
    response.set_cookie(
        COOKIE_NAME,
        raw,
        max_age=max_age,
        path=cookie_path(request),
        secure=is_https(request),
        httponly=True,
        samesite="lax",
    )


def clear_session_cookie(response: Response, request: Request) -> None:
    response.delete_cookie(
        COOKIE_NAME,
        path=cookie_path(request),
        secure=is_https(request),
        httponly=True,
        samesite="lax",
    )


def safe_next(value: str | None, base: str | None = None) -> str:
    """Where to send someone after signing in: `value` if it provably stays on
    this app, otherwise "/app" (Phase 29 amendment A5).

    "Starts with / but not //" is NOT enough, and each extra rule is a way that
    test lies. Browsers read a backslash as a slash, so `/\\evil.com` leaves the
    site; they strip tab/CR/LF from URLs, so `/\\t/evil.com` does too; and a
    percent-encoded one (`/%09/evil.com`) survives a naive check until something
    decodes it. So the rules run over the value AND each decoding of it, and the
    survivor must still resolve to the app's own origin. The frontend runs the
    same rules against `location.origin`.

    A "." or ".." PATH SEGMENT is refused too (FIXB B6): a browser removes dot
    segments before it reads the path, so `/.//evil.com` and `/app/..//evil.com`
    both become `//evil.com`, a protocol-relative URL, the moment anything
    normalises them. Python's urljoin does not agree with browsers on every
    such case (`/..//evil.com`), so the test is the segment itself, not a
    resolution. No real in-app destination contains one; a dot inside a
    segment, a query or a fragment is untouched.
    """
    fallback = "/app"
    candidate = value or ""
    if not candidate:
        return fallback
    forms = [candidate]
    current = candidate
    for _ in range(3):
        decoded = unquote(current)
        if decoded == current:
            break
        forms.append(decoded)
        current = decoded
    for form in forms:
        if "\\" in form or any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in form):
            return fallback
        if not form.startswith("/") or form.startswith("//"):
            return fallback
        path = form.split("?", 1)[0].split("#", 1)[0]
        if any(segment in (".", "..") for segment in path.split("/")):
            return fallback
    origin = (base if base is not None else get_settings().app_base_url) or "http://x"
    expected = urlsplit(origin)
    resolved = urlsplit(urljoin(origin, candidate))
    if (resolved.scheme, resolved.netloc) != (expected.scheme, expected.netloc):
        return fallback
    return candidate


# --- the session lifecycle -----------------------------------------------------
class ResolvedSession(NamedTuple):
    user_id: int
    session_id: int
    # Set when THIS call slid the expiry forward, so the gate can re-issue the
    # cookie with a matching lifetime — without that the browser drops the
    # cookie one TTL after sign-in and the sliding renewal is decorative.
    renewed_until: datetime | None


def prune_sessions(db: Session, now: datetime | None = None) -> None:
    """Delete session rows revoked or expired more than RETENTION ago. Run on
    the write path (sign-in) AND by the inbox cron (FIXB B19,
    `auth_throttle.prune_security_log`): on an instance nobody signs in to, the
    write path alone would keep a device string and a network prefix for ever."""
    cutoff = naive_utc((now or utc_now()) - RETENTION)
    db.execute(
        delete(AuthSession)
        .where(or_(AuthSession.revoked_at < cutoff, AuthSession.expires_at < cutoff))
        .execution_options(synchronize_session=False)
    )


def create_session(
    db: Session, user_id: int, request: Request | None = None, now: datetime | None = None
) -> str:
    """Mint a session and return its RAW token — the only moment the token
    exists outside the cookie. Adds the row without committing, so a signup's
    user, login, token and session land in one transaction."""
    now = now or utc_now()
    prune_sessions(db, now)
    raw = secrets.token_urlsafe(32)
    agent = request.headers.get("user-agent", "") if request is not None else ""
    address = client_ip(request) if request is not None else ""
    db.add(
        AuthSession(
            user_id=user_id,
            token_hash=token_hash(raw),
            created_at=now,
            last_used_at=now,
            expires_at=now + session_ttl(get_settings()),
            user_agent=agent[:255],
            ip_hint=ip_hint(address),
        )
    )
    return raw


def resolve_session(db: Session, raw: str, now: datetime | None = None) -> ResolvedSession | None:
    """The live session behind a cookie, or None (unknown, revoked, expired, or
    its user deactivated). Slides a due session forward as a side effect.

    The renewal is best-effort and never raises — a failed bookkeeping write
    must not turn a valid session into a 500 — and it commits, which expires
    every attribute of every instance in `db`: callers read what they need
    AFTER this returns, inside the same session (see the gate).
    """
    if not raw or len(raw) > 128:
        return None
    now = now or utc_now()
    row = db.execute(
        select(AuthSession).where(AuthSession.token_hash == token_hash(raw))
    ).scalars().first()
    if row is None or row.revoked_at is not None or as_utc(row.expires_at) <= now:
        return None
    user = db.get(User, row.user_id)
    if user is None or not user.is_active:
        return None
    user_id, session_id = row.user_id, row.id
    renewed: datetime | None = None
    last = as_utc(row.last_used_at)
    if last is None or now - last >= RENEW_EVERY:
        s = get_settings()
        created = as_utc(row.created_at) or now
        until = min(created + timedelta(days=max(1, s.session_max_days)), now + session_ttl(s))
        try:
            extend = until > as_utc(row.expires_at)
            row.last_used_at = now
            if extend:
                row.expires_at = until
            db.commit()
            renewed = until if extend else None
        except Exception:  # noqa: BLE001 - the session is valid whether or not its renewal wrote
            db.rollback()
            renewed = None
    return ResolvedSession(user_id, session_id, renewed)


def revoke_session(db: Session, session_id: int | None, now: datetime | None = None) -> None:
    if session_id is None:
        return
    db.execute(
        update(AuthSession)
        .where(AuthSession.id == session_id, AuthSession.revoked_at.is_(None))
        .values(revoked_at=now or utc_now())
        .execution_options(synchronize_session=False)
    )


def revoke_all(
    db: Session, user_id: int, except_id: int | None = None, now: datetime | None = None
) -> int:
    """Revoke every live session of a user, optionally sparing one (the caller's
    own). Returns how many were live. Does not commit."""
    query = update(AuthSession).where(
        AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None)
    )
    if except_id is not None:
        query = query.where(AuthSession.id != except_id)
    result = db.execute(
        query.values(revoked_at=now or utc_now()).execution_options(synchronize_session=False)
    )
    return result.rowcount or 0
