"""Generate a tailored cover letter from the resume + JD."""
from __future__ import annotations

from app.core.lang import resume_language
from app.llm.client import get_llm_client
from app.llm import prompts
from app.models import JDModel, ResumeModel


def generate_cover_letter(resume: ResumeModel, jd: JDModel, tone: str = "professional") -> str:
    client = get_llm_client()
    return client.complete_text(
        # Hebrew résumé => write in Hebrew; Hebrew JD => Israeli mode
        # (3-5 sentence email body instead of a formal letter).
        prompts.cover_letter_system(resume_language(resume), jd.language),
        prompts.cover_letter_user(resume.model_dump_json(), jd.model_dump_json(), tone),
    ).strip()
