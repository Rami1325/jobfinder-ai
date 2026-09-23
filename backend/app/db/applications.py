"""Reads over a user's tracker rows that more than one writer needs.

`routes.create_application` and `kits.approve_kit` both write a tracked job, and
both must find the row a posting already has instead of adding a second one
(PLAN 31.1/5 and 31.4: one posting, one tracker row). The job page (PLAN 31.4)
also asks which undecided kit is on its way to a row's posting.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Application, TailorKit

# A kit nobody has decided on yet: waiting to run, running, or done and waiting
# for review. An approved, rejected or submitted kit is decided; a failed one is
# refunded and listed where kits are, never offered as a draft on the way.
PENDING_KIT_STATUSES = ("queued", "running", "done")


def tracked_job(db: Session, user_id: int, job_url: str) -> Application | None:
    """This user's newest tracker row for exactly this posting URL, or None.

    Exact, trimmed match only. A URL is the one identity a saved job, its
    tailor handoff and its save all carry unchanged; anything looser (title and
    company, a normalised LinkedIn host) could merge two real applications."""
    url = (job_url or "").strip()
    if not url:
        return None
    return db.execute(
        select(Application)
        .where(Application.user_id == user_id, Application.job_url == url)
        .order_by(Application.id.desc())
    ).scalars().first()


def pending_kit(db: Session, user_id: int, job_url: str) -> TailorKit | None:
    """This user's newest undecided kit for exactly this posting URL, or None.

    Matched by URL, the same identity `tracked_job` uses: a kit links to its
    row only once it is approved (`TailorKit.application_id`), which is exactly
    when it stops being pending."""
    url = (job_url or "").strip()
    if not url:
        return None
    return db.execute(
        select(TailorKit)
        .where(
            TailorKit.user_id == user_id,
            TailorKit.url == url,
            TailorKit.status.in_(PENDING_KIT_STATUSES),
        )
        .order_by(TailorKit.id.desc())
    ).scalars().first()
