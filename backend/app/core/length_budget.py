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
resort and only entries that carry nothing the JD named — judged by the
SCORER's own matcher, not by token overlap, so this module and `keyword_guard`
can never disagree about whether one entry carries one keyword.
"""
from __future__ import annotations

import re

from app.core.scorer import _WORD_RE, _keyword_present, _tokens
from app.models import CVPlan, JDModel, LengthReport, Project, ResumeModel
from app.render.pdf_renderer import page_count
from app.render.templates import DEFAULT_TEMPLATE

# The note this module writes when it runs out of things to trim. Public because
# `tailor` has to be able to RETRACT it: the keyword guard's back-off can get
# under the limit after this was written, and a report carrying both "could not
# get below 3 pages" and a 3-page CV is worse than either of them alone. The
# constant is imported rather than the sentence restated — the
# `geo_restriction.BLOCKING_KINDS` convention.
OVERFLOW_NOTE = "could not get below"

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

# Redundancy discount: a project's value to the reader is its relevance times
# its NOVELTY, so one sharing most of its vocabulary with a project already
# picked keeps only the fraction that is actually new, and an exact duplicate
# adds nothing. At 1.0 that reads directly as `keyword * (1 - overlap)`.
# Discounting a share of the global best score instead (the obvious additive
# form) lets a duplicate that matches the JD 4x better than anything else win
# every slot regardless — which is the eight-n8n-workflows CV.
_DIVERSITY_WEIGHT = 1.0

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


def _relevance_parts(project: Project, jd: JDModel, plan: CVPlan | None = None) -> tuple[float, float]:
    """(keyword_score, plan_boost) — kept apart so the diversity penalty can
    act on the keyword half without ever outweighing the planner's decision."""
    text = _project_text(project).lower()
    tokens = set(_WORD_RE.findall(text))
    if not tokens:
        return -1e6, 0.0  # an empty project is the first thing to go

    keyword = 0.0
    for weight, group in ((3.0, jd.hard_skills), (2.0, jd.keywords), (1.0, jd.preferred_skills)):
        for kw in group:
            kw = (kw or "").strip().lower()
            if not kw:
                continue
            if kw in text:  # whole phrase present
                keyword += weight
                continue
            parts = _WORD_RE.findall(kw)
            if parts and all(p in tokens for p in parts):
                keyword += weight
            elif parts and any(p in tokens for p in parts):
                keyword += weight * 0.5

    boost = 0.0
    if plan is not None:
        for rank, name in enumerate(plan.select_projects):
            if _name_matches(name, project.name):
                boost += 1000.0 - rank  # keep the planner's ordering intact
                break
        if any(_name_matches(n, project.name) for n in plan.emphasize):
            boost += 200.0
        if any(_name_matches(n, project.name) for n in plan.drop_projects):
            boost -= 1000.0
        if any(_name_matches(n, project.name) for n in plan.downplay):
            boost -= 150.0
    return keyword, boost


def project_relevance(project: Project, jd: JDModel, plan: CVPlan | None = None) -> float:
    """How much this project earns its space for THIS job.

    Keyword credit is capped at one hit per keyword so a long, rambling project
    cannot outrank a sharp one by repeating the same term. The planner's own
    picks dominate the ranking when it expressed an opinion — it read the job
    description, this function only counts tokens.
    """
    keyword, boost = _relevance_parts(project, jd, plan)
    return keyword + boost


def _similarity(a: set[str], b: set[str]) -> float:
    """Jaccard overlap of two projects' vocabulary. Shared tooling dominates it,
    which is exactly the signal wanted: eight n8n workflows look alike here."""
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def ranked_indices(resume: ResumeModel, jd: JDModel, plan: CVPlan | None = None) -> list[int]:
    """Project indices, MOST relevant first — picked greedily so the ordering
    spans the candidate's range instead of repeating one strength.

    Pure keyword ranking is self-reinforcing: a JD that says "automation" eight
    times ranks eight near-identical n8n workflows above every shipped
    application, so trimming to fit keeps proving the same single skill and
    buries the full-stack products. Each pick is therefore discounted by how
    much vocabulary it shares with what is already chosen (classic maximal
    marginal relevance). The discount applies to the KEYWORD half of the score
    only, never the planner's ±1000 boosts, so it reorders within the planner's
    selection without ever promoting a project the planner rejected.

    `overlaps[i]` carries each candidate's similarity to the BEST-matching
    project already chosen, updated against the new pick each round. Recomputing
    it from scratch every round — max() over all of `chosen` — compares the same
    pair once per remaining round and makes this O(n³): measured 2 ms at 30
    projects but 154 ms at 126, and a 126-project master is a real case (18.4).
    The running maximum is the same number by induction, at O(n²).
    """
    parts = [_relevance_parts(p, jd, plan) for p in resume.projects]
    vocab = [set(_WORD_RE.findall(_project_text(p).lower())) for p in resume.projects]

    chosen: list[int] = []
    overlaps = [0.0] * len(resume.projects)  # similarity to the closest already-chosen project
    remaining = list(range(len(resume.projects)))
    while remaining:
        best, best_value = remaining[0], None
        for i in remaining:
            keyword, boost = parts[i]
            # Marginal value: what this project still adds once the reader has
            # already seen the ones above it.
            value = boost + keyword * (1.0 - _DIVERSITY_WEIGHT * overlaps[i])
            if best_value is None or value > best_value:
                best, best_value = i, value
        chosen.append(best)
        remaining.remove(best)
        for i in remaining:
            overlaps[i] = max(overlaps[i], _similarity(vocab[i], vocab[best]))
    return chosen


def rank_projects(resume: ResumeModel, jd: JDModel, plan: CVPlan | None = None) -> list[str]:
    """Project names in DROP order — least relevant first, i.e. the reverse of
    `ranked_indices`, so both agree on what goes and what stays."""
    order = ranked_indices(resume, jd, plan)
    return [resume.projects[i].name for i in reversed(order)]


# --------------------------------------------------------------------------- #
# Trim operations (each returns a NEW resume, or None when it can do nothing)
# --------------------------------------------------------------------------- #
def _first_sentences(text: str, n: int) -> str:
    parts = [s for s in _SENTENCE_RE.split((text or "").strip()) if s.strip()]
    return " ".join(parts[:n]).strip() if len(parts) > n else (text or "").strip()


def _keep_top_projects(resume: ResumeModel, ranked: list[int], n: int) -> ResumeModel:
    """Keep the `n` highest-ranked projects, in their original order."""
    if n >= len(resume.projects):
        return resume
    keep = set(ranked[:max(0, n)])
    out = resume.model_copy(deep=True)
    out.projects = [p for i, p in enumerate(out.projects) if i in keep]
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


def _jd_terms(jd: JDModel) -> list[str]:
    """Every term the job names, lowercased and deduped — the three groups the
    keyword guard reads, in the JD's own order.

    Written here rather than imported from `keyword_guard`, deliberately: that
    module has exactly one importer in the whole app (`core/tailor.py`, pinned
    by the smoke test), and the dependency would run the wrong way anyway — the
    budget is a floor the guard composes with, not a client of it. What IS
    shared is the matcher, which is the part that has to agree.
    """
    out: list[str] = []
    seen: set[str] = set()
    for group in (jd.hard_skills, jd.keywords, jd.preferred_skills):
        for kw in group:
            k = (kw or "").strip().lower()
            if k and k not in seen:
                seen.add(k)
                out.append(k)
    return out


def _drop_unmatched_skill(resume: ResumeModel, jd: JDModel) -> ResumeModel | None:
    """Last resort: drop the longest skills entry that carries nothing this job
    asked for. Skills are the ATS keyword surface, so anything the JD named
    stays regardless of how long the line is.

    **The protection is expressed in the SCORER's terms, and that is
    load-bearing.** It used to be whole-token overlap (`tokens & jd_tokens`)
    while `keyword_guard` chooses the entries it puts back with
    `scorer._keyword_present`, which tries the verbatim phrase FIRST. So every
    carrier matched through that substring branch shared no token with the JD
    and was fully eligible for this drop — which picks the LONGEST unmatched
    entry, i.e. exactly the descriptive ones a carrier tends to be. Two cases,
    both real: `פיתוח בפייתון` for `פייתון` (Hebrew's inseparable prefixes are
    word characters, so the substring branch is the only thing that matches it —
    our primary market) and `PostgreSQL administration` for `Postgres`.
    Reproduced end to end: the guard restored 10 carriers and this trim removed
    9 of them under "dropped skills the job never asked for", while the changelog
    still said it had put them back. One matcher, one answer.

    It is strictly WIDER than the token rule it replaces — a shared token is a
    `partial` hit, which is already not `missing` — so nothing that used to be
    protected stopped being.

    Removes the entry from its skill GROUP as well — the flat list and the
    groups are one fact in two shapes, and a trim that touched only one of them
    would either come back or render a skill the scorer no longer counts."""
    terms = _jd_terms(jd)
    if not terms:
        return None

    worst_i, worst_len = -1, 0
    for i, entry in enumerate(resume.skills):
        text = entry.lower()
        tokens = _tokens(entry)
        if any(_keyword_present(kw, text, tokens) != "missing" for kw in terms):
            continue
        if len(entry) > worst_len:
            worst_i, worst_len = i, len(entry)
    if worst_i < 0:
        return None
    out = resume.model_copy(deep=True)
    dropped = out.skills[worst_i]
    out.skills = [s for i, s in enumerate(out.skills) if i != worst_i]
    # Keep the grouped view consistent with the flat one. `skills` is the flat
    # union of every group's items, and `ResumeModel` re-establishes that on
    # every construction — so leaving the item in its group would resurrect it
    # the moment this résumé round-trips through JSON, and the trim would
    # silently do nothing. Only when the last copy is gone from the flat list:
    # a skill listed twice is still owned by its group.
    if out.skill_groups and not any(s == dropped for s in out.skills):
        for group in out.skill_groups:
            group.items = [i for i in group.items if i != dropped]
        out.skill_groups = [g for g in out.skill_groups if g.items]
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
    ranked = ranked_indices(resume, jd, plan)
    current, pages, budget = resume, before, _MAX_MEASUREMENTS

    def fit_projects(floor: int, target: int, note: str) -> None:
        """Keep the MOST projects that still fit, by binary search.

        Dropping one project at a time and re-measuring costs one render per
        drop, which a big master résumé exhausts: at 126 projects the old loop
        hit the measurement cap and returned a 7-page CV, silently over the
        hard limit. Page count is monotonic in the number of projects kept, so
        the largest fitting count is a binary search — ~7 renders instead of
        ~120, and it lands on the MOST projects that fit rather than the first
        count that happens to.
        """
        nonlocal current, pages, budget
        if pages <= target or len(current.projects) <= floor:
            return
        base, lo, hi, best = current, floor, len(current.projects), None
        while lo <= hi and budget > 0:
            mid = (lo + hi) // 2
            candidate = _keep_top_projects(base, ranked, mid)
            budget -= 1
            if page_count(candidate, template) <= target:
                best, lo = mid, mid + 1
            else:
                hi = mid - 1
        keep = best if best is not None else floor
        if keep < len(base.projects):
            current = _keep_top_projects(base, ranked, keep)
            pages = page_count(current, template)
            budget -= 1
            if note not in report.notes:
                report.notes.append(note)

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

    fit_projects(SOFT_MIN_PROJECTS, max_pages, "dropped less relevant projects")
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
        fit_projects(HARD_MIN_PROJECTS, hard_max_pages, "dropped more projects to fit")
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
    # Say so when the budget could not be met. A silent over-length CV reads as
    # "this fits" to every caller downstream, which is how the 126-project case
    # shipped seven pages without anyone noticing.
    if pages > hard_max_pages:
        report.notes.append(
            f"{OVERFLOW_NOTE} {hard_max_pages} pages — still {pages}; "
            "everything trimmable is already at its floor"
        )
    return current, report
