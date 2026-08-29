"""A floor under the tailor: a JD keyword the candidate HAS must not vanish
in the rewrite. 100% deterministic.

`score_after` already MEASURES the loss — it is the second half of the two
numbers the result carries — and until now nothing repaired it. Five separate
mechanisms can delete a keyword the résumé genuinely owned:

1. the model's own skills shortlist (the dominant one). TAILOR rule 2 orders
   curation — "drop irrelevant noise", "roughly 15-25 INDIVIDUAL skills",
   "DROP whole areas it never mentions" — and every one of those rules runs one
   way. The self-check verifies output ⊆ original; nothing verified the reverse.
   Measured through the stub: coverage fell 60.0 → 40.0, deleting Kubernetes and
   Terraform from a candidate who lists both.
2. `length_budget` removing the prose that carried the only occurrence.
3. `cv_planner` dropping the project that carried it, before the budget runs.
4. `drop_invented_roles` cutting a promoted row and the keywords inside it.
5. the humanizer, whose acceptance gate weighed fabrication, voice and pages —
   never coverage.

Prompt work (step 5 of this change) narrows 1; the humanizer gate narrows 5.
Neither is a guarantee, which is the same relationship `length_budget`'s own
docstring describes: "The LLM is *asked* to curate... but asked is not
guaranteed." This module is the floor.

WHAT IT MAY WRITE, and this is the whole no-fabrication argument: the ONLY
strings it can put into a résumé are entries that already exist byte-for-byte in
`original.skills`. It never synthesizes a term, never adopts the JD's spelling
for something the candidate lacks, and never writes prose. A keyword whose only
home in the original was a sentence is REPORTED, never repaired — re-inserting a
sentence into a rewritten résumé either duplicates a claim (which TAILOR bans and
`voice_audit` flags as `repeated_phrase`) or grafts a token into the model's own
prose, which is new writing the fabrication guard structurally cannot see.

The restore is provably invisible to that guard for a second reason too:
`build_facts_ledger` never reads `resume.skills`, so a restored skill cannot
produce a `FabricationFlag`. Both halves are smoke-pinned — the flag count and
the reason it holds — because pinning only the count passes by coincidence on a
fixture whose skills happen not to collide with the ledger.

THE WRITE IS FLAT ONLY: the entry is appended to `skills` and `skill_groups` is
left alone. CLAUDE.md's two-field rule ("Removing a skill is a TWO-FIELD write")
is scoped to REMOVAL — the validator only ever ADDS, so an additive one-field
write is a fixed point of it — and `skills.skill_blocks` renders an unclaimed
skill in a trailing unlabelled block, so nothing is hidden.

A REPAIR IS NOT A MEASUREMENT, and this module now says so in its shape. Three
functions, three jobs:

* `preserve_keywords` REPAIRS, and its two lists describe the résumé IT
  returned. The caller refits that résumé afterwards, so those lists are a
  claim about a document that may not be the one that ships.
* `lost_keywords` MEASURES, and does nothing else: a rank comparison, no copy,
  no budget, no carrier search. It is the humanizer gate's detector and the
  input to the report.
* `report_restore` describes what SHIPPED, after every stage that can change
  the CV has finished, by measuring both ends. That is what the changelog says.

Using the repairer as the measurement is what the split exists to stop: it
reported only the losses it could not repair, in a copy it then discarded, with
a fresh `MAX_RESTORED` budget — so a keyword the refit deleted, which it had
just proved it COULD put back, landed in NEITHER list and shipped missing,
unrepaired and unreported. Measured: 57 JD hard skills all present in the master,
25 restored, an independent rank comparison saying 32 were still lost, and a
changelog naming 7.

Never the LLM and never the network, both source-pinned by the smoke test for
the reason `geo_restriction.py` is: behaviour alone cannot tell the two apart,
because an LLM-backed restorer also returns a résumé and a list — and would pass
every behavioural check while putting a temperature=0.3 sample in charge of what
the CV says. The renderer is out too, which is why `shed_restored` takes its
page measurement as a callable instead of importing one.

THE ONE TRUE MATCHER is imported, never re-implemented. `scorer._keyword_present`
tries the verbatim phrase FIRST, which is what makes Hebrew work: ב/ל/ה/ו/מ/ש
glue onto the noun, so `פייתון` has to match inside `בפייתון`. A second matcher
with a word boundary in it misses exactly that and would disagree with the
coverage number the user can see, in the primary market. The frontend has the
same rule from the other side (check-mirrors 4 and 10).

`length_budget`'s last-resort skills trim now protects an entry through the SAME
call, and that is the other half of this module working. It used to protect on
whole-token overlap while the carrier search selected on the substring branch —
two questions, two answers, about one entry: every Hebrew carrier shared no
token with the JD and was fully eligible for a trim that removes the LONGEST
unmatched entry. Measured on a Hebrew master: 10 carriers restored, 9 of them
removed again under "dropped skills the job never asked for", changelog still
claiming they had been put back.

The remaining gap is named rather than papered over: an entry can raise a
keyword's rank by completing a phrase across the JOIN between two entries while
carrying no part of it alone, and that one the trim may still drop. It can no
longer produce a false claim, because the changelog is measured on what SHIPS —
it comes out as a `trimmed` loss, which is what it is.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from app.core.scorer import _keyword_present, _resume_text, _tokens
from app.models import JDModel, ResumeModel

# A keyword is LOST when its rank FALLS, not merely when it stops being covered:
# covered → partial is a real degradation of the ATS surface and the user paid
# for it in the same rewrite.
_RANK = {"missing": 0, "partial": 1, "covered": 2}

# How many skill ENTRIES a single restore may append. The trade is real and it
# runs the other way from the obvious one: an entry is chosen here because
# `_keyword_present` reads it as carrying a JD keyword, and
# `length_budget._drop_unmatched_skill` now protects an entry through THAT SAME
# CALL — so the entries this module writes are the entries that trim refuses to
# touch. (It used to protect on whole-token overlap, which is a different
# question with a different answer; see the module docstring.) An uncapped
# restore is therefore paid for by the refit out of PROJECTS and BULLETS — i.e.
# it would lose prose keywords to save skill keywords, which is a worse CV. What
# it is NOT paid for with is an over-length CV: `shed_restored` gives entries
# back when the page budget cannot hold them. 25 matches the TAILOR prompt's own
# upper bound for the section. Public because the changelog copy quotes the
# number and the smoke test asserts against it — the
# `geo_restriction.BLOCKING_KINDS` convention: import the constant, never restate it.
MAX_RESTORED = 25

# Which section of the ORIGINAL carried a keyword, for the changelog copy. Order
# is reporting order, not priority: the first that covers it names the loss.
_SECTIONS: tuple[str, ...] = ("skills", "experience", "projects", "summary",
                              "education", "certifications")


@dataclass(frozen=True)
class LostKeyword:
    """A JD keyword the original covered better than the shipped résumé does.

    Deliberately a local dataclass and NOT a field on `TailorResult`. A
    `kept_back: list[...]` defaulting to `[]` would read as "nothing was lost"
    on every stored kit and tracker row written before this guard existed, which
    is false — the same trap CLAUDE.md names twice ("a row that predates the
    field means unknown, never zero"). The changelog is a log of ACTIONS TAKEN,
    so its absence on an old row means "no such action", which is true.
    """

    keyword: str
    # "prose"   — the original carried it only in wording, and wording is never
    #             rewritten by this module.
    # "partial" — the original's SKILLS carry part of it, those entries are back
    #             on the page, and they still do not cover the job's phrase.
    #             NOT "prose": that sentence ("only inside wording that was
    #             rewritten") contradicts itself about a skills entry.
    # "cap"     — `MAX_RESTORED` was already spent.
    # "trimmed" — it was on the résumé this module produced and the page budget
    #             took it back out. The one class WE caused rather than the
    #             user's wording, which is why it is not folded into "prose".
    reason: Literal["prose", "partial", "cap", "trimmed"] = "prose"
    where: str = ""


def _jd_keywords(jd: JDModel) -> list[str]:
    """Every term this job names, in the JD's own priority order, casefold-deduped.

    Deliberately WIDER than `scorer.keyword_analysis`, which reads
    `keywords + hard_skills` only: a preferred skill the candidate HAS and we
    deleted is still a deletion, whatever the coverage percentage counts. The
    asymmetry is the point — widening `keyword_analysis` itself would change the
    visible coverage denominator on every score in the app, a behaviour change
    with no defect behind it.
    """
    out: list[str] = []
    seen: set[str] = set()
    for group in (jd.hard_skills, jd.keywords, jd.preferred_skills):
        for kw in group:
            k = (kw or "").strip()
            key = k.casefold()
            if key and key not in seen:
                seen.add(key)
                out.append(k)
    return out


def _rank_of(keyword: str, text: str, tokens: set[str]) -> int:
    return _RANK[_keyword_present(keyword, text, tokens)]


def _read(resume: ResumeModel) -> tuple[str, set[str]]:
    text = _resume_text(resume)
    return text, _tokens(text)


def _where(original: ResumeModel, keyword: str) -> str:
    """Which section of the ORIGINAL covers this keyword on its own.

    Only ever used for the changelog sentence — "your résumé shows this inside
    wording that was rewritten". It answers with the original's own structure,
    so it stays true no matter what the tailor did.
    """
    for section in _SECTIONS:
        probe = ResumeModel()
        setattr(probe, section, getattr(original, section))
        text, tokens = _read(probe)
        if _rank_of(keyword, text, tokens) > 0:
            return section
    return ""


def lost_keywords(original: ResumeModel, shipped: ResumeModel, jd: JDModel) -> list[str]:
    """Every JD keyword the ORIGINAL covers better than `shipped` does, in the
    JD's own priority order.

    PURE MEASUREMENT: a rank comparison and nothing else — no `model_copy`, no
    restore budget, no carrier search. That purity is the whole point of the
    function existing, and it was learned from the version that lacked it. The
    first detector wrapped `preserve_keywords`, so it answered with the losses
    that function could not REPAIR, in a copy it then threw away, on a fresh
    budget. Two failures came out of the one shortcut:

    * a keyword the refit had deleted — which the repairer proved it COULD put
      back, since it restored it into the copy — landed in neither the restored
      list nor the kept-back one. It shipped missing, unrepaired and unreported.
    * it inherited the repairer's `not original.skills` early return, so
      "nothing to repair from" was indistinguishable from "nothing was lost",
      and the humanizer gate ACCEPTED a revision that deleted both of the JD's
      hard skills from a bullet.

    Both callers pass "the résumé we owe" and "the résumé we have": the guard
    passes (master, what ships), the humanizer gate passes (tailored, revised) —
    it answers only for what IT deleted.
    """
    keywords = _jd_keywords(jd)
    if not keywords:
        return []
    orig_text, orig_tokens = _read(original)
    ship_text, ship_tokens = _read(shipped)
    return [
        kw for kw in keywords
        if _rank_of(kw, ship_text, ship_tokens) < _rank_of(kw, orig_text, orig_tokens)
    ]


def preserve_keywords(
    original: ResumeModel, tailored: ResumeModel, jd: JDModel
) -> tuple[ResumeModel, list[str], list[LostKeyword]]:
    """Put back the JD keywords the rewrite deleted — from the candidate's own
    skills list, and from nowhere else.

    Returns `(resume, restored, kept_back)`. Both lists describe THE RÉSUMÉ THIS
    FUNCTION RETURNED, which is not yet the one that ships: the caller refits it
    for the page budget, and that refit can trim prose or (via `shed_restored`)
    hand entries back. So neither list may be quoted at the user — `restored`
    said "Put back: X" for keywords the refit had taken straight out again.
    `report_restore` is what the changelog is built from; `kept_back` is carried
    into it because a reason is a fact about the ORIGINAL's wording and nothing
    downstream changes that.

    On a clean pair it returns `tailored` ITSELF — the same object, no deep copy,
    no allocation. That is not a micro-optimisation: the caller keys the refit,
    the voice re-audit and the changelog entry off that identity, and a guard
    that quietly rewrites a résumé it had nothing to say about is the
    fires-on-legitimate-input failure this codebase treats as worse than no guard
    at all.
    """
    keywords = _jd_keywords(jd)
    if not keywords:
        return tailored, [], []
    # NO `not original.skills` SHORT CUT. It saved one pass over a résumé with an
    # empty skills list and cost a total classification: `report_restore` reads
    # "absent from kept_back" as "the refit took it", so a prose loss on a
    # skill-less master would have been reported as our trim. Without carriers
    # the loop below reaches the same answer honestly, one `_where` call apiece.

    orig_text, orig_tokens = _read(original)
    work = tailored
    text, tokens = _read(work)

    # Everything already in the tailored skills list, so a restore never writes a
    # duplicate spelling of a term the model kept.
    present = {s.strip().casefold() for s in work.skills if s.strip()}

    restored: list[str] = []
    kept_back: list[LostKeyword] = []
    budget = MAX_RESTORED

    for kw in keywords:
        target = _rank_of(kw, orig_text, orig_tokens)
        if _rank_of(kw, text, tokens) >= target:
            continue  # the rewrite kept it — nothing owed

        if budget <= 0:
            kept_back.append(LostKeyword(kw, "cap", _where(original, kw)))
            continue

        # CLASSIFICATION IS BY CARRIER, and the search is INCREMENTAL rather than
        # one probe per entry: a keyword can be covered by the UNION of two
        # entries and by neither alone ("REST APIs" against skills ['REST',
        # 'APIs']), which a per-entry probe reads as prose and abandons.
        probe_text, probe_tokens = text, tokens
        probe_rank = _rank_of(kw, probe_text, probe_tokens)
        carriers: list[str] = []
        starved = False
        for entry in original.skills:
            if probe_rank >= target:
                break
            if len(carriers) >= budget:
                starved = True  # more carriers exist; the cap is what stopped us
                break
            key = entry.strip().casefold()
            if not key or key in present:
                continue
            next_text = probe_text + " " + entry.lower()
            next_tokens = probe_tokens | _tokens(entry)
            next_rank = _rank_of(kw, next_text, next_tokens)
            if next_rank > probe_rank:
                carriers.append(entry)
                probe_text, probe_tokens, probe_rank = next_text, next_tokens, next_rank

        # WHAT WAS FOUND IS KEPT, even when the union falls short of the
        # original's rank. The old code discarded those carriers — an
        # all-or-nothing restore — and then reported the keyword as "prose"
        # while `where` said "skills", a sentence that contradicts itself about
        # the user's own skills list. The carriers are the candidate's entries
        # under the same byte-for-byte provenance rule as any other write, and
        # `REST` back on the page beats nothing when the job asks for
        # `REST APIs`: partial outranks missing on the ATS surface. The keyword
        # is still reported as not carried over, under `partial`.
        if carriers:
            if work is tailored:
                work = tailored.model_copy(deep=True)
            # FLAT ONLY — `skill_groups` is untouched on purpose (see the module
            # docstring). Plain assignment, so no validator re-runs and the write
            # is exactly what it says it is.
            work.skills = [*work.skills, *carriers]
            present.update(e.strip().casefold() for e in carriers)
            budget -= len(carriers)
            # Re-read the REAL résumé rather than trusting the appended-probe
            # string. The probe puts the entry at the very end of the text while
            # the real one inserts it among the skills, so a phrase straddling
            # the skills → certifications boundary can read differently in the
            # two. Rare, and cheap to be exact about: the next keyword is
            # measured on the document that will actually ship.
            text, tokens = _read(work)

        if carriers and _rank_of(kw, text, tokens) >= target:
            restored.append(kw)
        else:
            # Three failures wearing one shape, and telling them apart is the
            # whole value of the report. CAP: the budget ran out with carriers
            # still on the shelf — the only class a bigger number would fix.
            # PARTIAL: the skills list holds part of the phrase, and now says so
            # on the page, but not the phrase itself. PROSE: the original said it
            # in a sentence, and this module does not write sentences.
            reason: Literal["prose", "partial", "cap"] = (
                "cap" if starved else "partial" if carriers else "prose"
            )
            kept_back.append(LostKeyword(kw, reason, _where(original, kw)))

    return work, restored, kept_back


def report_restore(
    original: ResumeModel,
    before: ResumeModel,
    shipped: ResumeModel,
    jd: JDModel,
    attempted: list[LostKeyword],
) -> tuple[list[str], list[LostKeyword]]:
    """The changelog's two lists, measured on the résumé that ACTUALLY SHIPS.

    `before` is the tailored résumé as the restore found it, `shipped` is what
    the user will download — after the page refit and any back-off — and
    `attempted` is `preserve_keywords`' own `kept_back`.

    `restored` is therefore "was lost before the restore AND is at target on the
    shipped document", which is a MEASUREMENT of both ends rather than a claim
    carried forward from a stage that ran three trims ago. Nothing between the
    two adds content, so it can only ever name keywords this module put back.

    A loss the restore already classified keeps its reason: "only in prose",
    "the budget was spent", "your skills hold part of it" are facts about the
    ORIGINAL's wording and no later trim changes them. Anything else still lost
    was NOT lost when the restore ran, so the refit the restore triggered is what
    removed it — its own class, because that one is caused by us.
    """
    lost_before = lost_keywords(original, before, jd)
    still_lost = lost_keywords(original, shipped, jd)
    remaining = set(still_lost)
    restored = [kw for kw in lost_before if kw not in remaining]

    by_keyword = {k.keyword: k for k in attempted}
    kept_back: list[LostKeyword] = []
    for kw in still_lost:
        known = by_keyword.get(kw)
        kept_back.append(known if known is not None
                         else LostKeyword(kw, "trimmed", _where(original, kw)))
    return restored, kept_back


def shed_restored(
    resume: ResumeModel, entries: list[str], fits: Callable[[ResumeModel], bool]
) -> tuple[ResumeModel, list[str]]:
    """Give restored entries back — LONGEST FIRST — until `fits` says yes.

    The restore adds render height and the refit that follows cannot always take
    it back: everything trimmable can already be at its floor, and the
    last-resort skills trim refuses to remove a restored entry — the matcher
    that chose it as a carrier is the one that protects it, which is the whole
    point of them being the same call. Reproduced at 4 pages against a hard max
    of 3, with
    `fit_to_pages` writing "could not get below 3 pages" into its notes and
    nothing acting on it. A guard that ships a CV over the stated hard limit has
    traded a keyword for the one thing the page budget exists to guarantee, so
    the guard retreats — and the keywords it gives back are reported, since
    `report_restore` measures the document that ships.

    Longest first, for the same reason `_drop_unmatched_skill` picks the longest
    entry: the most height per keyword given up.

    `fits` is INJECTED rather than imported. A page count is a real reportlab
    build and belongs with the pipeline; this module stays free of the renderer,
    and a check can drive both directions with a two-line predicate.

    The removal is flat-only, and that is exact rather than a shortcut: a
    carrier is by construction absent from the tailored résumé's skill GROUPS,
    because `preserve_keywords` skips any entry already in `skills` and
    `ResumeModel` keeps `skills` ⊇ every grouped item on every construction.
    """
    if not entries or fits(resume):
        return resume, []
    work, shed = resume, []
    for entry in sorted(entries, key=len, reverse=True):
        if entry not in work.skills:
            continue
        work = work.model_copy(update={"skills": [s for s in work.skills if s != entry]})
        shed.append(entry)
        if fits(work):
            break
    return work, shed
