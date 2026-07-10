"""Match scoring + gap analysis.

Keyword coverage is computed deterministically in Python (cheap, explainable);
the holistic fit score comes from the LLM. The two are combined into `overall`.
"""
from __future__ import annotations

import json
import re

from app.core.lang import detect_language
from app.llm.client import get_llm_client
from app.llm import prompts
from app.models import GapItem, JDModel, ResumeModel, Score

# Word characters for keyword tokenization. Not ASCII-only: the Hebrew block
# (U+0590-U+05FF — letters incl. finals ך ם ן ף ץ, niqqud, geresh) is included
# so Hebrew JDs/résumés tokenize correctly. Hebrew has no case, so the lower()
# calls below are simply no-ops for it. Mixed phrases like "ניסיון ב-Spark"
# split on the hyphen into Hebrew + English tokens, each matched independently.
_WORD_RE = re.compile("[a-z0-9+#.\\u0590-\\u05FF]+")


def _resume_text(resume: ResumeModel) -> str:
    parts = [resume.summary, " ".join(resume.skills), " ".join(resume.certifications)]
    for exp in resume.experience:
        parts.extend([exp.title, exp.company, *exp.bullets])
    for proj in resume.projects:
        parts.extend([proj.name, proj.description, *proj.bullets])
    for edu in resume.education:
        parts.extend([edu.degree, edu.field, edu.institution, edu.details])
    return " ".join(parts).lower()


def _tokens(text: str) -> set[str]:
    return set(_WORD_RE.findall(text.lower()))


def _keyword_present(keyword: str, resume_text: str, resume_tokens: set[str]) -> str:
    """Return 'covered', 'partial', or 'missing' for a keyword."""
    kw = keyword.lower().strip()
    if not kw:
        return "missing"
    # Whole phrase appears verbatim → covered.
    if kw in resume_text:
        return "covered"
    parts = _WORD_RE.findall(kw)
    if not parts:
        return "missing"
    hits = sum(1 for p in parts if p in resume_tokens)
    if hits == len(parts):
        return "covered"
    if hits > 0:
        return "partial"
    return "missing"


def keyword_analysis(resume: ResumeModel, jd: JDModel) -> tuple[float, list[GapItem]]:
    resume_text = _resume_text(resume)
    resume_tokens = _tokens(resume_text)

    # Dedupe JD keywords (keywords + hard_skills) case-insensitively.
    raw = [*jd.keywords, *jd.hard_skills]
    seen: set[str] = set()
    keywords: list[str] = []
    for k in raw:
        kl = k.lower().strip()
        if kl and kl not in seen:
            seen.add(kl)
            keywords.append(k.strip())

    if not keywords:
        return 0.0, []

    gaps: list[GapItem] = []
    covered = 0.0
    for kw in keywords:
        status = _keyword_present(kw, resume_text, resume_tokens)
        if status == "covered":
            covered += 1.0
        elif status == "partial":
            covered += 0.5
        suggestion = ""
        if status != "covered":
            suggestion = f"Surface real experience using the term '{kw}' if applicable."
        gaps.append(GapItem(keyword=kw, status=status, suggestion=suggestion))

    coverage_pct = round(100.0 * covered / len(keywords), 1)
    return coverage_pct, gaps


def top_matched_and_gaps(gaps: list[GapItem], limit: int = 6) -> tuple[list[str], list[str]]:
    """The strongest covered keywords and the top not-covered ones, each in the
    JD's own priority order (keyword_analysis preserves it). Job cards show both."""
    matched = [g.keyword for g in gaps if g.status == "covered"][:limit]
    missing = [g.keyword for g in gaps if g.status != "covered"][:limit]
    return matched, missing


def fit_score(resume: ResumeModel, jd: JDModel) -> tuple[float, str]:
    client = get_llm_client()
    data = client.complete_json(
        prompts.FIT_SCORE_SYSTEM,
        prompts.fit_score_user(
            resume.model_dump_json(),
            jd.model_dump_json(),
        ),
    )
    score = float(data.get("fit_score", 0) or 0)
    score = max(0.0, min(100.0, score))
    return round(score, 1), str(data.get("rationale", ""))


def score_resume(resume: ResumeModel, jd: JDModel) -> Score:
    coverage, gaps = keyword_analysis(resume, jd)
    fit, rationale = fit_score(resume, jd)
    # Weight keyword coverage (ATS gate) and holistic fit equally.
    overall = round(0.5 * coverage + 0.5 * fit, 1)
    return Score(
        keyword_coverage=coverage,
        fit_score=fit,
        overall=overall,
        rationale=rationale,
        gaps=gaps,
    )


def analyze_and_score(resume: ResumeModel, jd_text: str) -> tuple[JDModel, Score]:
    """JD extraction + holistic fit in ONE LLM round-trip (the JD_FIT task,
    PLAN 12.1). The job-search hot path scores dozens of postings; splitting
    analyze_jd + fit_score doubled its LLM latency for no quality gain.
    Keyword coverage stays deterministic and `overall` combines exactly like
    score_resume. Tailor and job-match keep using analyze_jd + score_resume."""
    # Detected deterministically (Hebrew-block regex), never by the LLM — the
    # same invariant jd_analyzer.analyze_jd enforces.
    language = detect_language(jd_text)
    data = get_llm_client().complete_json(
        prompts.jd_fit_system(language),
        prompts.jd_fit_user(resume.model_dump_json(), jd_text),
    )
    jd = JDModel.model_validate(data)  # the extra fit_score/rationale keys are ignored
    jd.language = language  # authoritative — overrides anything the LLM emitted
    fit = float(data.get("fit_score", 0) or 0)
    fit = round(max(0.0, min(100.0, fit)), 1)
    coverage, gaps = keyword_analysis(resume, jd)
    overall = round(0.5 * coverage + 0.5 * fit, 1)
    return jd, Score(
        keyword_coverage=coverage,
        fit_score=fit,
        overall=overall,
        rationale=str(data.get("rationale", "")),
        gaps=gaps,
    )
