"""True auto-submit (PLAN 8.4) — Comeet channel only.

Research outcome (live-verified 2026-07-06, see PLAN.md):
- Drushim and JobMaster expose NO apply emails; both boards apply through
  their own account-gated site flows (sendcv.aspx / a JS ApplyJob call), so
  automating them would mean scripting a proprietary logged-in flow. Not
  legitimate → not built.
- Comeet's own hosted careers pages submit applications to a public endpoint:
  `POST comeet.co/careers-api/1.0/company/{comp_uid}/positions/{pos_uid}/apply
  ?token=<public page token>` with a multipart form of snake_cased candidate
  fields (first_name, last_name, email, phone, comment) plus the CV file in a
  `cv` field — extracted from comeet.com/common/careers.js. That is the exact
  channel the position page's Apply button uses, so submitting there IS the
  legitimate application path. Screening questionnaires, when a company has
  them, are completable post-submit via a URL the API returns.

Hard guardrails (every one enforced in `submit_kit`, none bypassable from the
API): only kits a human APPROVED in the 8.2 review, only guard-clean kits
(`flag_count == 0` — flagged kits are never auto-submittable, the reviewer
override only reaches the tracker), only while the draft on the job's row still
reads exactly 0 flags (PLAN 31.4/5: it can be tailored again or typed on after
the approval, and an unknown count is never clean), only the Comeet channel
(LinkedIn is never automated), one auto-application per company per user, a
per-user daily cap (`DAILY_SUBMIT_CAP`), and a full audit trail on the tracker
application.

`parse_comeet_position_url`, `split_name`, and `build_multipart` are pure
functions pinned by the smoke test; the HTTP POST is injectable so the whole
submit path is testable offline.

Every refusal is a `SubmitRefused`: a stable code from `REFUSAL_CODES`, the
values its sentence names, and an English sentence. The job's page translates
the code (the English went to a Hebrew page verbatim until 2026-09-27), and the
route keeps the English as `detail` for a tab loaded before the codes existed.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Callable, NamedTuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.applications import draft_guard_clean
from app.db.models import Application, TailorKit, User
from app.models import ResumeModel

_APPLY_URL = (
    "https://www.comeet.co/careers-api/1.0/company/{comp_uid}/positions/{pos_uid}/apply"
)
_TIMEOUT_S = 60
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
)

# Every way the send can be refused, as the code the job's page translates
# (`frontend/src/lib/sendRefusal.ts`). check-mirrors 81 reads this tuple and
# requires a sentence for each code in both locales, and the smoke test requires
# every `raise` in the send path to name one of these, and each of these to be
# raised somewhere. ONE quoted entry per line: the check reads it line by line.
REFUSAL_CODES = (
    "kit_not_found",
    "already_sent",
    "not_approved",
    "kit_flagged",
    "not_comeet",
    "not_comeet_url",
    "recaptcha",
    "company_already_sent",
    "application_missing",
    "draft_changed",
    "resume_unreadable",
    "contact_missing",
    "careers_unreachable",
    "comeet_locked",
    "comeet_declined",
    "comeet_unreachable",
)


class SubmitRefused(ValueError):
    """The send refused, or Comeet declined: `code` (one of REFUSAL_CODES), the
    values the translated sentence names (`params`: `company`, `status`), and
    the English sentence as the exception's text. A ValueError still, so a
    caller that only knew the old contract ("raises ValueError with a
    user-facing message") reads it unchanged."""

    def __init__(self, code: str, message: str, **params: str | int) -> None:
        super().__init__(message)
        self.code = code
        self.params = params


# https://www.comeet.com/jobs/<slug>/<CO.UID>/<position-slug>/<PO.UID>
_POSITION_URL_RE = re.compile(
    r"^https?://(?:www\.)?comeet\.com/jobs/([A-Za-z0-9_-]+)/"
    r"([0-9A-Fa-f]{2}\.[0-9A-Fa-f]{3})/[^/?#]+/([0-9A-Fa-f]{2}\.[0-9A-Fa-f]{3})"
)

# (url, body, content_type) -> response body. Injectable for offline tests.
PostFn = Callable[[str, bytes, str], str]

# Comeet enables reCAPTCHA per POSITION (not per company): a position page ships
# `RECAPTCHA_ENABLED = true` and its own client appends a grecaptcha_token to the
# apply form. We can't (and won't) solve a reCAPTCHA, so those positions can't be
# auto-submitted — the public endpoint answers 423 ("Locked") without the token.
# Detected pre-flight from the position page so we refuse cleanly instead of
# firing a doomed POST and burning the daily cap. Note the careers *listing*
# page can say false while a position under it says true — always check the
# position page. (Injectable so the smoke test never hits the network.)
_RECAPTCHA_RE = re.compile(r"RECAPTCHA_ENABLED\s*=\s*true", re.IGNORECASE)


def _fetch_page(url: str) -> str:
    from app.core.job_match import _http_get

    return _http_get(url, timeout=_TIMEOUT_S)


def position_requires_recaptcha(position_url: str, fetch: Callable[[str], str] | None = None) -> bool:
    """True when the Comeet position page gates applications behind reCAPTCHA.
    Best-effort: a fetch failure returns False (let the send attempt surface the
    real error) rather than blocking a submit on a transient network blip."""
    try:
        return bool(_RECAPTCHA_RE.search((fetch or _fetch_page)(position_url)))
    except Exception:  # noqa: BLE001 - network/markup trouble ⇒ don't block on a guess
        return False


class ComeetPositionRef(NamedTuple):
    slug: str
    company_uid: str
    position_uid: str


def parse_comeet_position_url(url: str) -> ComeetPositionRef:
    """(slug, company_uid, position_uid) from a Comeet hosted-position URL;
    raises ValueError otherwise. Pure function pinned by the smoke test."""
    m = _POSITION_URL_RE.match(url.strip())
    if not m:
        raise ValueError(
            "This kit's job URL isn't a Comeet position page, so it can't be "
            "auto-submitted."
        )
    return ComeetPositionRef(m.group(1), m.group(2), m.group(3))


def split_name(full_name: str) -> tuple[str, str]:
    """(first, last) from a free-form full name — Comeet's form takes them
    separately. Single-word names repeat as both (the API wants both non-empty).
    Pure function pinned by the smoke test."""
    parts = full_name.split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], parts[0]
    return parts[0], " ".join(parts[1:])


def build_multipart(
    fields: dict[str, str],
    file_field: str,
    file_name: str,
    file_bytes: bytes,
    file_content_type: str = "application/pdf",
    boundary: str = "",
) -> tuple[bytes, str]:
    """(body, content-type header) for a multipart/form-data POST — text fields
    first, then one file part. UTF-8 throughout (candidate names/cover letters
    can be Hebrew). Pure given `boundary`; pinned by the smoke test."""
    boundary = boundary or f"----jobfinder{uuid.uuid4().hex}"
    lines: list[bytes] = []
    for key, value in fields.items():
        if value is None or value == "":
            continue
        lines.append(f"--{boundary}\r\n".encode())
        lines.append(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode())
        lines.append(str(value).encode("utf-8") + b"\r\n")
    lines.append(f"--{boundary}\r\n".encode())
    lines.append(
        f'Content-Disposition: form-data; name="{file_field}"; '
        f'filename="{file_name}"\r\n'
        f"Content-Type: {file_content_type}\r\n\r\n".encode()
    )
    lines.append(file_bytes + b"\r\n")
    lines.append(f"--{boundary}--\r\n".encode())
    return b"".join(lines), f"multipart/form-data; boundary={boundary}"


def _default_post(url: str, body: bytes, content_type: str) -> str:
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "User-Agent": _UA,
            "Content-Type": content_type,
            "Accept": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as resp:
        return resp.read().decode("utf-8", "replace")


def _resolve_token(db: Session, ref: ComeetPositionRef) -> str:
    """The company's public careers-page token (same one the search provider
    scrapes/caches): registry first, live scrape as fallback."""
    from app.core.providers.comeet import _scrape_token
    from app.db.comeet import save_tokens, upsert_company
    from app.db.models import ComeetCompany

    row = db.execute(
        select(ComeetCompany).where(ComeetCompany.slug == ref.slug)
    ).scalars().first()
    if row is not None and row.token:
        return row.token
    careers_url = f"https://www.comeet.com/jobs/{ref.slug}/{ref.company_uid}"
    try:
        token = _scrape_token(careers_url)
    except Exception as e:  # noqa: BLE001 - network/markup trouble, user-facing
        raise SubmitRefused(
            "careers_unreachable",
            f"Couldn't reach {ref.slug}'s Comeet careers page to authorize the "
            "application. Try again in a minute.",
            company=ref.slug,
        ) from e
    if row is not None:
        save_tokens(db, {ref.slug: token})
    else:
        upsert_company(
            db, slug=ref.slug, name=ref.slug, uid=ref.company_uid,
            token=token, careers_url=careers_url,
        )
    return token


def _now() -> datetime:
    return datetime.now(timezone.utc)


def submit_kit(
    db: Session,
    user: User,
    kit: TailorKit,
    charge: Callable[[], None] | None = None,
    post_fn: PostFn | None = None,
    recaptcha_fn: Callable[[str], bool] | None = None,
) -> TailorKit:
    """Send one approved kit's application through Comeet's public apply
    endpoint, enforcing every 8.4 guardrail. Raises `SubmitRefused` (a
    ValueError) with a code and an English sentence on any refusal — the route
    maps it to a 400 carrying both.

    `charge` (the daily-cap check) runs AFTER the guardrails but BEFORE the
    network send, so refused submits don't burn the cap but every real send
    attempt does."""
    # --- Guardrails -------------------------------------------------------
    if kit.status == "submitted":
        raise SubmitRefused("already_sent", "This application was already sent.")
    if kit.status != "approved":
        raise SubmitRefused("not_approved", "Only a kit you approved in review can be sent.")
    if (kit.flag_count or 0) > 0:
        raise SubmitRefused(
            "kit_flagged",
            "This kit has fabrication flags — flagged kits are never "
            "auto-submitted, even after approval.",
        )
    if (kit.source or "") != "comeet":
        raise SubmitRefused(
            "not_comeet",
            "Auto-submit only works for Comeet postings (the one channel with a "
            "public application API). Apply to this one on the board itself.",
        )
    try:
        ref = parse_comeet_position_url(kit.url or "")
    except ValueError as e:
        raise SubmitRefused("not_comeet_url", str(e)) from e

    # reCAPTCHA-gated positions can't be auto-submitted: the apply endpoint
    # answers 423 without a grecaptcha_token we can't (and won't) produce.
    # Refuse here — a cheap guardrail alongside the others, before the app-row
    # lookup, the cap charge, and any network send — and point at the
    # assisted-apply path (the browser extension fills the form; the user
    # clicks Apply, which produces the token legitimately).
    if (recaptcha_fn or position_requires_recaptcha)(kit.url or ""):
        raise SubmitRefused(
            "recaptcha",
            f"{kit.company or ref.slug} protects this position with a reCAPTCHA "
            "bot check, so it can't be auto-submitted. Use the browser extension's "
            "assisted apply (it fills the form with this kit — you click Apply), or "
            "apply on the Comeet page directly.",
            company=kit.company or ref.slug,
        )

    company_key = (kit.company or "").strip().lower()
    if company_key:
        already = db.execute(
            select(TailorKit.id).where(
                TailorKit.user_id == user.id,
                TailorKit.status == "submitted",
                TailorKit.id != kit.id,
            )
        ).scalars().all()
        if already:
            sent_companies = {
                (r.company or "").strip().lower()
                for r in db.execute(
                    select(TailorKit).where(TailorKit.id.in_(already))
                ).scalars().all()
            }
            if company_key in sent_companies:
                raise SubmitRefused(
                    "company_already_sent",
                    f"You already auto-applied to {kit.company} — one application "
                    "per company. Apply to their other openings manually.",
                    company=kit.company or "",
                )

    app_row = db.get(Application, kit.application_id) if kit.application_id else None
    if app_row is None or app_row.user_id != user.id or not app_row.tailored_resume_json:
        raise SubmitRefused(
            "application_missing", "This kit's approved application is missing — re-approve it."
        )
    # PLAN 31.4/5: the kit's flags above were read when it was approved, but what
    # is sent is the row's draft NOW. The job's page can tailor the job again onto
    # this row, and the document writes every typed line to it with an unknown
    # count, so a clean kit is no answer for the draft that would go out.
    if not draft_guard_clean(app_row):
        raise SubmitRefused(
            "draft_changed",
            "The resume on this job changed after you approved it (a new tailor, "
            "or lines you typed), so it has no clean fabrication-guard reading to "
            "send on. Apply on the Comeet page, or with the extension's assisted apply.",
        )
    try:
        resume = ResumeModel.model_validate_json(app_row.tailored_resume_json)
    except Exception as e:  # noqa: BLE001 - corrupt row, user-facing
        raise SubmitRefused(
            "resume_unreadable", "This kit's approved resume can't be read — re-approve it."
        ) from e

    first, last = split_name(resume.contact.name.strip())
    email = resume.contact.email.strip()
    if not first or not email:
        raise SubmitRefused(
            "contact_missing",
            "Your resume needs a name and an email address before it can be "
            "sent — fix the contact section and re-approve.",
        )

    # --- Build the application -------------------------------------------
    from app.render.pdf_renderer import render_pdf

    token = _resolve_token(db, ref)
    pdf = render_pdf(resume)
    fields = {
        "first_name": first,
        "last_name": last,
        "email": email,
        "phone": resume.contact.phone.strip(),
        "linkedin_url": resume.contact.linkedin.strip(),
        "comment": (app_row.cover_letter or "").strip(),
    }
    body, content_type = build_multipart(fields, "cv", "resume.pdf", pdf)
    url = _APPLY_URL.format(comp_uid=ref.company_uid, pos_uid=ref.position_uid)
    url = f"{url}?token={urllib.parse.quote(token)}"

    if charge is not None:
        charge()  # daily cap — counts real send attempts only

    try:
        raw = (post_fn or _default_post)(url, body, content_type)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            payload = json.loads(e.read().decode("utf-8", "replace"))
            detail = str(payload.get("message") or payload.get("error") or "")
        except Exception:  # noqa: BLE001 - non-JSON error body
            pass
        if e.code == 423:
            # "Locked" — almost always a reCAPTCHA/bot gate our pre-flight
            # check didn't catch, or a position that just closed.
            raise SubmitRefused(
                "comeet_locked",
                f"{kit.company or ref.slug} locked this application against "
                "automated sending (usually a bot check, or the position just "
                "closed). Use the extension's assisted apply, or apply on Comeet "
                "directly.",
                company=kit.company or ref.slug,
            ) from e
        # Comeet's own words stay in the English sentence only: they are the
        # board's, in no language this app can translate.
        raise SubmitRefused(
            "comeet_declined",
            f"Comeet declined the application (HTTP {e.code})"
            + (f": {detail}" if detail else "."),
            status=int(e.code),
        ) from e
    except Exception as e:  # noqa: BLE001 - network trouble, user-facing
        raise SubmitRefused(
            "comeet_unreachable", "Couldn't reach Comeet to send the application. Try again."
        ) from e

    try:
        result = json.loads(raw) if raw.strip() else {}
    except Exception:  # noqa: BLE001 - success with a non-JSON body
        result = {}
    questionnaire_url = str(
        result.get("post_submit_questionnaires")
        or result.get("postSubmitQuestionnaires")
        or ""
    ).strip()

    # --- Audit trail ------------------------------------------------------
    now = _now()
    stamp = now.strftime("%Y-%m-%d %H:%M UTC")
    audit = (
        f"[auto-apply {stamp}] Sent to {kit.company or ref.slug} via Comeet's "
        f"careers API (position {ref.position_uid}): tailored PDF resume"
        + (" + cover letter" if fields["comment"] else "")
        + f", from kit #{kit.id}."
    )
    if questionnaire_url:
        audit += f" Follow-up questionnaire: {questionnaire_url}"
    app_row.status = "applied"
    # FIXB B13: stamped like a PATCH that changes the status. Without it the
    # inbox's rule 5 and the stale-application nudge read the kit's APPROVAL
    # (created_at) as the card's last change, so an older rejection received
    # between approval and send could close the card the user just sent.
    app_row.status_changed_at = now
    app_row.status_source = "manual"
    # Phase 29 (I3): the send IS the application date. Stamped only while
    # unknown, so a date already on the card is never overwritten.
    if app_row.applied_at is None:
        app_row.applied_at = now
    app_row.notes = (app_row.notes + "\n\n" if app_row.notes else "") + audit
    kit.status = "submitted"
    kit.submitted_at = now.replace(tzinfo=None)
    kit.submit_note = questionnaire_url
    db.commit()
    db.refresh(kit)
    return kit
