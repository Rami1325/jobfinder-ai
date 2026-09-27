"""WhatsApp alerts (PLAN 32, part 2): the morning digest as a WhatsApp message,
through Meta's WhatsApp Cloud API. OFF by default, and off for everyone the
admin did not grant it to.

Every WhatsApp message costs the OWNER real money (Meta bills per delivered
template message; Israel's rate is in `docs/handbook/notifications.md`), so three
switches all have to be on before one is sent:

1. The server: `configured()`, i.e. `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
   `WHATSAPP_TEMPLATE_NAME` (the approved digest template) and
   `WHATSAPP_CODE_TEMPLATE_NAME` (the approved AUTHENTICATION template the
   verification code goes in: Meta allows a one-time code in no other category).
2. The account: `allowed()`, the admin always, anyone else only once the admin
   set `users.whatsapp_enabled` through `PATCH /admin/users/{id}`
   (`WHATSAPP_ACCESS=all` opens it to everyone, like the Gmail allowlist).
3. The person: a number they typed, the explicit opt-in they ticked, and the
   code WhatsApp delivered to that number, typed back (`verified_at`). A number
   nobody proved is never sent a digest: a typo would bill the owner to message
   a stranger, and Meta lowers the number's quality rating for it.

THE WHATSAPP DOOR. Every request goes through `_http`: https only, the host must
be `graph.facebook.com` (a constant, never a caller's URL), the path is the API
version and the phone number id, each validated by pattern, a redirect is an
error, a 15-second timeout, JSON. The recipient number is a body field, never
part of the URL. This is the Google door's shape (`inbox.md`), not the SSRF
guard's: for a constant host an allowlist proves it IS Meta. `_transport` is
the offline seam; the smoke test never reaches Meta.

The code is six digits, stored as an HMAC (`sessions.hkey`), valid ten minutes,
five wrong tries per code. Sending a code or a test message is capped per day
(`DAILY_WHATSAPP_CAP`); a digest goes at most once per morning run.
"""
from __future__ import annotations

import hmac
import json
import logging
import re
import secrets
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.core.sessions import as_utc, hkey
from app.db.models import User, WhatsAppContact

logger = logging.getLogger(__name__)

HOST = "graph.facebook.com"
TIMEOUT_S = 15.0
_MAX_RESPONSE_BYTES = 200_000
_VERSION = re.compile(r"^v\d{1,3}\.\d$")
_PHONE_ID = re.compile(r"^\d{5,20}$")
_TEMPLATE = re.compile(r"^[a-z0-9_]{1,512}$")
_E164 = re.compile(r"^\+[1-9]\d{7,14}$")
CODE_TTL = timedelta(minutes=10)
CODE_ATTEMPTS = 5
# Template variables are clipped: Meta refuses a parameter over 1024 characters,
# and a digest line only needs the job's name.
_PARAM_MAX = 120

# (method, url, headers, body, timeout) -> (status, raw body)
Transport = Callable[[str, str, dict[str, str], bytes, float], "tuple[int, bytes]"]
_transport: Transport | None = None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, D102
        return None


# --- the door ---------------------------------------------------------------------
def _messages_url(s: Settings) -> str:
    version = (s.whatsapp_api_version or "").strip()
    phone_id = (s.whatsapp_phone_number_id or "").strip()
    if not _VERSION.match(version) or not _PHONE_ID.match(phone_id):
        raise ValueError("whatsapp settings")
    return f"https://{HOST}/{version}/{phone_id}/messages"


def _http(url: str, body: dict[str, Any], token: str) -> tuple[int, dict[str, Any]]:
    """The only function in the app that talks to Meta. (status, JSON body);
    status 0 when nothing answered."""
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname != HOST or parts.port not in (None, 443) or parts.username:
        raise ValueError("host_not_allowed")
    raw_body = json.dumps(body, ensure_ascii=False).encode("utf-8")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"}
    if _transport is not None:
        status, raw = _transport("POST", url, headers, raw_body, TIMEOUT_S)
    else:
        request = urllib.request.Request(url, data=raw_body, headers=headers, method="POST")
        opener = urllib.request.build_opener(_NoRedirect)
        try:
            with opener.open(request, timeout=TIMEOUT_S) as resp:  # noqa: S310 - fixed host, checked above
                status, raw = resp.status, resp.read(_MAX_RESPONSE_BYTES)
        except urllib.error.HTTPError as e:
            status, raw = e.code, (e.read(_MAX_RESPONSE_BYTES) if e.fp is not None else b"")
        except (urllib.error.URLError, TimeoutError, OSError):
            return 0, {}
    try:
        data = json.loads(raw.decode("utf-8")) if raw else {}
    except (ValueError, UnicodeDecodeError):
        data = {}
    return int(status), data if isinstance(data, dict) else {}


# --- switches -----------------------------------------------------------------
def configured(s: Settings | None = None) -> bool:
    s = s or get_settings()
    return bool(
        (s.whatsapp_token or "").strip()
        and _PHONE_ID.match((s.whatsapp_phone_number_id or "").strip())
        and _TEMPLATE.match((s.whatsapp_template_name or "").strip())
        and _TEMPLATE.match((s.whatsapp_code_template_name or "").strip())
        and _VERSION.match((s.whatsapp_api_version or "").strip())
    )


def allowed(user: User, s: Settings | None = None) -> bool:
    s = s or get_settings()
    if user.is_admin:
        return True
    if (s.whatsapp_access or "").strip().lower() == "all":
        return True
    return bool(getattr(user, "whatsapp_enabled", False))


def available(user: User) -> bool:
    return configured() and allowed(user)


def template_lang(lang: str, s: Settings | None = None) -> str:
    """The approved language version to send: the person's, when the owner got
    that version approved (`WHATSAPP_TEMPLATE_LANGS`), else the first listed."""
    s = s or get_settings()
    langs = [x.strip() for x in (s.whatsapp_template_langs or "").split(",") if x.strip()] or ["en"]
    want = "he" if lang == "he" else "en"
    return want if want in langs else langs[0]


# --- numbers --------------------------------------------------------------------
def normalize_phone(raw: str) -> str:
    """E.164 ("+972501234567"), or "" when it is not a phone number. An Israeli
    number typed the local way (050-123-4567) is read as +972; "00" is "+"."""
    text = re.sub(r"[\s\-().‎‏]", "", (raw or "").strip())
    if text.startswith("00"):
        text = "+" + text[2:]
    elif re.fullmatch(r"0\d{8,9}", text):
        text = "+972" + text[1:]
    if text.startswith("+9720"):  # the trunk 0 kept after the country code
        text = "+972" + text[5:]
    return text if _E164.match(text) else ""


def contact_of(db: Session, user_id: int) -> WhatsAppContact | None:
    return db.execute(select(WhatsAppContact).where(WhatsAppContact.user_id == user_id)).scalars().first()


# --- sending --------------------------------------------------------------------
@dataclass(frozen=True)
class SendResult:
    ok: bool
    # "" when ok; else a short reason the page translates: not_on_whatsapp,
    # opted_out, rate_limited, template, payment, token, network, failed.
    reason: str = ""
    meta_code: int = 0


# Meta's error codes (developers.facebook.com/documentation/business-messaging/
# whatsapp/support/error-codes), mapped to what the person or the owner can do.
_REASONS = {
    131026: "not_on_whatsapp",  # the number is not on WhatsApp (or the app is too old)
    131050: "opted_out",  # the person stopped marketing messages from this business
    131049: "rate_limited",  # Meta's per-user marketing limit; try tomorrow
    131056: "rate_limited",  # pair rate limit
    130429: "rate_limited",  # throughput
    132000: "template",
    132001: "template",  # no such template in that language, or not approved
    132012: "template",
    132015: "template",
    132016: "template",
    131042: "payment",  # no working payment method on the account
    190: "token",  # the access token expired
}


def _send(to: str, template: str, lang_code: str, components: list[dict[str, Any]]) -> SendResult:
    s = get_settings()
    if not configured(s):
        return SendResult(False, "failed")
    body = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": to.lstrip("+"),
        "type": "template",
        "template": {"name": template, "language": {"code": lang_code}, "components": components},
    }
    try:
        status, data = _http(_messages_url(s), body, s.whatsapp_token.strip())
    except ValueError:
        return SendResult(False, "failed")
    if status == 0:
        return SendResult(False, "network")
    if 200 <= status < 300 and data.get("messages"):
        return SendResult(True)
    err = data.get("error") if isinstance(data.get("error"), dict) else {}
    code = err.get("code") if isinstance(err.get("code"), int) else 0
    # The code and Meta's short type only: a message text can quote the number.
    logger.warning("whatsapp: send refused (HTTP %s, code %s)", status, code)
    return SendResult(False, _REASONS.get(code, "failed"), code)


def _text(value: str) -> dict[str, Any]:
    value = " ".join((value or "").split())
    return {"type": "text", "text": value[:_PARAM_MAX] or "-"}


def send_code(contact: WhatsAppContact, code: str) -> SendResult:
    """The verification code, in the owner's AUTHENTICATION template: Meta's
    fixed "<code> is your verification code." with a copy-code button, whose
    button parameter repeats the code."""
    s = get_settings()
    lang = template_lang(contact.lang or "en", s)
    return _send(contact.phone, s.whatsapp_code_template_name.strip(), lang, [
        {"type": "body", "parameters": [{"type": "text", "text": code}]},
        {"type": "button", "sub_type": "url", "index": "0", "parameters": [{"type": "text", "text": code}]},
    ])


def digest_params(count: int, best: str) -> list[dict[str, Any]]:
    """The digest template's two NAMED body variables: {{job_count}} and
    {{top_job}}. Named, so the English and Hebrew versions can word them in
    their own order."""
    return [{"type": "body", "parameters": [
        {**_text(str(count)), "parameter_name": "job_count"},
        {**_text(best), "parameter_name": "top_job"},
    ]}]


def send_digest(contact: WhatsAppContact, count: int, best: str) -> SendResult:
    s = get_settings()
    return _send(contact.phone, s.whatsapp_template_name.strip(), template_lang(contact.lang or "en", s),
                 digest_params(count, best))


def record_send(contact: WhatsAppContact, result: SendResult, now: datetime | None = None) -> None:
    """What a send tells us about the number. A person who is not on WhatsApp or
    stopped these messages is not sent to again until they set it up anew."""
    moment = now or datetime.now(timezone.utc)
    if result.ok:
        contact.last_sent_at = moment
        contact.last_error = ""
        return
    contact.last_error = result.reason
    if result.reason in ("not_on_whatsapp", "opted_out"):
        contact.verified_at = None
        contact.opted_in_at = None


# --- the code -------------------------------------------------------------------
def _code_hash(user_id: int, phone: str, code: str) -> str:
    return hkey("wa-code", str(user_id), phone, code)


def new_code(contact: WhatsAppContact, now: datetime | None = None) -> str:
    moment = now or datetime.now(timezone.utc)
    code = f"{secrets.randbelow(10**6):06d}"
    contact.code_hash = _code_hash(contact.user_id, contact.phone, code)
    contact.code_expires_at = moment + CODE_TTL
    contact.code_attempts = 0
    return code


def check_code(contact: WhatsAppContact, typed: str, now: datetime | None = None) -> str:
    """"ok", "expired" (none pending, or past its ten minutes), "locked" (five
    wrong tries) or "wrong". A right code verifies and is spent."""
    moment = now or datetime.now(timezone.utc)
    expires = as_utc(contact.code_expires_at)
    if not contact.code_hash or expires is None or moment >= expires:
        return "expired"
    if int(contact.code_attempts or 0) >= CODE_ATTEMPTS:
        return "locked"
    digits = re.sub(r"\D", "", typed or "")
    if len(digits) == 6 and hmac.compare_digest(
        _code_hash(contact.user_id, contact.phone, digits).encode(), contact.code_hash.encode()
    ):
        contact.verified_at = moment
        contact.code_hash = ""
        contact.code_expires_at = None
        contact.code_attempts = 0
        return "ok"
    contact.code_attempts = int(contact.code_attempts or 0) + 1
    return "locked" if contact.code_attempts >= CODE_ATTEMPTS else "wrong"


def ready(contact: WhatsAppContact | None) -> bool:
    """Opted in and proven: the only numbers a digest goes to."""
    return bool(contact is not None and contact.phone and contact.opted_in_at and contact.verified_at)
