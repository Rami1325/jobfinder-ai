"""Standalone résumé health-check — JD-independent quality grade of the master
résumé (the ATS scanner needs a JD; this grades the résumé itself).

The score comes ONLY from the deterministic checks below (explainable, stable);
the LLM contributes critique text (strengths / improvements / bullet rewrites)
and never the number. Checks carry stable ids the UI translates, plus verbatim
offending snippets so the user sees exactly what tripped each one. Hebrew
résumés are first-class: weak-opener lists and date parsing cover both languages.
"""
from __future__ import annotations

import re
from datetime import date

from app.core.lang import resume_language
from app.llm.client import get_llm_client
from app.llm import prompts
from app.models import BulletRewrite, HealthCheck, ResumeHealthResult, ResumeModel

# Openers that bury the achievement (en + he). Matched against the start of a bullet.
_WEAK_OPENERS = (
    "responsible for", "worked on", "helped", "assisted", "participated in",
    "involved in", "tasked with", "duties included", "in charge of",
    "אחראי על", "אחראית על", "עבדתי על", "השתתפתי", "סייעתי", "עזרתי",
)

# The AI-tell buzzword list (same family the TAILOR prompt bans).
_BUZZWORDS = (
    "spearheaded", "leveraged", "leveraging", "utilized", "utilizing", "honed",
    "passionate", "results-driven", "detail-oriented", "dynamic", "seamless",
    "cutting-edge", "meticulous", "proven track record", "synergy",
    "fast-paced environment", "impactful", "empowered", "championed",
    "orchestrated", "harnessed", "fostered a culture", "streamlined",
    "actionable insights", "best-in-class", "world-class",
)

_MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8,
    "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
    "ינואר": 1, "פברואר": 2, "מרץ": 3, "אפריל": 4, "מאי": 5, "יוני": 6,
    "יולי": 7, "אוגוסט": 8, "ספטמבר": 9, "אוקטובר": 10, "נובמבר": 11, "דצמבר": 12,
}
_PRESENT = ("present", "current", "now", "today", "היום", "כיום", "הווה")


def parse_month(s: str, *, is_end: bool = False) -> int | None:
    """Best-effort '(Month) YYYY' → absolute month index (year*12 + month-1).

    When only a year is given, assume January for starts and December for ends,
    so a '2020'→'2021' handoff never reads as a gap — only real gaps trip the
    check. Returns None when unparseable."""
    low = (s or "").strip().lower()
    if not low:
        return None
    if any(p in low for p in _PRESENT):
        t = date.today()
        return t.year * 12 + (t.month - 1)
    m = re.search(r"(19|20)\d{2}", low)
    if not m:
        return None
    year = int(m.group(0))
    month = 12 if is_end else 1
    for name, num in _MONTHS.items():
        if name in low:
            month = num
            break
    return year * 12 + (month - 1)


def _first_word(bullet: str) -> str:
    parts = (bullet or "").strip().split()
    return parts[0].strip(".,;:!?\"'()").lower() if parts else ""


def _clip(text: str, cap: int = 90) -> str:
    text = (text or "").strip()
    return text if len(text) <= cap else text[: cap - 1] + "…"


def deterministic_checks(resume: ResumeModel) -> list[HealthCheck]:  # noqa: C901
    checks: list[HealthCheck] = []
    bullets = [b for e in resume.experience for b in e.bullets if (b or "").strip()]
    all_text = " ".join(
        [resume.summary or ""]
        + list(resume.skills)
        + bullets
        + [b for p in resume.projects for b in p.bullets]
    )

    # 1. Weak openers ("responsible for…", "אחראי על…") bury the achievement.
    weak = [b for b in bullets if any(b.strip().lower().startswith(w) for w in _WEAK_OPENERS)]
    checks.append(
        HealthCheck(
            id="weak-openers",
            severity="good" if not weak else ("bad" if len(weak) > max(2, len(bullets) // 3) else "warn"),
            count=len(weak),
            total=len(bullets),
            examples=[_clip(b) for b in weak[:3]],
        )
    )

    # 2. Quantified bullets: evidence beats adjectives.
    if bullets:
        quant = sum(1 for b in bullets if re.search(r"\d", b))
        pct = quant / len(bullets)
        if pct >= 0.4:
            sev = "good"
        elif pct >= 0.15 or len(bullets) < 4:
            sev = "warn"
        else:
            sev = "bad"
        checks.append(HealthCheck(id="quantified", severity=sev, count=quant, total=len(bullets)))

    # 3. Buzzword bloat (the AI-tell list recruiters smell instantly).
    low_all = all_text.lower()
    found = [w for w in _BUZZWORDS if w in low_all]
    checks.append(
        HealthCheck(
            id="buzzwords",
            severity="good" if not found else ("bad" if len(found) >= 3 else "warn"),
            count=len(found),
            examples=found[:5],
        )
    )

    # 4. Bullets that run past ~30 words read as paragraphs.
    long_bullets = [b for b in bullets if len(b.split()) > 30]
    checks.append(
        HealthCheck(
            id="long-bullets",
            severity="good" if not long_bullets else "warn",
            count=len(long_bullets),
            total=len(bullets),
            examples=[_clip(b) for b in long_bullets[:2]],
        )
    )

    # 5. One-page length heuristic (word count of the content that renders).
    words = len(all_text.split())
    checks.append(
        HealthCheck(
            id="length",
            severity="good" if words <= 550 else ("warn" if words <= 800 else "bad"),
            count=words,
        )
    )

    # 6. Employment gaps ≥ 6 months between consecutive roles (best-effort date
    # parse, en+he; skipped entirely when fewer than 2 roles have usable dates).
    dated = []
    for e in resume.experience:
        start = parse_month(e.start_date)
        end = parse_month(e.end_date, is_end=True)
        if start is not None and end is not None and end >= start:
            dated.append((start, end, e.company or e.title or "?"))
    if len(dated) >= 2:
        dated.sort()
        gaps: list[str] = []
        reach = dated[0][1]
        prev_name = dated[0][2]
        for start, end, name in dated[1:]:
            if start - reach > 6:
                gaps.append(f"{prev_name} → {name} (~{start - reach} mo)")
            if end >= reach:
                reach, prev_name = end, name
        checks.append(
            HealthCheck(
                id="gaps",
                severity="good" if not gaps else "warn",
                count=len(gaps),
                examples=gaps[:3],
            )
        )

    # 7. Opening-verb variety: the same verb starting 3+ bullets reads templated.
    firsts: dict[str, int] = {}
    for b in bullets:
        w = _first_word(b)
        if w:
            firsts[w] = firsts.get(w, 0) + 1
    repeated = [w for w, n in firsts.items() if n >= 3]
    checks.append(
        HealthCheck(
            id="repeated-verbs",
            severity="good" if not repeated else "warn",
            count=len(repeated),
            examples=repeated[:4],
        )
    )

    return checks


_SEV_POINTS = {"good": 1.0, "warn": 0.5, "bad": 0.0}


def health_score(checks: list[HealthCheck]) -> float:
    if not checks:
        return 0.0
    return round(100.0 * sum(_SEV_POINTS.get(c.severity, 0.0) for c in checks) / len(checks), 1)


def check_resume_health(resume: ResumeModel) -> ResumeHealthResult:
    checks = deterministic_checks(resume)
    client = get_llm_client()
    data = client.complete_json(
        prompts.with_resume_language(prompts.RESUME_HEALTH_SYSTEM, resume_language(resume)),
        prompts.resume_health_user(resume.model_dump_json()),
    )
    rewrites = [
        BulletRewrite(before=str(r.get("before", "")), after=str(r.get("after", "")))
        for r in data.get("rewrites", [])
        if isinstance(r, dict)
    ]
    return ResumeHealthResult(
        score=health_score(checks),
        checks=checks,
        strengths=[str(x) for x in data.get("strengths", [])],
        improvements=[str(x) for x in data.get("improvements", [])],
        rewrites=rewrites,
    )
