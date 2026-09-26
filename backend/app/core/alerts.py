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

MONTHLY USES (Phase 30 / B6). A scheduled morning costs a free user one use,
reserved before its search, and keeps it only when the morning emails jobs:
nothing above the bar, zero matches, a blank address, no SMTP, a failed send
or a raise all give it back. With no use left the morning is skipped
(`last_skip`), and the alerts card reads paused until the 1st (`pause_state`,
worked out from the pool when the card is read). "Run now" is a search the
user pressed: its route charges one `search` use and passes it in, and the run
keeps it whenever its search completed, because the results are in History.
"""
from __future__ import annotations

import html as html_lib
import logging
import math
import time
import urllib.parse
from datetime import datetime, timezone
from functools import partial
from typing import Callable

from fastapi import HTTPException
from sqlalchemy import case, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core import hidden_jobs, mailer, quota
from app.core.job_search import resume_hash, search_jobs
from app.db.history import load_score_cache, record_search_hits
from app.db.models import JobAlert, JobSearchHit, SavedResume, User
from app.db.sightings import load_sightings, record_sightings
from app.models import (
    AlertRunResult,
    GhostReport,
    GhostSignal,
    JobMatch,
    JobSearchResult,
    ResumeModel,
    SearchContext,
)

logger = logging.getLogger(__name__)


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


def displayed_score(overall: float) -> int:
    """The integer the USER sees for a fit score, everywhere.

    Half-up, matching JavaScript's `Math.round` — which is what `ProgressRing`
    uses and therefore what the fit ring, the job card and the History row all
    show. Python's built-in `round()` is half-to-even, so it disagrees on every
    x.5, and `overall` is stored to one decimal so x.5 is reachable rather than
    hypothetical.

    Anything that thresholds on a fit score the user can read must go through
    this, or the app contradicts itself about one job across two surfaces.
    """
    return math.floor(overall + 0.5)


def above_min(matches: list[JobMatch], min_score: int) -> list[JobMatch]:
    """The subset of `matches` worth an email: fit at or above the bar. Pure —
    smoke-pinned, in BOTH directions (a bar that drops everything is trivially
    "only high-match jobs").

    Compared on `round(m.overall)`, which is the number the email prints and the
    number the app's fit ring shows — not on the raw float. A posting at 74.6
    renders as "75% match" everywhere the user can see it, so dropping it from a
    75%-bar email would have the History tab contradicting the email footer about
    the same job. One matcher, one answer, applied to the displayed value.

    `overall` is the blend the search ranks by and both email bodies print, so
    the bar is stated in the same currency the user is already reading.

    HALF-UP, NOT `round()`. Python's built-in rounds half to EVEN, so
    `round(74.5)` is 74 while the fit ring's `Math.round(74.5)` is 75 — and
    `overall` is stored to one decimal (`round(0.5*cov + 0.5*fit, 1)`), so x.5
    is exactly reachable, e.g. coverage 80.0 with fit 69.0. The docstring above
    promised the email and the visible number agree; on that band they did not,
    and the app painted "75% match" in History under a footer saying the mail
    carried everything at 75% or above. `floor(x + 0.5)` is what JavaScript
    does, and the displayed value is the one both sides must round the same way.
    """
    if min_score <= 0:
        return list(matches)
    return [m for m in matches if displayed_score(m.overall) >= min_score]


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
    return f"Only jobs at {min_score}% match or above — the rest are in your search history."


# Strongest first: `certain` outranks `strong` outranks `weak`. An UNRECOGNISED
# strength sorts LAST, not first — a value this build does not know came from a
# newer classifier, and letting it outrank a `certain` we do understand would
# swap a fact for a guess in the one line the reader sees.
_GHOST_STRENGTH_RANK = {"certain": 0, "strong": 1, "weak": 2}

# Every kind `_ghost_label` can name; the Python twin of cards.tsx GHOST_KINDS.
_GHOST_KINDS = ("closed", "evergreen", "long_open", "reposted")


def _ghost_shown(ghost: GhostReport | None) -> GhostSignal | None:
    """The ONE signal both surfaces draw, or None: `closed or likely`, known
    kinds only, strongest first (the first minimal wins, so ties keep the
    classifier's order) — exactly `cards.tsx::strongestGhostSignal`.

    Known kinds are filtered BEFORE the pick, as on the card. Picking first and
    then finding an unknown kind would print nothing where the card, which
    skips the unknown kind and shows the next known one, prints a line — and
    `_older_chip_date` reads this pick to decide whether the age chip is
    already drawn, so the two surfaces would also disagree about the date."""
    if ghost is None or not (ghost.closed or ghost.likely):
        return None
    known = [s for s in ghost.signals if s.kind in _GHOST_KINDS]
    if not known:
        return None
    return min(known, key=lambda s: _GHOST_STRENGTH_RANK.get(s.strength, len(_GHOST_STRENGTH_RANK)))


def _older_chip_date(m: JobMatch) -> str:
    """The date the "Older posting" chip prints, or "" for no chip. ONE
    definition, read by both email bodies.

    It prints `first_posted_at`, the earliest date a BOARD stated for the role
    (`ghost_signals.earliest_board_date`), so a relisted role reads "older
    posting — 2026-09-07" and not the relist's own date. `posted_at` is the
    fallback for a match from an older backend or a caller that never set the
    field. Never a `first_seen_at` date: that is our own lower bound.

    NEVER TWO AGE CHIPS, exactly as on the Jobs card: when the ghost line shown
    for this posting is `long_open`, it IS the age chip ("Seen for N days"), and
    printing an "Older posting" date beside it would have one line of the email
    argue with the next about how old the posting is."""
    if not m.stale:
        return ""
    shown = _ghost_shown(m.ghost)
    if shown is not None and shown.kind == "long_open":
        return ""
    return (m.first_posted_at or m.posted_at)[:10]


def _ghost_label(ghost: GhostReport | None) -> str:
    """The STRONGEST ghost signal's short label, or "" when there is nothing
    this build can name. Pure.

    ONE definition, read by BOTH email bodies, so the HTML chip and the
    plain-text parenthetical can never describe the same posting differently —
    the "one matcher, one answer" rule applied to the two renderings of one
    email. It is a LABEL, never a verdict: `GhostReport` carries evidence that a
    posting may not be a live vacancy, and none of these four kinds can say it
    isn't.

    `closed` is in the table and cannot occur here, deliberately. A certain
    signal filters the posting before a JobMatch exists (see `_job_card_html`),
    exactly as a Tier-1 geo restriction does, so nothing in an alert email can
    carry it. The row stays because a function that answers for every kind the
    contract defines is safer than one with a hole — and a hole here returns "",
    which is indistinguishable from "no signal".

    An unrecognised `kind` is never printed. Printing `sig.kind` would put a raw
    internal token like `long_open` in someone's inbox, and `sig.raw` is the
    BOARD's own sentence, which is evidence and not a label. It is SKIPPED, and
    the next-strongest known signal is labelled, the way the card does it
    (`_ghost_shown`); until 2026-09-21 a strongest-but-unknown kind returned ""
    here while the card showed the next known signal.
    """
    # `closed or likely` is the threshold, NEVER `signals` being non-empty, and
    # the two are genuinely different: `likely` is >= 1 strong or >= 2 weak, so a
    # posting carrying a single WEAK signal — merely relisted, or 35 days old —
    # has signals and is not likely.
    #
    # This is the one place the email could contradict the app about the same
    # posting, and it did. `cards.tsx::strongestGhostSignal` gates on exactly
    # these two booleans; gating here on the list instead chipped "Relisted" in
    # the inbox for a job whose card showed nothing, so tapping through from the
    # email landed on a posting with no sign of what the email had just claimed.
    # That is the geo section's own lesson — a second surface deciding on a
    # different gate and so contradicting the first about one posting.
    #
    # Note what makes this ONE rule rather than two agreeing ones: `likely` is
    # computed once, in `ghost_signals._report`, and both surfaces only READ it.
    # Neither re-derives the strong/weak arithmetic, so there is no second
    # matcher here to drift. The gate and the pick live in `_ghost_shown`,
    # which `_older_chip_date` reads too, so the ghost chip and the age chip
    # can never be decided off two different signals.
    #
    # `min` returns the FIRST minimal element, so ties fall back to the
    # classifier's own signal order rather than to whatever sorts alphabetically.
    sig = _ghost_shown(ghost)
    if sig is None:
        return ""
    if sig.kind == "closed":
        return "No longer accepting applications"
    if sig.kind == "evergreen":
        return "General application"
    if sig.kind == "reposted":
        return "Relisted"
    if sig.kind == "long_open":
        days = max(0, int(sig.days))
        plural = "" if days == 1 else "s"
        # Two bases, two sentences, because they are two different claims.
        # `first_published` is the BOARD's own stated date; `first_seen` is only
        # a LOWER bound — the day one of our own searches first noticed it, which
        # says nothing about how long it was up before that. Printing "Posted N
        # days ago" off a sighting would attribute to the board a date it never
        # stated. An unknown basis therefore falls to the weaker sentence: the
        # abstaining direction is the one that claims less.
        if sig.basis == "first_published":
            return f"Posted {days} day{plural} ago"
        return f"Seen for {days} day{plural}"
    return ""


def _job_link(m: JobMatch, app_url: str = "") -> str:
    """Where a job in an alert email opens (PLAN 31.4/6): the job IN THE APP,
    through the Jobs page's `?open=<posting>`, which opens the job's own page
    once it is tracked and its History row until then, so the fit, the reasons
    and Tailor are one tap away. The posting itself when no app URL is
    configured, as before, and "" for a match with no URL."""
    if not m.url:
        return ""
    base = app_url.strip().rstrip("/")
    return f"{base}/jobs?open={urllib.parse.quote(m.url, safe='')}" if base else m.url


def build_alert_email(
    new: list[JobMatch], ctx: SearchContext, min_score: int = 0, app_url: str = ""
) -> tuple[str, str]:
    """(subject, plain-text body) for an alert email. Pure — smoke-pinned.

    `new` is already filtered by the caller (`run_alert`), so every count here
    describes what the reader can actually see; `min_score` only names the bar in
    the footer. Keeping the filter OUT of the builders is what lets both bodies
    stay pure functions of the list they render. `app_url` sends every job's
    link into the app (`_job_link`), as the HTML twin's do.
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
        bits.append(f"— match {round(m.overall)}%")
        # The earliest date a board stated, and no chip when a `long_open`
        # ghost line is already the age chip — the HTML twin reads the SAME
        # function, so the two bodies cannot print different dates.
        if older := _older_chip_date(m):
            bits.append(f"(older posting — {older})")
        if m.geo_restriction is not None:
            bits.append("(states a location requirement)")
        # The plain-text twin of the HTML ghost chip, off the SAME label
        # function, so the two bodies of one email cannot say different things
        # about one posting. Lower-cased on the FIRST CHARACTER ONLY: it reads
        # as a sentence fragment beside "(states a location requirement)", and
        # `.lower()` on the whole string would flatten an acronym the day one of
        # these labels carries one.
        if label := _ghost_label(m.ghost):
            bits.append(f"({label[:1].lower()}{label[1:]})")
        lines.append("• " + " ".join(bits))
        if link := _job_link(m, app_url):
            lines.append(f"  {link}")
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
        f'font:600 13px {_EM_FONT};white-space:nowrap;">{pct}% match</span>'
    )


def _job_card_html(m: JobMatch, app_url: str = "") -> str:
    esc = html_lib.escape
    title = esc(m.title or "Untitled role")
    # Both links open the job in the app when an app URL is configured.
    link = _job_link(m, app_url)
    if link:
        title = (
            f'<a href="{esc(link, quote=True)}" style="color:{_EM["ink"]};'
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
    # Older posting (PLAN 15.6): amber chip with the EARLIEST date a board
    # stated for the role, so an older posting is never mistaken for a fresh
    # one and a relist never passes off its own date as the role's
    # (`_older_chip_date`, shared with the plain-text twin).
    if older := _older_chip_date(m):
        chips += (
            f'{" " if chips else ""}<span style="display:inline-block;padding:3px 10px;'
            f'border-radius:999px;background:#3a2f18;border:1px solid #6b5527;'
            f'color:#ffc96b;font:600 11px {_EM_FONT};letter-spacing:.4px;">'
            f"Older posting &#183; {esc(older)}</span>"
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
    # Ghost signals (PLAN 28.5), and the paragraph above applies unchanged one
    # class over: the SOFT signals are the only ones that can reach this chip.
    # A CERTAIN `closed` signal filters the posting before a JobMatch exists, so
    # the cron can no more email a dead posting than it can email a Tier-1 geo
    # restriction — what arrives here is `evergreen` / `long_open` / `reposted`,
    # reasons to SUSPECT the vacancy is not live and never proof that it isn't.
    # Like the geo chip it is a label and never a filter. v1 excludes nothing on
    # a ghost signal because the precision of these rules is unmeasured (PLAN
    # 28.5 buys that number with three real searches read by hand first), and
    # there is deliberately no held-back count and no footer line — a number you
    # cannot tap to reveal is a dead end in an inbox, which is the geo work's own
    # conclusion about this email.
    #
    # `esc` even though every label is our own literal: `days` is interpolated,
    # and the next kind added to `_ghost_label` may well carry a board's words.
    if ghost_label := _ghost_label(m.ghost):
        chips += (
            f'{" " if chips else ""}<span style="display:inline-block;padding:3px 10px;'
            f'border-radius:999px;background:#3a2f18;border:1px solid #6b5527;'
            f'color:#ffc96b;font:600 11px {_EM_FONT};letter-spacing:.4px;">'
            f"{esc(ghost_label)}</span>"
        )
    view = (
        f'<a href="{esc(link, quote=True)}" style="color:{_EM["accent_soft"]};'
        f'font:600 13px {_EM_FONT};text-decoration:none;">View job &#8594;</a>'
        if link
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
    cards = "".join(_job_card_html(m, app_url) for m in new)
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


# The default for `run_alert(send_fn=...)`, resolved when the run sends (see `_resolve_send`).
_DEFAULT_SEND = object()


def _resolve_send(send_fn: object) -> Callable[..., None] | None:
    """What a run sends its mail with, or None when it cannot send.

    The default reads `mailer.send_email` and `mailer.smtp_configured` through the
    MODULE at call time. A binding taken at import would bypass anything that
    patches those two attributes later, which is exactly how the offline suite
    captures an alert email (Part J's checks do it)."""
    if send_fn is _DEFAULT_SEND:
        return mailer.send_email if mailer.smtp_configured() else None
    return send_fn  # type: ignore[return-value]


def _is_monthly_limit(exc: HTTPException) -> bool:
    detail = exc.detail
    return exc.status_code == 429 and isinstance(detail, dict) and detail.get("code") == "monthly_limit"


def _give_back(db: Session, charge: quota.Charge | None) -> None:
    """Refund a run's use; a second call gives nothing (`refund_units` refunds a
    charge at most once). Best effort: bookkeeping may never turn a run into a raise."""
    if charge is None:
        return
    try:
        charge.refund(db)
    except Exception:  # noqa: BLE001 - the run's own outcome is what gets reported
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        logger.warning("alert run: giving back use %s did not complete", charge.event_id, exc_info=True)


def _record_error(db: Session, row: JobAlert, message: str, *, stamp_run: bool, clear_skip: bool) -> None:
    """Write a run's error onto its settings row, best effort: a failing commit
    here must not become the raise `run_alert` promises never to make."""
    try:
        if stamp_run:
            row.last_run_at = datetime.now(timezone.utc)
        if clear_skip:
            row.last_skip = ""
        row.last_error = message[:500]
        db.commit()
    except Exception:  # noqa: BLE001
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


def pause_state(db: Session, user: User, row: JobAlert, *, now: datetime) -> tuple[str, str]:
    """Why the alert is paused right now and when it resumes: ("monthly_limit",
    the 1st of next month as YYYY-MM-DD) for an enabled alert whose owner has a
    monthly limit and no use left this month; otherwise ("", "").

    Worked out from the POOL when the card is read, never from `last_skip`, which
    only records that a morning was skipped. So the card reads paused the moment
    any feature spends the last use, and a new month clears it with no write."""
    if not row.enabled or quota.limit_for(user) is None:
        return "", ""
    usage = quota.snapshot(db, user, now)
    if usage.remaining == 0:
        return "monthly_limit", usage.resets_on
    return "", ""


def run_alert(
    db: Session,
    user_id: int,
    *,
    force: bool = False,
    search_fn: Callable[..., JobSearchResult] = search_jobs,
    charge: quota.Charge | None = None,
    send_fn: object = _DEFAULT_SEND,
    now: datetime | None = None,
) -> AlertRunResult:
    """Execute one alert run for one user. `force=True` runs even when the
    toggle is off (the UI's "Run now"). Never raises: failures land in
    `last_error` and the returned result, so the cron caller always gets a 200
    with the outcome and one user's failure never stops the next. `search_fn` is
    called as `search_fn(resume, context, cache=..., sightings_fn=...)` — fakes
    must accept BOTH kwargs.

    Monthly uses (Phase 30 / B6):

    - With `charge=None` (the cron, and every direct call) the run reserves one
      `job_alert` use once it knows it will search, after the enabled and
      master-resume checks, and KEEPS it only if the morning emailed jobs.
      Nothing above the bar, zero matches, a blank address, no SMTP, a failed
      send or a raise all give it back. With no use left the morning does not
      run: `last_skip` is set, `last_run_at` is left alone and the result says
      `skipped_reason="monthly_limit"`. A reserve that succeeds clears
      `last_skip`. An owner with no monthly limit writes nothing.
    - With a `charge` ("Run now", which its route already charged one `search`
      use) nothing is reserved here, and the use is given back only when there
      was no master resume or the search itself failed. A search that completed
      keeps it whatever the email did, because its results are in History.

    `send_fn` defaults to the mailer, read at call time (`_resolve_send`); `now`
    is the aware clock the reserve reads (default: the real time).
    """
    row = get_alert(db, user_id)
    if not row.enabled and not force:
        return AlertRunResult(user_id=user_id, ran=False, error="Alerts are disabled.")
    resume = _master_resume(db, user_id)
    if resume is None:
        _give_back(db, charge)
        row.last_error = "No master resume saved yet."
        db.commit()
        return AlertRunResult(user_id=user_id, ran=False, error=row.last_error)

    # The morning's own use, taken before anything that costs money and outside
    # the try below: a refusal at the limit is a skip, not a failure. Any other
    # refusal is reported rather than raised, or it would stop the cron.
    own_use = charge is None
    if own_use:
        try:
            charge = quota.reserve(db, db.get(User, user_id), "job_alert", now=now)
        except HTTPException as exc:
            if _is_monthly_limit(exc):
                row.last_skip = "monthly_limit"
                db.commit()
                return AlertRunResult(user_id=user_id, ran=False, skipped_reason="monthly_limit")
            db.rollback()
            _record_error(db, row, f"Could not start the run: {exc.detail}", stamp_run=False, clear_skip=False)
            return AlertRunResult(user_id=user_id, ran=False, error=f"Could not start the run: {exc.detail}"[:500])
        except Exception as exc:  # noqa: BLE001 - never raise: the next user must still run
            db.rollback()
            _record_error(db, row, f"Could not start the run: {exc}", stamp_run=False, clear_skip=False)
            return AlertRunResult(user_id=user_id, ran=False, error=f"Could not start the run: {exc}"[:500])

    emailed = False
    try:
        try:
            # PLAN 12.4: the daily cron re-surfaces mostly the SAME postings every
            # morning — the score cache turns those into zero-LLM, zero-fetch reuse
            # when the master resume hasn't changed since they were last scored.
            master_hash = resume_hash(resume)
            try:  # the cache is an optimization — an unreadable history must not kill the run
                cache = load_score_cache(db, user_id, master_hash)
            except Exception:  # noqa: BLE001
                cache = {}

            # The ghost detector's market memory (PLAN 28.3). `search_fn` calls it ONCE
            # on this thread before its scoring pool, so it can share the run's session.
            # Bare, not wrapped like `cache` above: `search_jobs` already catches what
            # this raises and falls back to no sightings, and a second try/except here
            # would be a second owner of one policy.
            #
            # THE CRON IS WHAT MAKES `long_open` HONEST, so this call site is not one of
            # three equivalent ones. A daily alert run is a daily sample of the market,
            # which is what turns `first_seen_at` from "the day someone happened to
            # search" into a real lower bound on a posting's age, within weeks of deploy.
            # The user's "Not for me" set (PLAN 31.5/4): a morning never emails a job
            # the user hid, and a hidden posting takes no slot in it either.
            owner = db.get(User, user_id)
            result = search_fn(
                resume,
                alert_context(row),
                cache=cache,
                sightings_fn=partial(load_sightings, db),
                **hidden_jobs.search_kw(owner.hidden_jobs_json if owner else ""),
            )
            new = split_new_matches(db, result.matches, user_id)
            record_search_hits(db, result.matches, user_id, resume_hash=master_hash)
        except Exception as e:  # noqa: BLE001 - report, don't crash the cron
            # Rolled back BEFORE the refund, so nothing the failed search left
            # pending can ride the refund's commit. The search did not complete,
            # so the use comes back, the morning's or Run now's alike.
            db.rollback()
            _give_back(db, charge)
            row.last_run_at = datetime.now(timezone.utc)
            row.last_error = str(e)[:500]
            if own_use:
                row.last_skip = ""
            db.commit()
            return AlertRunResult(user_id=user_id, ran=True, error=row.last_error)

        # READ BEFORE WRITE (PLAN 28.3): the reader above ran INSIDE the search;
        # this records what that search found. Reversed, every posting would be
        # stamped `first_seen_at = now` and then read back in the same run, so
        # `long_open` would measure each posting's age against the moment we noticed
        # it — zero days, always, for ever. The signal would pass by never firing.
        #
        # In its OWN best-effort block rather than the try above, because the two
        # have different consequences: a failure inside that try abandons the run and
        # the user loses this morning's email, while this is bookkeeping for
        # TOMORROW's ghost signals. `usage.record_tokens` keeps the same rule and the
        # same shape — rollback rather than `pass`, so a half-written upsert cannot
        # leave the session dirty for the settings commit further down.
        try:
            record_sightings(db, result.matches, datetime.now(timezone.utc))
        except Exception:  # noqa: BLE001 - never lose a served run over bookkeeping
            db.rollback()

        # The bar, applied AFTER record_search_hits above: below-bar postings are
        # kept out of the inbox and kept in the history the app reads and the score
        # cache reuses. `new` stays the diff's answer ("never seen before") and
        # `worth` is the email's ("...and worth your morning") — two questions, two
        # numbers, because a run that finds 12 and emails 3 must not look like a run
        # that found 3.
        min_score = alert_min_score(row)
        worth = above_min(new, min_score)

        send = _resolve_send(send_fn)
        email_error = ""
        if worth and row.email and send is not None:
            app_url = get_settings().app_base_url
            subject, body = build_alert_email(worth, result.context, min_score, app_url=app_url)
            html = build_alert_email_html(worth, result.context, app_url=app_url, min_score=min_score)
            try:
                send(row.email, subject, body, html=html)
                emailed = True
            except Exception as e:  # noqa: BLE001
                email_error = f"Email failed: {e}"

        # A morning keeps its use only if it emailed jobs. Run now keeps its use
        # here whatever the email did: its search completed and History holds it.
        if own_use and not (emailed and worth):
            _give_back(db, charge)
        row.last_run_at = datetime.now(timezone.utc)
        row.last_new_count = len(new)
        row.last_above_min = len(worth)
        row.last_error = email_error
        if own_use:
            row.last_skip = ""
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
    except Exception as e:  # noqa: BLE001 - never raise: one user's failure must not stop the cron
        # Anything after the reserve: roll back, give the morning's use back unless
        # it already emailed jobs, and report. Run now's use stays spent here,
        # because its search had completed before anything could raise.
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        if own_use and not emailed:
            _give_back(db, charge)
        message = (str(e) or type(e).__name__)[:500]
        _record_error(db, row, message, stamp_run=True, clear_skip=own_use)
        return AlertRunResult(user_id=user_id, ran=True, error=message)


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
