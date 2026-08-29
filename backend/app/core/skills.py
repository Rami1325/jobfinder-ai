"""How the Skills section is laid out — the ONE place both renderers agree.

A real CV groups its skills under labels ("AI & LLMs", "Backend & Data"); ours
kept a flat `skills: list[str]` and printed 138 tokens as one undifferentiated
run. `ResumeModel.skill_groups` carries the grouping, and this module turns the
two fields into the blocks both `pdf_renderer` and `docx_renderer` draw, so the
PDF and the DOCX can never disagree about what the section says.

Two properties matter more than the look:

* **Nothing is ever hidden.** `skills` is the flat surface every scorer, the ATS
  scan and the ATS x-ray read. If a skill were in `skills` but in no group, and
  the renderers drew only the groups, the x-ray would correctly report it
  MISSING from the document we told the user to send. So whatever the groups do
  not claim is emitted as a final, unlabelled block.
* **Empty groups change nothing.** With `skill_groups == []` this returns a
  single unlabelled block holding exactly `resume.skills`, which is the
  pre-existing render, flowable for flowable.

`normalize_skills` lives here for the same reason: it is the other half of the
question "what is one skill?". Layout answers it for the page, normalisation
answers it for the data, and both have to answer it the same way or a chip on
the paper stops matching a keyword in the scorer.
"""
from __future__ import annotations

from app.models import ResumeModel, SkillGroup

# The separator set is deliberately CONSERVATIVE, and every omission below is a
# guard that would otherwise fire on legitimate input — the one thing this
# codebase forbids. Each was measured against the user's own stored master (66
# skills in 5 groups), not imagined:
#   `/`      — `CI/CD` is one of their skills. So are `TCP/IP` and `A/B testing`.
#              Splitting it also drops `CI` under the ATS x-ray's `_MIN_FACT = 3`
#              floor, so both halves would vanish from x-ray coverage entirely.
#   ` and `  — `prompt and system design`, `evaluation and fallback handling` and
#              `RTL and i18n` are three real entries, each ONE skill.
#   ` ו`     — Hebrew's vav conjunction is an INSEPARABLE prefix (CLAUDE.md
#              already names ב/ל/ה/ו/מ/ש) and is orthographically identical to a
#              word-initial vav, so the rule shreds פיתוח ווב, עריכת וידאו,
#              ולידציה and וורדפרס. Telling the two apart needs a Hebrew parser,
#              and a rule that needs a parser is not deterministic.
# What is left is the punctuation a CV actually uses to list skills on one line.
_SKILL_SEPARATORS = frozenset(",;|·•\n\t")

# ...and a separator INSIDE a bracket or a quoted run is not a separator at all.
# `Cloud (AWS, GCP)` is ONE skill the user typed; splitting it wrote two
# fragments nobody wrote — `Cloud (AWS` and `GCP)` — into the master résumé and
# into the downloaded PDF, at the one door that parses the user's own CV. A
# depth counter is enough. This is not a parser and must not become one: an
# entry whose delimiters never close simply keeps its separators, which is the
# conservative direction (the user's text comes back whole).
_OPENERS = {"(": ")", "[": "]", "{": "}", '"': '"', "“": "”"}
# DOUBLE quotes only. The apostrophe is a word character in this domain —
# `Bachelor's` would OPEN a quote that never closes and suppress every separator
# after it in the same entry, which is the fires-on-legitimate-input failure the
# set above exists to avoid, arriving from the other side. The typographic pair
# is here because a CV pasted out of Word carries it. Hebrew's geresh/gershayim
# (׳ ״) are deliberately absent for the same reason as the apostrophe: they sit
# INSIDE words (ד״ר, צה״ל), never around them.
_QUOTE_CLOSERS = frozenset({'"', "”"})


def _split_entry(raw: str) -> list[str]:
    """One raw entry → the skills it actually holds.

    Never a truncation: a separator-free entry comes back whole however long it
    is. The renderer wraps a long chip; nothing here shortens the user's text.
    """
    parts: list[str] = []
    buf: list[str] = []
    stack: list[str] = []
    for ch in raw or "":
        if stack and ch == stack[-1]:
            stack.pop()
        elif ch in _OPENERS and not (stack and stack[-1] in _QUOTE_CLOSERS):
            # Text inside quotes is literal, so a stray bracket in it opens
            # nothing — otherwise one unbalanced `(` would swallow the rest.
            stack.append(_OPENERS[ch])
        elif ch in _SKILL_SEPARATORS and not stack:
            parts.append("".join(buf))
            buf = []
            continue
        buf.append(ch)
    parts.append("".join(buf))
    return [part.strip() for part in parts if part.strip()]


def normalize_skills(
    skills: list[str], groups: list[SkillGroup]
) -> tuple[list[str], list[SkillGroup]]:
    """Split multi-skill entries into single skills — in BOTH fields, together.

    A CV that writes "Python, SQL, Go" on one line arrives from the structurer
    as a SINGLE skill: it renders as one chip, scores as one keyword, and is one
    fact to the ATS x-ray. Splitting it is therefore a real fix to what the
    document says, not tidying.

    **It must be a two-field write, and the one-field form is worse than doing
    nothing.** `ResumeModel._sync_skill_groups` only ever ADDS: it re-establishes
    `skills` as the flat union of every group's items on every construction. So
    normalising the flat list alone and round-tripping through JSON gives back
    `['Python', 'SQL', 'Go', 'Python, SQL']` — the un-split entry resurrects out
    of its group and now coexists with its own fragments, so that skill renders
    twice and is counted twice. Splitting is a removal plus an add, which is the
    same rule `length_budget._drop_unmatched_skill` already obeys in the other
    direction.

    The returned pair is a FIXED POINT of that validator by construction: every
    grouped item is in the flat list, so re-validating adds nothing. The smoke
    test pins that rather than this function paying for a full re-validation
    round-trip on every parse.

    NO length cap, in characters or in bytes. A skill is the user's own text and
    "never truncate the user's own document" applies to it verbatim; a
    sentence-shaped skill is REPORTED by `ats_scan` and wrapped by the renderer,
    never shortened. (A display cap would also have to be measured in rendered
    POINTS, not bytes — the `split` rail holds 27 lowercase Latin characters but
    28 Hebrew ones, so a byte cap would hand the primary market half the room.)
    """
    out_groups: list[SkillGroup] = []
    for group in groups:
        items: list[str] = []
        group_seen: set[str] = set()
        for raw in group.items:
            for item in _split_entry(raw):
                key = item.casefold()
                if key in group_seen:
                    continue
                group_seen.add(key)
                items.append(item)
        # An emptied group is kept rather than dropped: `skill_blocks` already
        # renders nothing for a label with no items, and silently deleting a
        # group is a bigger change than this function is allowed to make.
        out_groups.append(group.model_copy(update={"items": items}))

    # Flat first, then the groups top it up — deliberately the same order
    # `_sync_skill_groups` uses, so the spelling that wins here is the spelling
    # that would have won there. `.casefold()` matches it too.
    flat: list[str] = []
    seen: set[str] = set()

    def _take(item: str) -> None:
        key = item.casefold()
        if key not in seen:
            seen.add(key)
            flat.append(item)

    for raw in skills:
        for item in _split_entry(raw):
            _take(item)
    for group in out_groups:
        for item in group.items:  # already split above
            _take(item)
    return flat, out_groups


def normalize_resume_skills(resume: ResumeModel) -> ResumeModel:
    """`normalize_skills` applied to a whole résumé — the ONE definition of the
    two-field write.

    Callers get both fields written or neither. That placement is the same
    reasoning as `setMaster` calling `adoptMaster` on the frontend: a second
    enforcement door added later inherits the correct behaviour instead of
    re-deriving it and getting half of it right.

    Returns `resume` ITSELF when nothing needed splitting, so a caller can
    identity-compare to ask "did this change anything?" without diffing.
    """
    flat, groups = normalize_skills(resume.skills, resume.skill_groups)
    if flat == resume.skills and groups == resume.skill_groups:
        return resume
    return resume.model_copy(update={"skills": flat, "skill_groups": groups})


def skill_blocks(resume: ResumeModel) -> list[tuple[str, list[str]]]:
    """`[(label, items)]` for the Skills section, in render order.

    An empty label means "draw the items with no label" — which is exactly the
    ungrouped behaviour, so the no-groups case comes out of the same code path
    the grouped one does.
    """
    live_skills = [s.strip() for s in resume.skills if s and s.strip()]
    if not resume.skill_groups:
        return [("", live_skills)] if live_skills else []

    blocks: list[tuple[str, list[str]]] = []
    claimed: set[str] = set()
    for group in resume.skill_groups:
        items: list[str] = []
        seen: set[str] = set()
        for raw in group.items:
            item = (raw or "").strip()
            key = item.casefold()
            if not item or key in seen:
                continue
            seen.add(key)
            claimed.add(key)
            items.append(item)
        if items:
            blocks.append(((group.label or "").strip(), items))

    # Anything the groups did not claim still has to appear — see the module
    # docstring: an invisible skill is an x-ray "missing", not a tidier page.
    leftover = [s for s in live_skills if s.casefold() not in claimed]
    if leftover:
        blocks.append(("", leftover))
    return blocks
