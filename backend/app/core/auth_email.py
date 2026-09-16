"""Auth mail — verification codes, reset links, security notices (Phase 29 / B1).

The nudges/alerts shape, so every message is pinned without SMTP: pure
`build_*_email(...) -> (subject, text)` and `build_*_email_html(...) -> str`
builders, and ONE door that actually sends, `send_auth_email`. English or Hebrew
by the account's locale; a Hebrew message is `dir="rtl"` from the <html> element
down, with the code itself held left-to-right so six digits never render
reversed.

**Who may send is decided in exactly one function, `_resolve_sender`, and that
function is the seam the smoke test swaps.** It sits ABOVE the SMTP check on
purpose: a seam below it would leave signup answering 503 in a suite whose SMTP
is blank by design, and a seam that bypassed the resolver would leave the real
503 path unpinned.

**Nothing is sent over budget** (`auth_throttle.reserve_mail`: 200 an hour
across everyone; per address, 3 verification mails and, separately, 3 reset
mails an hour; a "password changed" notice is held only to the global cap, so
nobody can silence it by spending an address's allowance first). Auth mail
rides the owner's own SMTP account, the one that also carries the job alerts.

**Continue with Google adds two notices** (Phase 30 / E5): Google sign-in was
added to an existing account, and a sign-in took over an unconfirmed email
signup. Both are `notice` mail (global cap only), sent after the change they
describe is committed, and best effort. In Hebrew the address or link they name
sits on a line of its own, never inside a right-to-left sentence.

**Never a password and never an extension key.** A mailbox is not a vault: the
only secrets these messages carry are single-use and expire within the hour.
"""
from __future__ import annotations

import html as html_lib
from typing import Callable

from sqlalchemy.orm import Session
from starlette.requests import Request

from app.config import get_settings
from app.core import auth_throttle, mailer
from app.core.alerts import _EM, _EM_FONT


class EmailUnavailable(Exception):
    """Auth mail cannot go out right now: no sender is configured, the budget is
    spent, or the send itself failed. Callers answer 503 email_unavailable."""


_COPY: dict[str, dict[str, str]] = {
    "en": {
        "verify_subject": "JobFinder: your verification code is {code}",
        "verify_head": "Confirm your email",
        "verify_lead": "Your JobFinder verification code:",
        "verify_how_link": "Enter it on the verification page, or open this link to confirm the address:",
        "verify_how_code": "Enter it on the verification page.",
        "verify_button": "Confirm my email",
        "verify_ttl": "The code and the link expire in {ttl} minutes.",
        "verify_ttl_code": "The code expires in {ttl} minutes.",
        "verify_ignore": "If you didn't create a JobFinder account, ignore this email. Nothing happens without the code.",
        "reset_subject": "JobFinder: reset your password",
        "reset_head": "Reset your password",
        "reset_lead": "Someone asked to reset the password for this JobFinder account. If it was you, open this link to choose a new one:",
        "reset_button": "Choose a new password",
        "reset_ttl": "The link works once and expires in {ttl} minutes.",
        "reset_ignore": "If it wasn't you, ignore this email. Your password stays as it is.",
        "changed_subject": "JobFinder: your password was changed",
        "changed_head": "Your password was changed",
        "changed_lead": "The password for your JobFinder account was just changed, and every other device was signed out.",
        "changed_key": "Your browser extension key was replaced too, so the JobFinder extension needs the new key from Settings.",
        "changed_act": "If this wasn't you, reset your password now:",
        "changed_act_nolink": "If this wasn't you, reset your password from the JobFinder login page.",
        "changed_button": "Reset my password",
        "google_linked_subject": "JobFinder: Google sign-in was added to your account",
        "google_linked_head": "Google sign-in was added",
        "google_linked_lead": "Google sign-in was added to your JobFinder account for {address}.",
        "google_linked_out": "Other devices were signed out.",
        "google_linked_out_key": "Other devices were signed out and your extension key was replaced.",
        "google_linked_act": "If this wasn't you, secure your Google account.",
        "google_linked_password": "This account also has a password. If you did not set it, reset it with Forgot password.",
        "google_superseded_subject": "JobFinder: you signed in with Google",
        "google_superseded_head": "You signed in with Google",
        "google_superseded_lead": "You signed in to JobFinder with Google. The password chosen when this account was created, before the address was confirmed, was removed, and other devices were signed out.",
        "google_superseded_act": "Use Continue with Google, or set a password here:",
        "google_superseded_act_nolink": "Use Continue with Google, or set a password with Forgot password on the JobFinder login page.",
        "google_superseded_button": "Set a password",
        "link_fallback": "If the button doesn't work, open this link:",
        "footer": "Sent by JobFinder because of activity on your account",
    },
    "he": {
        "verify_subject": "JobFinder: קוד האימות שלך הוא {code}",
        "verify_head": "אימות כתובת המייל",
        "verify_lead": "קוד האימות שלך ב-JobFinder:",
        "verify_how_link": "הזינו אותו בעמוד האימות, או פתחו את הקישור הזה כדי לאשר את הכתובת:",
        "verify_how_code": "הזינו אותו בעמוד האימות.",
        "verify_button": "אישור כתובת המייל",
        "verify_ttl": "הקוד והקישור בתוקף ל-{ttl} דקות.",
        "verify_ttl_code": "הקוד בתוקף ל-{ttl} דקות.",
        "verify_ignore": "אם לא פתחתם חשבון ב-JobFinder, אפשר להתעלם מהמייל הזה. בלי הקוד לא קורה כלום.",
        "reset_subject": "JobFinder: איפוס הסיסמה",
        "reset_head": "איפוס הסיסמה",
        "reset_lead": "התקבלה בקשה לאפס את הסיסמה של החשבון הזה ב-JobFinder. אם זה אתם, פתחו את הקישור הזה כדי לבחור סיסמה חדשה:",
        "reset_button": "בחירת סיסמה חדשה",
        "reset_ttl": "הקישור עובד פעם אחת ובתוקף ל-{ttl} דקות.",
        "reset_ignore": "אם זה לא אתם, אפשר להתעלם מהמייל הזה. הסיסמה נשארת כמו שהיא.",
        "changed_subject": "JobFinder: הסיסמה שלך שונתה",
        "changed_head": "הסיסמה שלך שונתה",
        "changed_lead": "הסיסמה של החשבון שלך ב-JobFinder שונתה עכשיו, וכל שאר המכשירים נותקו.",
        "changed_key": "גם מפתח התוסף לדפדפן הוחלף, ולכן התוסף של JobFinder צריך את המפתח החדש מההגדרות.",
        "changed_act": "אם זה לא אתם, אפסו את הסיסמה עכשיו:",
        "changed_act_nolink": "אם זה לא אתם, אפסו את הסיסמה מעמוד הכניסה של JobFinder.",
        "changed_button": "איפוס הסיסמה",
        "google_linked_subject": "JobFinder: נוספה לחשבון שלך כניסה עם Google",
        "google_linked_head": "נוספה כניסה עם Google",
        "google_linked_lead": "נוספה כניסה עם Google לחשבון שלך ב-JobFinder, עבור הכתובת:",
        "google_linked_out": "שאר המכשירים נותקו.",
        "google_linked_out_key": "שאר המכשירים נותקו, ומפתח התוסף לדפדפן הוחלף.",
        "google_linked_act": "אם זה לא אתם, אבטחו את חשבון Google שלכם.",
        "google_linked_password": 'לחשבון הזה יש גם סיסמה. אם לא אתם הגדרתם אותה, אפסו אותה דרך "שכחתם סיסמה?" בעמוד הכניסה.',
        "google_superseded_subject": "JobFinder: נכנסתם עם Google",
        "google_superseded_head": "נכנסתם עם Google",
        "google_superseded_lead": "נכנסתם ל-JobFinder עם Google. הסיסמה שנבחרה כשהחשבון נוצר, לפני שהכתובת אושרה, הוסרה, וכל שאר המכשירים נותקו.",
        "google_superseded_act": "בפעם הבאה אפשר להיכנס עם Google, או להגדיר סיסמה כאן:",
        "google_superseded_act_nolink": 'בפעם הבאה אפשר להיכנס עם Google, או להגדיר סיסמה דרך "שכחתם סיסמה?" בעמוד הכניסה של JobFinder.',
        "google_superseded_button": "הגדרת סיסמה",
        "link_fallback": "אם הכפתור לא עובד, פתחו את הקישור הזה:",
        "footer": "נשלח מ-JobFinder בעקבות פעילות בחשבון שלך",
    },
}


def _lang(locale: str | None) -> str:
    return "he" if (locale or "").strip().lower().startswith("he") else "en"


def link_base(request: Request | None) -> str:
    """The origin the links in auth mail point at: APP_BASE_URL, else the calling
    page's Origin when it is one of this app's own CORS origins, else "" (no link).

    Never `request.base_url`: behind the Vite proxy the backend sees
    127.0.0.1:8000 with /api stripped, which is not a page anyone can open.
    """
    s = get_settings()
    base = (s.app_base_url or "").strip().rstrip("/")
    if base:
        return base
    if request is None:
        return ""
    origin = (request.headers.get("origin") or "").strip().rstrip("/")
    allowed = {o.rstrip("/") for o in s.cors_origin_list}
    return origin if origin and origin in allowed else ""


# --- builders (pure) -----------------------------------------------------------
def build_verify_email(code: str, link: str = "", locale: str = "", ttl_min: int = 60) -> tuple[str, str]:
    """(subject, plain-text body). Pure — smoke-pinned.

    The code rides in the SUBJECT on purpose: on a phone it is readable straight
    off the notification, without opening a mail app that may open the link in
    a different browser from the one that is signing up.
    """
    c = _COPY[_lang(locale)]
    lines = [c["verify_lead"], "", f"    {code}", "", c["verify_how_link"] if link else c["verify_how_code"]]
    if link:
        lines.append(link)
    # With no link, no sentence may mention one — a mail promising a link it
    # does not contain reads as broken, and the user goes looking for it.
    ttl = (c["verify_ttl"] if link else c["verify_ttl_code"]).format(ttl=ttl_min)
    lines += ["", ttl, c["verify_ignore"]]
    return c["verify_subject"].format(code=code), "\n".join(lines)


def build_reset_email(link: str, locale: str = "", ttl_min: int = 60) -> tuple[str, str]:
    """(subject, plain-text body). Pure — smoke-pinned."""
    c = _COPY[_lang(locale)]
    lines = [c["reset_lead"], link, "", c["reset_ttl"].format(ttl=ttl_min), c["reset_ignore"]]
    return c["reset_subject"], "\n".join(lines)


def build_password_changed_email(link: str = "", locale: str = "", key_rotated: bool = False) -> tuple[str, str]:
    """(subject, plain-text body). `link` points at the forgot-password page.
    `key_rotated` adds the sentence saying the extension key was replaced — and
    only then, so the notice never claims a replacement that did not happen."""
    c = _COPY[_lang(locale)]
    lines = [c["changed_lead"]] + ([c["changed_key"]] if key_rotated else []) + [""]
    lines += [c["changed_act"], link] if link else [c["changed_act_nolink"]]
    return c["changed_subject"], "\n".join(lines)


def build_google_linked_email(
    address: str, locale: str = "", *, has_password: bool = False, key_rotated: bool = False
) -> tuple[str, str]:
    """(subject, plain-text body): Google sign-in was added to an existing account
    (Phase 30 / E5). The key clause appears only when the extension key was
    replaced, and the password sentence only when the account also has one, so
    the notice never claims what did not happen. English names the address inside
    its sentence; the Hebrew copy has no placeholder, so the address follows on a
    line of its own. Pure — smoke-pinned."""
    c = _COPY[_lang(locale)]
    lead = c["google_linked_lead"]
    lines = [lead.format(address=address)] if "{address}" in lead else [lead, address]
    lines.append(c["google_linked_out_key"] if key_rotated else c["google_linked_out"])
    lines.append(c["google_linked_act"])
    if has_password:
        lines += ["", c["google_linked_password"]]
    return c["google_linked_subject"], "\n".join(lines)


def build_google_superseded_email(link: str = "", locale: str = "") -> tuple[str, str]:
    """(subject, plain-text body): a Google sign-in took over an unconfirmed email
    signup (Phase 30 / E5). `link` points at the forgot-password page, on a line
    of its own; with none, no sentence mentions one. There is no extension-key
    sentence: an unverified account could never read its key. Pure — smoke-pinned."""
    c = _COPY[_lang(locale)]
    lines = [c["google_superseded_lead"], ""]
    lines += [c["google_superseded_act"], link] if link else [c["google_superseded_act_nolink"]]
    return c["google_superseded_subject"], "\n".join(lines)


def _html(locale: str, headline: str, lead: str, body: str = "", cta_label: str = "",
          cta_href: str = "", tail: list[str] | None = None, lead_html: str = "") -> str:
    """The shared message frame: the alert/nudge email's dark theme, inline
    styles and presentation tables only, every dynamic string escaped.
    `lead_html`, when given, is lead markup the caller has ALREADY escaped (it
    wraps an address in a left-to-right span) and replaces `lead`."""
    esc = html_lib.escape
    lang = _lang(locale)
    direction = "rtl" if lang == "he" else "ltr"
    align = "right" if lang == "he" else "left"
    c = _COPY[lang]
    cta = (
        f'<a href="{esc(cta_href, quote=True)}" style="display:inline-block;padding:12px 26px;'
        f"border-radius:999px;background:{_EM['accent']};color:#ffffff;font:600 15px {_EM_FONT};"
        f'text-decoration:none;">{esc(cta_label)}</a>'
        if cta_href
        else ""
    )
    fallback = (
        f'<div style="padding-top:12px;">{esc(c["link_fallback"])}<br>'
        f'<a dir="ltr" href="{esc(cta_href, quote=True)}" style="color:{_EM["accent_soft"]};'
        f'word-break:break-all;">{esc(cta_href)}</a></div>'
        if cta_href
        else ""
    )
    tail_html = "<br>".join(esc(line) for line in (tail or []))
    lead_block = lead_html or esc(lead)
    return f"""<!doctype html>
<html lang="{lang}" dir="{direction}">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
</head>
<body dir="{direction}" style="margin:0;padding:0;background:{_EM['bg']};" bgcolor="{_EM['bg']}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="{direction}" style="background:{_EM['bg']};">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" dir="{direction}" style="width:100%;max-width:600px;">
        <tr>
          <td align="{align}" style="padding:0 4px 18px;">
            <span dir="ltr" style="font:700 20px {_EM_FONT};color:{_EM['ink']};">Job<span
              style="color:{_EM['accent']};">Finder</span></span>
          </td>
        </tr>
        <tr>
          <td style="border-radius:14px;background:linear-gradient(135deg,{_EM['accent']},{_EM['mint']});padding:1px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                   style="background:{_EM['panel']};border-radius:13px;">
              <tr>
                <td dir="{direction}" align="{align}" style="padding:22px 24px;text-align:{align};">
                  <div style="color:{_EM['ink']};font:700 24px {_EM_FONT};">{esc(headline)}</div>
                  <div style="padding-top:8px;color:{_EM['muted']};font:15px {_EM_FONT};line-height:1.5;">{lead_block}</div>
                  {body}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr><td align="center" style="padding:20px 0 0;">{cta}</td></tr>
        <tr>
          <td dir="{direction}" align="{align}" style="padding:18px 4px 0;color:{_EM['muted']};font:13px {_EM_FONT};line-height:1.5;text-align:{align};">
            {tail_html}{fallback}
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:14px 4px 0;color:{_EM['faint']};font:12px {_EM_FONT};">
            {esc(c["footer"])}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>"""


def _paragraph(text: str) -> str:
    """One more body paragraph in the lead's style, escaped."""
    return (
        f'<div style="padding-top:8px;color:{_EM["muted"]};font:15px {_EM_FONT};line-height:1.5;">'
        f"{html_lib.escape(text)}</div>"
    )


def build_verify_email_html(code: str, link: str = "", locale: str = "", ttl_min: int = 60) -> str:
    """HTML alternative. The code is its own left-to-right block, so a Hebrew
    message can never lay the digits out backwards. Pure — smoke-pinned."""
    c = _COPY[_lang(locale)]
    code_block = (
        f'<div dir="ltr" style="padding:18px 0 4px;text-align:center;color:{_EM["ink"]};'
        f'font:700 34px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:8px;">'
        f"{html_lib.escape(code)}</div>"
    )
    return _html(
        locale,
        c["verify_head"],
        c["verify_lead"],
        body=code_block,
        cta_label=c["verify_button"],
        cta_href=link,
        tail=[(c["verify_ttl"] if link else c["verify_ttl_code"]).format(ttl=ttl_min), c["verify_ignore"]],
    )


def build_reset_email_html(link: str, locale: str = "", ttl_min: int = 60) -> str:
    c = _COPY[_lang(locale)]
    return _html(
        locale,
        c["reset_head"],
        c["reset_lead"],
        cta_label=c["reset_button"],
        cta_href=link,
        tail=[c["reset_ttl"].format(ttl=ttl_min), c["reset_ignore"]],
    )


def build_password_changed_email_html(link: str = "", locale: str = "", key_rotated: bool = False) -> str:
    c = _COPY[_lang(locale)]
    key_note = (
        f'<div style="padding-top:8px;color:{_EM["muted"]};font:15px {_EM_FONT};line-height:1.5;">'
        f"{html_lib.escape(c['changed_key'])}</div>"
        if key_rotated
        else ""
    )
    return _html(
        locale,
        c["changed_head"],
        c["changed_lead"],
        body=key_note,
        cta_label=c["changed_button"],
        cta_href=link,
        tail=[c["changed_act"] if link else c["changed_act_nolink"]],
    )


def build_google_linked_email_html(
    address: str, locale: str = "", *, has_password: bool = False, key_rotated: bool = False
) -> str:
    """HTML alternative. The address is always a `dir="ltr"` span: inside the
    English sentence, and in a block of its own after the Hebrew one, so a
    right-to-left paragraph never reorders it. Pure — smoke-pinned."""
    c = _COPY[_lang(locale)]
    esc = html_lib.escape
    shown = f'<span dir="ltr">{esc(address)}</span>'
    lead = c["google_linked_lead"]
    if "{address}" in lead:
        before, _, after = lead.partition("{address}")
        lead_html = f"{esc(before)}{shown}{esc(after)}"
    else:
        lead_html = f'{esc(lead)}<div style="padding-top:6px;">{shown}</div>'
    body = _paragraph(c["google_linked_out_key"] if key_rotated else c["google_linked_out"])
    if has_password:
        body += _paragraph(c["google_linked_password"])
    return _html(locale, c["google_linked_head"], "", body=body, tail=[c["google_linked_act"]], lead_html=lead_html)


def build_google_superseded_email_html(link: str = "", locale: str = "") -> str:
    c = _COPY[_lang(locale)]
    return _html(
        locale,
        c["google_superseded_head"],
        c["google_superseded_lead"],
        cta_label=c["google_superseded_button"],
        cta_href=link,
        tail=[c["google_superseded_act"] if link else c["google_superseded_act_nolink"]],
    )


# --- sending -------------------------------------------------------------------
Sender = Callable[..., None]


def _console_sender(to: str, subject: str, text: str, html: str, *, code: str = "", link: str = "") -> None:
    print(f"[auth-mail] to={to} subject={subject} code={code} link={link}", flush=True)


def _smtp_sender(to: str, subject: str, text: str, html: str, *, code: str = "", link: str = "") -> None:
    mailer.send_email(to, subject, text, html=html)


def _resolve_sender() -> Sender | None:
    """The function that delivers auth mail right now, or None when nothing can.

    THE seam. The smoke test replaces this whole function with one returning
    its capture, and restores it to pin the unconfigured-SMTP 503.
    """
    if (get_settings().auth_email_mode or "").strip().lower() == "console":
        return _console_sender
    return _smtp_sender if mailer.smtp_configured() else None


def mail_ready(db: Session, to: str, purpose: str = "verify") -> bool:
    """Could one auth mail of this purpose to `to` go out right now? The
    preflight a signup runs BEFORE it creates anything: an account whose code
    can never arrive is a dead end that only someone who knows to sign up again
    can escape."""
    return _resolve_sender() is not None and auth_throttle.mail_allowed(db, to, purpose=purpose)


def send_auth_email(
    db: Session,
    to: str,
    subject: str,
    text: str,
    html: str,
    *,
    user_id: int | None = None,
    code: str = "",
    link: str = "",
    purpose: str = "verify",
) -> None:
    """Deliver one auth mail, or raise EmailUnavailable. Claims the budget of
    its purpose first (`auth_throttle.mail_allowed`)."""
    sender = _resolve_sender()
    if sender is None:
        raise EmailUnavailable("no auth-mail sender is configured")
    if not auth_throttle.reserve_mail(db, to, user_id=user_id, purpose=purpose):
        raise EmailUnavailable("the auth-mail budget is spent")
    try:
        sender(to, subject, text, html, code=code, link=link)
    except Exception as e:  # noqa: BLE001 - every delivery failure is the same answer to the caller
        raise EmailUnavailable(str(e)[:200]) from e


def send_verify(
    db: Session, request: Request | None, to: str, code: str, token: str, *,
    locale: str = "", user_id: int | None = None,
) -> None:
    base = link_base(request)
    link = f"{base}/verify?token={token}" if base else ""
    ttl = get_settings().verify_ttl_min
    subject, text = build_verify_email(code, link, locale, ttl)
    html = build_verify_email_html(code, link, locale, ttl)
    send_auth_email(db, to, subject, text, html, user_id=user_id, code=code, link=link, purpose="verify")


def send_reset(
    db: Session, request: Request | None, to: str, token: str, *,
    locale: str = "", user_id: int | None = None,
) -> None:
    link = f"{link_base(request)}/reset?token={token}"
    ttl = get_settings().reset_ttl_min
    subject, text = build_reset_email(link, locale, ttl)
    html = build_reset_email_html(link, locale, ttl)
    send_auth_email(db, to, subject, text, html, user_id=user_id, link=link, purpose="reset")


def send_password_changed(
    db: Session, request: Request | None, to: str, *, locale: str = "", user_id: int | None = None,
    key_rotated: bool = False,
) -> None:
    base = link_base(request)
    link = f"{base}/forgot" if base else ""
    subject, text = build_password_changed_email(link, locale, key_rotated)
    html = build_password_changed_email_html(link, locale, key_rotated)
    send_auth_email(db, to, subject, text, html, user_id=user_id, link=link, purpose="notice")


def send_google_linked(
    db: Session, request: Request | None, to: str, *, locale: str = "", user_id: int | None = None,
    has_password: bool = False, key_rotated: bool = False,
) -> None:
    """Google sign-in was added to the account at `to` (Phase 30 / E5). A
    `notice`: the global cap only, so nothing an address can spend first
    silences it. The caller sends it after its commit and swallows
    EmailUnavailable. `request` is taken for the same signature as every other
    sender; this notice carries no link."""
    subject, text = build_google_linked_email(to, locale, has_password=has_password, key_rotated=key_rotated)
    html = build_google_linked_email_html(to, locale, has_password=has_password, key_rotated=key_rotated)
    send_auth_email(db, to, subject, text, html, user_id=user_id, purpose="notice")


def send_google_superseded(
    db: Session, request: Request | None, to: str, *, locale: str = "", user_id: int | None = None,
) -> None:
    """A Google sign-in took over the unconfirmed signup at `to` (Phase 30 / E5),
    mailed to the address Google just proved. A `notice`, like the one above."""
    base = link_base(request)
    link = f"{base}/forgot" if base else ""
    subject, text = build_google_superseded_email(link, locale)
    html = build_google_superseded_email_html(link, locale)
    send_auth_email(db, to, subject, text, html, user_id=user_id, link=link, purpose="notice")
