"""Plain-SMTP email sending for job alerts (no new dependencies).

Configured entirely via env (ALERT_SMTP_* / ALERT_EMAIL_FROM — see
.env.example). Gmail works with an app password: smtp.gmail.com:587.
When unconfigured, `smtp_configured()` is False and alert runs simply skip
the email step — the diffing/history side still works.
"""
from __future__ import annotations

import smtplib
from email.message import EmailMessage

from app.config import get_settings


def smtp_configured() -> bool:
    s = get_settings()
    return bool(s.alert_smtp_host and (s.alert_email_from or s.alert_smtp_user))


def send_email(to: str, subject: str, text: str) -> None:
    """Send a plain-text email; raises on failure (callers report, not crash)."""
    s = get_settings()
    msg = EmailMessage()
    msg["From"] = s.alert_email_from or s.alert_smtp_user
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    if s.alert_smtp_port == 465:
        with smtplib.SMTP_SSL(s.alert_smtp_host, s.alert_smtp_port, timeout=30) as smtp:
            if s.alert_smtp_user:
                smtp.login(s.alert_smtp_user, s.alert_smtp_password)
            smtp.send_message(msg)
    else:
        with smtplib.SMTP(s.alert_smtp_host, s.alert_smtp_port, timeout=30) as smtp:
            smtp.starttls()
            if s.alert_smtp_user:
                smtp.login(s.alert_smtp_user, s.alert_smtp_password)
            smtp.send_message(msg)
