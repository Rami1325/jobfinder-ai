"""Outreach Studio — recruiter / hiring-manager / referral messages.

The highest-converting path to an interview is a warm, specific message to a
real person, not another portal application. Everything is grounded in the
résumé (the prompt enforces it, same honesty rule as the fabrication guard).
"""
from __future__ import annotations

from app.core.lang import resume_language
from app.llm.client import get_llm_client
from app.llm import prompts
from app.models import OutreachResult, ResumeModel


def generate_outreach(
    resume: ResumeModel,
    jd_text: str = "",
    company: str = "",
    job_title: str = "",
    contact_name: str = "",
    contact_role: str = "recruiter",
) -> OutreachResult:
    client = get_llm_client()
    data = client.complete_json(
        # Hebrew résumé => messages in Hebrew (note appended AFTER the Task tag).
        prompts.with_resume_language(prompts.OUTREACH_SYSTEM, resume_language(resume)),
        prompts.outreach_user(
            resume.model_dump_json(),
            jd_text,
            company,
            job_title,
            contact_name,
            contact_role,
        ),
    )
    return OutreachResult(
        connection_note=str(data.get("connection_note", "")),
        inmail_subject=str(data.get("inmail_subject", "")),
        inmail_body=str(data.get("inmail_body", "")),
        referral_message=str(data.get("referral_message", "")),
    )
