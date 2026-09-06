"""Deterministic language detection (Hebrew vs. English).

Pure regex on the Hebrew Unicode block — never the LLM — so pipeline behavior
is reproducible and testable offline. Shared by the JD analyzer, the prompt
language notes, and the job providers (Drushim/Comeet).
"""
from __future__ import annotations

import re

from app.models import ResumeModel

# Hebrew block U+0590-U+05FF: letters incl. finals (ך ם ן ף ץ), niqqud, geresh.
HEBREW_RE = re.compile("[\\u0590-\\u05FF]")


def detect_language(text: str) -> str:
    """"he" if the text contains any Hebrew letters, else "en"."""
    return "he" if HEBREW_RE.search(text) else "en"


def resume_language(resume: ResumeModel) -> str:
    """Detect the language a resume is written in.

    Only prose fields count (summary, skills, titles, bullets, project /
    education text) — company names, locations, and contact info are excluded
    so an English resume at a Hebrew-named employer stays "en".
    """
    parts = [resume.summary, " ".join(resume.skills)]
    for exp in resume.experience:
        parts.append(exp.title)
        parts.extend(exp.bullets)
    for proj in resume.projects:
        parts.append(proj.description)
        parts.extend(proj.bullets)
    for edu in resume.education:
        parts.extend([edu.degree, edu.field, edu.details])
    for ms in resume.military_service:
        parts.append(ms.role)
        parts.extend(ms.bullets)
    return detect_language(" ".join(parts))
