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
* **The model's own order survives the CUT** — `shortlist_skills` selects in
  it and never re-sorts. What that order is not allowed to decide any more is
  what leads the section: the rule used to read "the tailor is told to put the
  JD-relevant entries first and it does that well", and a rendered page
  falsified it — what it puts first is the AD's vocabulary, because a phrase
  copied from the posting scores `covered` by construction. `order_skills`
  partitions the selected list so the candidate's own wording leads. It keeps
  every entry, so the other half of the old rule (the ATS reads the leading
  entries hardest) costs nothing.

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


def order_skills(resume: ResumeModel, original: ResumeModel) -> ResumeModel:
    """The candidate's own words lead; wording the model introduced follows.

    A STABLE PARTITION, never a re-sort. The model's ranking survives inside
    each group, so this discards the least judgement of anything that fixes the
    defect below.

    IT IS NOT FREE, AND THE FIRST VERSION OF THIS DOCSTRING SAID IT WAS. "The set
    is unchanged, so coverage and the page count cannot move" is wrong twice.
    `scorer._resume_text` joins the skills with a SPACE and `_keyword_present`
    tries the verbatim phrase first, so a multi-word JD keyword can match ACROSS
    the join between two adjacent entries; in Hebrew the token fallback does not
    rescue it, because ב/ל/ה/ו/מ/ש glue to the noun. Measured — same set,
    reordered: `['בפייתון', 'מתקדם']` scores 100.0 against `פייתון מתקדם` and
    `['מתקדם', 'בפייתון']` scores 50.0, in the primary market. And `_Chips._pack`
    fills rows by WIDTH, so a reorder repacks the section and can change its
    rendered height, after the page budget has already signed the CV off.

    So the CALLER enforces what this cannot promise: `tailor_resume` measures
    coverage and the page count either side and keeps the old order unless the
    new one is free. Only `check_fabrication` is genuinely order-blind (it never
    reads skills at all), and `length_budget._drop_unmatched_skill` picks by
    length and match rather than position.

    WHY, MEASURED. `shortlist_skills` ranks an entry by whether the JD names it,
    so a phrase COPIED FROM THE AD scores `covered` by construction and outranks
    the candidate's own tools. On a real "AI Engineer, Agentic Workflows"
    tailor the first twelve chips were `workflow automation`, `LLM systems`,
    `document processing`, `retrieval`, `tool use`, `orchestration patterns`,
    `evaluation`, `feedback loops`, `data pipelines`, `unstructured data
    processing` — ten of thirty entries absent from the candidate's own 66 —
    while `OpenAI`, `RAG`, `pgvector`, `MCP`, `FastAPI` and `SQLAlchemy` sat in
    the tail. This is the same defect the cap-at-20 regression was: raising the
    cap to 30 lengthened the tail without changing who won the top.

    THIS REPLACES "the model's own order survives", which was one of this
    module's three rules. That rule's stated premise was that the tailor "is
    told to put the JD-relevant entries first and it does that well" — and a
    rendered page falsifies it: what it puts first is the ad's vocabulary. Its
    other half, that the ATS reads the leading entries hardest, is why the
    partition keeps every entry rather than dropping any; ordering is the only
    thing traded, and no ATS behaviour this repo has measured depends on it.

    Judged the only way it can be: three orderings of the identical set were
    rendered and read side by side. A full re-sort by tier scattered niche
    entries (`Cloudflare Tunnel`) into the lead; this partition put the real
    stack in the first three rows on both jobs tested and cost nothing.
    """
    own = {s.strip() for s in original.skills}
    mine = [s for s in resume.skills if s.strip() in own]
    if not mine or len(mine) == len(resume.skills):
        # Nothing to move — every entry is the candidate's, or none is. The
        # identity convention `shortlist_skills` and `preserve_keywords` share:
        # a guard with nothing to say returns the object it was given.
        return resume
    out = resume.model_copy(deep=True)
    out.skills = mine + [s for s in resume.skills if s.strip() not in own]
    return out


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
