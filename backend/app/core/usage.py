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


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def check_and_count(db: Session, user: User, action: str, cap: int, count: int = 1) -> None:
    """Count `count` uses of `action` for `user` today; 429 if that would
    exceed the cap. Batch callers (kit enqueue, PLAN 8.1) charge the whole
    batch upfront — fail-fast beats discovering the limit mid-batch.

    The attempt is counted before the action runs (simple, and a crashed run
    still consumed an LLM call or scrape budget)."""
    if user.is_admin or cap <= 0 or count <= 0:
        return
    day = _today()
    row = db.execute(
        select(UsageLog).where(
            UsageLog.user_id == user.id, UsageLog.action == action, UsageLog.day == day
        )
    ).scalars().first()
    if (row.count if row else 0) + count > cap:
        raise HTTPException(
            429, detail={"code": "daily_limit", "action": action, "cap": cap}
        )
    if row is None:
        row = UsageLog(user_id=user.id, action=action, day=day, count=0)
        db.add(row)
    row.count += count
    db.commit()
