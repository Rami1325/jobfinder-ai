"""Code-enforced anti-fabrication check.

After tailoring, re-extract atomic facts from the output and diff against the
original ledger. Any NEW employer / title / date / credential / metric that
wasn't in the original is flagged for the user to review.
"""
from __future__ import annotations

from app.models import FabricationFlag, FactsLedger, ResumeModel
from app.parsers.structurer import build_facts_ledger


def _norm(s: str) -> str:
    return " ".join(s.lower().split())


def _known(value: str, allowed: list[str]) -> bool:
    v = _norm(value)
    if not v:
        return True
    allowed_norm = [_norm(a) for a in allowed]
    # Exact or containment match in either direction tolerates light rephrasing
    # (e.g. "Senior Engineer" vs "Engineer") without flagging.
    return any(v == a or v in a or a in v for a in allowed_norm if a)


def check_fabrication(tailored: ResumeModel, ledger: FactsLedger) -> list[FabricationFlag]:
    flags: list[FabricationFlag] = []
    new = build_facts_ledger(tailored)

    def scan(values: list[str], allowed: list[str], category: str) -> None:
        for v in values:
            if not _known(v, allowed):
                flags.append(
                    FabricationFlag(
                        category=category,
                        value=v,
                        detail=f"'{v}' was not present in the original resume.",
                    )
                )

    scan(new.employers, ledger.employers, "employer")
    scan(new.titles, ledger.titles, "title")
    scan(new.dates, ledger.dates, "date")
    scan(new.institutions, ledger.institutions, "institution")
    scan(new.degrees, ledger.degrees, "degree")
    scan(new.certifications, ledger.certifications, "credential")
    scan(new.numbers, ledger.numbers, "number")
    scan(new.military, ledger.military, "military")
    return flags
