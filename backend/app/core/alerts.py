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

NEW SINCE THE FIT BAR: "new" is necessary but no longer sufficient. A search
returns up to 25 postings ranked by fit and the alert used to email every unseen
one of them, so a good morning arrived as twenty jobs of which two were worth
opening — the daily mail read as noise and stopped being read. `JobAlert.min_score`
(default 75, 0 = everything) is the bar, and `above_min` applies it to the
already-diffed list.

The bar filters the EMAIL, never the history: `record_search_hits` still records
every match. Two reasons, and both matter. History is what the app's History tab
shows and what `load_score_cache` reads, so skipping the below-bar rows would
make every daily cron re-score them from scratch — the cache exists precisely to
stop that. And a posting hidden from the inbox is still one the user can find in
the app; a posting missing from history is one we deliberately lost.
"""
from __future__ import annotations

import html as html_lib
import time
from datetime import datetime, timezone
from typing import Callable

from sqlalchemy import case, select
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


# Default fit bar for a new (or never-configured) alert. 75 is not a new opinion:
# it is `KIT_DEFAULT_THRESHOLD` in frontend/src/pages/jobs/kits.tsx, the bar the
# batch-tailor card already offers for "worth applying to", so the daily email and
# the batch queue agree about which jobs clear it.
DEFAULT_MIN_SCORE = 75


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
    min_score: int | None = None,
) -> JobAlert:
    """`min_score=None` leaves the fit bar alone — see AlertSettingsIn for why
    that one field is not a full replace like the others."""
    row = get_alert(db, user_id)
    row.enabled = enabled
    row.email = email.strip()
    row.context_json = context.model_dump_json() if context else ""
    row.nudge_emails = nudge_emails
    if min_score is not None:
        row.min_score = max(0, min(100, int(min_score)))
    db.commit()
    db.refresh(row)
    return row


def alert_min_score(row: JobAlert) -> int:
    """The row's fit bar, clamped, with the DEFAULT as the fallback.

    The ADD COLUMN shim backfills existing rows with 75, so a NULL here is not
    expected — the guard is for the paths that could still produce one (a row
    written straight to the DB, a column added by an earlier partial deploy
    without a default). What is deliberate is WHICH way it falls: to the default,
    never to 0. Falling back to 0 turns the bar off, and it would do so for
    exactly the rows that never got a chance to set one — a filter silently
    disabling itself on the rows it knows least about."""
    raw = getattr(row, "min_score", None)
    if raw is None:
        return DEFAULT_MIN_SCORE
    return max(0, min(100, int(raw)))


def above_min(matches: list[JobMatch], min_score: int) -> list[JobMatch]:
    """The subset of `matches` worth an email: fit at or above the bar. Pure —
    smoke-pinned, in BOTH directions (a bar that drops everything is trivially
    "only high-match jobs").

    Compared on `round(m.overall)`, which is the number the email prints and the
    number the app's fit ring shows — not on the raw float. A posting at 74.6
    renders as "75% fit" everywhere the user can see it, so dropping it from a
    75%-bar email would have the History tab contradicting the email footer about
    the same job. One matcher, one answer, applied to the displayed value.

    `overall` is the blend the search ranks by and both email bodies print, so
    the bar is stated in the same currency the user is already reading.
    """
    if min_score <= 0:
        return list(matches)
    return [m for m in matches if round(m.overall) >= min_score]


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


def _bar_note(min_score: int) -> str:
    """One sentence naming the bar, or "" when there isn't one.

    States the RULE, never a held-back count. The geo work settled this for the
    alert email already: "a number you cannot tap to reveal is a dead end in an
    inbox". "9 more were below your bar" is exactly that — it invites a question
    the email cannot answer. The rule is different: it explains why the list is
    short and says where to change it, and the postings themselves are one tap
    away in the app either way.
    """
    if min_score <= 0:
        return ""
    return f"Only jobs at {min_score}% fit or above — the rest are in your search history."


def build_alert_email(
    new: list[JobMatch], ctx: SearchContext, min_score: int = 0
) -> tuple[str, str]:
    """(subject, plain-text body) for an alert email. Pure — smoke-pinned.

    `new` is already filtered by the caller (`run_alert`), so every count here
    describes what the reader can actually see; `min_score` only names the bar in
    the footer. Keeping the filter OUT of the builders is what lets both bodies
    stay pure functions of the list they render.
    """
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
        if m.geo_restriction is not None:
            bits.append("(states a location requirement)")
        lines.append("• " + " ".join(bits))
        if m.url:
            lines.append(f"  {m.url}")
    lines += [""]
    if note := _bar_note(min_score):
        lines += [note]
    lines += ["Sent by your JobFinder job alert. Manage it on the Jobs page."]
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
    # Tier-2 geo note (PLAN geo): Tier-1 restrictions never reach an alert at
    # all — they are filtered before a JobMatch exists, so the cron cannot email
    # one or burn one of the newest-100 history slots on it. This chip carries
    # the weaker signal, which is a label and never a filter. The email
    # deliberately gets NO filtered COUNT: a number you cannot tap to reveal is
    # a dead end in an inbox.
    if m.geo_restriction is not None:
        chips += (
            f'{" " if chips else ""}<span style="display:inline-block;padding:3px 10px;'
            f'border-radius:999px;background:#3a2f18;border:1px solid #6b5527;'
            f'color:#ffc96b;font:600 11px {_EM_FONT};letter-spacing:.4px;">'
            f"Location requirement</span>"
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


def build_alert_email_html(
    new: list[JobMatch], ctx: SearchContext, app_url: str = "", min_score: int = 0
) -> str:
    """HTML alternative for the alert email, themed like the app's dark UI.
    Pure — smoke-pinned. Inline styles + tables only (email-client-safe);
    every dynamic string is escaped; Hebrew titles get dir="auto".

    Like the plain-text twin, `new` arrives already filtered and `min_score` only
    names the bar in the footer."""
    esc = html_lib.escape
    where = f" in {ctx.location}" if ctx.location.strip() else ""
    n = len(new)
    headline = f"{n} new job{'s' if n != 1 else ''}"
    search_desc = esc(f"{ctx.job_title}{where}")
    cards = "".join(_job_card_html(m) for m in new)
    bar = _bar_note(min_score)
    bar_row = (
        f'<div style="padding-bottom:6px;">{esc(bar)}</div>' if bar else ""
    )
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
            {bar_row}Sent by your JobFinder job alert{manage}
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
        return AlertRunResult(user_id=user_id, ran=False, error="Alerts are disabled.")
    resume = _master_resume(db, user_id)
    if resume is None:
        row.last_error = "No master résumé saved yet."
        db.commit()
        return AlertRunResult(user_id=user_id, ran=False, error=row.last_error)

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
        return AlertRunResult(user_id=user_id, ran=True, error=row.last_error)

    # The bar, applied AFTER record_search_hits above: below-bar postings are
    # kept out of the inbox and kept in the history the app reads and the score
    # cache reuses. `new` stays the diff's answer ("never seen before") and
    # `worth` is the email's ("...and worth your morning") — two questions, two
    # numbers, because a run that finds 12 and emails 3 must not look like a run
    # that found 3.
    min_score = alert_min_score(row)
    worth = above_min(new, min_score)

    emailed = False
    email_error = ""
    if worth and row.email and mailer.smtp_configured():
        subject, body = build_alert_email(worth, result.context, min_score)
        html = build_alert_email_html(
            worth, result.context, app_url=get_settings().app_base_url, min_score=min_score
        )
        try:
            mailer.send_email(row.email, subject, body, html=html)
            emailed = True
        except Exception as e:  # noqa: BLE001
            email_error = f"Email failed: {e}"

    row.last_run_at = datetime.now(timezone.utc)
    row.last_new_count = len(new)
    row.last_above_min = len(worth)
    row.last_error = email_error
    db.commit()
    return AlertRunResult(
        user_id=user_id,
        ran=True,
        total=len(result.matches),
        new_count=len(new),
        above_min=len(worth),
        emailed=emailed,
        error=email_error,
    )


def due_user_ids(db: Session) -> list[int]:
    """Enabled alerts, LONGEST-UNRUN FIRST — the rotation that makes the time
    budget in `run_all_alerts` fair.

    NULL `last_run_at` (never run) sorts first, via an explicit CASE rather than
    NULLS FIRST: SQLite puts NULLs first on ASC and Postgres puts them last, so
    relying on the default would silently starve brand-new alerts in production
    while looking correct locally. Pure SQL ordering; smoke-pinned.
    """
    rows = db.execute(
        select(JobAlert.user_id)
        .join(User, User.id == JobAlert.user_id)
        .where(JobAlert.enabled.is_(True), User.is_active.is_(True))
        .order_by(
            case((JobAlert.last_run_at.is_(None), 0), else_=1),
            JobAlert.last_run_at.asc(),
            JobAlert.user_id,
        )
    ).scalars().all()
    return [uid for uid in rows if uid is not None]


def run_all_alerts(
    db: Session,
    *,
    search_fn: Callable[..., JobSearchResult] = search_jobs,
    budget_s: float | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> tuple[list[AlertRunResult], int]:
    """One cron tick (PLAN 7.3): run enabled alerts until the time budget runs
    out. Returns (results, skipped).

    THE BUDGET IS THE POINT (PLAN 20.5/C2). This used to be a list
    comprehension over every enabled user, and one alert is a full multi-board
    fan-out plus up to 25 LLM scoring calls — minutes of work. Vercel kills a
    function at 300s, so past a handful of users the cron simply died partway
    and the users at the end of the list silently never got their alerts. There
    was nothing to notice: no error, no log, just missing email.

    Now it stops cleanly with room to spare and reports what it didn't reach,
    and `due_user_ids` orders longest-unrun first — so whoever got skipped today
    is first in line tomorrow instead of being permanently starved by a stable
    user ordering. Per-user failures stay isolated inside `run_alert`.
    """
    if budget_s is None:
        budget_s = get_settings().alert_cron_budget_s
    user_ids = due_user_ids(db)
    results: list[AlertRunResult] = []
    started = clock()
    for i, uid in enumerate(user_ids):
        # Check BEFORE starting a run, never mid-run: an alert that has already
        # scraped and scored must be allowed to finish and record its history,
        # or the next tick redoes the same work and calls it "new" again.
        if budget_s > 0 and i and clock() - started >= budget_s:
            break
        results.append(run_alert(db, uid, search_fn=search_fn))
    return results, len(user_ids) - len(results)
