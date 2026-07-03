"""Persistence helpers for the LinkedIn job-search history (job_search_hits)."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db.models import JobSearchHit
from app.models import JobMatch

MAX_HISTORY = 100  # newest rows kept; older ones are trimmed on every record


def record_search_hits(db: Session, matches: list[JobMatch]) -> None:
    """Upsert scraped matches into history (deduped by URL), then trim to MAX_HISTORY."""
    now = datetime.now(timezone.utc)
    pending: dict[str, JobSearchHit] = {}  # dedupe within this batch (session has autoflush=False)
    for m in matches:
        if not m.url:
            continue  # pasted listings have no URL to dedupe/re-open by
        row = pending.get(m.url) or db.execute(
            select(JobSearchHit).where(JobSearchHit.url == m.url)
        ).scalars().first()
        if row is None:
            row = JobSearchHit(url=m.url)
            db.add(row)
        pending[m.url] = row
        row.title = m.title
        row.company = m.company
        row.location = m.location
        row.overall = m.overall
        row.keyword_coverage = m.keyword_coverage
        row.fit_score = m.fit_score
        row.top_gaps_json = json.dumps(m.top_gaps)
        row.jd_text = m.jd_text
        row.searched_at = now
    db.flush()
    keep_ids = db.execute(
        select(JobSearchHit.id)
        .order_by(JobSearchHit.searched_at.desc(), JobSearchHit.id.desc())
        .limit(MAX_HISTORY)
    ).scalars().all()
    db.execute(delete(JobSearchHit).where(JobSearchHit.id.not_in(keep_ids)))
    db.commit()


def list_search_hits(db: Session) -> list[JobSearchHit]:
    """Newest-first history, at most MAX_HISTORY rows."""
    return list(
        db.execute(
            select(JobSearchHit)
            .order_by(JobSearchHit.searched_at.desc(), JobSearchHit.id.desc())
            .limit(MAX_HISTORY)
        ).scalars().all()
    )


def delete_search_hit(db: Session, hit_id: int) -> bool:
    row = db.get(JobSearchHit, hit_id)
    if not row:
        return False
    db.delete(row)
    db.commit()
    return True


def clear_search_hits(db: Session) -> int:
    deleted = db.execute(delete(JobSearchHit)).rowcount or 0
    db.commit()
    return deleted
