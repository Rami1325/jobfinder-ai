"""Deterministic relevance shortlist for the tailored skills section.

The mirror image of `keyword_guard`. That module is the FLOOR — a JD keyword the
candidate's own skills list carried may not be deleted by the rewrite. This one
is the CEILING — a tailored CV is a shortlist for one job, not the master's
inventory, and past a point every extra entry buries the ones that matter.

WHY THIS IS CODE AND NOT A SENTENCE IN THE PROMPT. Measured on the real master
(66 skills) across six real job ads x 2 reps against gpt-5.4-mini: the tailored
CV shipped a **median of 66 skills, range 45-79** — more, on most runs, than the
master it was cut down from — with **18.3%** of the entries terms the job named.
The prompt has asked for "roughly 15-25 INDIVIDUAL skills" the whole time. It was
also instrumented: `preserve_keywords` added **zero** entries on every run, so the
model itself returns 50-68 and no downstream stage was responsible.

Nothing in the pipeline could have caught it. Measured, at n = 66/50/40/30/25/20:
keyword coverage is NON-DECREASING in the count, the voice score is flat, the
fabrication guard reads 0 at every n (skills are unguarded by design), and
`length_budget`'s skills rung sits behind `pages > hard_max_pages` AFTER every
project and bullet has been cut — fed synthetic lists of 100, 150, 200, 250 and
300 entries it removed **zero** skills every time. So a longer list scored the
same or better on every number the app records, and the only signal it was wrong
was the owner looking at it. That is precisely the shape of thing that has to be
a guarantee rather than a request: every other size promise here is already code
(`length_budget` guarantees the page count the prompt asks for; `keyword_guard`
guarantees the keyword floor the prompt asks for), and this is the third.

THREE RULES, each avoiding a defect this codebase has already paid for once:

* **The matcher is `scorer._keyword_present`** — the same one `keyword_guard`
  picks carriers with and `length_budget._drop_unmatched_skill` protects entries
  with. A trim that decided relevance its own way would be a second gate
  disagreeing with the first about the same entry, which is the correction the
  geo-restriction work paid for.
* **A `covered` entry is never dropped, and neither is a restored one**, cap or
  no cap. The cap governs the tail. Dropping a term the job named is the exact
  defect `keyword_guard` exists to repair, so a trim able to cause it would be
  undoing the last release from the other side — and a carrier the guard just
  put back is protected by the very matcher that chose it.
* **The model's own order survives.** The tailor is told to put the JD-relevant
  entries first and it does that well; re-sorting by tier would throw away a
  judgement it actually got right, and the ATS reads the first entries hardest.

IT MAY NEVER REACH THE MODEL OR THE NETWORK, like `keyword_guard` and
`geo_restriction`, and like them that is source-pinned through the AST rather
than by grep — `scorer` imports `get_llm_client`, so appending `fit_score` to the
import line below would put the model in charge of the CV while every substring
pin stayed green.
"""
from __future__ import annotations

from app.core.scorer import _keyword_present, _tokens
from app.models import JDModel, ResumeModel


def _jd_terms(jd: JDModel) -> list[str]:
    """Every term this job names, casefold-deduped.

    Written here rather than imported from `length_budget._jd_terms` or
    `keyword_guard._jd_keywords`, following the precedent those two set between
    themselves: each is a floor/ceiling the others compose with, not a client of
    them, and the dependency would run the wrong way. What is SHARED is the
    matcher, which is the part that has to agree.

    Wider than `scorer.keyword_analysis`, which reads `keywords + hard_skills`
    only: a preferred skill the candidate genuinely has still earns its place on
    the page, and dropping it because the coverage denominator ignores it would
    be optimising for the number instead of the résumé.
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


def relevance(entry: str, terms: list[str]) -> str:
    """`covered` / `partial` / `missing` — does THIS job ask for this one entry?

    Note the direction: the scorer asks "does the résumé carry this JD keyword",
    and this asks "does any JD keyword describe this entry". Same matcher, one
    entry at a time, exactly as `_drop_unmatched_skill` uses it.
    """
    text = entry.lower()
    tokens = _tokens(entry)
    best = "missing"
    for kw in terms:
        got = _keyword_present(kw, text, tokens)
        if got == "covered":
            return "covered"
        if got == "partial":
            best = "partial"
    return best


def shortlist_skills(
    resume: ResumeModel,
    jd: JDModel,
    cap: int,
    protected: frozenset[str] | set[str] = frozenset(),
) -> tuple[ResumeModel, list[str]]:
    """Cut the skills list to the `cap` most job-relevant entries.

    Returns `(resume, dropped)`. **On a list already at or under the cap it
    returns the SAME OBJECT**, no copy — the identity convention
    `preserve_keywords` established, and for the same reason: the caller keys its
    changelog entry off having actually done something, and a guard that quietly
    rewrites a document it had nothing to say about is the fires-on-legitimate-
    input failure this codebase treats as worse than no guard.

    `protected` is the entries `keyword_guard` just restored. They are carriers
    for a JD keyword by construction, so most of them already rank `covered` or
    `partial` — but a carrier for a MULTI-WORD keyword ranks `partial` on its own
    ("REST" against "REST APIs"), and a cap that evicted it would silently undo
    the restore and leave the changelog claiming the term was put back.
    """
    terms = _jd_terms(jd)
    if cap <= 0 or not terms or len(resume.skills) <= cap:
        return resume, []

    tier = {s: relevance(s, terms) for s in resume.skills}
    rank = {"covered": 0, "partial": 1, "missing": 2}
    order = {s: i for i, s in enumerate(resume.skills)}
    ranked = sorted(resume.skills, key=lambda s: (rank[tier[s]], order[s]))

    keep = {s for s in resume.skills if tier[s] == "covered" or s in protected}
    for s in ranked:
        if len(keep) >= cap:
            break
        keep.add(s)

    dropped = [s for s in resume.skills if s not in keep]
    if not dropped:
        return resume, []

    out = resume.model_copy(deep=True)
    out.skills = [s for s in resume.skills if s in keep]
    if out.skill_groups:
        # The two-field write, for the reason `_drop_unmatched_skill` documents:
        # `skills` is the flat union of the groups and `ResumeModel`
        # re-establishes that on every construction, so a group still holding a
        # dropped entry resurrects it on the next round trip and the trim
        # silently does nothing. A tailored CV is normally already flat; this is
        # here so the function is correct wherever it is called from.
        for g in out.skill_groups:
            g.items = [i for i in g.items if i in keep]
        out.skill_groups = [g for g in out.skill_groups if g.items]
    return out, dropped
