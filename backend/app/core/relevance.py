"""Deterministic query-vs-title relevance for job search (PLAN 15.6).

Job boards match keywords anywhere in a posting, so a search for "Software
Engineer" happily returns a product-manager role at a software company whose
description mentions both words. The fan-out uses `title_relevance` to spend
its fetch/scoring budget on postings whose TITLE actually matches the searched
keywords, and to decide which too-old postings are still worth backfilling
when fresh relevant ones run out.

100% deterministic — never the LLM (this runs on every raw hit of every
search). Hebrew-aware two ways: tokens come from the scorer's Hebrew-safe
word regex, and a small bilingual alias table maps common role vocabulary
both directions, so an English keyword finds Hebrew titles and vice versa.
"""
from __future__ import annotations

from app.core.scorer import _WORD_RE

# A hit counts as "title-relevant" when at least this fraction of one query
# keyword's tokens appear in the posting title — e.g. "Backend Developer"
# matches "Senior Software Engineer (Backend)" at 0.5 via "backend".
RELEVANT_MIN = 0.5

# en → he role vocabulary. Keep entries high-confidence: a wrong alias makes
# irrelevant titles look relevant, which is exactly the bug this module fixes.
# The map is expanded bidirectionally at import, and the suffix-tolerant token
# match below absorbs inflections (מהנדס↔מהנדסת, engineer↔engineering).
_ALIASES: dict[str, set[str]] = {
    "engineer": {"מהנדס", "הנדסת"},
    "engineering": {"הנדסה", "הנדסת"},
    "developer": {"מפתח", "פיתוח"},
    "development": {"פיתוח"},
    "software": {"תוכנה"},
    "data": {"נתונים", "דאטה"},
    "product": {"מוצר"},
    "project": {"פרויקט", "פרויקטים"},
    "manager": {"מנהל"},
    "lead": {"ראש", "מוביל"},
    "qa": {"בודק", "בדיקות"},
    "test": {"בדיקות"},
    "automation": {"אוטומציה"},
    "analyst": {"אנליסט"},
    "security": {"אבטחת", "סייבר"},
    "cyber": {"סייבר"},
    "support": {"תמיכה"},
    "designer": {"מעצב", "עיצוב"},
    "marketing": {"שיווק"},
    "sales": {"מכירות"},
    "recruiter": {"מגייס", "גיוס"},
    "student": {"סטודנט"},
    "intern": {"מתמחה"},
    "architect": {"ארכיטקט"},
    "frontend": {"פרונטאנד", "פרונט"},
    "backend": {"באקאנד", "באק"},
    "fullstack": {"פולסטאק"},
    "mobile": {"מובייל"},
    "embedded": {"אמבדד"},
    "algorithm": {"אלגוריתמים"},
    "algorithms": {"אלגוריתמים"},
    "electrical": {"חשמל"},
    "mechanical": {"מכונות"},
}


def _build_alias_map() -> dict[str, frozenset[str]]:
    out: dict[str, set[str]] = {}
    for word, aliases in _ALIASES.items():
        out.setdefault(word, set()).update(aliases)
        for alias in aliases:
            out.setdefault(alias, set()).add(word)
    return {word: frozenset(aliases) for word, aliases in out.items()}


_ALIAS_MAP = _build_alias_map()

# Suffix tolerance: equal stems with a short tail ("engineer"/"engineering",
# "מהנדס"/"מהנדסת", "developer"/"developers") match; a ≥4-char stem plus a
# ≤3-char tail keeps "java" from matching "javascript" (+6) and "qa" from
# matching anything but itself.
_MIN_STEM = 4
_MAX_SUFFIX = 3


def _token_eq(a: str, b: str) -> bool:
    if a == b:
        return True
    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    return (
        len(shorter) >= _MIN_STEM
        and len(longer) - len(shorter) <= _MAX_SUFFIX
        and longer.startswith(shorter)
    )


def title_relevance(title: str, query_titles: list[str]) -> float:
    """0..1: how well the posting's title matches the searched keywords —
    for each query keyword, the fraction of its tokens present in the title
    (via alias expansion + suffix tolerance); the best keyword wins. Pure;
    pinned by the smoke test."""
    title_tokens = set(_WORD_RE.findall(title.lower()))
    if not title_tokens:
        return 0.0
    best = 0.0
    for query in query_titles:
        q_tokens = _WORD_RE.findall(query.lower())
        if not q_tokens:
            continue
        matched = sum(
            1
            for qt in q_tokens
            if any(
                _token_eq(alias, tt)
                for alias in ({qt} | set(_ALIAS_MAP.get(qt, frozenset())))
                for tt in title_tokens
            )
        )
        best = max(best, matched / len(q_tokens))
    return best
