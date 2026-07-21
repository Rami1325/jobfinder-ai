"""Job alerts: re-run the saved search, diff against history, email new hits.

The schedule lives outside (Vercel cron hits GET /jobs/alerts/cron daily; the
UI has a manual "Run now"). "New" means the job's URL wasn't in the user's
`job_search_hits` before this run — the same table the History tab shows, so
an alert never emails a job the user has already seen in the app. History is
capped at 100 rows per user, so a very old posting can resurface as "new";
acceptable.

Per-user since PLAN 7.3: one settings row per user, and the daily cron
iterates every enabled row (`run_all_alerts`). `run_alert` takes the search
function as a parameter so the offline smoke test can exercise the whole flow
(diffing, recording, settings bookkeeping) with a canned search result — no
network, no LLM.
"""
from __future__ import annotations

import html as html_lib
from datetime import datetime, timezone
from typing import Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core import mailer
from app.core.job_search import resume_hash, search_jobs
from app.db.history import load_score_cache, record_search_hits
from app.db.models import JobAlert, JobSearchHit, SavedResume, User
from app.models import (
    AlertRunResult,
    JobMatch,
    JobSearchResult,
    ResumeModel,
    SearchContext,
)


def get_alert(db: Session, user_id: int) -> JobAlert:
    """The user's settings row, created on first access."""
    row = db.execute(
        select(JobAlert).where(JobAlert.user_id == user_id).order_by(JobAlert.id)
    ).scalars().first()
    if row is None:
        row = JobAlert(user_id=user_id)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def update_alert(
    db: Session,
    user_id: int,
    *,
    enabled: bool,
    email: str,
    context: SearchContext | None,
    nudge_emails: bool = False,
) -> JobAlert:
    row = get_alert(db, user_id)
    row.enabled = enabled
    row.email = email.strip()
    row.context_json = context.model_dump_json() if context else ""
    row.nudge_emails = nudge_emails
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


def split_new_matches(db: Session, matches: list[JobMatch], user_id: int) -> list[JobMatch]:
    """Matches whose URL isn't in the user's search history yet (call BEFORE recording)."""
    urls = [m.url for m in matches if m.url]
    if not urls:
        return []
    seen = set(
        db.execute(
            select(JobSearchHit.url).where(
                JobSearchHit.url.in_(urls), JobSearchHit.user_id == user_id
            )
        ).scalars().all()
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
        if m.stale and m.posted_at:
            bits.append(f"(older posting — {m.posted_at[:10]})")
        lines.append("• " + " ".join(bits))
        if m.url:
            lines.append(f"  {m.url}")
    lines += ["", "Sent by your JobFinder job alert. Manage it on the Jobs page."]
    return subject, "\n".join(lines)


# Email-safe rendering of the site's dark theme (frontend/src/styles.css
# :root tokens). Email clients need literal colors + inline styles + tables.
_EM = {
    "bg": "#0c1019",  # --bg-soft
    "panel": "#18202f",  # --panel
    "panel2": "#1f2a3d",  # --panel-2
    "line": "#2b3850",  # --line
    "ink": "#e6ecf5",  # --ink
    "muted": "#9aa7bd",  # --ink-muted
    "faint": "#6b7891",  # --ink-faint
    "accent": "#4f8cff",  # --accent
    "accent_soft": "#6ea0ff",  # --accent-soft
    "mint": "#2bd4a0",  # --mint
}
_EM_FONT = "'Segoe UI', system-ui, -apple-system, sans-serif"
_EM_SOURCE_LABELS = {
    "linkedin": "LinkedIn",
    "drushim": "Drushim",
    "comeet": "Comeet",
    "jobmaster": "JobMaster",
    "jooble": "Jooble",
}


def _fit_pill(overall: float) -> str:
    """Score pill colored like the site's fit tiers (mint / blue / gray)."""
    pct = round(overall)
    if pct >= 60:
        bg, fg, border = "#14332b", _EM["mint"], "#1f5c48"
    elif pct >= 35:
        bg, fg, border = "#16253f", _EM["accent_soft"], "#28457a"
    else:
        bg, fg, border = _EM["panel2"], _EM["muted"], _EM["line"]
    return (
        f'<span style="display:inline-block;padding:5px 12px;border-radius:999px;'
        f"background:{bg};border:1px solid {border};color:{fg};"
        f'font:600 13px {_EM_FONT};white-space:nowrap;">{pct}% fit</span>'
    )


def _job_card_html(m: JobMatch) -> str:
    esc = html_lib.escape
    title = esc(m.title or "Untitled role")
    if m.url:
        title = (
            f'<a href="{esc(m.url, quote=True)}" style="color:{_EM["ink"]};'
            f'text-decoration:none;">{title}</a>'
        )
    sub_bits = [esc(b) for b in (m.company, m.location) if b]
    source = _EM_SOURCE_LABELS.get(m.source, m.source.capitalize()) if m.source else ""
    chips = (
        f'<span style="display:inline-block;padding:3px 10px;border-radius:999px;'
        f"background:{_EM['panel2']};color:{_EM['muted']};"
        f'font:600 11px {_EM_FONT};letter-spacing:.4px;">{esc(source)}</span>'
        if source
        else ""
    )
    # Old-but-relevant backfill (PLAN 15.6): amber chip with the post date so
    # an older posting is never mistaken for a fresh one.
    if m.stale and m.posted_at:
        chips += (
            f'{" " if chips else ""}<span style="display:inline-block;padding:3px 10px;'
            f'border-radius:999px;background:#3a2f18;border:1px solid #6b5527;'
            f'color:#ffc96b;font:600 11px {_EM_FONT};letter-spacing:.4px;">'
            f"Older posting &#183; {esc(m.posted_at[:10])}</span>"
        )
    view = (
        f'<a href="{esc(m.url, quote=True)}" style="color:{_EM["accent_soft"]};'
        f'font:600 13px {_EM_FONT};text-decoration:none;">View job &#8594;</a>'
        if m.url
        else ""
    )
    sub_row = (
        f'<div dir="auto" style="padding-top:4px;color:{_EM["muted"]};'
        f'font:13px {_EM_FONT};">{" &#183; ".join(sub_bits)}</div>'
        if sub_bits
        else ""
    )
    return f"""
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
       style="background:{_EM['panel']};border:1px solid {_EM['line']};border-radius:14px;">
  <tr>
    <td style="padding:18px 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td dir="auto" style="color:{_EM['ink']};font:600 16px {_EM_FONT};">{title}</td>
          <td align="right" valign="top" style="padding-left:12px;">{_fit_pill(m.overall)}</td>
        </tr>
      </table>
      {sub_row}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding-top:12px;">
        <tr>
          <td>{chips}</td>
          <td align="right">{view}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
<div style="height:12px;line-height:12px;">&nbsp;</div>"""


def build_alert_email_html(new: list[JobMatch], ctx: SearchContext, app_url: str = "") -> str:
    """HTML alternative for the alert email, themed like the app's dark UI.
    Pure — smoke-pinned. Inline styles + tables only (email-client-safe);
    every dynamic string is escaped; Hebrew titles get dir="auto"."""
    esc = html_lib.escape
    where = f" in {ctx.location}" if ctx.location.strip() else ""
    n = len(new)
    headline = f"{n} new job{'s' if n != 1 else ''}"
    search_desc = esc(f"{ctx.job_title}{where}")
    cards = "".join(_job_card_html(m) for m in new)
    manage = (
        f' &#183; <a href="{esc(app_url.rstrip("/"), quote=True)}/jobs" '
        f'style="color:{_EM["accent_soft"]};text-decoration:none;">Manage alerts</a>'
        if app_url.strip()
        else " on the Jobs page."
    )
    return f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
</head>
<body style="margin:0;padding:0;background:{_EM['bg']};" bgcolor="{_EM['bg']}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{_EM['bg']};">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">
        <tr>
          <td style="padding:0 4px 18px;">
            <span style="font:700 20px {_EM_FONT};color:{_EM['ink']};">Job<span
              style="color:{_EM['accent']};">Finder</span></span>
          </td>
        </tr>
        <tr>
          <td style="border-radius:14px;background:linear-gradient(135deg,{_EM['accent']},{_EM['mint']});padding:1px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                   style="background:{_EM['panel']};border-radius:13px;">
              <tr>
                <td style="padding:22px 24px;">
                  <div style="color:{_EM['ink']};font:700 24px {_EM_FONT};">{headline}</div>
                  <div dir="auto" style="padding-top:6px;color:{_EM['muted']};font:14px {_EM_FONT};">
                    matched your saved search &#8212; {search_desc}
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr><td style="height:18px;line-height:18px;">&nbsp;</td></tr>
        <tr><td>{cards}</td></tr>
        <tr>
          <td align="center" style="padding:10px 4px 0;color:{_EM['faint']};font:12px {_EM_FONT};">
            Sent by your JobFinder job alert{manage}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>"""


def _master_resume(db: Session, user_id: int) -> ResumeModel | None:
    for row in db.execute(
        select(SavedResume)
        .where(SavedResume.user_id == user_id)
        .order_by(SavedResume.updated_at.desc())
    ).scalars():
        try:
            return ResumeModel.model_validate_json(row.resume_json)
        except Exception:  # noqa: BLE001
            continue
    return None


def run_alert(
    db: Session,
    user_id: int,
    *,
    force: bool = False,
    search_fn: Callable[..., JobSearchResult] = search_jobs,
) -> AlertRunResult:
    """Execute one alert run for one user. `force=True` runs even when the
    toggle is off (the UI's "Run now"). Never raises: failures land in
    `last_error` and the returned result so the cron caller always gets a 200
    with the outcome. `search_fn` is called as
    `search_fn(resume, context, cache=...)` — fakes must accept the kwarg."""
    row = get_alert(db, user_id)
    if not row.enabled and not force:
        return AlertRunResult(ran=False, error="Alerts are disabled.")
    resume = _master_resume(db, user_id)
    if resume is None:
        row.last_error = "No master résumé saved yet."
        db.commit()
        return AlertRunResult(ran=False, error=row.last_error)

    # PLAN 12.4: the daily cron re-surfaces mostly the SAME postings every
    # morning — the score cache turns those into zero-LLM, zero-fetch reuse
    # when the master résumé hasn't changed since they were last scored.
    master_hash = resume_hash(resume)
    try:  # the cache is an optimization — an unreadable history must not kill the run
        cache = load_score_cache(db, user_id, master_hash)
    except Exception:  # noqa: BLE001
        cache = {}

    try:
        result = search_fn(resume, alert_context(row), cache=cache)
        new = split_new_matches(db, result.matches, user_id)
        record_search_hits(db, result.matches, user_id, resume_hash=master_hash)
    except Exception as e:  # noqa: BLE001 - report, don't crash the cron
        row.last_run_at = datetime.now(timezone.utc)
        row.last_error = str(e)[:500]
        db.commit()
        return AlertRunResult(ran=True, error=row.last_error)

    emailed = False
    email_error = ""
    if new and row.email and mailer.smtp_configured():
        subject, body = build_alert_email(new, result.context)
        html = build_alert_email_html(new, result.context, app_url=get_settings().app_base_url)
        try:
            mailer.send_email(row.email, subject, body, html=html)
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


def run_all_alerts(
    db: Session,
    *,
    search_fn: Callable[..., JobSearchResult] = search_jobs,
) -> list[AlertRunResult]:
    """One cron tick (PLAN 7.3): run the alert of every active user whose
    toggle is on. Per-user failures are isolated inside run_alert, so one
    broken alert never blocks the rest."""
    user_ids = db.execute(
        select(JobAlert.user_id)
        .join(User, User.id == JobAlert.user_id)
        .where(JobAlert.enabled.is_(True), User.is_active.is_(True))
        .order_by(JobAlert.user_id)
    ).scalars().all()
    return [run_alert(db, uid, search_fn=search_fn) for uid in user_ids if uid is not None]
