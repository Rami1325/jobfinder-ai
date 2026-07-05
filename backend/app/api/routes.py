"""FastAPI routes wiring the pipeline together."""
from __future__ import annotations

import hmac
import io
import json
import queue
import threading

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.deps import admin_user, current_user
from app.config import get_settings

from app.core import alerts as alerts_core
from app.core import auto_submit
from app.core.ats_scan import scan_resume
from app.core.cover_letter import generate_cover_letter
from app.core.mailer import smtp_configured
from app.core.follow_up import write_follow_up
from app.core.free_scan import free_scan, free_scan_limiter
from app.core.interview import answer_feedback, generate_questions, model_answer
from app.core.jd_analyzer import analyze_jd
from app.core.job_match import fetch_job_text, match_jobs
from app.core.job_search import derive_search_context, search_jobs
from app.core import kits as kits_core
from app.core.lang import resume_language
from app.core.linkedin import optimize_linkedin
from app.core.providers.comeet import register_company as register_comeet_company
from app.core.providers.greenhouse import register_company as register_greenhouse_company
from app.core.providers.greenhouse_seed import board_url as greenhouse_board_url
from app.core.tailor import tailor_resume
from app.core.usage import check_and_count
from app.db.comeet import list_companies as list_comeet_companies
from app.db.database import get_db
from app.db.greenhouse import list_companies as list_greenhouse_companies
from app.db.users import mint_user
from app.db.history import (
    application_statuses,
    clear_search_hits,
    delete_search_hit,
    list_search_hits,
    record_search_hits,
)
from app.db.models import (
    Application,
    Feedback,
    JobAlert,
    JobSearchHit,
    SavedResume,
    TailorKit,
    UsageLog,
    User,
)
from app.models import (
    AddComeetCompanyRequest,
    AddGreenhouseCompanyRequest,
    AlertCronResult,
    AlertRunResult,
    AlertSettingsIn,
    AlertSettingsOut,
    ApplicationCreate,
    ApplicationDetail,
    ApplicationOut,
    ApplicationUpdate,
    ATSScanRequest,
    ATSScanResult,
    ComeetCompanyList,
    ComeetCompanyOut,
    CoverLetterRequest,
    CoverLetterResponse,
    DeleteMyDataResult,
    FactsLedger,
    FeedbackIn,
    FeedbackList,
    FeedbackOut,
    FollowUpRequest,
    FollowUpResult,
    FreeScanResult,
    GreenhouseCompanyList,
    GreenhouseCompanyOut,
    InterviewAnswerRequest,
    InterviewAnswerResult,
    InterviewFeedbackRequest,
    InterviewFeedbackResult,
    InterviewQuestionsRequest,
    InterviewQuestionsResult,
    JDAnalyzeRequest,
    JDModel,
    JobFetchRequest,
    JobFetchResponse,
    JobMatchRequest,
    JobMatchResult,
    JobSearchHistory,
    JobSearchHitOut,
    JobSearchRequest,
    JobSearchResult,
    KitApproveRequest,
    KitBatchRequest,
    KitBatchResult,
    KitDetail,
    KitList,
    KitOut,
    KitProcessResult,
    KitRejectRequest,
    LinkedInRequest,
    LinkedInResult,
    MasterResumeIn,
    MasterResumeList,
    MasterResumeOut,
    RenderRequest,
    ResumeModel,
    ResumeUploadResponse,
    SearchContext,
    SearchContextRequest,
    TailorRequest,
    TailorResult,
    UserCreate,
    UserList,
    UserOut,
    UserUpdate,
)
from app.parsers.resume_parser import extract_text
from app.parsers.structurer import build_facts_ledger, structure_resume
from app.render.docx_renderer import render_docx
from app.render.pdf_renderer import render_pdf

router = APIRouter()


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/resume/upload", response_model=ResumeUploadResponse)
async def upload_resume(file: UploadFile = File(...)) -> ResumeUploadResponse:
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file.")
    try:
        raw = extract_text(file.filename or "", data)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not raw.strip():
        raise HTTPException(422, "Could not extract any text from the file.")
    try:
        resume = structure_resume(raw)
    except Exception as e:  # noqa: BLE001 - surface the real LLM error to the UI
        raise HTTPException(502, f"LLM error while structuring résumé: {e}")
    ledger = build_facts_ledger(resume)
    return ResumeUploadResponse(resume=resume, ledger=ledger)


@router.post("/jd/analyze", response_model=JDModel)
def jd_analyze(body: JDAnalyzeRequest) -> JDModel:
    if not body.jd_text.strip():
        raise HTTPException(400, "Job description text is empty.")
    try:
        return analyze_jd(body.jd_text)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while analyzing job description: {e}")


@router.post("/tailor", response_model=TailorResult)
def tailor(
    body: TailorRequest,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> TailorResult:
    check_and_count(db, user, "tailor", get_settings().daily_tailor_cap)
    try:
        return tailor_resume(body.resume, body.jd)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while tailoring résumé: {e}")


@router.post("/cover-letter", response_model=CoverLetterResponse)
def cover_letter(body: CoverLetterRequest) -> CoverLetterResponse:
    try:
        text = generate_cover_letter(body.resume, body.jd, body.tone)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while writing cover letter: {e}")
    return CoverLetterResponse(cover_letter=text)


@router.post("/render")
def render(body: RenderRequest):
    fmt = body.fmt.lower()
    if fmt == "pdf":
        content = render_pdf(body.resume, template=body.template)
        media = "application/pdf"
        filename = "resume.pdf"
    elif fmt == "docx":
        content = render_docx(body.resume, template=body.template)
        media = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        filename = "resume.docx"
    else:
        raise HTTPException(400, "fmt must be 'docx' or 'pdf'.")
    return StreamingResponse(
        io.BytesIO(content),
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --------------------------------------------------------------------------- #
# Interview prep
# --------------------------------------------------------------------------- #
@router.post("/interview/questions", response_model=InterviewQuestionsResult)
def interview_questions(body: InterviewQuestionsRequest) -> InterviewQuestionsResult:
    try:
        return generate_questions(body.resume, body.jd)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while generating interview questions: {e}")


@router.post("/interview/answer", response_model=InterviewAnswerResult)
def interview_answer(body: InterviewAnswerRequest) -> InterviewAnswerResult:
    if not body.question.strip():
        raise HTTPException(400, "Question is empty.")
    try:
        return model_answer(body.resume, body.jd, body.question)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while writing the model answer: {e}")


@router.post("/interview/feedback", response_model=InterviewFeedbackResult)
def interview_feedback(body: InterviewFeedbackRequest) -> InterviewFeedbackResult:
    if not body.answer.strip():
        raise HTTPException(400, "Answer is empty.")
    try:
        return answer_feedback(body.resume, body.question, body.answer)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while evaluating the answer: {e}")


# --------------------------------------------------------------------------- #
# Job discovery / matching
# --------------------------------------------------------------------------- #
@router.post("/jobs/match", response_model=JobMatchResult)
def jobs_match(body: JobMatchRequest) -> JobMatchResult:
    if not body.listings:
        raise HTTPException(400, "Provide at least one job listing.")
    try:
        return match_jobs(body.resume, body.listings)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while matching jobs: {e}")


@router.post("/jobs/fetch", response_model=JobFetchResponse)
def jobs_fetch(body: JobFetchRequest) -> JobFetchResponse:
    if not body.url.strip():
        raise HTTPException(400, "URL is empty.")
    try:
        return JobFetchResponse(text=fetch_job_text(body.url))
    except Exception as e:  # noqa: BLE001 - network/parse errors surface to the UI
        raise HTTPException(400, f"Could not fetch that URL: {e}")


@router.post("/jobs/search-context", response_model=SearchContext)
def jobs_search_context(body: SearchContextRequest) -> SearchContext:
    """Derive what/where to search from the résumé, so the UI can prefill the
    'Customize search' fields before any scrape runs."""
    try:
        return derive_search_context(body.resume)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Error deriving search context: {e}")


@router.post("/jobs/search", response_model=JobSearchResult)
def jobs_search(
    body: JobSearchRequest,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> JobSearchResult:
    check_and_count(db, user, "search", get_settings().daily_search_cap)
    try:
        result = search_jobs(body.resume, body.customize)
    except ValueError as e:  # user-facing scrape/search problems
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Error while searching jobs: {e}")
    try:  # history persistence is best-effort — never fail the search because of it
        record_search_hits(db, result.matches, user.id)
    except Exception:  # noqa: BLE001
        pass
    return result


def _sse_frame(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/jobs/search/stream")
def jobs_search_stream(
    body: JobSearchRequest,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> StreamingResponse:
    """Same search as POST /jobs/search, but as an SSE stream (PLAN 9.2) so the
    UI can show real per-board / per-job progress instead of guessing from
    elapsed time. Events: `progress` (see job_search.ProgressFn), then exactly
    one terminal `result` (a JobSearchResult) or `error` ({detail, status}).
    Errors after the 200 header ride the stream — the cap check raises a plain
    429 before streaming starts, so old error handling still applies there."""
    check_and_count(db, user, "search", get_settings().daily_search_cap)

    events: queue.Queue = queue.Queue()

    def _worker() -> None:
        try:
            result = search_jobs(
                body.resume, body.customize, progress=lambda e: events.put(("progress", e))
            )
            events.put(("result", result))
        except ValueError as e:  # user-facing scrape/search problems
            events.put(("error", {"detail": str(e), "status": 400}))
        except Exception as e:  # noqa: BLE001
            events.put(("error", {"detail": f"Error while searching jobs: {e}", "status": 502}))

    threading.Thread(target=_worker, daemon=True).start()

    def _stream():
        while True:
            try:
                kind, payload = events.get(timeout=15)
            except queue.Empty:
                yield ": keep-alive\n\n"  # searches sit minutes on slow boards; don't let proxies idle out
                continue
            if kind == "progress":
                yield _sse_frame("progress", payload)
            elif kind == "result":
                try:  # best-effort history persistence, same as the non-stream route
                    record_search_hits(db, payload.matches, user.id)
                except Exception:  # noqa: BLE001
                    pass
                yield _sse_frame("result", payload.model_dump())
                return
            else:
                yield _sse_frame("error", payload)
                return

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/jobs/history", response_model=JobSearchHistory)
def jobs_history(
    db: Session = Depends(get_db), user: User = Depends(current_user)
) -> JobSearchHistory:
    rows = list_search_hits(db, user.id)
    statuses = application_statuses(db, [row.url for row in rows], user.id)

    def _keyword_list(raw: str | None) -> list[str]:
        try:
            return json.loads(raw) if raw else []
        except Exception:  # noqa: BLE001 - tolerate legacy/corrupt rows
            return []

    hits: list[JobSearchHitOut] = []
    for row in rows:
        hits.append(
            JobSearchHitOut(
                id=row.id,
                title=row.title,
                company=row.company,
                location=row.location,
                url=row.url,
                overall=row.overall,
                keyword_coverage=row.keyword_coverage,
                fit_score=row.fit_score,
                top_matched=_keyword_list(row.top_matched_json),
                top_gaps=_keyword_list(row.top_gaps_json),
                jd_text=row.jd_text,
                posted_at=row.posted_at or "",
                source=row.source or "linkedin",
                logo_url=row.logo_url or "",
                searched_at=row.searched_at.isoformat() if row.searched_at else "",
                app_status=statuses.get(row.url, ""),
            )
        )
    return JobSearchHistory(hits=hits)


@router.delete("/jobs/history/{hit_id}")
def delete_jobs_history_item(
    hit_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> dict[str, bool]:
    if not delete_search_hit(db, hit_id, user.id):
        raise HTTPException(404, "History item not found.")
    return {"deleted": True}


@router.delete("/jobs/history")
def clear_jobs_history(
    db: Session = Depends(get_db), user: User = Depends(current_user)
) -> dict[str, int]:
    return {"deleted": clear_search_hits(db, user.id)}


# --------------------------------------------------------------------------- #
# Job alerts (PLAN 6): saved-search re-runs on a schedule, email new hits
# --------------------------------------------------------------------------- #
def _alert_out(row, db: Session) -> AlertSettingsOut:  # noqa: ANN001 - JobAlert ORM row
    return AlertSettingsOut(
        enabled=row.enabled,
        email=row.email,
        context=alerts_core.alert_context(row),
        last_run_at=row.last_run_at.isoformat() if row.last_run_at else "",
        last_new_count=row.last_new_count or 0,
        last_error=row.last_error or "",
        smtp_configured=smtp_configured(),
    )


@router.get("/jobs/alerts", response_model=AlertSettingsOut)
def get_job_alert(
    db: Session = Depends(get_db), user: User = Depends(current_user)
) -> AlertSettingsOut:
    return _alert_out(alerts_core.get_alert(db, user.id), db)


@router.put("/jobs/alerts", response_model=AlertSettingsOut)
def update_job_alert(
    body: AlertSettingsIn,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> AlertSettingsOut:
    if body.enabled and not body.email.strip():
        raise HTTPException(400, "Add an email address to enable alerts.")
    row = alerts_core.update_alert(
        db, user.id, enabled=body.enabled, email=body.email, context=body.context
    )
    return _alert_out(row, db)


@router.post("/jobs/alerts/run", response_model=AlertRunResult)
def run_job_alert(
    db: Session = Depends(get_db), user: User = Depends(current_user)
) -> AlertRunResult:
    """Manual 'Run now' from the UI — runs even when the toggle is off."""
    return alerts_core.run_alert(db, user.id, force=True)


@router.get("/jobs/alerts/cron", response_model=AlertCronResult)
def cron_job_alert(request: Request, db: Session = Depends(get_db)) -> AlertCronResult:
    """Vercel cron entrypoint (exempt from the X-App-Key gate — see main.py).
    When CRON_SECRET is set, Vercel sends it as a Bearer token; require it.
    Runs every active user's enabled alert (PLAN 7.3)."""
    secret = get_settings().cron_secret
    if secret:
        auth = request.headers.get("authorization", "")
        if not hmac.compare_digest(auth, f"Bearer {secret}"):
            raise HTTPException(401, "Bad cron secret.")
    results = alerts_core.run_all_alerts(db)
    return AlertCronResult(users=len(results), results=results)


# --------------------------------------------------------------------------- #
# Batch auto-tailor kits (PLAN 8.1): enqueue high-fit search results, then the
# client loops POST /kits/process-next — one tailor pipeline run per request,
# so each invocation fits the serverless time budget without queue infra.
# --------------------------------------------------------------------------- #
@router.post("/kits/batch", response_model=KitBatchResult)
def kits_batch(
    body: KitBatchRequest,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> KitBatchResult:
    """Queue tailor kits for the given jobs (deduped by URL; failed kits are
    requeued). What will actually run is charged against the daily tailor cap
    upfront, before any kit is written — fail-fast beats dying mid-batch."""
    try:
        queued_rows, skipped = kits_core.enqueue_kits(
            db,
            user,
            body.jobs,
            charge=lambda n: check_and_count(
                db, user, "tailor", get_settings().daily_tailor_cap, count=n
            ),
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return KitBatchResult(
        queued=[kits_core.kit_out(r) for r in queued_rows], skipped_existing=skipped
    )


@router.post("/kits/process-next", response_model=KitProcessResult)
def kits_process_next(
    db: Session = Depends(get_db), user: User = Depends(current_user)
) -> KitProcessResult:
    """Run the tailor pipeline on the oldest queued kit (already charged to the
    cap at batch time). Pipeline failures land on the kit as status=failed —
    the response is always 200 so the client's loop keeps draining the queue."""
    row, remaining = kits_core.process_next_kit(db, user)
    return KitProcessResult(kit=kits_core.kit_out(row) if row else None, remaining=remaining)


@router.get("/kits", response_model=KitList)
def kits_list(
    db: Session = Depends(get_db), user: User = Depends(current_user)
) -> KitList:
    return KitList(kits=[kits_core.kit_out(r) for r in kits_core.list_kits(db, user.id)])


def _owned_kit(db: Session, kit_id: int, user: User) -> TailorKit:
    row = db.get(TailorKit, kit_id)
    if not row or row.user_id != user.id:
        raise HTTPException(404, "Kit not found.")
    return row


@router.get("/kits/{kit_id}", response_model=KitDetail)
def kits_get(
    kit_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> KitDetail:
    return kits_core.kit_detail(_owned_kit(db, kit_id, user))


@router.post("/kits/{kit_id}/approve", response_model=KitOut)
def kits_approve(
    kit_id: int,
    body: KitApproveRequest,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> KitOut:
    """Approve a reviewed kit (PLAN 8.2): lands in the tracker as a "saved"
    (ready-to-send) application carrying the reviewer's effective résumé and
    cover letter; the kit links to it via application_id."""
    row = _owned_kit(db, kit_id, user)
    try:
        row = kits_core.approve_kit(db, user, row, resume=body.resume, cover_letter=body.cover_letter)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return kits_core.kit_out(row)


@router.post("/kits/{kit_id}/reject", response_model=KitOut)
def kits_reject(
    kit_id: int,
    body: KitRejectRequest,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> KitOut:
    """Reject a reviewed kit, recording why — the reasons feed threshold tuning."""
    row = _owned_kit(db, kit_id, user)
    try:
        row = kits_core.reject_kit(db, row, body.reason)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return kits_core.kit_out(row)


@router.post("/kits/{kit_id}/submit", response_model=KitOut)
def kits_submit(
    kit_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> KitOut:
    """True auto-submit (PLAN 8.4): send an approved, guard-clean Comeet kit's
    application through Comeet's public apply API. Every guardrail lives in
    `auto_submit.submit_kit`; the daily cap is charged only when a real send
    is about to happen."""
    row = _owned_kit(db, kit_id, user)
    settings = get_settings()
    try:
        row = auto_submit.submit_kit(
            db,
            user,
            row,
            charge=lambda: check_and_count(db, user, "submit", settings.daily_submit_cap),
        )
    except ValueError as e:  # refused by a guardrail / declined upstream
        raise HTTPException(400, str(e))
    return kits_core.kit_out(row)


@router.delete("/kits/{kit_id}")
def kits_delete(
    kit_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> dict[str, bool]:
    row = db.get(TailorKit, kit_id)
    if not row or row.user_id != user.id:
        raise HTTPException(404, "Kit not found.")
    db.delete(row)
    db.commit()
    return {"deleted": True}


@router.get("/jobs/comeet/companies", response_model=ComeetCompanyList)
def comeet_companies(db: Session = Depends(get_db)) -> ComeetCompanyList:
    """The Comeet company registry the job search queries (seeded on first use)."""
    return ComeetCompanyList(
        companies=[
            ComeetCompanyOut(slug=c.slug, name=c.name, careers_url=c.careers_url)
            for c in list_comeet_companies(db)
        ]
    )


@router.post("/jobs/comeet/companies", response_model=ComeetCompanyOut)
def comeet_add_company(
    body: AddComeetCompanyRequest, db: Session = Depends(get_db)
) -> ComeetCompanyOut:
    """Grow the registry: paste any public Comeet careers-page URL and its jobs
    join every future search."""
    try:
        c = register_comeet_company(db, body.url)
    except ValueError as e:  # bad URL / not a Comeet page — user-facing
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Error while adding that company: {e}")
    return ComeetCompanyOut(slug=c.slug, name=c.name, careers_url=c.careers_url)


@router.get("/jobs/greenhouse/companies", response_model=GreenhouseCompanyList)
def greenhouse_companies(db: Session = Depends(get_db)) -> GreenhouseCompanyList:
    """The Greenhouse company registry the job search queries (seeded on first use)."""
    return GreenhouseCompanyList(
        companies=[
            GreenhouseCompanyOut(slug=c.slug, name=c.name, board_url=greenhouse_board_url(c.slug))
            for c in list_greenhouse_companies(db)
        ]
    )


@router.post("/jobs/greenhouse/companies", response_model=GreenhouseCompanyOut)
def greenhouse_add_company(
    body: AddGreenhouseCompanyRequest, db: Session = Depends(get_db)
) -> GreenhouseCompanyOut:
    """Grow the registry: paste a Greenhouse board slug or careers URL and its
    jobs join every future search."""
    try:
        c = register_greenhouse_company(db, body.board)
    except ValueError as e:  # bad slug / no such board — user-facing
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Error while adding that company: {e}")
    return GreenhouseCompanyOut(slug=c.slug, name=c.name, board_url=greenhouse_board_url(c.slug))


# --------------------------------------------------------------------------- #
# Free public CV-vs-JD scan (PLAN 6): the landing-page wedge. Exempt from the
# X-App-Key gate (see main.py), deterministic only — never the LLM — and
# nothing is persisted. Rate-limited per client because it is public.
# --------------------------------------------------------------------------- #
@router.post("/public/scan", response_model=FreeScanResult)
async def public_scan(
    request: Request,
    file: UploadFile = File(...),
    jd_text: str = Form(""),
) -> FreeScanResult:
    forwarded = request.headers.get("x-forwarded-for", "")
    client_ip = forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown")
    if not free_scan_limiter.allow(client_ip):
        raise HTTPException(429, "Too many scans from this address — try again in a bit.")
    if not jd_text.strip():
        raise HTTPException(400, "Paste the job description text.")
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file.")
    try:
        raw = extract_text(file.filename or "", data)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not raw.strip():
        raise HTTPException(422, "Could not extract any text from the file.")
    return free_scan(raw, jd_text)


# --------------------------------------------------------------------------- #
# Standalone tools
# --------------------------------------------------------------------------- #
@router.post("/tools/ats-scan", response_model=ATSScanResult)
def tools_ats_scan(body: ATSScanRequest) -> ATSScanResult:
    try:
        return scan_resume(body.resume, body.jd_text)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Error while scanning résumé: {e}")


@router.post("/tools/linkedin", response_model=LinkedInResult)
def tools_linkedin(body: LinkedInRequest) -> LinkedInResult:
    try:
        return optimize_linkedin(body.resume)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while optimizing LinkedIn profile: {e}")


@router.post("/tools/follow-up", response_model=FollowUpResult)
def tools_follow_up(body: FollowUpRequest) -> FollowUpResult:
    try:
        return write_follow_up(body.company, body.role, body.stage, body.context)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while writing the follow-up email: {e}")


# --------------------------------------------------------------------------- #
# Master résumés (persisted, reused across Tailor / Interview / Job Match).
# Paired he/en: one row per language, keyed by the résumé's detected language —
# never client-supplied, so the pairing can't drift from the actual content.
# --------------------------------------------------------------------------- #
def _row_to_master(row: SavedResume) -> MasterResumeOut | None:
    if not row.resume_json:
        return None
    try:
        resume = ResumeModel.model_validate_json(row.resume_json)
    except Exception:  # noqa: BLE001 - tolerate legacy/corrupt rows
        return None
    ledger = None
    if row.ledger_json:
        try:
            ledger = FactsLedger.model_validate_json(row.ledger_json)
        except Exception:  # noqa: BLE001
            ledger = None
    return MasterResumeOut(
        resume=resume,
        ledger=ledger,
        label=row.label,
        language=row.language or "en",
        updated_at=row.updated_at.isoformat() if row.updated_at else "",
    )


def _master_rows(db: Session, user_id: int) -> list[SavedResume]:
    """The user's saved-résumé rows, newest first, with legacy `language` healed.

    The ADD-COLUMN shim stamps pre-pairing rows "en"; a Hebrew master saved
    before the column existed would shadow the real English slot, so recompute
    the language from the stored résumé whenever they disagree.
    """
    rows = db.execute(
        select(SavedResume)
        .where(SavedResume.user_id == user_id)
        .order_by(SavedResume.updated_at.desc())
    ).scalars().all()
    healed = False
    for row in rows:
        try:
            actual = resume_language(ResumeModel.model_validate_json(row.resume_json))
        except Exception:  # noqa: BLE001 - corrupt row; leave its language alone
            continue
        if (row.language or "en") != actual:
            row.language = actual
            healed = True
    if healed:
        db.commit()
    return rows


@router.get("/profile/resume", response_model=MasterResumeOut | None)
def get_master_resume(
    lang: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> MasterResumeOut | None:
    """The master résumé — most recently updated, or the `lang` one when asked."""
    for row in _master_rows(db, user.id):
        if lang and (row.language or "en") != lang:
            continue
        master = _row_to_master(row)
        if master:
            return master
    return None


@router.get("/profile/resumes", response_model=MasterResumeList)
def list_master_resumes(
    db: Session = Depends(get_db), user: User = Depends(current_user)
) -> MasterResumeList:
    """Every saved master (at most one per language), newest first."""
    return MasterResumeList(
        resumes=[m for row in _master_rows(db, user.id) if (m := _row_to_master(row))]
    )


@router.put("/profile/resume", response_model=MasterResumeOut)
def save_master_resume(
    body: MasterResumeIn,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> MasterResumeOut:
    language = resume_language(body.resume)
    row = next(
        (r for r in _master_rows(db, user.id) if (r.language or "en") == language), None
    )
    if row is None:
        row = SavedResume(language=language, user_id=user.id)
        db.add(row)
    row.label = body.label
    row.resume_json = body.resume.model_dump_json()
    row.ledger_json = body.ledger.model_dump_json() if body.ledger else ""
    db.commit()
    db.refresh(row)
    return MasterResumeOut(
        resume=body.resume,
        ledger=body.ledger,
        label=row.label,
        language=row.language,
        updated_at=row.updated_at.isoformat() if row.updated_at else "",
    )


# --------------------------------------------------------------------------- #
# Application tracker
# --------------------------------------------------------------------------- #
def _to_out(app: Application) -> ApplicationOut:
    return ApplicationOut(
        id=app.id,
        job_title=app.job_title,
        company=app.company,
        overall_score=app.overall_score,
        status=app.status,
        notes=app.notes,
        job_url=app.job_url,
        interviewed=app.interviewed,
        excitement=app.excitement or 0,
        created_at=app.created_at.isoformat() if app.created_at else "",
    )


def _owned_application(db: Session, app_id: int, user: User) -> Application:
    app = db.get(Application, app_id)
    if not app or app.user_id != user.id:
        raise HTTPException(404, "Application not found.")
    return app


@router.get("/applications", response_model=list[ApplicationOut])
def list_applications(
    db: Session = Depends(get_db), user: User = Depends(current_user)
) -> list[ApplicationOut]:
    rows = db.execute(
        select(Application)
        .where(Application.user_id == user.id)
        .order_by(Application.created_at.desc())
    ).scalars().all()
    return [_to_out(r) for r in rows]


@router.get("/applications/{app_id}", response_model=ApplicationDetail)
def get_application(
    app_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> ApplicationDetail:
    app = _owned_application(db, app_id, user)
    resume = None
    if app.tailored_resume_json:
        try:
            resume = ResumeModel.model_validate_json(app.tailored_resume_json)
        except Exception:  # noqa: BLE001 - tolerate legacy/corrupt rows
            resume = None
    return ApplicationDetail(
        id=app.id,
        job_title=app.job_title,
        company=app.company,
        jd_text=app.jd_text,
        tailored_resume=resume,
        cover_letter=app.cover_letter,
        overall_score=app.overall_score,
        status=app.status,
        notes=app.notes,
        job_url=app.job_url,
        interviewed=app.interviewed,
        excitement=app.excitement or 0,
        created_at=app.created_at.isoformat() if app.created_at else "",
    )


@router.post("/applications", response_model=ApplicationOut)
def create_application(
    body: ApplicationCreate,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> ApplicationOut:
    app = Application(
        user_id=user.id,
        job_title=body.job_title,
        company=body.company,
        jd_text=body.jd_text,
        tailored_resume_json=body.tailored_resume.model_dump_json() if body.tailored_resume else "",
        cover_letter=body.cover_letter,
        overall_score=body.overall_score,
        status=body.status,
        job_url=body.job_url,
    )
    db.add(app)
    db.commit()
    db.refresh(app)
    return _to_out(app)


@router.patch("/applications/{app_id}", response_model=ApplicationOut)
def update_application(
    app_id: int,
    body: ApplicationUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> ApplicationOut:
    app = _owned_application(db, app_id, user)
    if body.status is not None:
        app.status = body.status
    if body.notes is not None:
        app.notes = body.notes
    if body.interviewed is not None:
        app.interviewed = body.interviewed
    if body.excitement is not None:
        app.excitement = body.excitement
    db.commit()
    db.refresh(app)
    return _to_out(app)


@router.delete("/applications/{app_id}")
def delete_application(
    app_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> dict[str, bool]:
    app = _owned_application(db, app_id, user)
    db.delete(app)
    db.commit()
    return {"deleted": True}


# --------------------------------------------------------------------------- #
# Friends beta (PLAN 7): feedback, delete-my-data, admin user management
# --------------------------------------------------------------------------- #
@router.post("/feedback", response_model=FeedbackOut)
def send_feedback(
    body: FeedbackIn, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> FeedbackOut:
    if not body.text.strip():
        raise HTTPException(400, "Feedback text is empty.")
    row = Feedback(user_id=user.id, page=body.page.strip()[:255], text=body.text.strip())
    db.add(row)
    db.commit()
    db.refresh(row)
    return FeedbackOut(
        id=row.id,
        user_name=user.name,
        page=row.page,
        text=row.text,
        created_at=row.created_at.isoformat() if row.created_at else "",
    )


@router.delete("/profile/data", response_model=DeleteMyDataResult)
def delete_my_data(
    db: Session = Depends(get_db), user: User = Depends(current_user)
) -> DeleteMyDataResult:
    """Wipe everything the current user stored (PLAN 7.5) — résumés are PII
    and testers must be able to leave cleanly. The user row itself stays so
    the invite code keeps working."""
    def _wipe(model) -> int:  # noqa: ANN001
        return db.execute(delete(model).where(model.user_id == user.id)).rowcount or 0

    result = DeleteMyDataResult(
        resumes=_wipe(SavedResume),
        applications=_wipe(Application),
        history=_wipe(JobSearchHit),
        alerts=_wipe(JobAlert),
        usage=_wipe(UsageLog),
        feedback=_wipe(Feedback),
        kits=_wipe(TailorKit),
    )
    db.commit()
    return result


def _user_out(u: User) -> UserOut:
    return UserOut(
        id=u.id,
        name=u.name,
        email=u.email,
        invite_code=u.invite_code,
        is_admin=u.is_admin,
        is_active=u.is_active,
        created_at=u.created_at.isoformat() if u.created_at else "",
    )


@router.post("/admin/users", response_model=UserOut)
def admin_create_user(
    body: UserCreate, db: Session = Depends(get_db), _admin: User = Depends(admin_user)
) -> UserOut:
    """Mint a friend's invite code. Share the returned invite_code with them —
    it's what they enter in the app's access gate (and the extension options)."""
    if not body.name.strip():
        raise HTTPException(400, "Give the user a name.")
    return _user_out(mint_user(db, body.name, body.email))


@router.get("/admin/users", response_model=UserList)
def admin_list_users(
    db: Session = Depends(get_db), _admin: User = Depends(admin_user)
) -> UserList:
    rows = db.execute(select(User).order_by(User.id)).scalars().all()
    return UserList(users=[_user_out(u) for u in rows])


@router.patch("/admin/users/{user_id}", response_model=UserOut)
def admin_update_user(
    user_id: int,
    body: UserUpdate,
    db: Session = Depends(get_db),
    _admin: User = Depends(admin_user),
) -> UserOut:
    """Deactivate (revoke) / reactivate / rename a user. Admin accounts can't
    be deactivated — that would lock the owner out."""
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(404, "User not found.")
    if body.is_active is not None:
        if u.is_admin and not body.is_active:
            raise HTTPException(400, "Can't deactivate an admin account.")
        u.is_active = body.is_active
    if body.name is not None:
        u.name = body.name.strip()
    if body.email is not None:
        u.email = body.email.strip()
    db.commit()
    db.refresh(u)
    return _user_out(u)


@router.get("/admin/feedback", response_model=FeedbackList)
def admin_list_feedback(
    db: Session = Depends(get_db), _admin: User = Depends(admin_user)
) -> FeedbackList:
    """All tester feedback, newest first, with the sender's name attached."""
    rows = db.execute(
        select(Feedback, User.name)
        .join(User, User.id == Feedback.user_id, isouter=True)
        .order_by(Feedback.id.desc())
    ).all()
    return FeedbackList(
        feedback=[
            FeedbackOut(
                id=f.id,
                user_name=name or "",
                page=f.page,
                text=f.text,
                created_at=f.created_at.isoformat() if f.created_at else "",
            )
            for f, name in rows
        ]
    )
