"""Turn raw resume text into a structured ResumeModel via the LLM, and build the
immutable facts ledger used by the fabrication guard."""
from __future__ import annotations

import re

from app.config import get_settings
from app.core.skills import normalize_resume_skills
from app.llm.client import get_llm_client
from app.llm import prompts
from app.llm.limits import require_within
from app.models import Education, Experience, FactsLedger, ResumeModel

# Matches things like "20%", "$1.2M", "3+ years", "1,000", "10x"
_NUMBER_RE = re.compile(r"\$?\d[\d,.]*\s*(?:%|x|\+|k|m|bn|b|years?|yrs?)?", re.IGNORECASE)


def structure_resume(raw_text: str) -> ResumeModel:
    # Refused, not truncated: this text becomes the user's master résumé, and a
    # silently shortened CV is data loss they would discover from a recruiter.
    # Checked BEFORE the call so an oversize upload costs nothing. Read at call
    # time so the smoke test can env-override it (the max_upload_mb precedent).
    require_within(raw_text, get_settings().max_resume_kb, "resume")
    client = get_llm_client()
    data = client.complete_json(
        prompts.STRUCTURE_RESUME_SYSTEM,
        prompts.structure_resume_user(raw_text),
    )
    # THE ONE SERVER-SIDE DOOR for skill normalisation, and the placement is the
    # whole of the decision. This is the LLM's fresh output — a CV that listed
    # "Python, SQL, Go" on one line arrives here as a single skill, and nothing
    # downstream can tell that apart from a genuinely long skill. It is also the
    # last moment the résumé is not yet anything the user owns.
    #
    # NOT a `model_validator` on `ResumeModel`, which is where it would look
    # tidiest. A validator runs on every construction — i.e. every READ of every
    # stored master, tracker résumé, saved kit and version snapshot — so it would
    # silently rewrite all of them without any of them being a write: bypassing
    # `resume_versions.snapshot` (which only fires on a write) and breaking its
    # byte-identical dedupe, so the first save after deploy burns one of 20 undo
    # slots on a no-op. It would also fire between `original` and `tailored`
    # inside `TailorResult`, orphaning the frontend's text-derived
    # `@skills.<key>` tailoring anchors. A smoke check greps `app/models` to keep
    # it out, because behaviour alone cannot tell the two placements apart.
    return normalize_resume_skills(ResumeModel.model_validate(data))


def build_facts_ledger(resume: ResumeModel) -> FactsLedger:
    """Extract atomic, immutable facts that tailoring must never invent or alter."""
    ledger = FactsLedger()
    for exp in resume.experience:
        _add(ledger.employers, exp.company)
        _add(ledger.titles, exp.title)
        _add(ledger.dates, exp.start_date)
        _add(ledger.dates, exp.end_date)
        for b in exp.bullets:
            ledger.numbers.extend(_extract_numbers(b))
    for edu in resume.education:
        _add(ledger.institutions, edu.institution)
        _add(ledger.degrees, edu.degree)
        _add(ledger.dates, edu.start_date)
        _add(ledger.dates, edu.end_date)
    for cert in resume.certifications:
        _add(ledger.certifications, cert)
    for ms in resume.military_service:
        _add(ledger.military, ms.unit)
        _add(ledger.military, ms.role)
        _add(ledger.military, ms.rank)
        _add(ledger.dates, ms.start_date)
        _add(ledger.dates, ms.end_date)
        for b in ms.bullets:
            ledger.numbers.extend(_extract_numbers(b))
    # Projects contribute NUMBERS only — no employer/title/date claim lives here,
    # and PLAN 18.3 already cuts projects the tailor promoted into Experience.
    # They were missing entirely until PLAN 20.5/C1: the omission was symmetric
    # (the guard rebuilds a ledger the same way from the tailored résumé, so it
    # produced no false positives) which is exactly why it went unnoticed — a
    # metric invented into a project bullet simply passed. Projects are the
    # section the tailor rewrites most freely, so that was the wrong section to
    # leave unguarded.
    for proj in resume.projects:
        ledger.numbers.extend(_extract_numbers(proj.name))
        ledger.numbers.extend(_extract_numbers(proj.description))
        for b in proj.bullets:
            ledger.numbers.extend(_extract_numbers(b))
    ledger.numbers.extend(_extract_numbers(resume.summary))
    # Deliberately NOT folded into `titles`: a headline is positioning, not an
    # employment record, so the generic title diff must not fire every time
    # tailoring rewords it. `check_fabrication` reads it for rank inflation.
    _add(ledger.headlines, resume.headline)

    # De-duplicate while preserving order.
    for field in ("employers", "titles", "dates", "institutions", "degrees", "certifications", "numbers", "military", "headlines"):
        setattr(ledger, field, _dedupe(getattr(ledger, field)))
    return ledger


def _extract_numbers(text: str) -> list[str]:
    return [m.group().strip() for m in _NUMBER_RE.finditer(text or "")]


def _add(target: list[str], value: str) -> None:
    if value and value.strip():
        target.append(value.strip())


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for it in items:
        key = it.lower()
        if key not in seen:
            seen.add(key)
            out.append(it)
    return out
