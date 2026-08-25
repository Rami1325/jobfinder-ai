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
"""
from __future__ import annotations

from app.models import ResumeModel


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
