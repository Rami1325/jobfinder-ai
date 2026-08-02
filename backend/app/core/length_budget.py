"""Deterministic page budget for tailored résumés (PLAN 18).

The LLM is *asked* to curate — PLAN_CV names the projects worth keeping and
TAILOR writes to a page target — but asked is not guaranteed. A master résumé
carrying 20+ projects reliably came back as a 5-page tailored CV, because the
old TAILOR rule "never drop a project" outranked the one-page rule it also
carried. This module is the floor under that: it measures the REAL rendered
page count and removes content, in relevance order, until the résumé fits.

Two properties make it safe to run after the fabrication guard:

* It only ever REMOVES content — never rewrites, reorders or rephrases — so it
  cannot introduce a claim the guard has not already cleared.
* Protected entries are never touched: contact, headline, summary, every role
  (company / title / dates), education, certifications, military service and
  languages. Those are what a recruiter checks for gaps; dropping one to save
  a line is how a CV fails a background check, not how it gets shorter.

What it will trim, in order of increasing reluctance: whole projects (least
JD-relevant first), project descriptions, project bullets, then trailing
experience bullets from the oldest roles. Skills are trimmed only as a last
resort and only entries with zero JD overlap, because the skills list is the
ATS keyword surface.
"""
from __future__ import annotations

import re

from app.core.scorer import _WORD_RE
from app.models import CVPlan, JDModel, LengthReport, Project, ResumeModel
from app.render.pdf_renderer import page_count
from app.render.templates import DEFAULT_TEMPLATE

# Soft floors: what the budget refuses to go below while it is merely aiming
# for the target page count. A CV with one project and one bullet per role
# technically fits, but it is no longer a CV worth sending.
SOFT_MIN_PROJECTS = 3
SOFT_MIN_BULLETS_RECENT = 3  # most recent role
SOFT_MIN_BULLETS_OLDER = 2
SOFT_MAX_PROJECT_BULLETS = 2
SOFT_DESC_SENTENCES = 2

# Hard floors: only reached when the résumé is still over the HARD page limit,
# where shipping an over-length CV is the worse outcome.
HARD_MIN_PROJECTS = 1
HARD_MIN_BULLETS_RECENT = 2
HARD_MIN_BULLETS_OLDER = 1
HARD_DESC_SENTENCES = 1

# Bound the work: each measurement is a real reportlab build.
_MAX_MEASUREMENTS = 60

_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")


# --------------------------------------------------------------------------- #
# Relevance
# --------------------------------------------------------------------------- #
def _tokens_of(name: str) -> list[str]:
    return _WORD_RE.findall((name or "").lower())


def _name_matches(a: str, b: str) -> bool:
    """Fuzzy project-name match, on whole tokens.

    The planner echoes names back in its own wording ("Ziko delivery platform"
    for "Ziko — single-city delivery platform"), so exact equality would
    silently ignore every plan hint. Matching is a contiguous run of whole
    tokens rather than a raw substring, because substrings make "Project 1"
    match "Project 12" — and quietly keep the wrong project.
    """
    ta, tb = _tokens_of(a), _tokens_of(b)
    if not ta or not tb:
        return False
    short, long = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    n = len(short)
    return any(long[i:i + n] == short for i in range(len(long) - n + 1))


def _project_text(p: Project) -> str:
    return f"{p.name} {p.description} {' '.join(p.bullets)}"


def project_relevance(project: Project, jd: JDModel, plan: CVPlan | None = None) -> float:
    """How much this project earns its space for THIS job.

    Keyword credit is capped at one hit per keyword so a long, rambling project
    cannot outrank a sharp one by repeating the same term. The planner's own
    picks dominate the ranking when it expressed an opinion — it read the job
    description, this function only counts tokens.
    """
    text = _project_text(project).lower()
    tokens = set(_WORD_RE.findall(text))
    if not tokens:
        return -1e6  # an empty project is the first thing to go

    score = 0.0
    for weight, group in ((3.0, jd.hard_skills), (2.0, jd.keywords), (1.0, jd.preferred_skills)):
        for kw in group:
            kw = (kw or "").strip().lower()
            if not kw:
                continue
            if kw in text:  # whole phrase present
                score += weight
                continue
            parts = _WORD_RE.findall(kw)
            if parts and all(p in tokens for p in parts):
                score += weight
            elif parts and any(p in tokens for p in parts):
                score += weight * 0.5

    if plan is not None:
        for rank, name in enumerate(plan.select_projects):
            if _name_matches(name, project.name):
                score += 1000.0 - rank  # keep the planner's ordering intact
                break
        if any(_name_matches(n, project.name) for n in plan.emphasize):
            score += 200.0
        if any(_name_matches(n, project.name) for n in plan.drop_projects):
            score -= 1000.0
        if any(_name_matches(n, project.name) for n in plan.downplay):
            score -= 150.0
    return score


def rank_projects(resume: ResumeModel, jd: JDModel, plan: CVPlan | None = None) -> list[str]:
    """Project names in DROP order — least relevant first.

    Names rather than indices on purpose: the drop loop removes one project at
    a time, so any index captured up front would point at the wrong project
    from the second removal onward.
    """
    scored = [(project_relevance(p, jd, plan), i, p.name) for i, p in enumerate(resume.projects)]
    scored.sort(key=lambda t: (t[0], -t[1]))  # ties broken by later-listed-first
    return [name for _, _, name in scored]


# --------------------------------------------------------------------------- #
# Trim operations (each returns a NEW resume, or None when it can do nothing)
# --------------------------------------------------------------------------- #
def _first_sentences(text: str, n: int) -> str:
    parts = [s for s in _SENTENCE_RE.split((text or "").strip()) if s.strip()]
    return " ".join(parts[:n]).strip() if len(parts) > n else (text or "").strip()


def _drop_one_project(resume: ResumeModel, drop_order: list[str], floor: int) -> ResumeModel | None:
    """Remove the least relevant project still present, or None at the floor."""
    if len(resume.projects) <= floor:
        return None
    for name in drop_order:
        for i, p in enumerate(resume.projects):
            if p.name == name:
                out = resume.model_copy(deep=True)
                out.projects = [q for j, q in enumerate(out.projects) if j != i]
                return out
    # Ranking went stale (duplicate/blank names): fall back to the last one.
    out = resume.model_copy(deep=True)
    out.projects = out.projects[:-1]
    return out


def _compress_descriptions(resume: ResumeModel, sentences: int) -> ResumeModel | None:
    out = resume.model_copy(deep=True)
    changed = False
    for p in out.projects:
        short = _first_sentences(p.description, sentences)
        if short != p.description:
            p.description, changed = short, True
    return out if changed else None


def _trim_project_bullets(resume: ResumeModel, keep: int) -> ResumeModel | None:
    out = resume.model_copy(deep=True)
    changed = False
    for p in out.projects:
        if len(p.bullets) > keep:
            p.bullets, changed = p.bullets[:keep], True
    return out if changed else None


def _trim_experience_bullets(resume: ResumeModel, recent_floor: int, older_floor: int) -> ResumeModel | None:
    """Drop ONE trailing bullet, from the oldest role that can spare it.

    Bullets are already ordered most-relevant-first by the tailor, so the last
    one is the weakest thing that role says.
    """
    out = resume.model_copy(deep=True)
    for i in range(len(out.experience) - 1, -1, -1):
        floor = recent_floor if i == 0 else older_floor
        if len(out.experience[i].bullets) > floor:
            out.experience[i].bullets = out.experience[i].bullets[:-1]
            return out
    return None


def _drop_unmatched_skill(resume: ResumeModel, jd: JDModel) -> ResumeModel | None:
    """Last resort: drop the longest skills entry that shares nothing with the
    JD. Skills are the ATS keyword surface, so anything the JD asked for stays
    regardless of how long the line is."""
    jd_tokens: set[str] = set()
    for group in (jd.hard_skills, jd.keywords, jd.preferred_skills):
        for kw in group:
            jd_tokens.update(_WORD_RE.findall((kw or "").lower()))
    if not jd_tokens:
        return None

    worst_i, worst_len = -1, 0
    for i, entry in enumerate(resume.skills):
        tokens = set(_WORD_RE.findall(entry.lower()))
        if tokens & jd_tokens:
            continue
        if len(entry) > worst_len:
            worst_i, worst_len = i, len(entry)
    if worst_i < 0:
        return None
    out = resume.model_copy(deep=True)
    out.skills = [s for i, s in enumerate(out.skills) if i != worst_i]
    return out


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def fit_to_pages(
    resume: ResumeModel,
    jd: JDModel,
    plan: CVPlan | None = None,
    template: str = DEFAULT_TEMPLATE,
    max_pages: int = 2,
    hard_max_pages: int = 3,
) -> tuple[ResumeModel, LengthReport]:
    """Trim `resume` until it renders within the page budget.

    Aims for `max_pages` using the soft floors; if respecting those floors
    still leaves it over `hard_max_pages`, keeps going on the hard floors.
    A résumé already inside the target is returned untouched.
    """
    max_pages = max(1, int(max_pages))
    hard_max_pages = max(max_pages, int(hard_max_pages))

    before = page_count(resume, template)
    report = LengthReport(
        pages_before=before,
        pages_after=before,
        max_pages=max_pages,
        hard_max_pages=hard_max_pages,
    )
    if before <= max_pages:
        return resume, report

    original_names = [p.name for p in resume.projects]
    order = rank_projects(resume, jd, plan)
    current, pages, budget = resume, before, _MAX_MEASUREMENTS

    def apply(candidate: ResumeModel | None, note: str) -> bool:
        """Measure a candidate and keep it. Trims only remove content, so a
        candidate is always accepted — the measurement decides whether to
        keep going, not whether to keep the trim."""
        nonlocal current, pages, budget
        if candidate is None or budget <= 0:
            return False
        budget -= 1
        current = candidate
        pages = page_count(current, template)
        if note not in report.notes:
            report.notes.append(note)
        return True

    # --- soft pass: aim for the target without gutting the CV -------------
    # Shortening comes before dropping, all the way down to one sentence per
    # project. If the planner judged ten projects relevant, ten terse entries
    # serve the candidate better than six roomy ones and four deletions —
    # breadth is evidence too. Only when everything is already terse does a
    # whole project go.
    soft_steps = (
        lambda: (_compress_descriptions(current, SOFT_DESC_SENTENCES),
                 f"shortened project descriptions to {SOFT_DESC_SENTENCES} sentences"),
        lambda: (_trim_project_bullets(current, SOFT_MAX_PROJECT_BULLETS),
                 f"kept the top {SOFT_MAX_PROJECT_BULLETS} bullets per project"),
        lambda: (_compress_descriptions(current, HARD_DESC_SENTENCES),
                 "cut project descriptions to one sentence"),
        lambda: (_trim_project_bullets(current, 1),
                 "kept one bullet per project"),
    )
    # Never below one sentence AND one bullet: the tailor puts the substance in
    # whichever of the two it prefers, so zeroing either can leave a project
    # entry that is nothing but its tech-stack line.
    for step in soft_steps:
        if pages <= max_pages:
            break
        candidate, note = step()
        apply(candidate, note)

    while pages > max_pages and budget > 0:
        if not apply(_drop_one_project(current, order, SOFT_MIN_PROJECTS), "dropped less relevant projects"):
            break
    while pages > max_pages and budget > 0:
        if not apply(
            _trim_experience_bullets(current, SOFT_MIN_BULLETS_RECENT, SOFT_MIN_BULLETS_OLDER),
            "trimmed the weakest experience bullets",
        ):
            break

    # --- hard pass: only if the soft floors left it over the hard limit ----
    # Descriptions and project bullets are already at their floor by now; what
    # is left is dropping below the soft minimums.
    if pages > hard_max_pages:
        while pages > hard_max_pages and budget > 0:
            if not apply(_drop_one_project(current, order, HARD_MIN_PROJECTS), "dropped more projects to fit"):
                break
        while pages > hard_max_pages and budget > 0:
            if not apply(
                _trim_experience_bullets(current, HARD_MIN_BULLETS_RECENT, HARD_MIN_BULLETS_OLDER),
                "trimmed experience bullets further",
            ):
                break
        while pages > hard_max_pages and budget > 0:
            if not apply(_drop_unmatched_skill(current, jd), "dropped skills the job never asked for"):
                break

    kept = {p.name for p in current.projects}
    report.dropped_projects = [n for n in original_names if n not in kept]
    report.pages_after = pages
    report.trimmed = pages != before or bool(report.notes)
    return current, report
