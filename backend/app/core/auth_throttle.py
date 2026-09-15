"""Auth throttles, the auth-mail budget and the sign-in security log (Phase 29 / B1).

Counted in the `auth_events` TABLE, never in process memory: on Vercel every
instance has its own memory, so an in-process window is a separate budget per
cold start — a login limit built that way is a limit per instance, i.e. no
limit. (The CV scan's in-process `RateLimiter` was exactly that; Phase 30
deleted it for a per-user daily cap, which is counted in a table too.)

**Write first, then count.** An attempt inserts and commits its event BEFORE it
counts, so parallel requests see each other: a burst of fifty cannot slip fifty
password guesses past a limit of eight by all counting seven at once. An attempt
refused for being over the limit takes its own row back, so hammering a locked
door does not keep it locked for ever; an attempt that SUCCEEDS takes its row
back too (`forget`), so a correct password is never counted as a failure.

**Keys are HMACs** (`sessions.hkey`), never a raw address or email: an unkeyed
hash of an IPv4 address reverses in seconds, and a closed account must not
leave its email behind in plain text. IPv6 counts per /64.

**Keyed on the EMAIL, not the user**, for every limit a closed-and-reopened
account could otherwise reset (Phase 29 amendment A7). Closing an account NULLs
`user_id` on these rows instead of deleting them, so "burn the attempts, close
the account, sign up again with the same address" inherits the same counters.

**Pruned after 30 days**, on write: this table doubles as the sign-in security
log, and the privacy page promises that log does not outlive a month.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import NamedTuple

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.core.sessions import as_utc, hkey, ip_bucket, naive_utc, prune_sessions, utc_now
from app.db.models import AuthEvent

# (limit, window in seconds). Each is the number of attempts ALLOWED in the
# window; the one after the last allowed is refused.
SIGNUP_PER_IP = (5, 3600)
LOGIN_FAIL_PER_EMAIL = (8, 900)
LOGIN_FAIL_PER_IP = (30, 900)
# After this many wrong codes in a day only the emailed LINK verifies: the code
# space is a million, so the ceiling is what makes guessing it hopeless.
VERIFY_FAIL_PER_EMAIL = (30, 86400)
VERIFY_MAIL_COOLDOWN_S = 60
FORGOT_PER_EMAIL = (3, 3600)
FORGOT_PER_IP = (20, 3600)
CHANGE_EMAIL_PER_USER = (5, 3600)
# Continue with Google starts per network (Phase 30 / E2). The callback has NO
# failure throttle: its state and binding cookie are 256-bit, so a limit would
# guard nothing, and it would lock out a whole CGNAT address. Creating an account
# through Google counts on SIGNUP_PER_IP, the same counter as the email door.
GOOGLE_START_PER_IP = (30, 3600)
# Wrong codes tolerated against ONE token; the next attempt is locked out even
# with the right code, and a fresh code (resend) is the way forward.
TOKEN_ATTEMPTS = 5

# The global auth-mail budget. Auth mail rides the owner's own SMTP account —
# the one that also carries the job alerts — and an open signup form is
# otherwise a free way to make that account mail strangers until the provider
# suspends it. Over budget, nothing is sent.
MAIL_GLOBAL_PER_HOUR = 200
# Per ADDRESS, and per PURPOSE (FIXB B4/B5). Verification mail and reset mail
# each have their own hourly allowance, so an unverified squatter's signup and
# resends can never spend the real owner's reset link; a "password changed"
# notice has no per-address allowance at all — only the global cap — so
# anonymous /auth/forgot calls cannot silence it.
MAIL_PER_RECIPIENT_PER_HOUR = 3
MAIL_RESET_PER_RECIPIENT_PER_HOUR = 3
# Resends of an unverified account stop BELOW the verification allowance, so a
# squatter meets a 429 with a countdown, not a free-to-poll 503.
VERIFY_MAIL_PER_EMAIL = (MAIL_PER_RECIPIENT_PER_HOUR - 1, 3600)

RETENTION = timedelta(days=30)


def email_key(email: str) -> str:
    return "em:" + hkey("em", email)


def ip_key(ip: str) -> str:
    return "ip:" + hkey("ip", ip_bucket(ip))


def user_key(user_id: int) -> str:
    return f"u:{user_id}"


class Hit(NamedTuple):
    event_id: int | None  # the row this attempt wrote; None when it was refused
    retry_after: int  # seconds until an attempt can count again; 0 = this one counted


def prune(db: Session, now: datetime | None = None) -> None:
    """Delete events older than RETENTION (no commit)."""
    cutoff = naive_utc((now or utc_now()) - RETENTION)
    db.execute(
        delete(AuthEvent)
        .where(AuthEvent.created_at < cutoff)
        .execution_options(synchronize_session=False)
    )


def prune_security_log(db: Session, now: datetime | None = None) -> None:
    """Delete auth events and ended sessions older than RETENTION, and commit.

    Called by the inbox cron (FIXB B19) as well as on every write, because
    "pruned on write" alone means an instance nobody signs in to keeps its
    security log for ever — the privacy page's 30 days would then only be true
    on a busy day."""
    now = now or utc_now()
    prune(db, now)
    prune_sessions(db, now)
    db.commit()


def record(
    db: Session, kind: str, key: str, user_id: int | None = None, now: datetime | None = None
) -> int:
    """Write one event and commit; returns its id."""
    now = now or utc_now()
    prune(db, now)
    row = AuthEvent(user_id=user_id, kind=kind, key=key, created_at=now)
    db.add(row)
    db.commit()
    return row.id


def forget(db: Session, event_id: int | None) -> None:
    """Take an attempt back — it succeeded, or it was never a guess."""
    if event_id is None:
        return
    db.execute(
        delete(AuthEvent)
        .where(AuthEvent.id == event_id)
        .execution_options(synchronize_session=False)
    )
    db.commit()


def count(
    db: Session, kind: str, key: str | None, window_s: int, now: datetime | None = None
) -> int:
    """Events of `kind` (and `key`, unless None) inside the window."""
    cutoff = naive_utc((now or utc_now()) - timedelta(seconds=window_s))
    query = select(func.count()).select_from(AuthEvent).where(
        AuthEvent.kind == kind, AuthEvent.created_at > cutoff
    )
    if key is not None:
        query = query.where(AuthEvent.key == key)
    return int(db.execute(query).scalar() or 0)


def hit(
    db: Session,
    kind: str,
    key: str,
    limit: int,
    window_s: int,
    *,
    user_id: int | None = None,
    now: datetime | None = None,
) -> Hit:
    """Count one attempt against `limit` per `window_s`, writing it FIRST.

    Over the limit, the attempt's own row is taken back and `retry_after` says
    when enough older attempts will have aged out for the next one to count.
    """
    now = now or utc_now()
    event_id = record(db, kind, key, user_id, now)
    cutoff = naive_utc(now - timedelta(seconds=window_s))
    rows = db.execute(
        select(AuthEvent.id, AuthEvent.created_at)
        .where(AuthEvent.kind == kind, AuthEvent.key == key, AuthEvent.created_at > cutoff)
        .order_by(AuthEvent.created_at, AuthEvent.id)
    ).all()
    if len(rows) <= limit:
        return Hit(event_id, 0)
    forget(db, event_id)
    others = [as_utc(r.created_at) for r in rows if r.id != event_id]
    # Fewer than `limit` must remain for the next attempt to count, so it is
    # the (len - limit)-th oldest of the OTHERS whose expiry frees the slot.
    frees_at = others[len(others) - limit] + timedelta(seconds=window_s)
    return Hit(None, max(1, math.ceil((frees_at - now).total_seconds())))


def cooldown_left(
    db: Session, kind: str, key: str, cooldown_s: int, now: datetime | None = None
) -> int:
    """Seconds until `cooldown_s` has passed since the latest event of this kind and key."""
    now = now or utc_now()
    latest = db.execute(
        select(func.max(AuthEvent.created_at)).where(AuthEvent.kind == kind, AuthEvent.key == key)
    ).scalar()
    if latest is None:
        return 0
    left = (as_utc(latest) + timedelta(seconds=cooldown_s) - now).total_seconds()
    return max(0, math.ceil(left))


def mail_key(to: str, purpose: str = "verify") -> str:
    """The per-address key a mail of this purpose counts under. Every purpose
    records kind "mail", so the GLOBAL budget still counts all of them."""
    if purpose == "reset":
        return "rs:" + hkey("rs", to)
    if purpose == "notice":
        return "nt:" + hkey("nt", to)
    return email_key(to)


def mail_allowed(db: Session, to: str, now: datetime | None = None, purpose: str = "verify") -> bool:
    """Would one more auth mail of this purpose to `to` stay inside its budgets? Read-only.

    `verify` (codes and links) and `reset` each have their own per-address
    allowance; `notice` (a security notice) has none, only the global cap."""
    if count(db, "mail", None, 3600, now) >= MAIL_GLOBAL_PER_HOUR:
        return False
    if purpose == "notice":
        return True
    cap = MAIL_RESET_PER_RECIPIENT_PER_HOUR if purpose == "reset" else MAIL_PER_RECIPIENT_PER_HOUR
    return count(db, "mail", mail_key(to, purpose), 3600, now) < cap


def reserve_mail(
    db: Session, to: str, user_id: int | None = None, now: datetime | None = None, purpose: str = "verify"
) -> bool:
    """Claim one mail from the budget, or say no. A claimed mail counts even if
    the send then fails: a broken SMTP account must not be retried at speed."""
    if not mail_allowed(db, to, now, purpose):
        return False
    record(db, "mail", mail_key(to, purpose), user_id, now)
    return True
