"""FastAPI routes wiring the pipeline together."""
from __future__ import annotations

import hmac
import io
import json
import queue
import threading
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.deps import admin_user, current_user, llm_user, metered_user
from app.config import get_settings

from app.core import alerts as alerts_core
from app.core import auto_submit
from app.core import nudges as nudges_core
from app.core.ats_scan import scan_resume
from app.core.ats_xray import xray
from app.core.company_brief import build_company_brief
from app.core.cover_letter import generate_cover_letter
from app.core.resume_health import check_resume_health
from app.core.salary import extract_salary
from app.core.mailer import smtp_configured
from app.core.follow_up import write_follow_up
from app.core.free_scan import free_scan, free_scan_limiter
from app.core.interview import (
    answer_feedback,
    chat_turn,
    generate_questions,
    model_answer,
    recruiter_screen,
    session_scorecard,
)
from app.core.jd_analyzer import analyze_jd
from app.core.scorer import analyze_and_score, keyword_analysis
from app.core.job_match import fetch_job_text, match_jobs
from app.core.outreach import generate_outreach
from app.core.screening import answer_screening_question
from app.core.job_search import derive_search_context, resume_hash, search_jobs
from app.core import kits as kits_core
from app.core.lang import resume_language
from app.core.linkedin import optimize_linkedin
from app.core.providers.comeet import register_company as register_comeet_company
from app.core.providers.greenhouse import register_company as register_greenhouse_company
from app.core.providers.greenhouse_seed import board_url as greenhouse_board_url
from app.core.tailor import tailor_resume
from app.core.usage import check_and_count, record_tokens
from app.llm.metering import TokenTally, bind
from app.core import writing_prefs as writing_prefs_core
from app.db.comeet import list_companies as list_comeet_companies
from app.db.database import SessionLocal, get_db
from app.db.greenhouse import list_companies as list_greenhouse_companies
from app.db.users import mint_user
from app.db import resume_versions
from app.db.history import (
    application_statuses,
    clear_search_hits,
    delete_search_hit,
    list_search_hits,
    load_score_cache,
    applied_status_map,
    record_search_hits,
    stamp_applied,
)
from app.db.models import (
    Application,
    Feedback,
    JobAlert,
    JobSearchHit,
    SavedResume,
    SavedResumeVersion,
    TailorKit,
    UsageLog,
    User,
)
from app.models import (
    AddComeetCompanyRequest,
    AddGreenhouseCompanyRequest,
    AlertCronResult,
    AlsoOn,
    CoverageRequest,
    CoverageResult,
    FitCheckRequest,
    FitCheckResult,
    NudgeCronResult,
    AlertRunResult,
    AlertSettingsIn,
    AlertSettingsOut,
    ApplicationCreate,
    ApplicationDetail,
    ApplicationOut,
    ApplicationUpdate,
    ATSScanRequest,
    ATSXrayRequest,
    ATSXrayResult,
    ATSScanResult,
    ComeetCompanyList,
    ComeetCompanyOut,
    CompanyBriefRequest,
    CompanyBriefResult,
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
    InterviewChatRequest,
    InterviewChatResult,
    InterviewFeedbackRequest,
    InterviewFeedbackResult,
    InterviewScorecardResult,
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
    PageCountRequest,
    PageCountResult,
    ResumeVersionList,
    ResumeVersionOut,
    OutreachRequest,
    OutreachResult,
    RecruiterScreenRequest,
    RecruiterScreenResult,
    RenderRequest,
    ResumeHealthRequest,
    ResumeHealthResult,
    ResumeModel,
    ResumeUploadResponse,
    ScreeningAnswerResult,
    ScreeningRequest,
    SearchContext,
    SearchContextRequest,
    SearchPrefs,
    StaleApplicationList,
    TailorRequest,
    TailorResult,
    WritingPrefsIn,
    WritingPrefsOut,
    UserCreate,
    UserList,
    UserOut,
    UserUpdate,
)
from app.parsers.resume_parser import extract_text
from app.parsers.structurer import build_facts_ledger, structure_resume
from app.render.docx_renderer import render_docx
from app.render.pdf_renderer import page_count, render_pdf
from app.render.templates import get_template

router = APIRouter()


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


async def _read_capped(file: UploadFile) -> bytes:
    """Read an upload, refusing anything over MAX_UPLOAD_MB.

    Chunked on purpose: `await file.read()` with no argument pulls the WHOLE
    upload into memory before anything can object to its size, which on the
    no-access-code /public/scan route is a free way to exhaust an instance.
    This stops at the first chunk that crosses the line.
    """
    limit = get_settings().max_upload_mb * 1024 * 1024
    chunks: list[bytes] = []
    total = 0
    while chunk := await file.read(256 * 1024):
        total += len(chunk)
        if total > limit:
            raise HTTPException(
                413, f"That file is too large — {get_settings().max_upload_mb} MB max."
            )
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/resume/upload", response_model=ResumeUploadResponse)
async def upload_resume(file: UploadFile = File(...), _u: User = Depends(llm_user)) -> ResumeUploadResponse:
    data = await _read_capped(file)
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
def jd_analyze(body: JDAnalyzeRequest, _u: User = Depends(llm_user)) -> JDModel:
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
    user: User = Depends(metered_user),  # keeps its own tailor cap; meters tokens
) -> TailorResult:
    check_and_count(db, user, "tailor", get_settings().daily_tailor_cap)
    try:
        return tailor_resume(
            body.resume, body.jd,
            avoid_phrases=writing_prefs_core.avoid_phrases(user),
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while tailoring résumé: {e}")


@router.get("/profile/writing-prefs", response_model=WritingPrefsOut)
def get_writing_prefs(user: User = Depends(current_user)) -> WritingPrefsOut:
    return WritingPrefsOut(avoid=writing_prefs_core.avoid_phrases(user))


@router.post("/profile/writing-prefs", response_model=WritingPrefsOut)
def add_writing_prefs(
    body: WritingPrefsIn,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> WritingPrefsOut:
    """Record phrases the user rejected in the per-bullet review (§26 feedback
    loop). Future tailors receive them as an avoid-list."""
    return WritingPrefsOut(avoid=writing_prefs_core.record_rejected(db, user, body.rejected))


@router.post("/cover-letter", response_model=CoverLetterResponse)
def cover_letter(body: CoverLetterRequest, _u: User = Depends(llm_user)) -> CoverLetterResponse:
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
def interview_questions(body: InterviewQuestionsRequest, _u: User = Depends(llm_user)) -> InterviewQuestionsResult:
    try:
        return generate_questions(body.resume, body.jd)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while generating interview questions: {e}")


@router.post("/interview/answer", response_model=InterviewAnswerResult)
def interview_answer(body: InterviewAnswerRequest, _u: User = Depends(llm_user)) -> InterviewAnswerResult:
    if not body.question.strip():
        raise HTTPException(400, "Question is empty.")
    try:
        return model_answer(body.resume, body.jd, body.question)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while writing the model answer: {e}")


@router.post("/interview/feedback", response_model=InterviewFeedbackResult)
def interview_feedback(body: InterviewFeedbackRequest, _u: User = Depends(llm_user)) -> InterviewFeedbackResult:
    if not body.answer.strip():
        raise HTTPException(400, "Answer is empty.")
    try:
        return answer_feedback(body.resume, body.question, body.answer)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while evaluating the answer: {e}")


@router.post("/interview/recruiter-screen", response_model=RecruiterScreenResult)
def interview_recruiter_screen(body: RecruiterScreenRequest, _u: User = Depends(llm_user)) -> RecruiterScreenResult:
    """Prep sheet for the ~15-min recruiter phone screen: pitch, predictable
    questions with grounded talking points, and honest salary-range framing."""
    try:
        return recruiter_screen(body.resume, body.jd_text)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while building the recruiter-screen prep: {e}")


@router.post("/interview/chat", response_model=InterviewChatResult)
def interview_chat(body: InterviewChatRequest, _u: User = Depends(llm_user)) -> InterviewChatResult:
    """One mock-interview turn (PLAN 11.3). Stateless: the client sends the
    whole transcript; the model returns the interviewer's next message."""
    try:
        return chat_turn(body.resume, body.jd_text, body.transcript)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error during the mock interview: {e}")


@router.post("/interview/scorecard", response_model=InterviewScorecardResult)
def interview_scorecard(body: InterviewChatRequest, _u: User = Depends(llm_user)) -> InterviewScorecardResult:
    """End-of-session scorecard for a mock-interview transcript (PLAN 11.3)."""
    if not any(t.role == "candidate" and t.text.strip() for t in body.transcript):
        raise HTTPException(400, "Answer at least one question before ending the session.")
    try:
        return session_scorecard(body.resume, body.jd_text, body.transcript)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while writing the scorecard: {e}")


# --------------------------------------------------------------------------- #
# Job discovery / matching
# --------------------------------------------------------------------------- #
@router.post("/jobs/match", response_model=JobMatchResult)
def jobs_match(body: JobMatchRequest, _u: User = Depends(llm_user)) -> JobMatchResult:
    if not body.listings:
        raise HTTPException(400, "Provide at least one job listing.")
    try:
        return match_jobs(body.resume, body.listings)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while matching jobs: {e}")


@router.post("/jobs/fit", response_model=FitCheckResult)
def jobs_fit(body: FitCheckRequest, _u: User = Depends(llm_user)) -> FitCheckResult:
    """Read a posting and score the résumé against it, before any tailoring.

    ONE round-trip, on the existing JD_FIT task — no new prompt, no new stub
    branch. `analyze_jd` alone would cost the same unit and return half of this,
    so the merged task is strictly the better spend.

    The analysed JD rides back in the response on purpose: the caller tailors
    with it instead of paying to read the same posting a second time, and
    re-scores coverage against it for free on `/tools/coverage`.
    """
    if not body.jd_text.strip():
        raise HTTPException(400, "Job description text is empty.")
    try:
        jd, score = analyze_and_score(body.resume, body.jd_text)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while reading the job description: {e}")
    return FitCheckResult(
        jd=jd,
        keyword_coverage=score.keyword_coverage,
        fit_score=score.fit_score,
        rationale=score.rationale,
        gaps=score.gaps,
        covered=sum(1 for g in score.gaps if g.status == "covered"),
        partial=sum(1 for g in score.gaps if g.status == "partial"),
        missing=sum(1 for g in score.gaps if g.status == "missing"),
        total=len(score.gaps),
    )


@router.post("/jobs/fetch", response_model=JobFetchResponse)
def jobs_fetch(body: JobFetchRequest) -> JobFetchResponse:
    if not body.url.strip():
        raise HTTPException(400, "URL is empty.")
    try:
        return JobFetchResponse(text=fetch_job_text(body.url))
    except Exception as e:  # noqa: BLE001 - network/parse errors surface to the UI
        raise HTTPException(400, f"Could not fetch that URL: {e}")


@router.post("/jobs/search-context", response_model=SearchContext)
def jobs_search_context(body: SearchContextRequest, _u: User = Depends(llm_user)) -> SearchContext:
    """Derive what/where to search from the résumé, so the UI can prefill the
    'Customize search' fields before any scrape runs."""
    try:
        return derive_search_context(body.resume)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Error deriving search context: {e}")


@router.get("/jobs/search-prefs", response_model=SearchPrefs)
def get_search_prefs(user: User = Depends(current_user)) -> SearchPrefs:
    """The user's saved 'Customize search' picks — the Jobs page prefills its
    panel from this so a returning user doesn't re-enter everything."""
    raw = user.search_prefs_json or ""
    if not raw:
        return SearchPrefs()
    try:
        return SearchPrefs(context=SearchContext.model_validate_json(raw))
    except Exception:  # noqa: BLE001 - tolerate legacy/corrupt rows: just no prefill
        return SearchPrefs()


@router.put("/jobs/search-prefs", response_model=SearchPrefs)
def update_search_prefs(
    body: SearchPrefs,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> SearchPrefs:
    """Persist (context set) or clear (context null) the saved customize picks."""
    user.search_prefs_json = body.context.model_dump_json() if body.context else ""
    db.commit()
    return body


@router.post("/jobs/search", response_model=JobSearchResult)
def jobs_search(
    body: JobSearchRequest,
    db: Session = Depends(get_db),
    user: User = Depends(metered_user),  # keeps its own search cap; meters tokens
) -> JobSearchResult:
    check_and_count(db, user, "search", get_settings().daily_search_cap)
    rhash = resume_hash(body.resume)
    try:  # the cache is an optimization (PLAN 12.4) — never fail the search over it
        cache = load_score_cache(db, user.id, rhash)
    except Exception:  # noqa: BLE001
        cache = {}
    try:
        result = search_jobs(body.resume, body.customize, cache=cache)
    except ValueError as e:  # user-facing scrape/search problems
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Error while searching jobs: {e}")
    try:  # history persistence is best-effort — never fail the search because of it
        record_search_hits(db, result.matches, user.id, resume_hash=rhash)
    except Exception:  # noqa: BLE001
        pass
    try:  # so is the already-applied marking
        stamp_applied(result.matches, applied_status_map(db, user.id))
    except Exception:  # noqa: BLE001
        pass
    return result


def _sse_frame(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/jobs/search/stream")
def jobs_search_stream(
    body: JobSearchRequest,
    db: Session = Depends(get_db),
    # current_user, NOT metered_user: the LLM work happens after this returns,
    # in a thread the dependency's tally can't see. Metered explicitly below.
    user: User = Depends(current_user),
) -> StreamingResponse:
    """Same search as POST /jobs/search, but as an SSE stream (PLAN 9.2) so the
    UI can show real per-board / per-job progress instead of guessing from
    elapsed time. Events: `progress` (boards/scoring stages, see
    job_search.ProgressFn), `match` (PLAN 12.2 — one scored JobMatch object per
    frame, as each job finishes; old frontends ignore unknown event names),
    then exactly one terminal `result` (a JobSearchResult) or `error`
    ({detail, status}). Errors after the 200 header ride the stream — the cap
    check raises a plain 429 before streaming starts, so old error handling
    still applies there."""
    check_and_count(db, user, "search", get_settings().daily_search_cap)
    # The stream can run for minutes; don't pin the request's pooled (Neon)
    # connection to it. Read what we still need off the session — including the
    # score cache (PLAN 12.4), which must be built BEFORE the close — then
    # release it; history is persisted at the end on a fresh, short-lived
    # session. (check_and_count committed already; get_db's close() is a no-op.)
    user_id = user.id
    rhash = resume_hash(body.resume)
    try:  # the cache is an optimization — never fail the search over it
        cache = load_score_cache(db, user_id, rhash)
    except Exception:  # noqa: BLE001
        cache = {}
    try:  # read the tracker BEFORE the session closes; the stream runs for minutes
        applied_map = applied_status_map(db, user_id)
    except Exception:  # noqa: BLE001
        applied_map = {}
    db.close()

    events: queue.Queue = queue.Queue()  # thread-safe: search workers notify from threads
    # Token accounting (PLAN 20.8/N2) can't ride the metered_user dependency
    # here: this endpoint returns its StreamingResponse immediately and does the
    # LLM work afterwards in a raw thread, so there is no teardown left to read
    # a tally from. Bind one explicitly and write it when the stream ends.
    tally = TokenTally()

    def _worker() -> None:
        with bind(tally):
            try:
                result = search_jobs(
                    body.resume,
                    body.customize,
                    progress=lambda e: events.put(("progress", e)),
                    cache=cache,
                )
                events.put(("result", result))
            except ValueError as e:  # user-facing scrape/search problems
                events.put(("error", {"detail": str(e), "status": 400}))
            except Exception as e:  # noqa: BLE001
                events.put(("error", {"detail": f"Error while searching jobs: {e}", "status": 502}))

    threading.Thread(target=_worker, daemon=True).start()

    def _record_tokens_now() -> None:
        """Persist what the search spent. In a finally, so an abandoned stream
        (the client navigated away mid-search) still bills the tokens it burned."""
        if not tally.calls:
            return
        try:
            tok_db = SessionLocal()
            try:
                record_tokens(tok_db, user_id, tally.prompt, tally.completion)
            finally:
                tok_db.close()
        except Exception:  # noqa: BLE001 - bookkeeping never breaks the stream
            pass

    def _stream():
        try:
            while True:
                try:
                    kind, payload = events.get(timeout=15)
                except queue.Empty:
                    yield ": keep-alive\n\n"  # searches sit minutes on slow boards; don't let proxies idle out
                    continue
                if kind == "progress":
                    if payload.get("stage") == "match":
                        # Incremental result: the JobMatch itself rides its own
                        # event name so the UI can render rows as they score.
                        # Stamped here too — these frames ARE the list the user
                        # reads while the search runs; only marking the terminal
                        # `result` would show every job unmarked until the end.
                        stamp_applied([payload["match"]], applied_map)
                        yield _sse_frame("match", payload["match"])
                    else:
                        yield _sse_frame("progress", payload)
                elif kind == "result":
                    try:  # best-effort history persistence, same as the non-stream route
                        hist_db = SessionLocal()
                        try:
                            record_search_hits(hist_db, payload.matches, user_id, resume_hash=rhash)
                        finally:
                            hist_db.close()
                    except Exception:  # noqa: BLE001
                        pass
                    stamp_applied(payload.matches, applied_map)
                    yield _sse_frame("result", payload.model_dump())
                    return
                else:
                    yield _sse_frame("error", payload)
                    return
        finally:
            # Runs on the normal return, on an error frame, and on GeneratorExit
            # when the client disconnects mid-search — the tokens were spent
            # either way, so they get billed either way.
            _record_tokens_now()

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
                also_on=[
                    AlsoOn(source=str(a.get("source", "")), url=str(a.get("url", "")))
                    for a in _keyword_list(row.also_on_json)
                    if isinstance(a, dict)
                ],
                salary=extract_salary(row.jd_text or ""),
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
def _alert_out(row) -> AlertSettingsOut:  # noqa: ANN001 - JobAlert ORM row
    return AlertSettingsOut(
        enabled=row.enabled,
        email=row.email,
        context=alerts_core.alert_context(row),
        last_run_at=row.last_run_at.isoformat() if row.last_run_at else "",
        last_new_count=row.last_new_count or 0,
        last_error=row.last_error or "",
        smtp_configured=smtp_configured(),
        nudge_emails=bool(row.nudge_emails),
    )


@router.get("/jobs/alerts", response_model=AlertSettingsOut)
def get_job_alert(
    db: Session = Depends(get_db), user: User = Depends(current_user)
) -> AlertSettingsOut:
    return _alert_out(alerts_core.get_alert(db, user.id))


@router.put("/jobs/alerts", response_model=AlertSettingsOut)
def update_job_alert(
    body: AlertSettingsIn,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> AlertSettingsOut:
    if (body.enabled or body.nudge_emails) and not body.email.strip():
        raise HTTPException(400, "Add an email address to enable alerts.")
    row = alerts_core.update_alert(
        db,
        user.id,
        enabled=body.enabled,
        email=body.email,
        context=body.context,
        nudge_emails=body.nudge_emails,
    )
    return _alert_out(row)


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
    results, skipped = alerts_core.run_all_alerts(db)
    return AlertCronResult(users=len(results) + skipped, results=results, skipped=skipped)


@router.get("/jobs/nudges/cron", response_model=NudgeCronResult)
def cron_nudges(request: Request, db: Session = Depends(get_db)) -> NudgeCronResult:
    """Vercel cron entrypoint for stale-application nudges (PLAN 11.4) —
    exempt from the X-App-Key gate (see main.py), guarded by the same Bearer
    CRON_SECRET as the alerts cron. Emails every opted-in user whose 'applied'
    applications newly went stale."""
    secret = get_settings().cron_secret
    if secret:
        auth = request.headers.get("authorization", "")
        if not hmac.compare_digest(auth, f"Bearer {secret}"):
            raise HTTPException(401, "Bad cron secret.")
    results = nudges_core.run_all_nudges(db)
    return NudgeCronResult(users=len(results), results=results)


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
    db: Session = Depends(get_db), user: User = Depends(metered_user)
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
    data = await _read_capped(file)
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
# Deterministic, and therefore uncapped — every check is pure Python and the
# optional keyword pass takes an ALREADY-ANALYSED JD.
#
# It accepted raw `jd_text` and ran `analyze_jd` on it until 22.10, which is an
# LLM call on a route carrying no Depends at all: a free door onto the model for
# anyone past the shared access-code gate, with no per-user cap and no token
# row. That is the exact thing `CoverageRequest`'s docstring, thirty lines below,
# exists to forbid — the rule was written down and this route was the exception
# nobody noticed. Its smoke pin sent `jd_text: ""`, the one value that never
# enters the branch, under a label asserting the opposite; it is now pinned in
# both directions with a real JD.
@router.post("/tools/ats-scan", response_model=ATSScanResult)
def tools_ats_scan(body: ATSScanRequest) -> ATSScanResult:
    try:
        return scan_resume(body.resume, body.jd)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Error while scanning résumé: {e}")


# Deterministic like /tools/ats-scan — it renders and re-parses, never calls the
# model — so it is deliberately uncapped. That exclusion is smoke-pinned.
@router.post("/tools/ats-xray", response_model=ATSXrayResult)
def tools_ats_xray(body: ATSXrayRequest) -> ATSXrayResult:
    try:
        return xray(body.resume, template=body.template, fmt=body.fmt)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Error while x-raying résumé: {e}")


# Pure Python, ~0.05 ms, no model and no network — uncapped like its siblings.
#
# This exists so the review surface can move ONE number honestly as the user
# accepts and declines edits. The other half of the match score (`fit_score`) is
# an LLM sample and cannot move without spending, so it is deliberately not
# returned here: a caller that could animate it would be animating noise.
#
# NOT reimplemented in TypeScript, and that is the point of the route. The
# matcher tries the verbatim phrase FIRST, which is what makes Hebrew work —
# prefixes attach to the word (ב/ל/ה/ו/מ/ש), so "פייתון" has to match inside
# "בפייתון". The frontend's `keywordRegex` wraps the needle in token-boundary
# guards, which makes exactly that case miss. One matcher, one number.
@router.post("/tools/coverage", response_model=CoverageResult)
def tools_coverage(body: CoverageRequest) -> CoverageResult:
    try:
        pct, gaps = keyword_analysis(body.resume, body.jd)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Error while scoring keyword coverage: {e}")
    return CoverageResult(
        keyword_coverage=pct,
        gaps=gaps,
        covered=sum(1 for g in gaps if g.status == "covered"),
        partial=sum(1 for g in gaps if g.status == "partial"),
        missing=sum(1 for g in gaps if g.status == "missing"),
        total=len(gaps),
    )


# Deterministic like the two above — one reportlab build, no model, no network —
# so it is deliberately uncapped, and that exclusion is smoke-pinned.
#
# The editor calls this whenever the user restores something the page budget cut,
# because restoring produces a document NOTHING has measured: the trimmed résumé
# plus the master's full version of the restored item. Deriving it from
# `length_report.pages_before/after` would be a guess, and a wrong one.
@router.post("/tools/page-count", response_model=PageCountResult)
def tools_page_count(body: PageCountRequest) -> PageCountResult:
    spec = get_template(body.template)
    s = get_settings()
    try:
        pages = page_count(body.resume, template=spec.id)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Error while measuring page count: {e}")
    return PageCountResult(
        pages=pages,
        max_pages=s.resume_max_pages,
        hard_max_pages=s.resume_hard_max_pages,
        template=spec.id,
    )


@router.post("/tools/linkedin", response_model=LinkedInResult)
def tools_linkedin(body: LinkedInRequest, _u: User = Depends(llm_user)) -> LinkedInResult:
    try:
        return optimize_linkedin(body.resume)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while optimizing LinkedIn profile: {e}")


@router.post("/tools/follow-up", response_model=FollowUpResult)
def tools_follow_up(body: FollowUpRequest, _u: User = Depends(llm_user)) -> FollowUpResult:
    try:
        return write_follow_up(body.company, body.role, body.stage, body.context)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while writing the follow-up email: {e}")


@router.post("/outreach", response_model=OutreachResult)
def outreach(body: OutreachRequest, _u: User = Depends(llm_user)) -> OutreachResult:
    """Outreach Studio: a LinkedIn connection note, an InMail/cold email, and a
    referral request for one job — the direct-to-a-human path to an interview,
    grounded only in real résumé facts."""
    try:
        return generate_outreach(
            body.resume,
            body.jd_text,
            body.company,
            body.job_title,
            body.contact_name,
            body.contact_role,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while writing outreach messages: {e}")


@router.post("/tools/screening-answer", response_model=ScreeningAnswerResult)
def tools_screening_answer(body: ScreeningRequest, _u: User = Depends(llm_user)) -> ScreeningAnswerResult:
    """Draft an honest, résumé-grounded answer to an application/screening
    free-text question (e.g. "Why do you want to work here?")."""
    if not body.question.strip():
        raise HTTPException(400, "Question is empty.")
    try:
        return answer_screening_question(body.resume, body.jd_text, body.question)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while drafting the answer: {e}")


@router.post("/tools/company-brief", response_model=CompanyBriefResult)
def tools_company_brief(body: CompanyBriefRequest, _u: User = Depends(llm_user)) -> CompanyBriefResult:
    """Grounded pre-apply/pre-interview company brief: fetches the company's
    about/careers page (or takes pasted text) and summarizes it — plus key
    hiring-relevant people from the page and a short résumé-grounded reach-out.
    Never model memory alone; emails only when they appear on the page."""
    try:
        return build_company_brief(
            body.resume, body.company, body.url, body.page_text, body.jd_text, body.job_title
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while building the company brief: {e}")


@router.post("/tools/resume-health", response_model=ResumeHealthResult)
def tools_resume_health(body: ResumeHealthRequest, _u: User = Depends(llm_user)) -> ResumeHealthResult:
    """JD-independent résumé health-check: deterministic writing checks drive
    the score; the LLM adds critique text (strengths/improvements/rewrites)."""
    try:
        return check_resume_health(body.resume)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while checking the résumé: {e}")


# --------------------------------------------------------------------------- #
# Master résumés (persisted, reused across Tailor / Interview / Job Match).
# Paired he/en: one row per language, keyed by the résumé's detected language —
# never client-supplied, so the pairing can't drift from the actual content.
# --------------------------------------------------------------------------- #
def _saved_to_master(row, stamp) -> MasterResumeOut | None:  # noqa: ANN001
    """Parse a stored résumé row into the API shape, or None if unreadable.

    Takes the timestamp as an argument because it serves BOTH `saved_resumes`
    (whose column is `updated_at`) and `saved_resume_versions` (`created_at`,
    meaning "when this stopped being current"). Duck-typing the two was the
    first attempt and it raised on the attribute that isn't shared.
    """
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
        updated_at=stamp.isoformat() if stamp else "",
    )


def _row_to_master(row: SavedResume) -> MasterResumeOut | None:
    return _saved_to_master(row, row.updated_at)


def _version_to_master(row) -> MasterResumeOut | None:  # noqa: ANN001 - SavedResumeVersion
    return _saved_to_master(row, row.created_at)


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
    # A ledger-less save (the from-scratch builder, PLAN 15.3) derives the
    # facts ledger from the résumé itself: the user typed these facts, so the
    # résumé IS the source of truth the fabrication guard should protect.
    ledger = body.ledger or build_facts_ledger(body.resume)
    row = next(
        (r for r in _master_rows(db, user.id) if (r.language or "en") == language), None
    )
    if row is None:
        row = SavedResume(language=language, user_id=user.id)
        db.add(row)
    else:
        # Keep the outgoing content before it is overwritten (PLAN 20.8/N1).
        # Best-effort: a failure here must never cost the user the save they
        # actually asked for — losing an undo point beats losing the résumé.
        try:
            resume_versions.snapshot(db, row, body.resume.model_dump_json())
        except Exception:  # noqa: BLE001
            pass
    row.label = body.label
    row.resume_json = body.resume.model_dump_json()
    row.ledger_json = ledger.model_dump_json()
    db.commit()
    db.refresh(row)
    return MasterResumeOut(
        resume=body.resume,
        ledger=ledger,
        label=row.label,
        language=row.language,
        updated_at=row.updated_at.isoformat() if row.updated_at else "",
    )


# --------------------------------------------------------------------------- #
# Master résumé version history (PLAN 20.8 / N1). The save above overwrites in
# place, and several UI paths save without the user thinking of it as a save —
# so these are the undo.
# --------------------------------------------------------------------------- #
def _version_out(row) -> ResumeVersionOut:  # noqa: ANN001 - SavedResumeVersion ORM row
    """Metadata for the picker. The résumé is parsed only for the three counts
    that let a user tell restore points apart; a corrupt row still lists (with
    zeros) rather than vanishing, because a version you cannot see is a version
    you cannot restore."""
    headline, experience, projects = "", 0, 0
    try:
        resume = ResumeModel.model_validate_json(row.resume_json)
        headline = resume.headline or resume.contact.name
        experience, projects = len(resume.experience), len(resume.projects)
    except Exception:  # noqa: BLE001
        pass
    return ResumeVersionOut(
        id=row.id,
        label=row.label,
        language=row.language or "en",
        created_at=row.created_at.isoformat() if row.created_at else "",
        headline=headline,
        experience_count=experience,
        project_count=projects,
    )


@router.get("/profile/resume/versions", response_model=ResumeVersionList)
def list_resume_versions(
    lang: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> ResumeVersionList:
    """Restore points, newest first. Metadata only — see ResumeVersionOut."""
    rows = resume_versions.list_versions(db, user.id, lang or "")
    return ResumeVersionList(versions=[_version_out(r) for r in rows])


@router.get("/profile/resume/versions/{version_id}", response_model=MasterResumeOut)
def get_resume_version(
    version_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> MasterResumeOut:
    """One full version, for previewing before restoring."""
    row = resume_versions.owned_version(db, version_id, user.id)
    if row is None:
        raise HTTPException(404, "Version not found.")
    master = _version_to_master(row)
    if master is None:
        raise HTTPException(422, "That version can't be read.")
    return master


@router.post("/profile/resume/versions/{version_id}/restore", response_model=MasterResumeOut)
def restore_resume_version(
    version_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> MasterResumeOut:
    """Make a version current again.

    The CURRENT content is snapshotted on the way past, so restoring is itself
    undoable — a mis-click in the picker must not be the thing that loses the
    résumé. Restores into the version's OWN language slot, so restoring a
    Hebrew version can never overwrite the English master.
    """
    row = resume_versions.owned_version(db, version_id, user.id)
    if row is None:
        raise HTTPException(404, "Version not found.")
    master = _version_to_master(row)
    if master is None:
        raise HTTPException(422, "That version can't be read.")

    language = row.language or "en"
    current = next(
        (r for r in _master_rows(db, user.id) if (r.language or "en") == language), None
    )
    if current is None:
        current = SavedResume(language=language, user_id=user.id)
        db.add(current)
    else:
        resume_versions.snapshot(db, current, row.resume_json)
    current.label = row.label
    current.resume_json = row.resume_json
    current.ledger_json = row.ledger_json
    db.commit()
    db.refresh(current)
    return MasterResumeOut(
        resume=master.resume,
        ledger=master.ledger,
        label=current.label,
        language=current.language,
        updated_at=current.updated_at.isoformat() if current.updated_at else "",
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
        template=app.template or "",
        voice_score=app.voice_score,
        fabrication_flag_count=app.fabrication_flag_count,
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


@router.get("/applications/nudges", response_model=StaleApplicationList)
def application_nudges(
    db: Session = Depends(get_db), user: User = Depends(current_user)
) -> StaleApplicationList:
    """Applications stuck in 'applied' with no status change for
    STALE_APPLICATION_DAYS days — a nudge to follow up. Surfaced on the tracker."""
    days = get_settings().stale_application_days
    if days <= 0:
        return StaleApplicationList()
    now = datetime.now(timezone.utc)
    pairs = nudges_core.stale_rows(db, user.id, days, now)
    return StaleApplicationList(items=nudges_core.to_stale_out(pairs, now))


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
        template=body.template,
        voice_score=body.voice_score,
        fabrication_flag_count=body.fabrication_flag_count,
        status_changed_at=datetime.now(timezone.utc),
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
        if body.status != app.status:
            app.status_changed_at = datetime.now(timezone.utc)
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
        resume_versions=_wipe(SavedResumeVersion),
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
