"""Which order the resume sections are laid out in (PLAN 17.5).

A fixed order serves the wrong reader half the time. Someone with eight years
of work should lead with Experience; a student, a fresh graduate, or anyone
still studying should lead with Education, because that is the strongest thing
on the page and a recruiter reads the top third.

The rule is deterministic — dates and section contents, no LLM call — so the
same resume always lays out the same way and the choice is explainable. Both
renderers and the on-screen preview read this, so the download can never
disagree with what the user was shown.
"""
from __future__ import annotations

from app.core.dates import is_current, parse_date, years_of_experience
from app.models import ResumeModel

# Section keys in layout order. Both renderers own a builder per key.
EXPERIENCED_ORDER: tuple[str, ...] = (
    "summary", "skills", "experience", "projects", "education", "military",
    "certifications", "languages",
)
EARLY_CAREER_ORDER: tuple[str, ...] = (
    "summary", "skills", "education", "experience", "projects", "military",
    "certifications", "languages",
)

# Below this, education is still the headline credential.
EARLY_CAREER_YEARS = 3
# How long after starting a degree a blank end date can still mean "in progress".
STUDY_WINDOW_YEARS = 6


def _studying_now(resume: ResumeModel) -> bool:
    """Whether any degree is still in progress: explicitly current, ending in
    the future, or started recently with the end date left blank."""
    year = _this_year()
    for edu in resume.education:
        end = (edu.end_date or "").strip()
        if is_current(end) or "expected" in end.lower() or "צפוי" in end:
            return True
        parsed = parse_date(end)
        if parsed and parsed[0] > year:
            return True
        if not end:
            start = parse_date(edu.start_date)
            # A blank end date only means "still there" when the studies began
            # recently. On a degree from 2005 it just means the field was never
            # filled in — reading that as "student" would push a veteran's
            # Education section above their Experience.
            if start and year - start[0] <= STUDY_WINDOW_YEARS:
                return True
    return False


def _this_year() -> int:
    from datetime import date

    return date.today().year


def is_early_career(resume: ResumeModel) -> bool:
    """True when Education should outrank Experience."""
    if not resume.education:
        return False  # nothing to promote
    if not resume.experience:
        return True
    if _studying_now(resume):
        return True
    return years_of_experience(resume) < EARLY_CAREER_YEARS


def section_order(resume: ResumeModel) -> tuple[str, ...]:
    return EARLY_CAREER_ORDER if is_early_career(resume) else EXPERIENCED_ORDER
