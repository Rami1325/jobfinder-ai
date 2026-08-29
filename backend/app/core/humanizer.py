"""Human-voice editing pass (CV humanization spec, stage 7).

Runs ONLY when the deterministic voice audit found issues, and its output is
accepted ONLY if it survives the fabrication guard and actually improves the
voice score — otherwise the original tailored resume ships unchanged. The
humanizer can therefore never make the resume less truthful, only less robotic.
"""
from __future__ import annotations

from app.core.lang import resume_language
from app.llm import prompts
from app.llm.client import get_llm_client
from app.models import JDModel, ResumeModel, VoiceIssue

# Locations are appended when present so the editor can find the spot fast.
_ISSUE_LINE = "- [{category}] {value}{loc}: {detail}"


def _issues_text(issues: list[VoiceIssue]) -> str:
    lines = []
    for i in issues:
        loc = f" (in {i.location})" if i.location else ""
        lines.append(_ISSUE_LINE.format(category=i.category, value=i.value, loc=loc, detail=i.detail))
    return "\n".join(lines)


def humanize_resume(tailored: ResumeModel, issues: list[VoiceIssue], jd: JDModel) -> ResumeModel | None:
    """One LLM edit pass over the audit findings. Returns None on any failure —
    the caller treats None as 'keep the tailored resume as-is'."""
    if not issues:
        return None
    # `preferred_skills` are in the keep-list too. They were excluded, which read
    # as symmetry with `scorer.keyword_analysis` (keywords + hard_skills) but is
    # not the same question: coverage is a PERCENTAGE and widening its
    # denominator would change every visible number, while this list is prose in
    # a prompt ("Keep the listed ATS keywords present"). A wider list is strictly
    # more protective and costs only prompt bytes, which `@_bounded` already caps.
    keep = list(dict.fromkeys([*jd.keywords, *jd.hard_skills, *jd.preferred_skills]))
    client = get_llm_client()
    try:
        data = client.complete_json(
            prompts.with_resume_language(prompts.HUMANIZE_SYSTEM, resume_language(tailored)),
            prompts.humanize_user(tailored.model_dump_json(), _issues_text(issues), keep),
        )
        revised = data.get("revised_resume")
        if not isinstance(revised, dict):
            return None
        return ResumeModel.model_validate(revised)
    except Exception:  # noqa: BLE001 - a failed polish pass must never break tailoring
        return None
