"""The tailoring engine: score -> plan -> rewrite -> guard -> humanize ->
credibility review -> rescore (the humanization-spec pipeline)."""
from __future__ import annotations

from app.config import get_settings
from app.core.credibility import review_credibility
from app.core.cv_planner import plan_cv
from app.core.fabrication_guard import check_fabrication
from app.core.humanizer import humanize_resume
from app.core.lang import resume_language
from app.core.length_budget import fit_to_pages
from app.core.scorer import score_resume
from app.core.voice_audit import audit_voice
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
from app.render.pdf_renderer import page_count
from app.render.templates import DEFAULT_TEMPLATE


def tailor_resume(
    resume: ResumeModel,
    jd: JDModel,
    ledger: FactsLedger | None = None,
    avoid_phrases: list[str] | None = None,
    template: str = DEFAULT_TEMPLATE,
) -> TailorResult:
    """`avoid_phrases`: wording this user rejected in past reviews (§26
    feedback loop) — injected into the tailor prompt as a hard avoid-list.
    `template`: which résumé template the page budget measures against."""
    if ledger is None:
        ledger = build_facts_ledger(resume)

    settings = get_settings()
    max_pages = settings.resume_max_pages
    hard_max_pages = settings.resume_hard_max_pages

    score_before = score_resume(resume, jd)

    # Stage 4 (positioning): decide the professional story before writing —
    # including WHICH projects earn their space in this particular CV.
    # Best-effort — a failed plan (None) tailors without one.
    plan = plan_cv(resume, jd)

    client = get_llm_client()
    data = client.complete_json(
        # Hebrew résumé => tailor in Hebrew (note appended AFTER the Task tag).
        prompts.with_resume_language(prompts.TAILOR_SYSTEM, resume_language(resume)),
        prompts.tailor_user(
            resume.model_dump_json(),
            jd.model_dump_json(),
            plan_json=plan.model_dump_json() if plan else "",
            avoid_phrases=avoid_phrases,
            max_pages=max_pages,
            source_pages=page_count(resume, template),
            source_projects=len(resume.projects),
        ),
    )

    tailored = ResumeModel.model_validate(data.get("tailored_resume", resume.model_dump()))
    changelog = [ChangeLogEntry.model_validate(c) for c in data.get("changelog", [])]
    covered = list(data.get("covered_keywords", []))

    # Page budget: the prompt asks for a 2-pager, this guarantees one. Runs
    # BEFORE the guard and the voice pass so every later stage sees exactly
    # the content that will ship. Trimming only removes, so it can never add
    # a claim the guard would have caught.
    tailored, length_report = fit_to_pages(
        tailored, jd, plan, template=template,
        max_pages=max_pages, hard_max_pages=hard_max_pages,
    )

    flags = check_fabrication(tailored, ledger)

    # Human-voice loop (humanization spec): the deterministic audit hunts for
    # AI tells; when it finds any, one humanizer LLM pass fixes wording. The
    # revision ships ONLY if the guard finds nothing new in it AND the re-audit
    # confirms the voice actually improved — otherwise the tailored resume
    # stands. Voice polish is never allowed to cost truthfulness, and since
    # rewording can run long, it is not allowed to cost the page budget either.
    report = audit_voice(tailored, jd)
    if report.issues:
        revised = humanize_resume(tailored, report.issues, jd)
        if revised is not None:
            revised_flags = check_fabrication(revised, ledger)
            post = audit_voice(revised, jd)
            if (
                len(revised_flags) <= len(flags)
                and post.human_voice_score > report.human_voice_score
                and page_count(revised, template) <= max(length_report.pages_after, max_pages)
            ):
                remaining = {(i.category, i.value) for i in post.issues}
                post.fixed = [i for i in report.issues if (i.category, i.value) not in remaining]
                post.revised = True
                tailored, flags, report = revised, revised_flags, post

    # Stage 11 (credibility): true-but-overstated wording the candidate may
    # struggle to defend in an interview. Advisory flags, never auto-removal.
    credibility_flags = review_credibility(tailored, jd)

    score_after = score_resume(tailored, jd)

    return TailorResult(
        tailored_resume=tailored,
        changelog=changelog,
        covered_keywords=covered,
        fabrication_flags=flags,
        score_before=score_before,
        score_after=score_after,
        voice_report=report,
        plan=plan,
        credibility_flags=credibility_flags,
        length_report=length_report,
    )
