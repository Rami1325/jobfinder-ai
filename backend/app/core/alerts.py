"""Job alerts: re-run the saved search, diff against history, email new hits.

The schedule lives outside (Vercel cron hits GET /jobs/alerts/cron daily; the
UI has a manual "Run now"). "New" means the job's URL wasn't in
`job_search_hits` before this run — the same table the History tab shows, so
an alert never emails a job the user has already seen in the app. History is
capped at 100 rows, so a very old posting can resurface as "new"; acceptable.

`run_alert` takes the search function as a parameter so the offline smoke
test can exercise the whole flow (diffing, recording, settings bookkeeping)
with a canned search result — no network, no LLM.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import mailer
from app.core.job_search import search_jobs
from app.db.history import record_search_hits
from app.db.models import JobAlert, JobSearchHit, SavedResume
from app.models import (
    AlertRunResult,
    JobMatch,
    JobSearchResult,
    ResumeModel,
    SearchContext,
)


def get_alert(db: Session) -> JobAlert:
    """The single settings row, created on first access."""
    row = db.execute(select(JobAlert).order_by(JobAlert.id)).scalars().first()
    if row is None:
        row = JobAlert()
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def update_alert(
    db: Session, *, enabled: bool, email: str, context: SearchContext | None
) -> JobAlert:
    row = get_alert(db)
    row.enabled = enabled
    row.email = email.strip()
    row.context_json = context.model_dump_json() if context else ""
    db.commit()
    db.refresh(row)
    return row


def alert_context(row: JobAlert) -> SearchContext | None:
    if not row.context_json:
        return None
    try:
        return SearchContext.model_validate_json(row.context_json)
    except Exception:  # noqa: BLE001 - tolerate legacy/corrupt rows
        return None


def split_new_matches(db: Session, matches: list[JobMatch]) -> list[JobMatch]:
    """Matches whose URL isn't in the search history yet (call BEFORE recording)."""
    urls = [m.url for m in matches if m.url]
    if not urls:
        return []
    seen = set(
        db.execute(select(JobSearchHit.url).where(JobSearchHit.url.in_(urls))).scalars().all()
    )
    return [m for m in matches if m.url and m.url not in seen]


def build_alert_email(new: list[JobMatch], ctx: SearchContext) -> tuple[str, str]:
    """(subject, plain-text body) for an alert email. Pure — smoke-pinned."""
    where = f" in {ctx.location}" if ctx.location.strip() else ""
    subject = f"JobFinder: {len(new)} new job{'s' if len(new) != 1 else ''} for {ctx.job_title}{where}"
    lines = [
        f"{len(new)} new job{'s' if len(new) != 1 else ''} matched your saved search "
        f"({ctx.job_title}{where}):",
        "",
    ]
    for m in new:
        bits = [m.title or "Untitled role"]
        if m.company:
            bits.append(f"at {m.company}")
        bits.append(f"— fit {round(m.overall)}%")
        lines.append("• " + " ".join(bits))
        if m.url:
            lines.append(f"  {m.url}")
    lines += ["", "Sent by your JobFinder job alert. Manage it on the Jobs page."]
    return subject, "\n".join(lines)


def _master_resume(db: Session) -> ResumeModel | None:
    for row in db.execute(
        select(SavedResume).order_by(SavedResume.updated_at.desc())
    ).scalars():
        try:
            return ResumeModel.model_validate_json(row.resume_json)
        except Exception:  # noqa: BLE001
            continue
    return None


def run_alert(
    db: Session,
    *,
    force: bool = False,
    search_fn: Callable[[ResumeModel, SearchContext | None], JobSearchResult] = search_jobs,
) -> AlertRunResult:
    """Execute one alert run. `force=True` runs even when the toggle is off
    (the UI's "Run now"). Never raises: failures land in `last_error` and the
    returned result so the cron caller always gets a 200 with the outcome."""
    row = get_alert(db)
    if not row.enabled and not force:
        return AlertRunResult(ran=False, error="Alerts are disabled.")
    resume = _master_resume(db)
    if resume is None:
        row.last_error = "No master résumé saved yet."
        db.commit()
        return AlertRunResult(ran=False, error=row.last_error)

    try:
        result = search_fn(resume, alert_context(row))
        new = split_new_matches(db, result.matches)
        record_search_hits(db, result.matches)
    except Exception as e:  # noqa: BLE001 - report, don't crash the cron
        row.last_run_at = datetime.now(timezone.utc)
        row.last_error = str(e)[:500]
        db.commit()
        return AlertRunResult(ran=True, error=row.last_error)

    emailed = False
    email_error = ""
    if new and row.email and mailer.smtp_configured():
        subject, body = build_alert_email(new, result.context)
        try:
            mailer.send_email(row.email, subject, body)
            emailed = True
        except Exception as e:  # noqa: BLE001
            email_error = f"Email failed: {e}"

    row.last_run_at = datetime.now(timezone.utc)
    row.last_new_count = len(new)
    row.last_error = email_error
    db.commit()
    return AlertRunResult(
        ran=True,
        total=len(result.matches),
        new_count=len(new),
        emailed=emailed,
        error=email_error,
    )
