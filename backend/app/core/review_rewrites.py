"""Model rewordings for the review's rewritable findings (PLAN 28.7).

This is the ONE part of the resume review that spends. Everything in
`resume_review.py` is deterministic, free and uncapped, and runs on every
keystroke; this runs behind a button, takes `Depends(llm_user)` and costs one
monthly use, but only when there is a bullet to ask about: the route chooses the
targets first with `rewrite_targets`, and none means no model call and no charge
(Phase 30 / B4.5). The split is deliberate and it is the shape the rest of this
repo already uses: a review that quietly billed per keystroke would be the
`/tools/ats-scan` defect wearing the other hat.

The model is not trusted with the result. Every rewrite it returns is checked
deterministically afterwards, the way `check_fabrication` runs after a tailor,
and anything that fails is DROPPED and COUNTED — never silently swallowed,
because a guard that fires invisibly is the 21.7 failure mode and "we asked for
five and are showing you two" is a fact the user can act on.

Three guards, each closing a different way the offer could damage the document:

1. **`before` must equal a real bullet, verbatim.** That match is what yields
   the `path`, and `path` is what "Use this" writes through — so a rewrite whose
   `before` matches nothing has no honest place to be applied and would write
   into whichever line happened to sit at a guessed address.
2. **No number in `after` that is not in `before`.** This is the fabrication
   rule, scoped to one sentence: the commonest way a model "strengthens" a
   bullet with no measured result is to invent one, and an invented metric on a
   CV collapses in the first screening call. Reuses the fabrication guard's own
   number extraction so the two cannot disagree about what a number is.
3. **`after` must clear `voice_audit`'s banned list.** The prompt bans the
   buzzwords; this is what makes the ban true.
"""
from __future__ import annotations

import json

from app.core.resume_review import REWRITABLE, review_resume
from app.core.voice_audit import _BANNED_RE
from app.llm import prompts
from app.llm.client import get_llm_client
from app.models import ResumeModel, ReviewRewrite, ReviewRewriteResult
from app.parsers.structurer import _extract_numbers

# One use buys a bounded prompt. The review routinely finds twenty weak bullets
# on a first-draft CV and sending all of them would turn one use into an
# arbitrarily long call.
MAX_BULLETS = 5


def _bullets(resume: ResumeModel) -> dict[str, str]:
    """Every bullet on the document, by block path.

    Built from `resume_review._blocks` rather than re-walked here, so the paths
    a rewrite is matched to are the same paths the findings carry — a second
    walk is a second opinion about where a bullet lives.
    """
    from app.core.resume_review import _bullet_blocks  # noqa: PLC0415

    return {path: text for path, text in _bullet_blocks(resume) if (text or "").strip()}


def rewrite_targets(resume: ResumeModel, paths: list[str] | None) -> list[tuple[str, str]]:
    """The bullets to ask about, as (path, text).

    An explicit `paths` list is honoured as given (still capped); an empty one
    means "choose the rewritable findings server-side", which is what the panel
    sends and what keeps the client from having to re-implement `REWRITABLE`.
    Public because the route decides with it whether there is anything to pay
    for: no targets means no model call, so no use is charged (Phase 30 / B4.5).
    """
    have = _bullets(resume)
    if paths:
        return [(p, have[p]) for p in paths if p in have][:MAX_BULLETS]
    seen: list[tuple[str, str]] = []
    for f in review_resume(resume).findings:
        if f.id in REWRITABLE and f.path in have and not any(p == f.path for p, _ in seen):
            seen.append((f.path, have[f.path]))
    return seen[:MAX_BULLETS]


def write_rewrites(
    resume: ResumeModel,
    paths: list[str] | None = None,
    *,
    targets: list[tuple[str, str]] | None = None,
) -> ReviewRewriteResult:
    """Ask the model to reword the weak bullets, then refuse what it got wrong.

    Returns an empty result rather than raising when there is nothing to ask
    about: "no rewritable findings" is a clean document, not an error, and the
    route should not spend a call to discover it. `targets` are the bullets the
    route already chose (and charged for), so the call asks about exactly those;
    when None they are chosen here from `paths`, as before.
    """
    if targets is None:
        targets = rewrite_targets(resume, paths)
    if not targets:
        return ReviewRewriteResult()

    client = get_llm_client()
    payload = json.dumps(
        [{"path": p, "text": t} for p, t in targets], ensure_ascii=False
    )
    raw = client.complete_json(
        prompts.with_resume_language(prompts.REVIEW_REWRITE_SYSTEM, _language(resume)),
        prompts.review_rewrite_user(payload),
    )

    by_text = {t: p for p, t in targets}
    kept: list[ReviewRewrite] = []
    reasons: list[str] = []
    used: set[str] = set()
    for row in raw.get("rewrites") or []:
        if not isinstance(row, dict):
            reasons.append("malformed rewrite row")
            continue
        before = (row.get("before") or "").strip()
        after = (row.get("after") or "").strip()
        if not before or not after:
            reasons.append("empty before or after")
            continue
        # 1. verbatim match — and the match IS the path.
        path = by_text.get(before)
        if path is None:
            reasons.append(f"`before` matches no bullet we asked about: {before[:60]!r}")
            continue
        if path in used:
            reasons.append(f"second rewrite offered for {path}")
            continue
        if after == before:
            reasons.append(f"{path}: rewrite is identical to the original")
            continue
        # 2. no invented number.
        invented = [n for n in _extract_numbers(after) if n not in set(_extract_numbers(before))]
        if invented:
            reasons.append(f"{path}: `after` invents {', '.join(invented)}")
            continue
        # 3. no buzzword.
        banned = next((label for label, rx in _BANNED_RE if rx.search(after)), "")
        if banned:
            reasons.append(f"{path}: `after` uses a banned phrase ({banned})")
            continue
        used.add(path)
        kept.append(ReviewRewrite(path=path, before=before, after=after))

    return ReviewRewriteResult(rewrites=kept, dropped=len(reasons), dropped_reasons=reasons)


def _language(resume: ResumeModel) -> str:
    from app.core.lang import resume_language  # noqa: PLC0415

    return resume_language(resume)
