"""Interview-defensibility review (humanization spec, stage 11).

The fabrication guard catches invented facts; this catches TRUE-BUT-OVERSTATED
wording — participation dressed as ownership, prototypes dressed as production,
scale words the resume doesn't back. Flags are advisory: the UI shows them with
a defensible rewording, and the existing per-bullet review lets the user act.

Best-effort by design: a failed review returns [] — it must never block the
tailor result.
"""
from __future__ import annotations

from app.llm import prompts
from app.llm.client import get_llm_client
from app.models import CredibilityFlag, JDModel, ResumeModel


def review_credibility(tailored: ResumeModel, jd: JDModel) -> list[CredibilityFlag]:
    try:
        data = get_llm_client().complete_json(
            prompts.CREDIBILITY_SYSTEM,
            prompts.credibility_user(tailored.model_dump_json(), jd.model_dump_json()),
        )
        flags = [CredibilityFlag.model_validate(f) for f in data.get("flags", [])]
        # A suggestion that introduces wording the guard would reject is the
        # reviewer misbehaving; drop empty-text entries defensively too.
        return [f for f in flags if f.text.strip()]
    except Exception:  # noqa: BLE001
        return []
