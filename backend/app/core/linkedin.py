"""LinkedIn profile optimizer — rewrites from real résumé facts only."""
from __future__ import annotations

from app.llm.client import get_llm_client
from app.llm import prompts
from app.models import LinkedInResult, ResumeModel


def optimize_linkedin(resume: ResumeModel) -> LinkedInResult:
    client = get_llm_client()
    data = client.complete_json(prompts.LINKEDIN_SYSTEM, prompts.linkedin_user(resume.model_dump_json()))
    return LinkedInResult(
        headline=str(data.get("headline", "")),
        about=str(data.get("about", "")),
        experience_bullets=[str(b) for b in data.get("experience_bullets", [])],
        skills=[str(s) for s in data.get("skills", [])],
    )
