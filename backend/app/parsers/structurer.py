"""Turn raw resume text into a structured ResumeModel via the LLM, and build the
immutable facts ledger used by the fabrication guard."""
from __future__ import annotations

import re

from app.llm.client import get_llm_client
from app.llm import prompts
from app.models import Education, Experience, FactsLedger, ResumeModel

# Matches things like "20%", "$1.2M", "3+ years", "1,000", "10x"
_NUMBER_RE = re.compile(r"\$?\d[\d,.]*\s*(?:%|x|\+|k|m|bn|b|years?|yrs?)?", re.IGNORECASE)


def structure_resume(raw_text: str) -> ResumeModel:
    client = get_llm_client()
    data = client.complete_json(
        prompts.STRUCTURE_RESUME_SYSTEM,
        prompts.structure_resume_user(raw_text),
    )
    return ResumeModel.model_validate(data)


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
