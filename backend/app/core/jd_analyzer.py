"""Analyze a pasted job description into structured requirements."""
from __future__ import annotations

from app.config import get_settings
from app.core.job_market import israel_market, market_code
from app.core.lang import detect_language
from app.llm.client import get_llm_client
from app.llm import prompts
from app.llm.limits import require_within
from app.models import JDModel


def analyze_jd(jd_text: str, location: str = "") -> JDModel:
    """`location`: an optional hint (a job board's location field) for the
    market stamp only — never sent to the model."""
    require_within(jd_text, get_settings().max_jd_kb, "jd")
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
    # Same rule, same reason: deterministic, and authoritative over anything the
    # model emitted. "" = unknown, never "not Israel".
    jd.market = market_code(israel_market(jd_text, location, language))
    return jd
