"""Match scoring + gap analysis.

Keyword coverage is computed deterministically in Python (cheap, explainable);
the holistic fit score comes from the LLM. The two are combined into `overall`.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache

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
    """Every section of the résumé that is PRINTED, as one lowercased string.

    "Printed" is the whole rule, and it is what this function got wrong for a
    long time: `headline`, `military_service` and `languages` were absent while
    both renderers draw all three. So a candidate whose Kubernetes/Terraform
    evidence lived in a military-service bullet — the Israeli norm, where a
    large share of technical evidence is unit work — scored those keywords
    `missing` and was advised to "surface real experience using the term
    'Terraform'" on a page that already printed it twice. The headline is worse
    still: the tailor deliberately sets it to the job's own title, so the one
    line most likely to carry the JD's vocabulary was the one line not counted.

    That number is not cosmetic. It is half of `overall`, which is what job
    search ranks by, what `job_search_hits` stores, what the fit ring shows and
    what the daily-alert bar filters the morning email on — and `keyword_guard`
    reads the same text, so a JD keyword whose only home was a military bullet
    had rank 0 and the keyword floor was structurally unable to notice the
    tailor deleting it.

    `ats_scan._resume_text` is a DELIBERATE second corpus, not a duplicate to be
    merged: it joins skills with ", " and parts with " \\n", filters empties and
    preserves case, because it feeds prose checks (`_has_term`, the one-page
    word count) rather than keyword matching. The two must read the same
    SECTIONS and are free to differ in punctuation; a smoke check pins exactly
    that, so neither can silently drop a section again.

    The space join between skills is load-bearing and must not become ", ":
    `order_skills`' acceptance gate measures coverage either side of the
    reorder, and a multi-word JD keyword matching ACROSS the join between two
    adjacent entries is the behaviour that gate was calibrated on.
    """
    parts = [resume.headline, resume.summary, " ".join(resume.skills), " ".join(resume.certifications)]
    for exp in resume.experience:
        parts.extend([exp.title, exp.company, *exp.bullets])
    for proj in resume.projects:
        parts.extend([proj.name, proj.description, *proj.bullets])
    for edu in resume.education:
        parts.extend([edu.degree, edu.field, edu.institution, edu.details])
    for ms in resume.military_service:
        parts.extend([ms.unit, ms.role, *ms.bullets])
    # `language` only, never `level`: "native"/"fluent" are proficiency
    # qualifiers, not terms an ATS matches a requirement against, and adding
    # them would let a JD keyword hit on a word no skill claim contains.
    parts.extend(lang.language for lang in resume.languages)
    return " ".join(parts).lower()


def _tokens(text: str) -> set[str]:
    return set(_WORD_RE.findall(text.lower()))


# The verbatim-phrase branch of `_keyword_present` used to be a bare
# `kw in resume_text` with no boundary of any kind. Measured against the real
# module, that reported `Go`, `R`, `C` and `ORM` as COVERED on a résumé holding
# only django/mongodb/terraform/react — `Go` inside "django", `ORM` inside
# "terraform" — and every one of those is an ordinary `jd.hard_skills` value.
# Each spurious hit inflated coverage, therefore `overall`, therefore which
# postings cleared the 75% alert bar; and because four call sites share this one
# function ("one matcher, one answer"), a false `covered` also shielded a skills
# entry from the page-budget trim and could make a restore look successful when
# nothing was carried.
#
# The boundary is ASYMMETRIC, mirroring `frontend/src/lib/keywords.ts` — which
# is the point, since the two matchers disagreed and the invariant says they may
# not. The LOOKBEHIND drops the Hebrew block so ב/ל/ה/ו/מ/ש still glue onto the
# noun and `פייתון` keeps matching inside `בפייתון` (a symmetric boundary would
# make every prefixed Hebrew occurrence invisible — in the primary market). The
# LOOKAHEAD keeps the whole class, so a longer word that merely STARTS with the
# keyword does not match.
#
# `.` NEEDS ITS OWN CLAUSE and getting this wrong is silent. It is a word
# character only so that `.NET` and `node.js` hold together, but a keyword at the
# end of a sentence is followed by a full stop too — so a symmetric class made
# `SQL` invisible inside "ניסיון בפייתון ו-SQL." and `Python` invisible inside
# "…in Python." The lookahead therefore rejects `.` ONLY when a word character
# follows it: `Python.` matches, `node` inside `node.js` does not. (The TS twin
# still has the flat class and the same blind spot; it counts highlights rather
# than scoring, so it is a smaller problem there, but it should follow.)
_LEAD_CLASS = "a-z0-9+#."
_TRAIL_CLASS = "a-z0-9+#\\u0590-\\u05FF"

# A longer résumé token that STARTS with the keyword — `PostgreSQL` for
# `Postgres` — is evidence, not the term, so it scores `partial` and never
# `covered`. Dropping it entirely was the first attempt and it broke a pinned
# invariant: `length_budget._drop_unmatched_skill` protects any entry the scorer
# reads as not-`missing`, and the trim removes the LONGEST unmatched entry, so a
# strict boundary would have let it delete "PostgreSQL administration and
# replication tuning at scale" from a CV applying to a job that says Postgres.
#
# The length floor is the honest part of this rule and it is TUNED, NOT
# MEASURED — recorded that way on purpose. It sits above `Java`, the
# counter-example `lib/keywords.ts` names in its own comment (`Java` must never
# reach `JavaScript`), and below `Postgres`, the case the trim's protection
# pins. Below it, a shared prefix is coincidence rather than a shared root:
# `R` inside "react" and `C` inside "clusters" are how single-letter JD skills
# used to score 100%.
_PREFIX_MIN = 5


@lru_cache(maxsize=4096)
def _phrase_re(kw: str) -> re.Pattern[str]:
    """Boundary-anchored matcher for one already-lowercased keyword.

    Cached because a single job search runs this over ~25 postings' keyword
    sets. Pure in `kw`; `re.escape` keeps `C++`, `C#` and `.NET` literal.
    """
    return re.compile(f"(?<![{_LEAD_CLASS}]){re.escape(kw)}(?![{_TRAIL_CLASS}])(?!\\.[a-z0-9])")


@lru_cache(maxsize=4096)
def _prefix_re(kw: str) -> re.Pattern[str]:
    """Keyword sitting at a token start with more word characters after it."""
    return re.compile(f"(?<![{_LEAD_CLASS}]){re.escape(kw)}(?=[a-z0-9\\u0590-\\u05FF])")


def _keyword_present(keyword: str, resume_text: str, resume_tokens: set[str]) -> str:
    """Return 'covered', 'partial', or 'missing' for a keyword."""
    kw = keyword.lower().strip()
    if not kw:
        return "missing"
    # Whole phrase appears verbatim, at token boundaries → covered.
    if _phrase_re(kw).search(resume_text):
        return "covered"
    parts = _WORD_RE.findall(kw)
    if not parts:
        return "missing"
    hits = sum(1 for p in parts if p in resume_tokens)
    if hits == len(parts):
        return "covered"
    if hits > 0:
        return "partial"
    # Last: a longer term that starts with the keyword. Only ever rescues what
    # would otherwise be `missing`, so it can never weaken a stronger verdict.
    if len(kw) >= _PREFIX_MIN and _prefix_re(kw).search(resume_text):
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
