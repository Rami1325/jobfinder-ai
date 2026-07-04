"""Analyze a pasted job description into structured requirements."""
from __future__ import annotations

from app.core.lang import detect_language
from app.llm.client import get_llm_client
from app.llm import prompts
from app.models import JDModel


def analyze_jd(jd_text: str) -> JDModel:
    # Detected deterministically (Hebrew-block regex), never by the LLM: it
    # drives prompt language notes and must be reproducible offline.
    language = detect_language(jd_text)
    client = get_llm_client()
    data = client.complete_json(
        prompts.analyze_jd_system(language),
        prompts.analyze_jd_user(jd_text),
    )
    jd = JDModel.model_validate(data)
    jd.language = language  # authoritative — overrides anything the LLM emitted
    return jd
