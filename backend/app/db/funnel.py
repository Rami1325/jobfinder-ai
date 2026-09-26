"""The first time each person reached a step of using the app (PLAN 31.8).

Content-free: a user id, a step name and a time, and nothing else. The owner's
question is whether the new first run helps (PLAN 31.5), and there are no
outside users yet (`jobfinder-beta-adoption`), so the first reader is the owner,
in the admin list on Settings (`GET /admin/funnel`).

The steps, in the order a person meets them. "Signed up" is not stored here: it
is `users.created_at`, which every account already carries.
- `uploaded`: a master resume saved for the first time (`PUT /profile/resume`).
- `searched`: a job search accepted (both search routes, after the caps).
- `tailored`: a tailor accepted (`/tailor`, `/tailor/stream`, after the caps).
- `downloaded`: a Word or PDF download (`/render?download=1`; the previews
  call the same route without it, so they never count).
- `application`: an application saved to the tracker (`POST /applications`),
  in any status: the step is keeping a job, not the Applied column.
- `returned`: a request more than a day and less than a week after signing up,
  stamped in the access gate beside `last_seen_at` (`users.touch_last_seen`),
  because only the gate sees every request.

Every write is the FIRST only (`INSERT … ON CONFLICT DO NOTHING` on the
(user, step) pair), best-effort (bookkeeping may never turn a served request
into an error, `usage.record_tokens`' rule), and on its own commit, so it is
called after the route's own work has committed. Both privacy doors delete a
person's steps: they describe what that person did.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.orm import Session

from app.db.models import FunnelStep

STEPS = ("uploaded", "searched", "tailored", "downloaded", "application", "returned")
# "Came back within 7 days": after the first day, before the eighth.
RETURN_AFTER = timedelta(hours=24)
RETURN_BEFORE = timedelta(days=7)

_TABLE = FunnelStep.__table__


def _insert(dialect: str, user_id: int, step: str, at: datetime):  # noqa: ANN202
    values = dict(user_id=user_id, step=step, at=at.astimezone(timezone.utc).replace(tzinfo=None))
    if dialect == "postgresql":
        return postgresql.insert(_TABLE).values(**values).on_conflict_do_nothing(index_elements=["user_id", "step"])
    if dialect == "sqlite":
        return sqlite.insert(_TABLE).values(**values).on_conflict_do_nothing(index_elements=["user_id", "step"])
    raise ValueError(f"no funnel insert for the {dialect!r} dialect (the app runs on sqlite and postgresql)")


def note(db: Session, user_id: int | None, step: str, now: datetime | None = None) -> None:
    """Record that `user_id` reached `step`, the first time only. Never raises."""
    if not user_id or step not in STEPS:
        return
    try:
        db.execute(_insert(db.get_bind().dialect.name, int(user_id), step, now or datetime.now(timezone.utc)))
        db.commit()
    except Exception:  # noqa: BLE001 - never fail a request over bookkeeping
        db.rollback()


def note_apart(user_id: int | None, step: str) -> None:
    """`note` on a short session of its own: for a stream's worker thread, whose
    request session is already closed. Never raises."""
    from app.db.database import SessionLocal

    try:
        own = SessionLocal()
        try:
            note(own, user_id, step)
        finally:
            own.close()
    except Exception:  # noqa: BLE001 - never fail a request over bookkeeping
        pass


def returned_now(created_at: datetime | None, now: datetime) -> bool:
    """Is a request at `now` a return within the first week of an account made
    at `created_at`? Unknown signup time is never a return."""
    if created_at is None:
        return False
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    age = now - created_at
    return RETURN_AFTER <= age < RETURN_BEFORE
