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
    ledger.numbers.extend(_extract_numbers(resume.summary))

    # De-duplicate while preserving order.
    for field in ("employers", "titles", "dates", "institutions", "degrees", "certifications", "numbers"):
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
