"""The tailoring engine: orchestrates score -> rewrite -> guard -> rescore."""
from __future__ import annotations

from app.core.fabrication_guard import check_fabrication
from app.core.lang import resume_language
from app.core.scorer import score_resume
from app.llm.client import get_llm_client
from app.llm import prompts
from app.models import (
    ChangeLogEntry,
    FactsLedger,
    JDModel,
    ResumeModel,
    TailorResult,
)
from app.parsers.structurer import build_facts_ledger


def tailor_resume(resume: ResumeModel, jd: JDModel, ledger: FactsLedger | None = None) -> TailorResult:
    if ledger is None:
        ledger = build_facts_ledger(resume)

    score_before = score_resume(resume, jd)

    client = get_llm_client()
    data = client.complete_json(
        # Hebrew résumé => tailor in Hebrew (note appended AFTER the Task tag).
        prompts.with_resume_language(prompts.TAILOR_SYSTEM, resume_language(resume)),
        prompts.tailor_user(resume.model_dump_json(), jd.model_dump_json()),
    )

    tailored = ResumeModel.model_validate(data.get("tailored_resume", resume.model_dump()))
    changelog = [ChangeLogEntry.model_validate(c) for c in data.get("changelog", [])]
    covered = list(data.get("covered_keywords", []))

    flags = check_fabrication(tailored, ledger)
    score_after = score_resume(tailored, jd)

    return TailorResult(
        tailored_resume=tailored,
        changelog=changelog,
        covered_keywords=covered,
        fabrication_flags=flags,
        score_before=score_before,
        score_after=score_after,
    )
