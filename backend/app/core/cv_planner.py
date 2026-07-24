"""CV positioning stage (humanization spec, stage 4).

Decides the professional story BEFORE the tailor writes anything: which
identity to present, what leads, what gets trimmed, and which claims need
conservative wording. The plan is injected into the TAILOR user message and
surfaced on TailorResult so the user sees the strategy, not just the output.

Best-effort by design: a failed plan returns None and tailoring proceeds
without one — positioning improves the result, it must never block it.
"""
from __future__ import annotations

from app.llm import prompts
from app.llm.client import get_llm_client
from app.models import CVPlan, JDModel, ResumeModel


def plan_cv(resume: ResumeModel, jd: JDModel) -> CVPlan | None:
    try:
        data = get_llm_client().complete_json(
            prompts.PLAN_CV_SYSTEM,
            prompts.plan_cv_user(resume.model_dump_json(), jd.model_dump_json()),
        )
        plan = CVPlan.model_validate(data)
        # An empty plan carries no signal — treat it as "no plan".
        return plan if plan.positioning.strip() else None
    except Exception:  # noqa: BLE001 - planning must never break tailoring
        return None
