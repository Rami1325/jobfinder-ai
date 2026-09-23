"""Stale-application nudge emails (PLAN 11.4): the tracker's "time to follow up"
card, promoted to a scheduled email.

Opt-in per user via the alert settings row (`JobAlert.nudge_emails` — the
alerts card already holds a recipient address). A nudge is sent ONCE per
stale period: each run emails only applications that CROSSED the staleness
threshold since `last_nudge_at`, so the daily cron never nags twice about the
same quiet application. A later status change resets `status_changed_at`, so
an application that goes quiet again re-arms naturally.

`run_all_nudges` mirrors `alerts.run_all_alerts`: per-user failures are
isolated, and `send_fn`/`now` are injectable so the offline smoke test can
exercise the whole loop (watermark, re-arm, retry-after-failure) with no
SMTP and a fixed clock.
"""
from __future__ import annotations

import html as html_lib
from datetime import datetime, timedelta, timezone
from typing import Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core import mailer
from app.core.alerts import _EM, _EM_FONT
from app.db.models import Application, JobAlert, User
from app.models import NudgeRunResult, StaleApplication


def _as_utc(dt: datetime) -> datetime:
    """SQLite returns naive datetimes — treat them as UTC."""
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def stale_rows(
    db: Session, user_id: int, days: int, now: datetime
) -> list[tuple[Application, datetime]]:
    """(application, staleness marker) pairs for apps stuck in 'applied' with
    no status change for `days`. The marker (status_changed_at or created_at,
    UTC) is what both the tracker card and the nudge watermark reason about."""
    cutoff = now - timedelta(days=days)
    rows = db.execute(
        select(Application).where(
            Application.user_id == user_id, Application.status == "applied"
        )
    ).scalars().all()
    out: list[tuple[Application, datetime]] = []
    for a in rows:
        marker = a.status_changed_at or a.created_at
        if marker is None:
            continue
        marker = _as_utc(marker)
        if marker <= cutoff:
            out.append((a, marker))
    return out


def to_stale_out(
    pairs: list[tuple[Application, datetime]], now: datetime
) -> list[StaleApplication]:
    items = [
        StaleApplication(
            id=a.id,
            job_title=a.job_title,
            company=a.company,
            status=a.status,
            days_stale=(now - marker).days,
            job_url=a.job_url,
        )
        for a, marker in pairs
    ]
    items.sort(key=lambda x: x.days_stale, reverse=True)
    return items


def _application_link(it: StaleApplication, app_url: str = "") -> str:
    """Where a quiet application in the nudge email opens (PLAN 31.4/6): its
    job's own page in the app, where the follow-up is one tap away (Prepare) and
    its emails and posting are; the posting itself when no app URL is
    configured, as before."""
    base = app_url.strip().rstrip("/")
    return f"{base}/applications/{it.id}" if base else (it.job_url or "")


def build_nudge_email(items: list[StaleApplication], app_url: str = "") -> tuple[str, str]:
    """(subject, plain-text body). Pure — smoke-pinned."""
    n = len(items)
    plural = "s" if n != 1 else ""
    subject = f"JobFinder: {n} application{plural} waiting on a follow-up"
    lines = [
        f"{n} application{plural} you sent went quiet — a short follow-up note "
        "keeps you on the radar:",
        "",
    ]
    for it in items:
        bits = [it.job_title or "Untitled role"]
        if it.company:
            bits.append(f"at {it.company}")
        bits.append(f"— {it.days_stale} days without a response")
        lines.append("• " + " ".join(bits))
        if link := _application_link(it, app_url):
            lines.append(f"  {link}")
    tail = (
        f"Write the follow-up from your tracker: {app_url.rstrip('/')}/tracker"
        if app_url.strip()
        else "Write the follow-up from the Tracker page."
    )
    lines += ["", tail, "", "Sent by JobFinder follow-up reminders. Manage them on the Jobs page."]
    return subject, "\n".join(lines)


def _nudge_row_html(it: StaleApplication, app_url: str = "") -> str:
    esc = html_lib.escape
    title = esc(it.job_title or "Untitled role")
    if link := _application_link(it, app_url):
        title = (
            f'<a href="{esc(link, quote=True)}" style="color:{_EM["ink"]};'
            f'text-decoration:none;">{title}</a>'
        )
    company = (
        f'<div dir="auto" style="padding-top:2px;color:{_EM["muted"]};'
        f'font:13px {_EM_FONT};">{esc(it.company)}</div>'
        if it.company
        else ""
    )
    days = (
        f'<span style="display:inline-block;padding:5px 12px;border-radius:999px;'
        f"background:{_EM['panel2']};border:1px solid {_EM['line']};color:{_EM['muted']};"
        f'font:600 13px {_EM_FONT};white-space:nowrap;">{it.days_stale}d quiet</span>'
    )
    return f"""
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
       style="background:{_EM['panel']};border:1px solid {_EM['line']};border-radius:14px;">
  <tr>
    <td style="padding:16px 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td dir="auto" style="color:{_EM['ink']};font:600 15px {_EM_FONT};">{title}</td>
          <td align="right" valign="top" style="padding-left:12px;">{days}</td>
        </tr>
      </table>
      {company}
    </td>
  </tr>
</table>
<div style="height:12px;line-height:12px;">&nbsp;</div>"""


def build_nudge_email_html(items: list[StaleApplication], app_url: str = "") -> str:
    """HTML alternative themed like the alert email (inline styles + tables,
    everything escaped, Hebrew-safe via dir="auto"). Pure — smoke-pinned."""
    esc = html_lib.escape
    n = len(items)
    headline = f"{n} application{'s' if n != 1 else ''} went quiet"
    rows = "".join(_nudge_row_html(it, app_url) for it in items)
    cta = (
        f'<a href="{esc(app_url.rstrip("/"), quote=True)}/tracker" '
        f'style="display:inline-block;padding:10px 22px;border-radius:999px;'
        f"background:{_EM['accent']};color:#ffffff;font:600 14px {_EM_FONT};"
        f'text-decoration:none;">Write a follow-up &#8594;</a>'
        if app_url.strip()
        else ""
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
                  <div style="padding-top:6px;color:{_EM['muted']};font:14px {_EM_FONT};">
                    A short, specific follow-up note keeps you on the radar.
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr><td style="height:18px;line-height:18px;">&nbsp;</td></tr>
        <tr><td>{rows}</td></tr>
        <tr><td align="center" style="padding:8px 0 0;">{cta}</td></tr>
        <tr>
          <td align="center" style="padding:14px 4px 0;color:{_EM['faint']};font:12px {_EM_FONT};">
            Sent by JobFinder follow-up reminders &#183; manage them on the Jobs page
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>"""


def run_user_nudge(
    db: Session,
    row: JobAlert,
    *,
    now: datetime,
    send_fn: Callable[..., None] | None,
) -> NudgeRunResult:
    """One user's nudge tick. Emails only applications whose staleness
    threshold was crossed after `last_nudge_at`; on a send failure (or no way
    to send) the watermark is NOT advanced, so the next run retries."""
    days = get_settings().stale_application_days
    if days <= 0:
        return NudgeRunResult(ran=False, error="Nudges disabled by STALE_APPLICATION_DAYS.")
    pairs = stale_rows(db, row.user_id, days, now)
    last = _as_utc(row.last_nudge_at) if row.last_nudge_at else None
    fresh = [
        (a, marker)
        for a, marker in pairs
        if last is None or marker + timedelta(days=days) > last
    ]

    emailed = False
    error = ""
    if fresh and row.email and send_fn is not None:
        items = to_stale_out(fresh, now)
        app_url = get_settings().app_base_url
        subject, body = build_nudge_email(items, app_url)
        html = build_nudge_email_html(items, app_url)
        try:
            send_fn(row.email, subject, body, html=html)
            emailed = True
        except Exception as e:  # noqa: BLE001 - report, don't crash the cron
            error = f"Email failed: {e}"[:500]

    if not fresh or emailed:
        row.last_nudge_at = now
        db.commit()
    return NudgeRunResult(
        ran=True, stale=len(pairs), new_stale=len(fresh), emailed=emailed, error=error
    )


_DEFAULT_SEND = object()  # sentinel: "resolve from mailer config at call time"


def run_all_nudges(
    db: Session,
    *,
    send_fn=_DEFAULT_SEND,  # noqa: ANN001 - sentinel default
    now: datetime | None = None,
) -> list[NudgeRunResult]:
    """One cron tick: every active user who opted into follow-up reminders and
    has an address. Per-user failures are isolated — one broken row never
    blocks the rest (mirrors alerts.run_all_alerts)."""
    if now is None:
        now = datetime.now(timezone.utc)
    if send_fn is _DEFAULT_SEND:
        send_fn = mailer.send_email if mailer.smtp_configured() else None
    rows = db.execute(
        select(JobAlert)
        .join(User, User.id == JobAlert.user_id)
        .where(
            JobAlert.nudge_emails.is_(True),
            JobAlert.email != "",
            User.is_active.is_(True),
        )
        .order_by(JobAlert.user_id)
    ).scalars().all()
    out: list[NudgeRunResult] = []
    for row in rows:
        if row.user_id is None:
            continue
        try:
            out.append(run_user_nudge(db, row, now=now, send_fn=send_fn))
        except Exception as e:  # noqa: BLE001
            out.append(NudgeRunResult(ran=True, error=str(e)[:500]))
    return out
