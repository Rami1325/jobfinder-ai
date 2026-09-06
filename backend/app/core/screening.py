"""Screening-question answerer — honest, resume-grounded application answers.

Many applications and screening calls ask free-text questions ("Why us?",
"Describe a time…"). This drafts an answer using only what's in the resume,
same honesty rule as the rest of the app.
"""
from __future__ import annotations

from app.core.lang import resume_language
from app.llm.client import get_llm_client
from app.llm import prompts
from app.models import ResumeModel, ScreeningAnswerResult


def answer_screening_question(
    resume: ResumeModel, jd_text: str, question: str
) -> ScreeningAnswerResult:
    client = get_llm_client()
    data = client.complete_json(
        prompts.with_resume_language(prompts.SCREENING_ANSWER_SYSTEM, resume_language(resume)),
        prompts.screening_user(resume.model_dump_json(), jd_text, question),
    )
    return ScreeningAnswerResult(
        answer=str(data.get("answer", "")),
        tips=[str(x) for x in data.get("tips", [])],
    )
