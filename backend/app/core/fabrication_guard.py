"""Code-enforced anti-fabrication check.

After tailoring, re-extract atomic facts from the output and diff against the
original ledger. Any NEW employer / title / date / credential / metric that
wasn't in the original is flagged for the user to review.
"""
from __future__ import annotations

import re

from app.models import FabricationFlag, FactsLedger, ResumeModel
from app.parsers.structurer import build_facts_ledger

# Rank words a headline has to have earned. Repositioning is honest — a
# "Software Engineer" may lead with "Backend Engineer", the same work in the
# JD's wording — but promoting is not, and a rank the candidate never held is
# exactly what collapses in the first screening call. Hebrew ranks are listed
# too; the product is bilingual and a Hebrew CV inflates the same way.
_RANK_WORDS = (
    "senior", "sr", "lead", "staff", "principal", "head", "chief", "director",
    "manager", "vp", "vice president", "cto", "cio", "ceo", "cfo",
    "בכיר", "בכירה", "ראש", "מנהל", "מנהלת", "סמנכ\"ל", "מנכ\"ל",
)


def _norm(s: str) -> str:
    return " ".join(s.lower().split())


def _has_rank(text: str, word: str) -> bool:
    """Whole-word match, so 'lead' does not fire on 'leading' and the Hebrew
    ranks do not fire mid-word either (\\w is Unicode-aware in Python 3)."""
    return re.search(rf"(?<!\w){re.escape(word)}(?!\w)", _norm(text)) is not None


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
    flags.extend(_headline_flags(tailored, ledger))
    return flags


def drop_invented_roles(tailored: ResumeModel, ledger: FactsLedger) -> tuple[ResumeModel, list[str]]:
    """Remove experience entries whose employer never appears in the original.

    Structural repair, not a style choice. Splitting the tailor's rules into
    "roles are protected, projects are droppable" gave the model an obvious way
    to save a project it liked: promote it into experience, where nothing may
    remove it. It does exactly that often enough to matter, and the result
    claims employment at "JobFinder AI" — a fabricated employer is the single
    worst thing a CV can carry, and the one a reference check kills instantly.

    The guard already FLAGS this, but flags are advisory and this pipeline runs
    unattended over many jobs, so the invented rows are cut rather than
    reported. Removal only, and only for employers the ledger has never seen —
    `_known` tolerates rephrasing in both directions, so a lightly reworded real
    employer is never touched.

    Returns the cleaned résumé and the names removed (for the changelog: content
    must never disappear silently).
    """
    if not tailored.experience:
        return tailored, []
    kept, removed = [], []
    for exp in tailored.experience:
        label = (exp.company or exp.title or "").strip()
        if exp.company and not _known(exp.company, ledger.employers):
            removed.append(label)
            continue
        kept.append(exp)
    if not removed:
        return tailored, []
    out = tailored.model_copy(deep=True)
    out.experience = kept
    return out, removed


def _headline_flags(tailored: ResumeModel, ledger: FactsLedger) -> list[FabricationFlag]:
    """Flag a headline that promotes the candidate. Only the rank is checked —
    the wording is free, because restating the same work in the target role's
    language is the whole point of the headline."""
    headline = (tailored.headline or "").strip()
    if not headline:
        return []
    held = " ".join(ledger.titles + ledger.military + ledger.headlines)
    claimed = [w for w in _RANK_WORDS if _has_rank(headline, w) and not _has_rank(held, w)]
    if not claimed:
        return []
    return [
        FabricationFlag(
            category="headline",
            value=headline,
            detail=(
                f"The headline claims '{claimed[0]}' but no role in the original resume "
                "carries that level. Aim the title at the job without promoting yourself."
            ),
        )
    ]
