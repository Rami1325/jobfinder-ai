"""Interview prep — questions, model answers, and feedback grounded in the résumé."""
from __future__ import annotations

from app.core.lang import resume_language
from app.llm.client import get_llm_client
from app.llm import prompts
from app.models import (
    InterviewAnswerResult,
    InterviewFeedbackResult,
    InterviewQuestion,
    InterviewQuestionsResult,
    JDModel,
    RecruiterPrepItem,
    RecruiterScreenResult,
    ResumeModel,
)


def generate_questions(resume: ResumeModel, jd: JDModel) -> InterviewQuestionsResult:
    client = get_llm_client()
    data = client.complete_json(
        prompts.INTERVIEW_QUESTIONS_SYSTEM,
        prompts.interview_questions_user(resume.model_dump_json(), jd.model_dump_json()),
    )
    questions = [InterviewQuestion.model_validate(q) for q in data.get("questions", []) if q]
    return InterviewQuestionsResult(questions=questions)


def model_answer(resume: ResumeModel, jd: JDModel, question: str) -> InterviewAnswerResult:
    client = get_llm_client()
    data = client.complete_json(
        # Hebrew résumé => answer in Hebrew (note appended AFTER the Task tag).
        prompts.with_resume_language(prompts.INTERVIEW_ANSWER_SYSTEM, resume_language(resume)),
        prompts.interview_answer_user(resume.model_dump_json(), jd.model_dump_json(), question),
    )
    return InterviewAnswerResult(
        answer=str(data.get("answer", "")),
        tips=[str(t) for t in data.get("tips", [])],
    )


def recruiter_screen(resume: ResumeModel, jd_text: str) -> RecruiterScreenResult:
    client = get_llm_client()
    data = client.complete_json(
        # Hebrew résumé => prep sheet in Hebrew (note appended AFTER the Task tag).
        prompts.with_resume_language(prompts.RECRUITER_SCREEN_SYSTEM, resume_language(resume)),
        prompts.recruiter_screen_user(resume.model_dump_json(), jd_text),
    )
    items = [RecruiterPrepItem.model_validate(x) for x in data.get("items", []) if x]
    return RecruiterScreenResult(
        pitch=str(data.get("pitch", "")),
        items=items,
        salary_note=str(data.get("salary_note", "")),
    )


def answer_feedback(resume: ResumeModel, question: str, answer: str) -> InterviewFeedbackResult:
    client = get_llm_client()
    data = client.complete_json(
        # Feedback + revised answer follow the résumé's language too.
        prompts.with_resume_language(prompts.INTERVIEW_FEEDBACK_SYSTEM, resume_language(resume)),
        prompts.interview_feedback_user(resume.model_dump_json(), question, answer),
    )
    score = float(data.get("score", 0) or 0)
    return InterviewFeedbackResult(
        score=max(0.0, min(100.0, score)),
        strengths=[str(s) for s in data.get("strengths", [])],
        improvements=[str(s) for s in data.get("improvements", [])],
        revised_answer=str(data.get("revised_answer", "")),
    )
