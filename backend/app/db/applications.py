"""Reads over a user's tracker rows that more than one writer needs.

`routes.create_application` and `kits.approve_kit` both write a tracked job, and
both must find the row a posting already has instead of adding a second one
(PLAN 31.1/5 and 31.4: one posting, one tracker row). The job page (PLAN 31.4)
also asks which undecided kit is on its way to a row's posting, and which
approved kit Comeet may still send it with.
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


def draft_guard_clean(app: Application) -> bool:
    """Whether the draft on this row has a clean fabrication-guard reading NOW.

    Exactly 0, never None: a draft typed on after the tailor stores an unknown
    count (PLAN 31.3/4), and unknown is never clean. The count is the row's
    CURRENT one, because a kit's approval is not the last word on the row's
    draft: since PLAN 31.4/4 the job's page re-tailors onto the same row, and
    the document writes every typed line to it."""
    return app.fabrication_flag_count == 0


def sendable_kit(db: Session, user_id: int, app: Application) -> TailorKit | None:
    """The kit this row was approved from, while Comeet's apply API may still
    send the row's draft with it (PLAN 8.4, offered on the job's page since
    31.4/5), or None.

    The same conditions `auto_submit.submit_kit` refuses on before it reaches
    the network: approved and not yet sent, a Comeet posting, no flags on the
    kit, and the row's own draft still clean (`draft_guard_clean`). The
    per-company dedupe, the reCAPTCHA check and the daily cap stay the send's
    alone, and each answers with a sentence of its own."""
    if not draft_guard_clean(app):
        return None
    kits = db.execute(
        select(TailorKit)
        .where(
            TailorKit.user_id == user_id,
            TailorKit.application_id == app.id,
            TailorKit.status == "approved",
            TailorKit.source == "comeet",
        )
        .order_by(TailorKit.id.desc())
    ).scalars().all()
    return next((k for k in kits if (k.flag_count or 0) == 0), None)
