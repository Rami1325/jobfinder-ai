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


def check_and_count(db: Session, user: User, action: str, cap: int) -> None:
    """Count one use of `action` for `user` today; 429 once the cap is hit.

    The attempt is counted before the action runs (simple, and a crashed run
    still consumed an LLM call or scrape budget)."""
    if user.is_admin or cap <= 0:
        return
    day = _today()
    row = db.execute(
        select(UsageLog).where(
            UsageLog.user_id == user.id, UsageLog.action == action, UsageLog.day == day
        )
    ).scalars().first()
    if row is not None and row.count >= cap:
        raise HTTPException(
            429, detail={"code": "daily_limit", "action": action, "cap": cap}
        )
    if row is None:
        row = UsageLog(user_id=user.id, action=action, day=day, count=0)
        db.add(row)
    row.count += 1
    db.commit()
