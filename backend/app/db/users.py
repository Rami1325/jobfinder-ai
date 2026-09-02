"""User helpers for the friends beta (PLAN 7).

Auth model: no signup UI. The admin mints per-friend invite codes; the
existing `X-App-Key` header now resolves to a user row instead of being
compared against a single env value. `APP_ACCESS_CODE` remains the admin's
own code — `ensure_admin` syncs it on startup, so the pre-multi-user
deployment (and the Chrome extension's saved access code) keeps working.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import Application, JobAlert, JobSearchHit, SavedResume, User


def ensure_admin(db: Session) -> User:
    """The admin user (first is_admin row), created on first call.

    When APP_ACCESS_CODE is set it is kept as the admin's invite code (the env
    var stays the source of truth, so rotating it in Vercel rotates the admin
    login). Locally with no access code the gate is off and the placeholder
    code is never checked.
    """
    admin = db.execute(
        select(User).where(User.is_admin.is_(True)).order_by(User.id)
    ).scalars().first()
    code = get_settings().app_access_code
    if admin is None:
        admin = User(
            name="Admin",
            invite_code=code or f"dev-admin-{secrets.token_urlsafe(8)}",
            is_admin=True,
        )
        db.add(admin)
        db.commit()
        db.refresh(admin)
    elif code and admin.invite_code != code:
        admin.invite_code = code
        db.commit()
    return admin


def resolve_user(db: Session, invite_code: str) -> User | None:
    """The active user owning this invite code, or None."""
    if not invite_code:
        return None
    return db.execute(
        select(User).where(User.invite_code == invite_code, User.is_active.is_(True))
    ).scalars().first()


# One page load fires several API calls; without a throttle each is a write to
# Neon. The question this column answers — "did they ever open it, and roughly
# when" — needs nothing finer than this.
SEEN_THROTTLE = timedelta(minutes=5)


def touch_last_seen(db: Session, user: User) -> None:
    """Stamp when this user was last seen. Throttled, and best-effort.

    Called from the access gate rather than from `current_user`, and that
    placement is the point: the gate runs BEFORE routing, so this covers the
    deterministic routes that are deliberately uncapped (and so write no
    `usage_log` row) and even requests to paths that do not exist. Moving it
    into a dependency would silently re-open exactly the blind spot it closes.

    Never raises. Bookkeeping must not turn a served request into an error —
    the `usage.record_tokens` precedent.
    """
    now = datetime.now(timezone.utc)
    last = user.last_seen_at
    if last is not None:
        # The column is a plain `DateTime`, so what was written as aware UTC
        # reads back NAIVE from both SQLite and Postgres. Comparing the two
        # directly raises TypeError — inside a try that would look like a
        # throttle that simply never fires, i.e. a write on every request.
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        if now - last < SEEN_THROTTLE:
            return
    try:
        user.last_seen_at = now
        db.commit()
    except Exception:  # noqa: BLE001 - never fail a request over bookkeeping
        db.rollback()


def mint_user(db: Session, name: str, email: str = "") -> User:
    """Create a friend account with a fresh random invite code."""
    user = User(
        name=name.strip(),
        email=email.strip(),
        invite_code=secrets.token_urlsafe(9),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def backfill_user_ids(db: Session) -> None:
    """Stamp pre-multi-user rows (user_id NULL after the ADD-COLUMN shim) as
    the admin's. Runs on every startup; no-op once everything is stamped."""
    admin = ensure_admin(db)
    for model in (SavedResume, Application, JobSearchHit, JobAlert):
        db.execute(
            update(model).where(model.user_id.is_(None)).values(user_id=admin.id)
        )
    db.commit()
