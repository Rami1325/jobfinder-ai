"""Per-user daily cost caps + usage tracking (PLAN 7.4).

Friends testing = the owner's OpenAI key burning, so the expensive actions
(job search, tailor) are capped per user per UTC day. Admins are exempt and
a cap <= 0 disables it. The 429 carries a structured detail the UI translates
(en+he): {"code": "daily_limit", "action": ..., "cap": ...}.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import UsageLog, User


# Token totals live under a reserved action name so they share the table and the
# per-(user, day) shape without ever colliding with a countable action.
TOKENS_ACTION = "tokens"
# The inbox classifier's spend (Phase 29 / B2), on a row of its own because it
# runs on a different, cheaper model. Folded into "tokens" it would blend two
# price tiers with nothing recording the split — the per-task routing caveat
# CLAUDE.md records — and the tailor's real cost would stop being readable here.
INBOX_TOKENS_ACTION = "inbox_tokens"


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _row_for(db: Session, user_id: int, action: str, day: str) -> UsageLog | None:
    return db.execute(
        select(UsageLog).where(
            UsageLog.user_id == user_id, UsageLog.action == action, UsageLog.day == day
        )
    ).scalars().first()


def record_tokens(
    db: Session, user_id: int, prompt: int, completion: int, action: str = TOKENS_ACTION
) -> None:
    """Add one request's token usage to the user's daily total (PLAN 20.8 / N2).

    Takes a user_id rather than a User because the SSE search records after its
    request session is long closed, where a User instance would be detached.

    `action` names the row: `TOKENS_ACTION` for everything the main model does,
    `INBOX_TOKENS_ACTION` for the inbox classifier's separate model.

    Best-effort by design: accounting must never turn a completed request into
    an error. Admins are counted too — the point here is knowing the real cost,
    which is exactly what the cap exemption hides.
    """
    if prompt <= 0 and completion <= 0:
        return
    try:
        day = _today()
        row = _row_for(db, user_id, action, day)
        if row is None:
            row = UsageLog(user_id=user_id, action=action, day=day, count=0)
            db.add(row)
        row.count += 1  # requests that spent anything
        row.prompt_tokens = (row.prompt_tokens or 0) + max(0, prompt)
        row.completion_tokens = (row.completion_tokens or 0) + max(0, completion)
        db.commit()
    except Exception:  # noqa: BLE001 - never fail a served request over bookkeeping
        db.rollback()


def used_today(db: Session, user_id: int, action: str) -> int:
    """How many uses of `action` this user has been charged today. For a batch
    that would rather charge what is LEFT under a cap than lose the whole batch
    to one 429 (the inbox sync)."""
    row = _row_for(db, user_id, action, _today())
    return int(row.count or 0) if row is not None else 0


def check_and_count(db: Session, user: User, action: str, cap: int, count: int = 1) -> None:
    """Count `count` uses of `action` for `user` today; 429 if that would
    exceed the cap. Batch callers (kit enqueue, PLAN 8.1) charge the whole
    batch upfront — fail-fast beats discovering the limit mid-batch.

    The attempt is counted before the action runs (simple, and a crashed run
    still consumed an LLM call or scrape budget)."""
    if user.is_admin or cap <= 0 or count <= 0:
        return
    day = _today()
    row = _row_for(db, user.id, action, day)
    if (row.count if row else 0) + count > cap:
        raise HTTPException(
            429, detail={"code": "daily_limit", "action": action, "cap": cap}
        )
    if row is None:
        row = UsageLog(user_id=user.id, action=action, day=day, count=0)
        db.add(row)
    row.count += count
    db.commit()
