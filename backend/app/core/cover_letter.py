"""Generate a tailored cover letter from the resume + JD."""
from __future__ import annotations

from app.core.lang import resume_language
from app.llm.client import get_llm_client
from app.llm import prompts
from app.models import JDModel, ResumeModel


def generate_cover_letter(resume: ResumeModel, jd: JDModel, tone: str = "professional") -> str:
    client = get_llm_client()
    return client.complete_text(
        # Hebrew résumé => write the letter in Hebrew.
        prompts.with_resume_language(prompts.COVER_LETTER_SYSTEM, resume_language(resume)),
        prompts.cover_letter_user(resume.model_dump_json(), jd.model_dump_json(), tone),
    ).strip()
