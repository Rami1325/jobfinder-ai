"""Standalone ATS scanner: deterministic format/content checks + optional JD keyword coverage.

Every check is pure Python and explainable — the user sees exactly what tripped
and what to do about it. Nothing here rewrites the résumé: the scanner reports
and the candidate decides, which is the same contract the fabrication guard has.
"""
from __future__ import annotations

import re

from app.core.dates import ats_form, is_current, years_of_experience
from app.core.scorer import keyword_analysis
from app.models import ATSIssue, ATSScanResult, JDModel, ResumeModel

# Terms an ATS matches literally: a résumé that only ever writes "CI/CD" misses
# a JD asking for "continuous integration", and the reverse misses one asking
# for "CI/CD". Writing both forms once covers both searches. Only pairs where
# BOTH forms genuinely appear in job ads are listed — nobody writes
# "application programming interface", so API is not here.
_ACRONYMS: tuple[tuple[str, str], ...] = (
    ("CI/CD", "continuous integration"),
    ("ML", "machine learning"),
    ("AI", "artificial intelligence"),
    ("NLP", "natural language processing"),
    ("QA", "quality assurance"),
    ("SaaS", "software as a service"),
    ("AWS", "Amazon Web Services"),
    ("GCP", "Google Cloud Platform"),
    ("UX", "user experience"),
    ("UI", "user interface"),
    ("SEO", "search engine optimization"),
    ("CRM", "customer relationship management"),
    ("ERP", "enterprise resource planning"),
    ("R&D", "research and development"),
    ("IDF", "Israel Defense Forces"),
)
_ACRONYM_REPORT_CAP = 3

# Résumés use the implied first person ("Built X"), never "I built X".
_PRONOUNS = re.compile(r"(?<!\w)(i|i'm|i've|my|me|myself|אני|שלי)(?!\w)", re.IGNORECASE)

_LONG_BULLET_WORDS = 34
_SHORT_BULLET_WORDS = 4
# A skill is a TERM an ATS matches ("PostgreSQL", "prompt engineering"), not a
# sentence. Six words is the floor because the longest entries on a real résumé
# here run to four ("evaluation and fallback handling", "prompt and system
# design"), and the longest phrase a job ad genuinely names tops out around five
# ("continuous integration and continuous delivery"). Above that it is prose, and
# prose in the skills list scores as one keyword however much it says.
_LONG_SKILL_WORDS = 6
_LONG_SKILL_REPORT_CAP = 2
# Roughly what one page holds in our renderers (see app/render/templates.py).
_ONE_PAGE_WORDS = 650
_ONE_PAGE_MAX_YEARS = 10


def _resume_text(resume: ResumeModel) -> str:
    parts = [resume.headline, resume.summary, ", ".join(resume.skills)]
    for exp in resume.experience:
        parts += [exp.title, exp.company, *exp.bullets]
    for proj in resume.projects:
        parts += [proj.name, proj.description, *proj.bullets]
    for edu in resume.education:
        parts += [edu.institution, edu.degree, edu.field, edu.details]
    for ms in resume.military_service:
        parts += [ms.unit, ms.role, *ms.bullets]
    parts += list(resume.certifications)
    return " \n".join(p for p in parts if p)


def _all_bullets(resume: ResumeModel) -> list[str]:
    bullets = [b for e in resume.experience for b in e.bullets]
    bullets += [b for p in resume.projects for b in p.bullets]
    bullets += [b for m in resume.military_service for b in m.bullets]
    return [b for b in bullets if b.strip()]


def _has_term(text: str, term: str) -> bool:
    return re.search(rf"(?<!\w){re.escape(term)}(?!\w)", text, re.IGNORECASE) is not None


def _date_issue(resume: ResumeModel) -> ATSIssue:
    """A date the parser cannot read is a role it may mis-date or drop. The fix
    is always the same shape, so the suggestion carries the rewritten value."""
    unreadable: list[str] = []
    rewrites: list[str] = []
    for exp in resume.experience:
        for value in (exp.start_date, exp.end_date):
            raw = (value or "").strip()
            if not raw or is_current(raw):
                continue
            suggested = ats_form(raw)
            if not suggested:
                unreadable.append(raw)
            elif suggested.lower() != raw.lower():
                rewrites.append(f"'{raw}' → '{suggested}'")
    if unreadable:
        return ATSIssue(
            label="Unreadable employment dates",
            severity="bad",
            detail="An ATS can't parse "
            + ", ".join(f"'{u}'" for u in unreadable[:3])
            + ". Write them as 'Mar 2020' or '2020'.",
        )
    if rewrites:
        return ATSIssue(
            label="Dates could be written more ATS-safely",
            severity="warn",
            detail="Parsers are most reliable on 'Mar 2020'. Try " + "; ".join(rewrites[:3]) + ".",
        )
    return ATSIssue(label="Dates are in an ATS-readable format", severity="good")


def _acronym_issue(text: str) -> ATSIssue:
    missing = [
        (short, long) for short, long in _ACRONYMS if _has_term(text, short) != _has_term(text, long)
    ]
    if not missing:
        return ATSIssue(label="Acronyms are spelled out", severity="good")
    pairs = "; ".join(
        f"'{short}' → add '{long}'" if _has_term(text, short) else f"'{long}' → add '{short}'"
        for short, long in missing[:_ACRONYM_REPORT_CAP]
    )
    return ATSIssue(
        label="Pair each acronym with its long form once",
        severity="warn",
        detail=f"Recruiters search both spellings: {pairs}.",
    )


def _pronoun_issue(resume: ResumeModel) -> ATSIssue:
    hits = sorted(
        {
            m.group(0)
            for chunk in [resume.summary, *_all_bullets(resume)]
            for m in _PRONOUNS.finditer(chunk or "")
        }
    )
    if not hits:
        return ATSIssue(label="No first-person pronouns", severity="good")
    return ATSIssue(
        label="Drop the first-person pronouns",
        severity="warn",
        detail="Résumés use the implied first person — 'Built the API', not 'I built the API'. "
        f"Found: {', '.join(hits[:4])}.",
    )


def _bullet_length_issue(bullets: list[str]) -> ATSIssue:
    long_ones = [b for b in bullets if len(b.split()) > _LONG_BULLET_WORDS]
    short_ones = [b for b in bullets if len(b.split()) < _SHORT_BULLET_WORDS]
    if not long_ones and not short_ones:
        return ATSIssue(label="Bullet lengths are well judged", severity="good")
    bits = []
    if long_ones:
        verb = "runs" if len(long_ones) == 1 else "run"
        bits.append(f"{len(long_ones)} {verb} past {_LONG_BULLET_WORDS} words and get skimmed")
    if short_ones:
        verb = "is" if len(short_ones) == 1 else "are"
        bits.append(f"{len(short_ones)} {verb} under {_SHORT_BULLET_WORDS} words and says too little"
                    if len(short_ones) == 1
                    else f"{len(short_ones)} {verb} under {_SHORT_BULLET_WORDS} words and say too little")
    return ATSIssue(
        label="Some bullets are the wrong length", severity="warn", detail=" · ".join(bits) + "."
    )


def _skill_length_issue(skills: list[str]) -> ATSIssue:
    """Report a skill written as a sentence. Never rewrite one.

    This is the honest home for "a skill is a sentence": the route is
    deterministic and uncapped, this module reaches no model, and the fix is a
    judgement call about words the user chose. `structure_resume` splits the
    entries a CV *punctuated* as a list; a sentence carries no separator, so
    nothing may split it and nothing may shorten it — that would be truncating
    the user's own document. The scanner shows the count and quotes the entry,
    exactly as the ATS x-ray shows rather than asserts.
    """
    long_ones = [s for s in skills if len(s.split()) > _LONG_SKILL_WORDS]
    if not long_ones:
        return ATSIssue(label="Skills read as terms, not sentences", severity="good")
    verb = "runs" if len(long_ones) == 1 else "run"
    return ATSIssue(
        label="Some skills are written as sentences",
        severity="warn",
        detail=f"{len(long_ones)} {verb} past {_LONG_SKILL_WORDS} words: "
        + "; ".join(f"'{s}'" for s in long_ones[:_LONG_SKILL_REPORT_CAP])
        + ". An ATS matches the term, so a whole sentence scores as one keyword — "
        "list the terms a job ad would name instead.",
    )


def _length_issue(resume: ResumeModel, text: str) -> ATSIssue:
    words = len(text.split())
    years = years_of_experience(resume)
    if words <= _ONE_PAGE_WORDS or years >= _ONE_PAGE_MAX_YEARS:
        return ATSIssue(label="Length suits the experience", severity="good")
    return ATSIssue(
        label="Long for the experience shown",
        severity="warn",
        detail=f"About {words} words against {years} years of experience. Under "
        f"{_ONE_PAGE_MAX_YEARS} years one page reads better — cut the weakest bullets first.",
    )


def scan_resume(resume: ResumeModel, jd: JDModel | None = None) -> ATSScanResult:
    """Deterministic scan. Takes an ALREADY-ANALYSED JD or none at all.

    It must never read a posting itself. The route is uncapped precisely
    because nothing in this module reaches the model, and analysing a JD right
    here is what turned that exemption into a free door onto it. The caller
    analyses once on a capped route. See `ATSScanRequest`.

    A smoke check greps this module's source for the analyser and the client
    factory, so re-importing either fails the build rather than quietly
    re-opening the door.
    """
    issues: list[ATSIssue] = []
    c = resume.contact
    text = _resume_text(resume)
    bullets = _all_bullets(resume)

    issues.append(
        ATSIssue(label="Email present", severity="good")
        if c.email
        else ATSIssue(label="Missing email", severity="bad", detail="Add a professional email address.")
    )
    issues.append(
        ATSIssue(label="Phone present", severity="good")
        if c.phone
        else ATSIssue(label="Missing phone", severity="warn", detail="Add a phone number.")
    )
    issues.append(
        ATSIssue(label="Summary present", severity="good")
        if resume.summary
        else ATSIssue(label="No summary", severity="warn", detail="A short targeted summary helps ATS and recruiters.")
    )
    issues.append(
        ATSIssue(label=f"{len(resume.skills)} skills listed", severity="good")
        if len(resume.skills) >= 5
        else ATSIssue(label="Few skills listed", severity="warn", detail="List more of your real, relevant hard skills.")
    )
    # Gated the way `_bullet_length_issue` is gated on `bullets`: a résumé with
    # no skills at all already carries "Few skills listed", and handing the
    # emptiest possible CV a free "good" would inflate `format_health` on the
    # one document that deserves it least.
    if resume.skills:
        issues.append(_skill_length_issue(resume.skills))

    if resume.experience:
        if bullets:
            quant = sum(1 for b in bullets if re.search(r"\d", b))
            if quant / len(bullets) >= 0.4:
                issues.append(ATSIssue(label="Bullets are quantified", severity="good"))
            else:
                issues.append(
                    ATSIssue(
                        label="Add metrics to bullets",
                        severity="warn",
                        detail=f"Only {quant} of {len(bullets)} bullets contain numbers.",
                    )
                )
        missing_dates = sum(1 for e in resume.experience if not (e.start_date or e.end_date))
        issues.append(
            ATSIssue(label="Dates present on all roles", severity="good")
            if missing_dates == 0
            else ATSIssue(label="Missing employment dates", severity="bad", detail="ATS needs start/end dates on each role.")
        )
        issues.append(_date_issue(resume))
    else:
        issues.append(ATSIssue(label="No experience section", severity="bad", detail="Add a work experience section."))

    issues.append(_acronym_issue(text))
    issues.append(_pronoun_issue(resume))
    if bullets:
        issues.append(_bullet_length_issue(bullets))
    issues.append(_length_issue(resume, text))

    coverage = 0.0
    gaps = []
    if jd is not None:
        coverage, gaps = keyword_analysis(resume, jd)

    good = sum(1 for i in issues if i.severity == "good")
    format_health = round(100.0 * good / len(issues), 1) if issues else 0.0
    score = round(0.5 * format_health + 0.5 * coverage, 1) if jd is not None else format_health

    return ATSScanResult(score=score, keyword_coverage=coverage, issues=issues, gaps=gaps)
