"""Generate a tailored cover letter from the resume + JD."""
from __future__ import annotations

from app.llm.client import get_llm_client
from app.llm import prompts
from app.models import JDModel, ResumeModel


def generate_cover_letter(resume: ResumeModel, jd: JDModel, tone: str = "professional") -> str:
    client = get_llm_client()
    return client.complete_text(
        prompts.COVER_LETTER_SYSTEM,
        prompts.cover_letter_user(resume.model_dump_json(), jd.model_dump_json(), tone),
    ).strip()
