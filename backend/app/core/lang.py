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
HEBREW_WORD_RE = re.compile("[\\u0590-\\u05FF]+")
LATIN_WORD_RE = re.compile("[A-Za-z]+")

# A resume is Hebrew when at least one word in HEBREW_SHARE_DEN of its prose is
# Hebrew (PLAN 31.6/1). Integers, not a float, so `lib/lang.ts` computes the
# identical answer. Measured on `tests/fixtures/lang_cases.json` before it was
# chosen: Hebrew resumes that carry English titles and tech terms, the common
# Israeli shape, sit at 46-100% Hebrew words, and English resumes with a
# Hebrew trace (an organisation, a pasted degree, one typed word) at 0-7%. A
# plain majority misreads the first kind, and "any Hebrew letter", the rule
# this replaced, misreads the second.
HEBREW_SHARE_DEN = 5


def detect_language(text: str) -> str:
    """"he" if the text contains any Hebrew letters, else "en"."""
    return "he" if HEBREW_RE.search(text) else "en"


def _hebrew_words(text: str) -> tuple[int, int]:
    """(Hebrew words, all words) in `text`, a word being one script's run.

    "ב-Python" is two words, one of each: the prefix is Hebrew grammar and the
    term is not. Digits and punctuation count for neither side."""
    hebrew = len(HEBREW_WORD_RE.findall(text))
    return hebrew, hebrew + len(LATIN_WORD_RE.findall(text))


def prose_language(text: str) -> str | None:
    """The language of one piece of prose by the same share of words as a
    resume, or None when it has no words to count. `lib/lang.ts::proseLanguage`
    is its twin. A pasted gig is read this way (the proposal writer answers in
    the gig's language): `detect_language` would read an English Upwork post
    that names a Hebrew-spelled company as Hebrew."""
    hebrew, words = _hebrew_words(text or "")
    if not words:
        return None
    return "he" if hebrew * HEBREW_SHARE_DEN >= words else "en"


def resume_language(resume: ResumeModel) -> str:
    """Detect the language a resume is written in.

    Only prose fields count (summary, titles, bullets, project / education
    text) — company names, locations, and contact info are excluded so an
    English resume at a Hebrew-named employer stays "en". Skills are terms,
    English in most Hebrew resumes, so they vote only when there is no prose
    yet (a page begun with its skills). One Hebrew word typed into an English
    resume no longer makes it a Hebrew one: that is what saved it over the
    person's Hebrew resume (PLAN 22, next up 5).
    """
    parts = [resume.summary]
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
    hebrew, words = _hebrew_words(" ".join(parts))
    if not words:
        hebrew, words = _hebrew_words(" ".join(resume.skills))
    return "he" if words and hebrew * HEBREW_SHARE_DEN >= words else "en"
