"""Deterministic "does this sound like AI wrote it" audit (CV humanization spec).

Pure Python, no LLM calls — cheap, explainable, and runs after every tailor:
- banned resume-buzzword scan (spearheaded, leveraged, results-driven, ...)
- repeated starting verbs across bullets
- repeated multi-word phrases across the resume
- outcome-clause overuse ("resulting in ...", "to streamline ...")
- job-description echo: multi-word phrases copied verbatim from the JD
- uniform bullet lengths (every bullet poured into the same mold)

The findings feed the humanizer LLM pass (app/core/humanizer.py), which fixes
wording without being allowed to touch facts.
"""
from __future__ import annotations

import re
from collections import Counter

from app.models import JDModel, ResumeModel, VoiceIssue, VoiceReport

# --------------------------------------------------------------------------- #
# Banned phrases: the classic AI-resume vocabulary. Each entry is a regex
# fragment matched with word boundaries, case-insensitively. Kept in sync with
# the ban list in prompts.TAILOR_SYSTEM (the prompt prevents, this detects).
# --------------------------------------------------------------------------- #
_BANNED_PATTERNS: list[tuple[str, str]] = [
    ("spearheaded", r"spearhead\w*"),
    ("leveraged", r"leverag\w*"),
    ("utilized", r"utiliz\w*"),
    ("honed", r"honed"),
    ("passionate", r"passionate"),
    ("results-driven", r"results[- ]driven"),
    ("detail-oriented", r"detail[- ]oriented"),
    ("dynamic professional", r"dynamic (professional|individual|team player|environment)"),
    ("seamless", r"seamless\w*"),
    ("cutting-edge", r"cutting[- ]edge"),
    ("meticulous", r"meticulous\w*"),
    ("proven track record", r"proven (track record|ability|expertise)"),
    ("synergy", r"synerg\w*"),
    ("fast-paced environment", r"fast[- ]paced environment"),
    ("impactful", r"impactful"),
    ("delve", r"delv(e|ed|ing)"),
    ("empowered", r"empower\w*"),
    ("championed", r"champion(ed|ing)"),
    ("orchestrated", r"orchestrat\w*"),
    ("harnessed", r"harness\w*"),
    ("fostered a culture", r"foster\w* a culture"),
    ("streamlined", r"streamlin\w*"),
    ("actionable insights", r"actionable insights"),
    ("best-in-class", r"best[- ]in[- ]class"),
    ("world-class", r"world[- ]class"),
    ("driving results", r"driving results"),
    ("demonstrated strong", r"demonstrated strong"),
    ("successfully collaborated", r"successfully collaborat\w*"),
    ("strategic thinker", r"strategic thinker"),
    ("state-of-the-art", r"state[- ]of[- ]the[- ]art"),
    ("scalable and robust", r"(scalable and robust|robust and scalable)"),
    ("operational efficiency", r"(optimiz\w+|improv\w+) operational efficiency"),
]
_BANNED_RE = [(label, re.compile(rf"\b{pat}\b", re.IGNORECASE)) for label, pat in _BANNED_PATTERNS]

# Outcome-clause connectors: fine once, an AI tell when they close bullet after
# bullet ("..., resulting in X", "... to streamline Y").
_OUTCOME_CONNECTORS: list[tuple[str, str]] = [
    ("resulting in", r"resulting in"),
    ("ensuring", r"ensuring"),
    ("enabling", r"enabling"),
    ("to streamline", r"to streamline"),
    ("to optimize", r"to optimi[sz]e"),
    ("to improve", r"to improve"),
    ("to enhance", r"to enhance"),
]
_OUTCOME_RE = [(label, re.compile(rf"\b{pat}\b", re.IGNORECASE)) for label, pat in _OUTCOME_CONNECTORS]

_WORD_RE = re.compile(r"[a-z0-9+#.֐-׿'-]+", re.IGNORECASE)

# Thresholds (spec: "acceptable configured threshold")
_VERB_REPEAT_MAX = 2  # same starting verb on >2 bullets → flagged
_PHRASE_REPEAT_MIN = 3  # same 3-word phrase 3+ times → flagged
_JD_ECHO_NGRAM = 5  # 5+ consecutive words copied from the JD → flagged
_MAX_ISSUES_PER_CATEGORY = 5  # keep the report readable

_KEYWORD_STUFFING_MAX = 3  # a JD keyword mentioned more often than this is stuffing

_PENALTY = {
    "banned_phrase": 8.0,
    "repeated_verb": 6.0,
    "repeated_phrase": 6.0,
    "outcome_clause": 5.0,
    "jd_echo": 7.0,
    "uniform_bullets": 5.0,
    "keyword_stuffing": 6.0,
}


def _texts(resume: ResumeModel) -> list[tuple[str, str]]:
    """(location, text) pairs for every prose chunk the audit should read."""
    out: list[tuple[str, str]] = []
    if resume.summary.strip():
        out.append(("summary", resume.summary))
    for exp in resume.experience:
        loc = f"experience: {exp.company or exp.title}".strip().rstrip(":")
        for b in exp.bullets:
            if b.strip():
                out.append((loc, b))
    for proj in resume.projects:
        loc = f"project: {proj.name}".strip().rstrip(":")
        if proj.description.strip():
            out.append((loc, proj.description))
        for b in proj.bullets:
            if b.strip():
                out.append((loc, b))
    return out


def _words(text: str) -> list[str]:
    return [w.lower() for w in _WORD_RE.findall(text)]


def _ngrams(words: list[str], n: int) -> set[tuple[str, ...]]:
    return {tuple(words[i : i + n]) for i in range(len(words) - n + 1)}


def _bullet_texts(resume: ResumeModel) -> list[tuple[str, str]]:
    return [(loc, t) for loc, t in _texts(resume) if loc != "summary"]


def audit_voice(resume: ResumeModel, jd: JDModel | None = None) -> VoiceReport:
    issues: list[VoiceIssue] = []
    chunks = _texts(resume)
    bullets = _bullet_texts(resume)

    # 1. Banned phrases — anywhere, including the skills list and summary.
    scannable = chunks + [("skills", ", ".join(resume.skills))]
    per_cat = 0
    for label, rx in _BANNED_RE:
        for loc, text in scannable:
            m = rx.search(text)
            if m:
                issues.append(
                    VoiceIssue(
                        category="banned_phrase",
                        value=m.group(0),
                        location=loc,
                        detail=f"'{m.group(0)}' is classic AI-resume language — restate the fact with a plain verb.",
                    )
                )
                per_cat += 1
                break  # one report per banned phrase is enough
        if per_cat >= _MAX_ISSUES_PER_CATEGORY:
            break

    # 2. Repeated starting verbs across bullets.
    starters = Counter()
    for _, text in bullets:
        w = _words(text)
        if w:
            starters[w[0]] += 1
    for verb, n in starters.most_common():
        if n > _VERB_REPEAT_MAX and re.match(r"[a-z]", verb):
            issues.append(
                VoiceIssue(
                    category="repeated_verb",
                    value=verb,
                    detail=f"{n} bullets start with '{verb}' — vary the opening or restructure some bullets.",
                )
            )

    # 3. Repeated 3-word phrases across the whole resume.
    phrase_counts: Counter[tuple[str, ...]] = Counter()
    for _, text in chunks:
        w = _words(text)
        # set() per chunk: repeating a phrase inside one bullet counts once
        for g in _ngrams(w, 3):
            phrase_counts[g] += 1
    reported = 0
    for gram, n in phrase_counts.most_common():
        if n < _PHRASE_REPEAT_MIN:
            break
        phrase = " ".join(gram)
        issues.append(
            VoiceIssue(
                category="repeated_phrase",
                value=phrase,
                detail=f"'{phrase}' appears {n} times — say it once, then vary or cut.",
            )
        )
        reported += 1
        if reported >= _MAX_ISSUES_PER_CATEGORY:
            break

    # 4. Outcome-clause overuse.
    for label, rx in _OUTCOME_RE:
        n = sum(len(rx.findall(text)) for _, text in chunks)
        if n >= 2:
            issues.append(
                VoiceIssue(
                    category="outcome_clause",
                    value=label,
                    detail=f"'{label} ...' closes {n} sentences — an AI tell; keep at most one.",
                )
            )

    # 5. JD echo: multi-word phrases copied verbatim from the JD's own prose —
    # plus the overall phrase-overlap percentage (spec stage 9: high overlap
    # means the CV copies the employer's wording).
    jd_copy_pct = 0.0
    if jd is not None:
        jd_prose = " . ".join([*jd.responsibilities, *jd.qualifications])
        jd_grams = _ngrams(_words(jd_prose), _JD_ECHO_NGRAM)
        if jd_grams:
            resume_grams: set[tuple[str, ...]] = set()
            reported = 0
            for loc, text in chunks:
                grams = _ngrams(_words(text), _JD_ECHO_NGRAM)
                resume_grams |= grams
                hit = next((g for g in grams if g in jd_grams), None)
                if hit and reported < _MAX_ISSUES_PER_CATEGORY:
                    phrase = " ".join(hit)
                    issues.append(
                        VoiceIssue(
                            category="jd_echo",
                            value=phrase,
                            location=loc,
                            detail="Copied verbatim from the job description — describe the real work in the candidate's own words.",
                        )
                    )
                    reported += 1
            if resume_grams:
                jd_copy_pct = round(100.0 * len(resume_grams & jd_grams) / len(resume_grams), 1)

    # 5b. Keyword stuffing: a JD keyword repeated past any natural need. ATS
    # software penalizes this too (spec stage 9: critical keyword 1-3 uses).
    if jd is not None:
        full_text = " . ".join(t for _, t in scannable).lower()
        seen_kw: set[str] = set()
        for kw in [*jd.keywords, *jd.hard_skills]:
            k = kw.lower().strip()
            if not k or k in seen_kw:
                continue
            seen_kw.add(k)
            n = full_text.count(k)
            if n > _KEYWORD_STUFFING_MAX:
                issues.append(
                    VoiceIssue(
                        category="keyword_stuffing",
                        value=kw,
                        detail=f"'{kw}' appears {n} times — ATS software penalizes stuffing; 1-3 natural uses is the target.",
                    )
                )

    # 6. Uniform bullet lengths: real resumes are uneven.
    lengths = [len(_words(t)) for _, t in bullets]
    if len(lengths) >= 5:
        mean = sum(lengths) / len(lengths)
        var = sum((n - mean) ** 2 for n in lengths) / len(lengths)
        if mean > 8 and var ** 0.5 < 2.0:
            issues.append(
                VoiceIssue(
                    category="uniform_bullets",
                    value=f"~{round(mean)} words each",
                    detail="Every bullet is nearly the same length — mix short, plain bullets with longer ones.",
                )
            )

    score = 100.0 - sum(_PENALTY.get(i.category, 5.0) for i in issues)
    return VoiceReport(
        human_voice_score=round(max(0.0, score), 1),
        jd_copy_pct=jd_copy_pct,
        issues=issues,
    )
