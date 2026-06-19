"""Analyze a pasted job description into structured requirements."""
from __future__ import annotations

from app.llm.client import get_llm_client
from app.llm import prompts
from app.models import JDModel


def analyze_jd(jd_text: str) -> JDModel:
    client = get_llm_client()
    data = client.complete_json(
        prompts.ANALYZE_JD_SYSTEM,
        prompts.analyze_jd_user(jd_text),
    )
    return JDModel.model_validate(data)
