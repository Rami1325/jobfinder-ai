"""Follow-up email writer for a specific application stage."""
from __future__ import annotations

from app.llm.client import get_llm_client
from app.llm import prompts
from app.models import FollowUpResult


def write_follow_up(company: str, role: str, stage: str, context: str) -> FollowUpResult:
    client = get_llm_client()
    data = client.complete_json(
        prompts.follow_up_system(stage),
        prompts.follow_up_user(company, role, stage, context),
    )
    return FollowUpResult(subject=str(data.get("subject", "")), body=str(data.get("body", "")))
