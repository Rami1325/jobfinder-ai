"""FastAPI routes wiring the pipeline together."""
from __future__ import annotations

import hmac
import base64
import io
import json
import logging
import queue
import threading
from datetime import datetime, timedelta, timezone
from functools import partial

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.api.deps import admin_user, current_user, llm_user, metered_user
from app.config import get_settings

from app.core import accounts as accounts_core
from app.core import alerts as alerts_core
from app.core import auto_submit
from app.core import inbox_apply
from app.core import inbox_sync as inbox_sync_core
from app.core import nudges as nudges_core
from app.core import quota
from app.core.sessions import clear_session_cookie, revoke_all
from app.core.resume_review import review_resume
from app.core.ats_xray import xray
from app.core.company_brief import build_company_brief
from app.core.cover_letter import generate_cover_letter
from app.core.review_rewrites import rewrite_targets, write_rewrites
from app.core.salary import extract_salary
from app.llm.limits import (
    ContextWindowExceeded,
    InputTooLarge,
    OutputTruncated,
    require_within,
    utf8_bytes,
)

# Re-raised past every generic `except Exception -> 502` wrapper below so the
# app-level handlers in main.py can map them to 413/503 with a structured,
# translatable detail. Without this a size limit reaches the user as
# "LLM error while structuring resume: resume is 317 KB…" — a 5xx, which also
# means Sentry keeps filing it.
_SIZE_ERRORS = (InputTooLarge, ContextWindowExceeded, OutputTruncated)
from app.core.mailer import smtp_configured
from app.core.follow_up import write_follow_up
from app.core.free_scan import free_scan
from app.core.interview import (
    answer_feedback,
    chat_turn,
    generate_questions,
    model_answer,
    recruiter_screen,
    session_scorecard,
)
from app.core.jd_analyzer import analyze_jd
from app.core.job_market import stamp_market
from app.core.scorer import analyze_and_score, keyword_analysis
from app.core.job_match import MAX_MATCH_LISTINGS, fetch_job_text, match_jobs
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
from app.core.usage import check_and_count, record_tokens, utc_day
from app.llm.metering import TokenTally, bind
from app.core import writing_prefs as writing_prefs_core
from app.core import resume_prefs as resume_prefs_core
from app.db.comeet import list_companies as list_comeet_companies
from app.db.database import SessionLocal, get_db
from app.db.greenhouse import list_companies as list_greenhouse_companies
from app.db.sightings import load_sightings, record_sightings
from app.db.users import mint_user
from app.db import applications as applications_db
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
    MailConnection,
    MailEvent,
    SavedResume,
    SavedResumeVersion,
    TailorKit,
    UsageLog,
    User,
    UserLogin,
)
from app.models import (
    ReviewRequest,
    ReviewResult,
    ReviewRewriteRequest,
    ReviewRewriteResult,
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
    ApplicationDraft,
    ApplicationDetail,
    ApplicationKit,
    ApplicationOut,
    ApplicationReview,
    ApplicationReviewOut,
    ApplicationUpdate,
    ATSXrayRequest,
    ATSXrayResult,
    ComeetCompanyList,
    ComeetCompanyOut,
    CompanyBriefRequest,
    CompanyBriefResult,
    CoverLetterPassRequest,
    CoverLetterRequest,
    CoverLetterResponse,
    DeleteAccountResult,
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
    KitCoverLetterIn,
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
    MeOut,
    PageCountRequest,
    PageImagesRequest,
    PageImagesResult,
    PageCountResult,
    ResumeVersionList,
    ResumeVersionOut,
    OutreachRequest,
    OutreachResult,
    RecruiterScreenRequest,
    RecruiterScreenResult,
    RenderRequest,
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
    ResumePrefs,
    WritingPrefsIn,
    WritingPrefsOut,
    UserCreate,
    UserList,
    UserOut,
    UserUpdate,
    UsagePassOut,
)
from app.parsers.resume_parser import extract_text
from app.parsers.structurer import build_facts_ledger, structure_resume
from app.render.docx_renderer import render_docx
from app.render.page_images import pdf_page_pngs
from app.render.pdf_renderer import page_count, render_pdf
from app.render.templates import get_template

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


async def _read_capped(file: UploadFile) -> bytes:
    """Read an upload, refusing anything over MAX_UPLOAD_MB.

    Chunked on purpose: `await file.read()` with no argument pulls the WHOLE
    upload into memory before anything can object to its size, and a free
    account costs nothing to make, so an unbounded read on /resume/upload or
    /tools/scan would be a cheap way to exhaust an instance. This stops at the
    first chunk that crosses the line.
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
async def upload_resume(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(metered_user),
) -> ResumeUploadResponse:
    """Parse an uploaded resume into the structured model.

    Uploading never costs a monthly use (Phase 30): it is a step of the counted
    flows, and counting it would make one tailor cost two. Its model call is
    bounded by its OWN daily cap instead (`upload`, B4.6), counted right before
    that call, so a file refused as empty, unreadable or textless costs nothing.
    `metered_user`, not `llm_user`: it no longer takes the shared llm unit, and
    its tokens are still recorded.
    """
    data = await _read_capped(file)
    if not data:
        raise HTTPException(400, "Empty file.")
    try:
        raw = extract_text(file.filename or "", data)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not raw.strip():
        raise HTTPException(422, "Could not extract any text from the file.")
    check_and_count(db, user, "upload", get_settings().daily_upload_cap)
    try:
        resume = structure_resume(raw)
    except _SIZE_ERRORS:
        raise  # app-level 413/503, never an 'LLM error' 502
    except Exception as e:  # noqa: BLE001 - surface the real LLM error to the UI
        raise HTTPException(502, f"LLM error while structuring resume: {e}")
    ledger = build_facts_ledger(resume)
    return ResumeUploadResponse(resume=resume, ledger=ledger)


@router.post("/jd/analyze", response_model=JDModel)
def jd_analyze(
    body: JDAnalyzeRequest,
    db: Session = Depends(get_db),
    user: User = Depends(metered_user),
) -> JDModel:
    """Read a pasted job ad into the analysed JD. It costs no monthly use (it is
    the first step of a tailor) and is bounded by its own daily `jd_analyze` cap
    (Phase 30 / B4.6) instead of the shared llm unit; its tokens are recorded."""
    if not body.jd_text.strip():
        raise HTTPException(400, "Job description text is empty.")
    check_and_count(db, user, "jd_analyze", get_settings().daily_jd_analyze_cap)
    try:
        # One argument, then the location re-stamp: `analyze_jd` is injected
        # with that one-argument shape by the smoke suite's metering fake.
        return stamp_market(analyze_jd(body.jd_text), body.jd_text, body.location)
    except _SIZE_ERRORS:
        raise  # app-level 413/503, never an 'LLM error' 502
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while analyzing job description: {e}")


def _tailor_or_502(body: TailorRequest, user: User) -> TailorResult:
    """The tailor itself, with the model's errors mapped once for both of /tailor's
    paths (a use charged, or a fit check's ride): a size limit stays the app-level
    413/503, and anything else is a 502."""
    try:
        return tailor_resume(
            body.resume, body.jd,
            avoid_phrases=writing_prefs_core.avoid_phrases(user),
            hide_arabic_in_israel=resume_prefs_core.hide_arabic_in_israel(user),
        )
    except _SIZE_ERRORS:
        raise  # app-level 413/503, never an 'LLM error' 502
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"LLM error while tailoring resume: {e}")


@router.post("/tailor", response_model=TailorResult)
def tailor(
    body: TailorRequest,
    db: Session = Depends(get_db),
    user: User = Depends(metered_user),  # keeps its own tailor cap; meters tokens
) -> TailorResult:
    """Tailor the resume to one analysed job: one monthly use (Phase 30 / B4), or
    none when a fit check of the same analysed JD already paid for it (B4.4).

    The daily tailor cap first, then the ride or the use, all in the handler: a
    charge in a dependency would bill a malformed body, because FastAPI resolves
    the dependencies before it validates the body.

    A fit check opens a 24-hour ride for ONE tailor of the JD it returned, keyed
    by that analysed JD (`TailorRequest` carries no posting text). A covered
    tailor that returns reclassifies the fit's use as this tailor, so `used` is
    unchanged and the header still says what is left; one that fails gives the
    ride back, so the retry is still covered. With no ride the `charged` block
    sits OUTSIDE the try/except -> 502, or its 429 would be re-wrapped as a 502,
    and any failure inside it (400, 413, 502, 503) gives the use back.
    """
    check_and_count(db, user, "tailor", get_settings().daily_tailor_cap)
    now = quota.utc_now()
    ride = quota.claim_fit_ride(db, user, ref=quota.jd_ref(body.jd), now=now)
    if ride is None:
        with quota.charged(db, user, "tailor", now=now):
            return _tailor_or_502(body, user)
    try:
        result = _tailor_or_502(body, user)
    except BaseException:
        quota.release_fit_ride(db, ride)
        raise
    quota.settle_fit_ride(db, user, ride, now=now)
    return result


@router.post("/tailor/stream")
def tailor_stream(
    body: TailorRequest,
    db: Session = Depends(get_db),
    # current_user, NOT metered_user, for the search stream's reason: the model
    # work happens after this returns, in a thread the dependency's tally cannot
    # see. Metered explicitly below.
    user: User = Depends(current_user),
) -> StreamingResponse:
    """The same tailor as POST /tailor, as an SSE stream (PLAN 31.3/2), so the page
    shows the pipeline's REAL stages instead of guessing from elapsed time:
    `progress` frames ({"stage": one of `TAILOR_STAGES`}, each sent as the
    pipeline starts it), then exactly one terminal `result` (a TailorResult) or
    `error` ({detail, status}).

    The charge is /tailor's, decided BEFORE the stream starts, so a refusal is a
    plain HTTP 429 carrying the uses header: the daily tailor cap first, then the
    fit check's ride, or one reserved use. The work runs on a worker thread with
    its own token tally, billed when the stream ends, a dropped client included.
    A tailor that returns settles the ride or keeps the use; one that fails
    releases the ride or gives the use back BEFORE its error frame is queued, on
    a short-lived session of the worker's own (the search stream's order, so no
    client reads "error" while the use is still spent). The error frame carries
    the status and the detail a plain response would, a size refusal's own
    `detail()` included, so the client reads one shape from either door."""
    check_and_count(db, user, "tailor", get_settings().daily_tailor_cap)
    now = quota.utc_now()
    ride = quota.claim_fit_ride(db, user, ref=quota.jd_ref(body.jd), now=now)
    # Everything the worker needs from the user, read while the session is open:
    # after it closes the row is detached, and the pooled (Neon) connection is
    # not pinned for the ~20 s the pipeline takes.
    user_id = user.id
    avoid = writing_prefs_core.avoid_phrases(user)
    hide_arabic = resume_prefs_core.hide_arabic_in_israel(user)
    # The use, reserved LAST, right before the session closes (the search
    # stream's rule): nothing between here and the worker's start can fail and
    # strand it.
    charge = quota.reserve(db, user, "tailor", now=now) if ride is None else None
    db.close()

    events: queue.Queue = queue.Queue()
    tally = TokenTally()

    def _finish(ok: bool) -> None:
        """Settle what paid for this tailor, on the worker's own short session: a
        served tailor settles its ride (the user row reloaded here, since the
        request's copy is detached) or keeps its use; a failed one releases the
        ride or refunds the use. Wrapped whole, like the search's refund: a
        settlement that fails must never stop the frame that follows it."""
        try:
            own = SessionLocal()
            try:
                if ride is not None:
                    if ok:
                        owner = own.get(User, user_id)
                        if owner is not None:
                            quota.settle_fit_ride(own, owner, ride, now=now)
                    else:
                        quota.release_fit_ride(own, ride)
                elif not ok and charge is not None:
                    charge.refund(own)
            finally:
                own.close()
        except Exception:  # noqa: BLE001 - the frame still has to go out
            logger.warning("tailor stream: settling the tailor's use did not complete", exc_info=True)

    def _worker() -> None:
        with bind(tally):
            try:
                result = tailor_resume(
                    body.resume,
                    body.jd,
                    avoid_phrases=avoid,
                    hide_arabic_in_israel=hide_arabic,
                    progress=lambda stage: events.put(("progress", {"stage": stage})),
                )
            except _SIZE_ERRORS as e:
                try:
                    _finish(False)
                finally:
                    events.put(("error", {"detail": e.detail(), "status": e.status}))
                return
            except Exception as e:  # noqa: BLE001
                try:
                    _finish(False)
                finally:
                    events.put(("error", {"detail": f"LLM error while tailoring resume: {e}", "status": 502}))
                return
            _finish(True)
            events.put(("result", result))

    threading.Thread(target=_worker, daemon=True).start()

    def _record_tokens_now() -> None:
        """Bill what the tailor spent. In a finally, so an abandoned stream (the
        client left mid-tailor) still bills the tokens it burned by then."""
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
                    yield ": keep-alive\n\n"  # a tailor sits 20 s in one model call; keep proxies awake
                    continue
                if kind == "progress":
                    yield _sse_frame("progress", payload)
                elif kind == "result":
                    yield _sse_frame("result", payload.model_dump())
                    return
                else:
                    yield _sse_frame("error", payload)
                    return
        finally:
            _record_tokens_now()

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/profile/resume-prefs", response_model=ResumePrefs)
def get_resume_prefs(user: User = Depends(current_user)) -> ResumePrefs:
    """The user's resume preferences (spec 07 / R1). Every switch OFF by default.
    Plain `current_user`: nothing here reaches a model."""
    return resume_prefs_core.load(user)


@router.put("/profile/resume-prefs", response_model=ResumePrefs)
def update_resume_prefs(
    body: ResumePrefs,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> ResumePrefs:
    """Full replace. Applies to the NEXT tailor; never rewrites a stored kit,
    tracker row or the master resume."""
    user.resume_prefs_json = resume_prefs_core.dump(body)
    db.commit()
    return resume_prefs_core.load(user)


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
def cover_letter(
    body: CoverLetterRequest, db: Session = Depends(get_db), user: User = Depends(llm_user)
) -> CoverLetterResponse:
    """Write a cover letter for one analysed job (Phase 30 / B5, OD-2 b).

    The first letter for a posting uses 1 and opens a 24-hour pass keyed by that
    analysed JD (`quota.jd_ref`); changes to it, in any tone, ride the pass up to
    10 calls in all, and a letter for another posting opens its own. The pass is
    reported on this response (`changes_left`, and `expires_in_s` beside the
    absolute `included_until`), never on the uses header, because it belongs to
    one posting; a page that remounted reads it back from /cover-letter/pass. The
    pass sits OUTSIDE the try/except -> 502, so a 429 stays a 429.
    """
    with quota.pass_charged(db, user, "cover_letter", ref=quota.jd_ref(body.jd)) as use:
        try:
            text = generate_cover_letter(body.resume, body.jd, body.tone)
        except _SIZE_ERRORS:
            raise  # app-level 413/503, never an 'LLM error' 502
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"LLM error while writing cover letter: {e}")
    return CoverLetterResponse(
        cover_letter=text,
        included_until=use.included_until,
        changes_left=use.calls_left,
        expires_in_s=use.seconds_left(),
    )


@router.post("/cover-letter/pass", response_model=UsagePassOut)
def cover_letter_pass(
    body: CoverLetterPassRequest, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> UsagePassOut:
    """This posting's cover-letter pass, as the next letter would ride it (P30-RELOAD-PASS).

    A remounted card (a reload of /kits/:id, Tracker and back on /app) asks here,
    because the pass is listed nowhere else. Read-only: it takes no slot, charges
    nothing and reaches no model, so it is uncapped like /tools/coverage and takes
    plain `current_user`; the JD is hashed here, with the letter's own `jd_ref`.
    """
    return quota.posting_pass(db, user, "cover_letter", ref=quota.jd_ref(body.jd))


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


@router.post("/render/pages", response_model=PageImagesResult)
def render_pages(body: PageImagesRequest) -> PageImagesResult:
    """The real PDF as page pictures, for a phone (PLAN 31.2/4): phone browsers
    do not draw a `blob:` PDF inside the page, so "The real PDF" showed nothing
    of the file on the one screen whose job is to show it. Drawn from the same
    bytes the download sends (`render_pdf`), by PDFium (`render/page_images`).
    Deterministic, uncapped and uncharged, like `/render` it stands beside."""
    spec = get_template(body.template)
    try:
        pages, total = pdf_page_pngs(render_pdf(body.resume, template=spec.id))
    except _SIZE_ERRORS:
        raise  # app-level 413/503, never a drawing error
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Error while drawing the pages: {e}")
    return PageImagesResult(
        pages=[base64.b64encode(p).decode("ascii") for p in pages],
        total=total,
        template=spec.id,
    )


# --------------------------------------------------------------------------- #
# Interview prep. A whole practice session is ONE monthly use (Phase 30 / B5):
# the first call opens a 3-hour pass of 60 calls and every call on these six
# routes rides it, whichever posting it is about, because the pass is keyed by
# the feature alone. Each route takes the pass after its own 400 checks and
# OUTSIDE its try/except -> 502, so a 429 stays a 429, and a pass on which no
# call was served gives its use back (quota.pass_charged, B5.3).
# --------------------------------------------------------------------------- #
@router.post("/interview/questions", response_model=InterviewQuestionsResult)
def interview_questions(
    body: InterviewQuestionsRequest, db: Session = Depends(get_db), user: User = Depends(llm_user)
) -> InterviewQuestionsResult:
    with quota.pass_charged(db, user, "interview"):
        try:
            return generate_questions(body.resume, body.jd)
        except _SIZE_ERRORS:
            raise  # app-level 413/503, never an 'LLM error' 502
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"LLM error while generating interview questions: {e}")


@router.post("/interview/answer", response_model=InterviewAnswerResult)
def interview_answer(
    body: InterviewAnswerRequest, db: Session = Depends(get_db), user: User = Depends(llm_user)
) -> InterviewAnswerResult:
    if not body.question.strip():
        raise HTTPException(400, "Question is empty.")
    with quota.pass_charged(db, user, "interview"):
        try:
            return model_answer(body.resume, body.jd, body.question)
        except _SIZE_ERRORS:
            raise  # app-level 413/503, never an 'LLM error' 502
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"LLM error while writing the model answer: {e}")


@router.post("/interview/feedback", response_model=InterviewFeedbackResult)
def interview_feedback(
    body: InterviewFeedbackRequest, db: Session = Depends(get_db), user: User = Depends(llm_user)
) -> InterviewFeedbackResult:
    if not body.answer.strip():
        raise HTTPException(400, "Answer is empty.")
    with quota.pass_charged(db, user, "interview"):
        try:
            return answer_feedback(body.resume, body.question, body.answer)
        except _SIZE_ERRORS:
            raise  # app-level 413/503, never an 'LLM error' 502
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"LLM error while evaluating the answer: {e}")


@router.post("/interview/recruiter-screen", response_model=RecruiterScreenResult)
def interview_recruiter_screen(
    body: RecruiterScreenRequest, db: Session = Depends(get_db), user: User = Depends(llm_user)
) -> RecruiterScreenResult:
    """Prep sheet for the ~15-min recruiter phone screen: pitch, predictable
    questions with grounded talking points, and honest salary-range framing."""
    with quota.pass_charged(db, user, "interview"):
        try:
            return recruiter_screen(body.resume, body.jd_text)
        except _SIZE_ERRORS:
            raise  # app-level 413/503, never an 'LLM error' 502
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"LLM error while building the recruiter-screen prep: {e}")


@router.post("/interview/chat", response_model=InterviewChatResult)
def interview_chat(
    body: InterviewChatRequest, db: Session = Depends(get_db), user: User = Depends(llm_user)
) -> InterviewChatResult:
    """One mock-interview turn (PLAN 11.3). Stateless: the client sends the
    whole transcript; the model returns the interviewer's next message. Every
    turn rides the session's pass, so the session is one use, not one per message."""
    with quota.pass_charged(db, user, "interview"):
        try:
            return chat_turn(body.resume, body.jd_text, body.transcript)
        except ContextWindowExceeded as e:
            # The transcript can be the larger part of this prompt, so the
            # overflow names the session and the CV together, never the CV alone.
            raise ContextWindowExceeded(str(e), kind="transcript") from e
        except _SIZE_ERRORS:
            raise  # app-level 413/503, never an 'LLM error' 502
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"LLM error during the mock interview: {e}")


@router.post("/interview/scorecard", response_model=InterviewScorecardResult)
def interview_scorecard(
    body: InterviewChatRequest, db: Session = Depends(get_db), user: User = Depends(llm_user)
) -> InterviewScorecardResult:
    """End-of-session scorecard for a mock-interview transcript (PLAN 11.3)."""
    if not any(t.role == "candidate" and t.text.strip() for t in body.transcript):
        raise HTTPException(400, "Answer at least one question before ending the session.")
    with quota.pass_charged(db, user, "interview"):
        try:
            return session_scorecard(body.resume, body.jd_text, body.transcript)
        except ContextWindowExceeded as e:
            raise ContextWindowExceeded(str(e), kind="session") from e  # see interview_chat
        except _SIZE_ERRORS:
            raise  # app-level 413/503, never an 'LLM error' 502
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"LLM error while writing the scorecard: {e}")


# --------------------------------------------------------------------------- #
# Job discovery / matching
# --------------------------------------------------------------------------- #
@router.post("/jobs/match", response_model=JobMatchResult)
def jobs_match(
    body: JobMatchRequest,
    db: Session = Depends(get_db),
    user: User = Depends(llm_user),
) -> JobMatchResult:
    """Rank pasted listings by fit: ONE use for up to MAX_MATCH_LISTINGS (Phase 30 / B4.3).

    Every listing that is read costs two model calls in a serial loop, so the
    count, the readable listings and every size are checked BEFORE the use is
    taken and before the first call: a refusal here costs nothing. Too many
    listings is a handler 400 with a sentence, never a Pydantic 422, whose list
    detail the client cannot show. A failure after the model ran gives the use
    back (OD-3).
    """
    if len(body.listings) > MAX_MATCH_LISTINGS:
        raise HTTPException(400, f"At most {MAX_MATCH_LISTINGS} listings per ranking.")
    usable = [text.strip() for text in body.listings if len(text.strip()) >= 20]
    if not usable:
        raise HTTPException(400, "Provide at least one job listing.")
    settings = get_settings()
    for text in usable:
        require_within(text, settings.max_jd_kb, "jd")
    require_within(body.resume.model_dump_json(), settings.max_resume_kb, "resume")
    with quota.charged(db, user, "search"):
        try:
            return match_jobs(body.resume, usable)
        except _SIZE_ERRORS:
            raise  # app-level 413/503, never an 'LLM error' 502
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"LLM error while matching jobs: {e}")


@router.post("/jobs/fit", response_model=FitCheckResult)
def jobs_fit(
    body: FitCheckRequest, db: Session = Depends(get_db), user: User = Depends(llm_user)
) -> FitCheckResult:
    """Read a posting and score the resume against it, before any tailoring.

    ONE round-trip, on the existing JD_FIT task — no new prompt, no new stub
    branch. `analyze_jd` alone would spend the same model call and return half of
    this, so the merged task is strictly the better spend.

    One monthly use, `fit_check`, and it buys the tailor too (Phase 30 / B4.4,
    OD-1): a fit check that returns opens a 24-hour ride for ONE tailor of the
    analysed JD it hands back, and `tailor_included_until` says when that cover
    ends ("" for a caller with no monthly limit). A fit check that fails gives
    its use back and opens no ride; one with no tailor after it still costs 1.

    The analysed JD rides back in the response on purpose: the caller tailors
    with it, which is the key the ride is held under, instead of paying to read
    the same posting a second time, and re-scores coverage against it for free
    on `/tools/coverage`.
    """
    if not body.jd_text.strip():
        raise HTTPException(400, "Job description text is empty.")
    now = quota.utc_now()
    with quota.charged(db, user, "fit_check", now=now) as charge:
        try:
            jd, score = analyze_and_score(body.resume, body.jd_text)
        except _SIZE_ERRORS:
            raise  # app-level 413/503, never an 'LLM error' 502
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"LLM error while reading the job description: {e}")
        result = FitCheckResult(
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
        # Last inside the block: a ride that cannot be opened gives the fit's use back.
        included_until = quota.open_fit_ride(db, user, ref=quota.jd_ref(jd), event_id=charge.event_id, now=now)
    result.tailor_included_until = included_until.isoformat() if included_until is not None else ""
    # Read as the response is built, after the model call: the ride's window
    # started at `now`, before it. The client reads these relative seconds, never
    # the instant, which a phone whose clock runs ahead reads as already over.
    result.tailor_expires_in_s = quota.seconds_until(included_until)
    return result


@router.post("/jobs/fetch", response_model=JobFetchResponse)
def jobs_fetch(
    body: JobFetchRequest,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> JobFetchResponse:
    """Read the posting at a URL the caller names, so the UI can take a link
    instead of pasted text.

    It reaches no model, so it costs no monthly use and has no tokens to meter —
    `current_user`, never `metered_user` — and B4.7's decision that this route is
    free stands. What it does spend is ONE outbound GET per call, through the
    SSRF guard, from the deployment's own IPs: invocations, inbound bytes and our
    standing with the boards. It carried no dependency and no cap of any kind
    until the Phase 30 review (COST-3) — 20 consecutive calls as a plan-free
    friend were 20 fetches with zero rows in every usage table — so it takes its
    own daily cap, which bounds it without putting a deterministic route on the
    pool."""
    check_and_count(db, user, "fetch", get_settings().daily_fetch_cap)
    if not body.url.strip():
        raise HTTPException(400, "URL is empty.")
    try:
        return JobFetchResponse(text=fetch_job_text(body.url))
    except Exception as e:  # noqa: BLE001 - network/parse errors surface to the UI
        raise HTTPException(400, f"Could not fetch that URL: {e}")


@router.post("/jobs/search-context", response_model=SearchContext)
def jobs_search_context(
    body: SearchContextRequest,
    db: Session = Depends(get_db),
    user: User = Depends(metered_user),
) -> SearchContext:
    """Derive what/where to search from the resume, so the UI can prefill the
    'Customize search' fields before any scrape runs. It costs no monthly use
    (it feeds a counted search) and is bounded by its own daily
    `search_context` cap (Phase 30 / B4.6) instead of the shared llm unit."""
    check_and_count(db, user, "search_context", get_settings().daily_search_context_cap)
    try:
        return derive_search_context(body.resume)
    except _SIZE_ERRORS:
        raise  # app-level 413/503, never an 'LLM error' 502
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
    """Search the boards and rank what they return: one monthly use (Phase 30 / B4).

    The daily search cap first, then the use around the search itself. A search
    that completes keeps its use, zero matches included (a 200 whose postings
    were all filtered is a completed search); a failure gives it back. History
    and the rest of the bookkeeping below are best-effort and outside the charge.
    """
    check_and_count(db, user, "search", get_settings().daily_search_cap)
    rhash = resume_hash(body.resume)
    try:  # the cache is an optimization (PLAN 12.4) — never fail the search over it
        cache = load_score_cache(db, user.id, rhash)
    except Exception:  # noqa: BLE001
        cache = {}
    with quota.charged(db, user, "search"):
        try:
            result = search_jobs(
                body.resume,
                body.customize,
                cache=cache,
                # READ BEFORE WRITE, and the order is the whole trap (PLAN 28.3).
                # `search_jobs` calls this once on THIS thread, after select_hits
                # and before the scoring pool — so the request's own session is
                # safe to close over — and `record_sightings` below runs only once
                # the search has returned. Recording first would stamp every
                # posting's `first_seen_at` with NOW and then read it straight
                # back, so `long_open` would measure each posting's age against the
                # moment we noticed it: zero days, for every posting, for ever.
                # The signal would pass by never firing.
                #
                # Passed BARE, not wrapped: `search_jobs` already catches whatever
                # this raises and falls back to no sightings, on the rule that
                # bookkeeping may never turn a served request into an error. A
                # second try/except here would be a second owner of one policy, and
                # the two would drift.
                sightings_fn=partial(load_sightings, db),
            )
        except ValueError as e:  # user-facing scrape/search problems
            raise HTTPException(400, str(e))
        except _SIZE_ERRORS:
            raise  # app-level 413/503, never an 'LLM error' 502
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"Error while searching jobs: {e}")
    try:  # history persistence is best-effort — never fail the search because of it
        record_search_hits(db, result.matches, user.id, resume_hash=rhash)
    except Exception:  # noqa: BLE001
        pass
    try:  # and so is the market memory this search just read (PLAN 28.3)
        record_sightings(db, result.matches, datetime.now(timezone.utc))
    except Exception:  # noqa: BLE001 - bookkeeping for TOMORROW's ghost signals
        # `rollback`, not `pass`, following `usage.record_tokens`: a half-written
        # upsert leaves the session dirty and the next commit on it fails
        # somewhere unrelated, which reads as a bug in whatever ran next.
        db.rollback()
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
    still applies there.

    Monthly uses (Phase 30 / B4.2). One use is reserved on this request's session
    before the stream starts, so a monthly 429 is a plain HTTP 429 like the daily
    cap, and the response carries the post-reserve X-Uses-Remaining. A search
    that completes keeps its use, zero matches included; one that fails gives it
    back BEFORE its error frame is queued, so no client can read the frame while
    the use is still spent. That refund runs on the worker's thread, outside the
    request, where it cannot change a header already sent: the client re-reads
    /auth/me after an error frame. There is no Idempotency-Key (a reused key
    would re-run the model for free), so a retry after a dropped connection pays
    again — and History already holds the search that finished."""
    check_and_count(db, user, "search", get_settings().daily_search_cap)
    # The stream can run for minutes; don't pin the request's pooled (Neon)
    # connection to it. Read what we still need off the session — including the
    # score cache (PLAN 12.4), which must be built BEFORE the close — then
    # release it; history is persisted by the worker on a fresh, short-lived
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
    # The use, reserved LAST on this session and right before it closes: nothing
    # between here and the worker's start can fail and strand it.
    charge = quota.reserve(db, user, "search")
    db.close()

    events: queue.Queue = queue.Queue()  # thread-safe: search workers notify from threads
    # Token accounting (PLAN 20.8/N2) can't ride the metered_user dependency
    # here: this endpoint returns its StreamingResponse immediately and does the
    # LLM work afterwards in a raw thread, so there is no teardown left to read
    # a tally from. Bind one explicitly and write it when the stream ends.
    tally = TokenTally()

    def _sightings_fn(keys: list[tuple[str, str]]) -> dict:
        """The ghost detector's market-memory read (PLAN 28.3), on the SSE path.

        It cannot close over `db` the way the non-stream route does: `db.close()`
        above deliberately released the pooled (Neon) connection before this
        endpoint returned, and `search_jobs` calls this minutes later on the
        worker thread. So it opens the same kind of short-lived session the
        worker opens for `record_search_hits` once the search completes
        (`hist_db`) rather than inventing a second pattern, and closes it
        immediately — the read is one query and happens once per search.

        try/FINALLY, not try/except: a raise here (a cold Neon connection, a
        table that isn't there yet) has to reach `search_jobs`, which owns the
        "abstain, never fail the search" rule for this callable. Swallowing it
        into `{}` locally would put that policy in two places. The session is
        closed either way.
        """
        sdb = SessionLocal()
        try:
            return load_sightings(sdb, keys)
        finally:
            sdb.close()

    def _refund_search() -> None:
        """Give the search's use back, on a short-lived session of the worker's
        own. Wrapped whole: a refund that fails must never stop the error frame
        that follows it, or the stream would spin keep-alives for ever."""
        try:
            refund_db = SessionLocal()
            try:
                charge.refund(refund_db)
            finally:
                refund_db.close()
        except Exception:  # noqa: BLE001 - the frame still has to go out
            logger.warning("search stream: giving back a failed search's use did not complete", exc_info=True)

    def _worker() -> None:
        with bind(tally):
            try:
                result = search_jobs(
                    body.resume,
                    body.customize,
                    progress=lambda e: events.put(("progress", e)),
                    cache=cache,
                    # Read before write: this runs before the scoring pool, and
                    # the sightings are recorded only once the search below has
                    # returned. See the non-stream route for what reversing it
                    # would cost.
                    sightings_fn=_sightings_fn,
                )
            except ValueError as e:  # user-facing scrape/search problems
                # The refund lands BEFORE the frame is queued, so no client can
                # read "error" while the use is still spent.
                try:
                    _refund_search()
                finally:
                    events.put(("error", {"detail": str(e), "status": 400}))
                return
            except Exception as e:  # noqa: BLE001
                try:
                    _refund_search()
                finally:
                    events.put(("error", {"detail": f"Error while searching jobs: {e}", "status": 502}))
                return
            # A completed search is in History BEFORE its result frame, written
            # here on the worker's own session rather than by the stream below:
            # the stream's generator only runs while a client is reading, so a
            # client that dropped would otherwise lose a search it already paid for.
            try:  # best-effort, same as the non-stream route
                hist_db = SessionLocal()
                try:
                    record_search_hits(hist_db, result.matches, user_id, resume_hash=rhash)
                    # The market memory rides the SAME short-lived session as the
                    # history write — one session, one close. A failure here is
                    # bookkeeping for TOMORROW's ghost signals and must not cost
                    # the user this search, so it lands in the best-effort
                    # `except` below; `hist_db` is closed and discarded either
                    # way, so there is no dirty session left to poison anything.
                    record_sightings(hist_db, result.matches, datetime.now(timezone.utc))
                finally:
                    hist_db.close()
            except Exception:  # noqa: BLE001
                pass
            events.put(("result", result))

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
                    # History was written by the worker before this frame was
                    # queued (see _worker); here the matches are only marked.
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
                first_posted_at=row.first_posted_at or "",
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
def _alert_out(row, db: Session, user: User) -> AlertSettingsOut:  # noqa: ANN001 - JobAlert ORM row
    # Phase 30 / B6.5: paused or not is read off the pool NOW, in both GET and
    # PUT, so the card says paused the moment any feature spends the last use.
    paused_reason, resumes_on = alerts_core.pause_state(db, user, row, now=quota.utc_now())
    return AlertSettingsOut(
        enabled=row.enabled,
        email=row.email,
        context=alerts_core.alert_context(row),
        last_run_at=row.last_run_at.isoformat() if row.last_run_at else "",
        last_new_count=row.last_new_count or 0,
        last_error=row.last_error or "",
        smtp_configured=smtp_configured(),
        nudge_emails=bool(row.nudge_emails),
        min_score=alerts_core.alert_min_score(row),
        last_above_min=row.last_above_min,  # `or 0` would erase the unknown/zero split
        paused_reason=paused_reason,
        resumes_on=resumes_on,
    )


@router.get("/jobs/alerts", response_model=AlertSettingsOut)
def get_job_alert(
    db: Session = Depends(get_db), user: User = Depends(current_user)
) -> AlertSettingsOut:
    return _alert_out(alerts_core.get_alert(db, user.id), db, user)


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
        min_score=body.min_score,
    )
    return _alert_out(row, db, user)


@router.post("/jobs/alerts/run", response_model=AlertRunResult)
def run_job_alert(
    db: Session = Depends(get_db), user: User = Depends(metered_user)
) -> AlertRunResult:
    """Manual 'Run now' from the UI — runs even when the toggle is off.

    A search the user pressed, charged like one (Phase 30 / B6.4). It used to be
    an unlimited free ranked search: no daily cap, every scored match recorded to
    History, and History hands back the fit, the gaps and the posting text. Now
    the daily search cap comes first, then one `search` use, both before anything
    runs; at the limit that is a plain 429, and the alert's `last_skip` is left
    alone (that line is about the scheduled mornings). The run keeps the use
    whenever its search completed (zero matches, nothing above the bar, no
    address, no SMTP and a failed send included) and gives it back only when
    there was no master resume or the search itself failed. Never wrapped in
    `quota.charged`: `run_alert` never raises, so that wrapper would never refund.
    The search is passed explicitly so a test can patch `routes.search_jobs`, and
    `metered_user` records the scoring tokens.
    """
    user_id = user.id
    check_and_count(db, user, "search", get_settings().daily_search_cap)
    charge = quota.reserve(db, user, "search", now=quota.utc_now())
    return alerts_core.run_alert(db, user_id, force=True, search_fn=search_jobs, charge=charge)


@router.get("/jobs/alerts/cron", response_model=AlertCronResult)
def cron_job_alert(request: Request, db: Session = Depends(get_db)) -> AlertCronResult:
    """Vercel cron entrypoint (exempt from the X-App-Key gate — see main.py),
    authenticated by the Bearer CRON_SECRET Vercel sends. Runs every active
    user's enabled alert (PLAN 7.3).

    It FAILS CLOSED like the inbox cron (Phase 30 / B6.1): with the gate on and no
    secret configured it refuses with 503 cron_unconfigured. Each morning it runs
    can spend a free user's monthly use, and a refunded morning stays bounded to
    once a day only while this Bearer check runs. The search is passed
    explicitly, as Run now does, so a test can patch `routes.search_jobs`; one
    user's failure cannot stop the next, because `run_alert` never raises.
    """
    s = get_settings()
    secret = s.cron_secret
    if not secret:
        if s.app_access_code:
            raise HTTPException(503, detail={"code": "cron_unconfigured"})
    else:
        auth = request.headers.get("authorization", "")
        if not hmac.compare_digest(auth.encode("utf-8"), f"Bearer {secret}".encode("utf-8")):
            raise HTTPException(401, "Bad cron secret.")
    # Phase 30 / B2: quota rows older than the previous month are pruned here and
    # by the inbox cron, not only on a day's first reserve, or a quiet instance
    # keeps them for ever (the FIXB B19 precedent). Housekeeping: it may never
    # cost the alerts.
    try:
        quota.prune(db, quota.utc_now())
    except Exception:  # noqa: BLE001 - best effort
        db.rollback()
    results, skipped = alerts_core.run_all_alerts(db, search_fn=search_jobs)
    return AlertCronResult(users=len(results) + skipped, results=results, skipped=skipped)


@router.get("/jobs/nudges/cron", response_model=NudgeCronResult)
def cron_nudges(request: Request, db: Session = Depends(get_db)) -> NudgeCronResult:
    """Vercel cron entrypoint for stale-application nudges (PLAN 11.4) —
    exempt from the X-App-Key gate (see main.py) and guarded by the same Bearer
    CRON_SECRET.

    It FAILS CLOSED like its siblings, the alerts and inbox crons (Phase 30
    review, SEC-4): with the gate on and no secret configured it refuses with
    503 cron_unconfigured. It reaches no model and spends no use, which is why
    it used to stay open — but it does send mail on the owner's own SMTP
    account, the resource the auth-mail budget exists to protect and one this
    mail is not counted against, so an open URL is a mail trigger for anyone who
    guesses the path. Two sibling crons disagreeing about who may call them is
    worse than either rule. Emails every opted-in user whose 'applied'
    applications newly went stale."""
    s = get_settings()
    secret = s.cron_secret
    if not secret:
        if s.app_access_code:
            raise HTTPException(503, detail={"code": "cron_unconfigured"})
    else:
        auth = request.headers.get("authorization", "")
        if not hmac.compare_digest(auth.encode("utf-8"), f"Bearer {secret}".encode("utf-8")):
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
    requeued). What will actually run is charged upfront, before any kit is
    written — fail-fast beats dying mid-batch: the daily tailor cap first, then
    one monthly use per NEW kit in a single reserve (Phase 30 / B4.1). A batch
    bigger than what is left is a 429 whose detail says what is left, and
    nothing is queued. Every queued kit carries the reserve's event, which is
    what a failed, deleted or wiped kit gives back."""

    def _charge(n: int) -> int | None:
        check_and_count(db, user, "tailor", get_settings().daily_tailor_cap, count=n)
        return quota.reserve(db, user, "tailor", n).event_id

    try:
        queued_rows, skipped = kits_core.enqueue_kits(db, user, body.jobs, charge=_charge)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return KitBatchResult(
        queued=[kits_core.kit_out(r) for r in queued_rows], skipped_existing=skipped
    )


@router.post("/kits/process-next", response_model=KitProcessResult)
def kits_process_next(
    db: Session = Depends(get_db), user: User = Depends(metered_user)
) -> KitProcessResult:
    """Run the tailor pipeline on the oldest queued kit (already paid for at
    batch time: the daily cap and the kit's monthly use). Pipeline failures land
    on the kit as status=failed and give that kit's use back (Phase 30 / B4.1) —
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


@router.put("/kits/{kit_id}/cover-letter")
def kits_save_cover_letter(
    kit_id: int,
    body: KitCoverLetterIn,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> dict[str, bool]:
    """Store the letter the review page just generated on the kit, so a reload of
    /kits/:id shows it again (it lived in page state alone). It stores text the
    user already has and reaches no model, so it is uncapped and uncharged."""
    row = _owned_kit(db, kit_id, user)
    try:
        kits_core.save_cover_letter(db, row, body.cover_letter)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"saved": True}


@router.post("/kits/{kit_id}/approve", response_model=KitOut)
def kits_approve(
    kit_id: int,
    body: KitApproveRequest,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> KitOut:
    """Approve a reviewed kit (PLAN 8.2): lands in the tracker as a "saved"
    (ready-to-send) application carrying the reviewer's effective resume and
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
    """Delete one kit. A kit still waiting in the queue gives its use back in the
    same transaction as the delete (Phase 30 / B4.1); a kit that ran keeps it."""
    row = db.get(TailorKit, kit_id)
    if not row or row.user_id != user.id:
        raise HTTPException(404, "Kit not found.")
    kits_core.refund_kit(db, kit_id, queued_only=True)
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
    body: AddComeetCompanyRequest,
    db: Session = Depends(get_db),
    _admin: User = Depends(admin_user),
) -> ComeetCompanyOut:
    """Grow the registry: paste any public Comeet careers-page URL and its jobs
    join EVERY user's future searches. Admin-only (Phase 30 / B4.8): the
    registry is shared by all accounts and each add fetches a third-party page,
    so an ordinary account adding companies would be changing everyone's search."""
    try:
        c = register_comeet_company(db, body.url)
    except ValueError as e:  # bad URL / not a Comeet page — user-facing
        raise HTTPException(400, str(e))
    except _SIZE_ERRORS:
        raise  # app-level 413/503, never an 'LLM error' 502
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
    body: AddGreenhouseCompanyRequest,
    db: Session = Depends(get_db),
    _admin: User = Depends(admin_user),
) -> GreenhouseCompanyOut:
    """Grow the registry: paste a Greenhouse board slug or careers URL and its
    jobs join EVERY user's future searches. Admin-only (Phase 30 / B4.8), for the
    same reason as the Comeet registry: it is shared by all accounts."""
    try:
        c = register_greenhouse_company(db, body.board)
    except ValueError as e:  # bad slug / no such board — user-facing
        raise HTTPException(400, str(e))
    except _SIZE_ERRORS:
        raise  # app-level 413/503, never an 'LLM error' 502
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Error while adding that company: {e}")
    return GreenhouseCompanyOut(slug=c.slug, name=c.name, board_url=greenhouse_board_url(c.slug))


# --------------------------------------------------------------------------- #
# The CV scan (PLAN 6): a resume file against a pasted job description,
# deterministic only — never the LLM — and nothing is persisted. An app feature
# since Phase 30 / A2: it sits behind the gate like every other feature (it has
# no `_GATE_EXEMPT` entry, so credentials, CSRF and verification all apply), and
# a scan that returns a result costs one monthly use. The anonymous /public/scan
# and its per-instance, per-IP limiter are gone; the per-user pool, the daily
# scan cap and the signup throttles replace them.
# --------------------------------------------------------------------------- #
@router.post("/tools/scan", response_model=FreeScanResult)
async def tools_scan(
    file: UploadFile = File(...),
    jd_text: str = Form(""),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> FreeScanResult:
    """Score a resume file against a job description.

    In order: an empty JD is a 400 that costs nothing; the daily scan cap counts
    the attempt and is never refunded; then one monthly use wraps the read, the
    parse and the scan, so a refused upload (413), an unreadable file (400) or a
    file with no text (422) gives the use back.
    """
    if not jd_text.strip():
        raise HTTPException(400, "Paste the job description text.")
    check_and_count(db, user, "scan", get_settings().daily_scan_cap)
    with quota.charged(db, user, "scan"):
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
@router.post("/tools/review", response_model=ReviewResult)
def tools_review(body: ReviewRequest) -> ReviewResult:
    """Every deterministic review check, against the document as it stands.

    NO `Depends` — this is the successor to `/tools/ats-scan` and it inherits
    that route's whole cautionary tale. It is uncapped because `resume_review`
    reaches no model and no network, which is source-pinned off the AST rather
    than asserted here; and it takes an ANALYSED `jd` or `null`, never job-ad
    text, because a route that accepted text would have to reach the model to
    use it, and an uncapped door onto the model is exactly the defect that rule
    exists to prevent.

    `useReview` re-runs this on a 400 ms debounce as the user types, so it must
    stay cheap and must never 500: an unmeasurable check reports itself in
    `skipped` instead.
    """
    try:
        return review_resume(body.resume, body.jd)
    except _SIZE_ERRORS:
        raise  # app-level 413/503, never an 'LLM error' 502
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Error while reviewing resume: {e}")


@router.post("/tools/review/rewrites", response_model=ReviewRewriteResult)
def tools_review_rewrites(
    body: ReviewRewriteRequest, db: Session = Depends(get_db), user: User = Depends(llm_user)
) -> ReviewRewriteResult:
    """Model rewordings for the rewritable findings — the one part of the
    review that spends, and therefore the one part that is capped.

    Its sibling above is free and runs on every keystroke; this one sits behind
    a button and costs one monthly use (Phase 30 / B4.5), but only when there is
    something to ask the model about. The targets are chosen ONCE, here: none (a
    tidy CV, or paths that match no bullet) is the empty result with no model
    call and no charge. `paths: []` means "the server picks", not "no targets".
    The charge sits OUTSIDE the try/except -> 502, so a 429 stays a 429. Every
    rewrite is guard-checked after the call and the response says how many were
    refused.
    """
    try:
        targets = rewrite_targets(body.resume, body.paths)
    except _SIZE_ERRORS:
        raise  # app-level 413/503, never an 'LLM error' 502
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Error while choosing bullets to rewrite: {e}")
    if not targets:
        return ReviewRewriteResult()
    with quota.charged(db, user, "rewrites"):
        try:
            return write_rewrites(body.resume, body.paths, targets=targets)
        except _SIZE_ERRORS:
            raise  # app-level 413/503, never an 'LLM error' 502
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"LLM error while rewriting bullets: {e}")


# Deterministic like /tools/ats-scan — it renders and re-parses, never calls the
# model — so it is deliberately uncapped. That exclusion is smoke-pinned.
@router.post("/tools/ats-xray", response_model=ATSXrayResult)
def tools_ats_xray(body: ATSXrayRequest) -> ATSXrayResult:
    try:
        return xray(body.resume, template=body.template, fmt=body.fmt)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except _SIZE_ERRORS:
        raise  # app-level 413/503, never an 'LLM error' 502
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Error while x-raying resume: {e}")


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
    except _SIZE_ERRORS:
        raise  # app-level 413/503, never an 'LLM error' 502
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
# because restoring produces a document NOTHING has measured: the trimmed resume
# plus the master's full version of the restored item. Deriving it from
# `length_report.pages_before/after` would be a guess, and a wrong one.
@router.post("/tools/page-count", response_model=PageCountResult)
def tools_page_count(body: PageCountRequest) -> PageCountResult:
    spec = get_template(body.template)
    s = get_settings()
    try:
        pages = page_count(body.resume, template=spec.id)
    except _SIZE_ERRORS:
        raise  # app-level 413/503, never an 'LLM error' 502
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Error while measuring page count: {e}")
    return PageCountResult(
        pages=pages,
        max_pages=s.resume_max_pages,
        hard_max_pages=s.resume_hard_max_pages,
        template=spec.id,
    )


@router.post("/tools/linkedin", response_model=LinkedInResult)
def tools_linkedin(
    body: LinkedInRequest, db: Session = Depends(get_db), user: User = Depends(llm_user)
) -> LinkedInResult:
    """One monthly use (Phase 30 / B4), given back if the rewrite fails."""
    with quota.charged(db, user, "linkedin"):
        try:
            return optimize_linkedin(body.resume)
        except _SIZE_ERRORS:
            raise  # app-level 413/503, never an 'LLM error' 502
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"LLM error while optimizing LinkedIn profile: {e}")


@router.post("/tools/follow-up", response_model=FollowUpResult)
def tools_follow_up(
    body: FollowUpRequest, db: Session = Depends(get_db), user: User = Depends(llm_user)
) -> FollowUpResult:
    """One monthly use (Phase 30 / B4), given back if the email cannot be written."""
    with quota.charged(db, user, "follow_up"):
        try:
            return write_follow_up(body.company, body.role, body.stage, body.context)
        except _SIZE_ERRORS:
            raise  # app-level 413/503, never an 'LLM error' 502
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"LLM error while writing the follow-up email: {e}")


@router.post("/outreach", response_model=OutreachResult)
def outreach(
    body: OutreachRequest, db: Session = Depends(get_db), user: User = Depends(llm_user)
) -> OutreachResult:
    """Outreach Studio: a LinkedIn connection note, an InMail/cold email, and a
    referral request for one job — the direct-to-a-human path to an interview,
    grounded only in real resume facts. One monthly use (Phase 30 / B4), given
    back if the messages cannot be written."""
    with quota.charged(db, user, "outreach"):
        try:
            return generate_outreach(
                body.resume,
                body.jd_text,
                body.company,
                body.job_title,
                body.contact_name,
                body.contact_role,
            )
        except _SIZE_ERRORS:
            raise  # app-level 413/503, never an 'LLM error' 502
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"LLM error while writing outreach messages: {e}")


@router.post("/tools/screening-answer", response_model=ScreeningAnswerResult)
def tools_screening_answer(
    body: ScreeningRequest, db: Session = Depends(get_db), user: User = Depends(llm_user)
) -> ScreeningAnswerResult:
    """Draft an honest, resume-grounded answer to an application/screening
    free-text question (e.g. "Why do you want to work here?").

    Up to 6 answers in 3 hours are one monthly use (Phase 30 / B5): the Chrome
    extension's autofill fires up to four answers per click, one request each,
    with no grouping id, so the pass is keyed by the feature alone. Taken after
    the empty-question 400 and OUTSIDE the try/except -> 502.
    """
    if not body.question.strip():
        raise HTTPException(400, "Question is empty.")
    with quota.pass_charged(db, user, "screening"):
        try:
            return answer_screening_question(body.resume, body.jd_text, body.question)
        except _SIZE_ERRORS:
            raise  # app-level 413/503, never an 'LLM error' 502
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"LLM error while drafting the answer: {e}")


@router.post("/tools/company-brief", response_model=CompanyBriefResult)
def tools_company_brief(
    body: CompanyBriefRequest, db: Session = Depends(get_db), user: User = Depends(llm_user)
) -> CompanyBriefResult:
    """Grounded pre-apply/pre-interview company brief: fetches the company's
    about/careers page (or takes pasted text) and summarizes it — plus key
    hiring-relevant people from the page and a short resume-grounded reach-out.
    Never model memory alone; emails only when they appear on the page. One
    monthly use (Phase 30 / B4): a page that cannot be fetched (400), or any
    other failure, gives it back."""
    with quota.charged(db, user, "company_brief"):
        try:
            return build_company_brief(
                body.resume, body.company, body.url, body.page_text, body.jd_text, body.job_title
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        except _SIZE_ERRORS:
            raise  # app-level 413/503, never an 'LLM error' 502
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"LLM error while building the company brief: {e}")


# --------------------------------------------------------------------------- #
# Master resumes (persisted, reused across Tailor / Interview / Job Match).
# Paired he/en: one row per language, keyed by the resume's detected language —
# never client-supplied, so the pairing can't drift from the actual content.
# --------------------------------------------------------------------------- #
def _saved_to_master(row, stamp) -> MasterResumeOut | None:  # noqa: ANN001
    """Parse a stored resume row into the API shape, or None if unreadable.

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
    """The user's saved-resume rows, newest first, with legacy `language` healed.

    The ADD-COLUMN shim stamps pre-pairing rows "en"; a Hebrew master saved
    before the column existed would shadow the real English slot, so recompute
    the language from the stored resume whenever they disagree.
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
    """The master resume — most recently updated, or the `lang` one when asked."""
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
    # facts ledger from the resume itself: the user typed these facts, so the
    # resume IS the source of truth the fabrication guard should protect.
    ledger = body.ledger or build_facts_ledger(body.resume)
    row = next(
        (r for r in _master_rows(db, user.id) if (r.language or "en") == language), None
    )
    # The master resume is embedded whole into ~20 downstream prompts, so this
    # is the door that bounds all of them at once — and it is a REAL door: since
    # Phase 23 the document is typed on directly, so a ResumeModel arrives here
    # with no file and no parser behind it. Guarded here rather than at each
    # prompt so the size is refused once, before anything is persisted.
    #
    # THE CARVE-OUT IS LOAD-BEARING: a save that SHRINKS an already-oversize
    # master is always allowed. Without it, anyone whose master predates this
    # cap is locked out of their own resume — every save refused, including the
    # trim that would fix it. That is a guard firing on the one action the user
    # must be able to take.
    incoming = body.resume.model_dump_json()
    stored_bytes = utf8_bytes(row.resume_json or "") if row is not None else 0
    if utf8_bytes(incoming) > stored_bytes:
        require_within(incoming, get_settings().max_resume_kb, "resume")
    if row is None:
        row = SavedResume(language=language, user_id=user.id)
        db.add(row)
    else:
        # Keep the outgoing content before it is overwritten (PLAN 20.8/N1).
        # Best-effort: a failure here must never cost the user the save they
        # actually asked for — losing an undo point beats losing the resume.
        try:
            resume_versions.snapshot(db, row, body.resume.model_dump_json())
        except Exception:  # noqa: BLE001
            pass
    row.label = body.label
    row.resume_json = body.resume.model_dump_json()
    row.ledger_json = ledger.model_dump_json()
    # "MOST RECENTLY UPDATED" HAS TO BE A TOTAL ORDER, AND THE CLOCK DOES NOT
    # GIVE ONE. `_master_rows` sorts on `updated_at` alone, and the column's
    # `onupdate` reads the system clock — which on Windows ticks about every
    # 15.6 ms, so three consecutive `datetime.now()` calls return the IDENTICAL
    # value. Two saves inside one tick therefore tie, and SQLite is free to
    # return them in either order: `GET /profile/resume` with no `lang` answers
    # with whichever it feels like, and the paired he/en master the user just
    # wrote is not necessarily the one they get back. Observed as an
    # intermittently red smoke check that passed on the next run — the shape of
    # thing this repo's own note says never to re-run away.
    #
    # A tiebreak in the ORDER BY cannot fix it: `id` is creation order, and the
    # row being written here is often the OLDER one (an upsert by language), so
    # `id DESC` would break the tie deterministically WRONG. The order has to be
    # made real at the point of writing instead — one microsecond past the
    # newest row this user has. Nothing else reads `updated_at` as a wall-clock
    # instant, and a save is not a measurement of time.
    now = datetime.now(timezone.utc)
    newest = max(
        (r.updated_at for r in _master_rows(db, user.id) if r is not row and r.updated_at),
        default=None,
    )
    if newest is not None:
        if newest.tzinfo is None:
            newest = newest.replace(tzinfo=timezone.utc)
        if now <= newest:
            now = newest + timedelta(microseconds=1)
    row.updated_at = now
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
# Master resume version history (PLAN 20.8 / N1). The save above overwrites in
# place, and several UI paths save without the user thinking of it as a save —
# so these are the undo.
# --------------------------------------------------------------------------- #
def _version_out(row) -> ResumeVersionOut:  # noqa: ANN001 - SavedResumeVersion ORM row
    """Metadata for the picker. The resume is parsed only for the three counts
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
    resume. Restores into the version's OWN language slot, so restoring a
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
def _utc_iso(dt: datetime | None) -> str | None:
    """A Phase 29 tracker timestamp with its offset stated. `created_at` above
    keeps its historical naive form, which the card slices as a date."""
    value = inbox_apply.utc(dt)
    return value.isoformat() if value is not None else None


def _to_out(app: Application, email_kind: str = "") -> ApplicationOut:
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
        source=app.source or "",
        applied_at=_utc_iso(app.applied_at),
        last_email_at=_utc_iso(app.last_email_at),
        last_email_kind=email_kind,
        location=app.location or "",
        posted_at=app.posted_at or "",
    )


def _stored_jd(jd: JDModel) -> str:
    """An analysed posting as the row stores it (PLAN 31.4), refused past the cap
    every other route puts on an analysed JD sent back by a client: a 413 of kind
    "jd", the one `main.py` already words, never a truncated analysis."""
    raw = jd.model_dump_json()
    require_within(raw, get_settings().max_jd_json_kb, "jd")
    return raw


def _stored_review(app: Application) -> dict:
    """The row's stored review as a dict, or {} when it has none or it no longer
    parses (an unknown, never a 500)."""
    if not app.review_json:
        return {}
    try:
        stored = json.loads(app.review_json)
    except ValueError:
        return {}
    return stored if isinstance(stored, dict) else {}


def _review_whole(stored: dict) -> bool:
    """A review the document can open: a result and the resume it came from."""
    return isinstance(stored.get("result"), dict) and isinstance(stored.get("base"), dict)


def _next_review(stored: dict, review: ApplicationReview | None) -> str:
    """The review to store beside a draft being written (PLAN 31.4/4).

    None clears it: the draft is being replaced, and a review of the previous
    one would reopen the wrong document. A review with a `result` replaces the
    stored result and base; one without (the saves after a result's first)
    keeps them and replaces only the declined changes and the typed lines.
    Measured before anything is written, like the analysis: a review past four
    times the resume cap is a 413, never truncated."""
    if review is None:
        return ""
    stored = dict(stored)
    if review.result is not None:
        stored["result"] = review.result.model_dump(mode="json")
        stored["base"] = review.base.model_dump(mode="json") if review.base is not None else None
        stored["scored_at"] = review.scored_at
    stored["rejected"] = review.rejected
    stored["overrides"] = review.overrides
    raw = json.dumps(stored, ensure_ascii=False)
    require_within(raw, 4 * get_settings().max_resume_kb, "resume")
    return raw


def _row_jd(app: Application) -> JDModel | None:
    """The row's stored analysis, or None when it has none or it no longer
    parses (a legacy or corrupt value is an unknown, never a 500)."""
    if not app.jd_json:
        return None
    try:
        return JDModel.model_validate_json(app.jd_json)
    except Exception:  # noqa: BLE001 - tolerate legacy/corrupt rows
        return None


def _email_kind(db: Session, user_id: int, app_id: int) -> str:
    events = inbox_apply.events_for_application(db, user_id, app_id)
    return events[0].kind if events else ""


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
    kinds = inbox_apply.latest_kinds(db, user.id)
    return [_to_out(r, kinds.get(r.id, "")) for r in rows]


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
    events = inbox_apply.events_for_application(db, user.id, app.id)
    conn = inbox_sync_core.connection_for(db, user.id)
    mailbox = (conn.email_address or "") if conn is not None and conn.provider == "gmail" else ""
    kit = applications_db.pending_kit(db, user.id, app.job_url)
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
        source=app.source or "",
        template=app.template or "",
        applied_at=_utc_iso(app.applied_at),
        last_email_at=_utc_iso(app.last_email_at),
        last_email_kind=events[0].kind if events else "",
        email_events=[inbox_sync_core.event_out(e, mailbox) for e in events],
        location=app.location or "",
        posted_at=app.posted_at or "",
        jd=_row_jd(app),
        status_changed_at=_utc_iso(app.status_changed_at),
        status_source=app.status_source or "",
        voice_score=app.voice_score,
        fabrication_flag_count=app.fabrication_flag_count,
        pending_kit=ApplicationKit(id=kit.id, status=kit.status) if kit is not None else None,
        has_review=_review_whole(_stored_review(app)),
    )


@router.get("/applications/{app_id}/review", response_model=ApplicationReviewOut)
def get_application_review(
    app_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> ApplicationReviewOut:
    """The review behind a job's saved draft, whole (PLAN 31.4/4): what the
    document needs to open it again after a reload. Its own route rather than a
    field on the detail, because every page that reads a job would carry it.
    Reaches no model and spends nothing (classed `free` in smoke 32.13). A row
    with no whole review, or one that no longer parses, is a 404, and so is
    someone else's row."""
    app = _owned_application(db, app_id, user)
    stored = _stored_review(app)
    if not _review_whole(stored):
        raise HTTPException(404, "This draft has no saved review.")
    try:
        return ApplicationReviewOut(
            result=stored["result"],
            base=stored["base"],
            rejected=stored.get("rejected") or [],
            overrides=stored.get("overrides") or {},
            scored_at=stored.get("scored_at"),
        )
    except Exception:  # noqa: BLE001 - a legacy or corrupt review is an unknown
        raise HTTPException(404, "This draft has no saved review.")


@router.post("/applications", response_model=ApplicationOut)
def create_application(
    body: ApplicationCreate,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> ApplicationOut:
    # PLAN 31.1/5: one posting, one tracker row. A job saved from Jobs, from the
    # extension or through "Use a job you saved" reaches /app with its URL but not
    # its row id, so "Save to tracker" and "Yes, applied" posted a SECOND row for
    # it. A post for a URL this user already tracks updates that row instead:
    #   * a tailored resume replaces the stored one, with the three what-was-sent
    #     signals it came with (None stays unknown, never a stale value);
    #   * a letter, a job description, a title or a company fills only a blank;
    #   * the status only moves FORWARD, saved -> applied, and never back: the
    #     inbox and the user's own moves own everything past Applied.
    # No URL (a pasted posting) is a new row, exactly as before.
    # PLAN 31.4 adds three: a place and a posted date fill only a blank, like a
    # title; an analysis REPLACES the stored one, because it is the one the draft
    # beside it was tailored against, and the letter's pass is keyed by it.
    # PLAN 31.4/4: a tailored resume carries its review, written with it (none
    # clears the stored one). Everything that can refuse is measured before
    # anything is written.
    jd_json = _stored_jd(body.jd) if body.jd is not None else ""
    existing = applications_db.tracked_job(db, user.id, body.job_url)
    if existing is not None:
        review_json = (
            _next_review(_stored_review(existing), body.review) if body.tailored_resume is not None else None
        )
        now = datetime.now(timezone.utc)
        if body.tailored_resume is not None:
            existing.tailored_resume_json = body.tailored_resume.model_dump_json()
            existing.overall_score = body.overall_score
            existing.template = body.template
            existing.voice_score = body.voice_score
            existing.fabrication_flag_count = body.fabrication_flag_count
            existing.review_json = review_json or ""
        if body.cover_letter:
            existing.cover_letter = body.cover_letter
        if body.jd_text and not existing.jd_text:
            existing.jd_text = body.jd_text
        if body.job_title and not existing.job_title:
            existing.job_title = body.job_title
        if body.company and not existing.company:
            existing.company = body.company
        if body.location and not existing.location:
            existing.location = body.location
        if body.posted_at and not existing.posted_at:
            existing.posted_at = body.posted_at
        if jd_json:
            existing.jd_json = jd_json
        if body.status == "applied" and existing.status == "saved":
            existing.status = "applied"
            existing.status_changed_at = now
            existing.status_source = "manual"
            if existing.applied_at is None:
                existing.applied_at = now
        db.commit()
        db.refresh(existing)
        return _to_out(existing, _email_kind(db, user.id, existing.id))
    review_json = _next_review({}, body.review) if body.tailored_resume is not None else ""
    app = Application(
        user_id=user.id,
        job_title=body.job_title,
        company=body.company,
        jd_text=body.jd_text,
        tailored_resume_json=body.tailored_resume.model_dump_json() if body.tailored_resume else "",
        review_json=review_json,
        cover_letter=body.cover_letter,
        overall_score=body.overall_score,
        status=body.status,
        job_url=body.job_url,
        template=body.template,
        voice_score=body.voice_score,
        fabrication_flag_count=body.fabrication_flag_count,
        status_changed_at=datetime.now(timezone.utc),
        # Phase 29: who set the status (the inbox's rule 5 reads it), and — for
        # a row saved straight into Applied — when it was sent (I3).
        status_source="created",
        applied_at=datetime.now(timezone.utc) if body.status == "applied" else None,
        location=body.location,
        posted_at=body.posted_at,
        jd_json=jd_json,
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
    # PLAN 31.4: measured before anything is written, so a refused analysis
    # leaves the whole row as it was.
    jd_json = _stored_jd(body.jd) if body.jd is not None else ""
    if body.status is not None:
        if body.status != app.status:
            app.status_changed_at = datetime.now(timezone.utc)
            # Phase 29: a hand-made status change, which no older email may
            # quietly undo (inbox_apply, rule 5) — and moving a card into Applied
            # is the moment it was sent, when nothing recorded one earlier (I3).
            app.status_source = "manual"
            if body.status == "applied" and app.applied_at is None:
                app.applied_at = datetime.now(timezone.utc)
        app.status = body.status
    if body.notes is not None:
        app.notes = body.notes
    if body.interviewed is not None:
        app.interviewed = body.interviewed
    if body.excitement is not None:
        app.excitement = body.excitement
    if body.cover_letter is not None:
        app.cover_letter = body.cover_letter
    if jd_json:
        app.jd_json = jd_json
    db.commit()
    db.refresh(app)
    return _to_out(app, _email_kind(db, user.id, app.id))


@router.put("/applications/{app_id}/draft", response_model=ApplicationOut)
def save_application_draft(
    app_id: int,
    body: ApplicationDraft,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> ApplicationOut:
    """The tailored draft, saved with its job as the user reviews it (PLAN
    31.3/4, owner decision 2). The page writes the row when a tailor finishes
    (`POST /applications`, which merges by URL) and then keeps it current here:
    every accept, decline, typed edit, template and letter. Reaches no model and
    spends nothing, so it is plain `current_user`, classed `free` in smoke 32.13.
    The resume and its signals are written together, None included; the letter
    only when one is sent (`ApplicationDraft`). Someone else's row is a 404.
    The analysis likewise (PLAN 31.4): written when sent, since a tailor started
    from the job's own page saves onto its row here, never through the POST.
    The review behind the draft is written WITH it (PLAN 31.4/4), and a save
    without one clears the stored review (`_next_review`)."""
    app = _owned_application(db, app_id, user)
    jd_json = _stored_jd(body.jd) if body.jd is not None else ""
    review_json = _next_review(_stored_review(app), body.review)
    app.tailored_resume_json = body.tailored_resume.model_dump_json()
    app.review_json = review_json
    app.template = body.template
    app.voice_score = body.voice_score
    app.fabrication_flag_count = body.fabrication_flag_count
    if body.overall_score is not None:
        app.overall_score = body.overall_score
    if body.cover_letter is not None:
        app.cover_letter = body.cover_letter
    if jd_json:
        app.jd_json = jd_json
    db.commit()
    db.refresh(app)
    return _to_out(app, _email_kind(db, user.id, app.id))


@router.delete("/applications/{app_id}")
def delete_application(
    app_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> dict[str, bool]:
    app = _owned_application(db, app_id, user)
    # Phase 29: the emails tied to this card forget it. SQLite hands a deleted
    # max id to the next row, so a dangling link would put this card's email
    # timeline, and its Undo, on whatever card is created next.
    db.execute(
        update(MailEvent)
        .where(MailEvent.user_id == user.id, MailEvent.application_id == app.id)
        .values(application_id=None)
        .execution_options(synchronize_session=False)
    )
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


def _wipe_user_rows(db: Session, user: User) -> DeleteMyDataResult:
    """Delete every row this user owns, and say how many per table.

    Two deliberate carve-outs (Phase 30 / B2): TODAY's usage_log rows stay (they
    are the daily caps, and `close_my_account` removes them), and the monthly-uses
    tables are never touched (the pool belongs to the person). Both exist so that
    neither privacy door is a way to reset a limit.

    Shared by BOTH destructive routes so the two can never drift: the day a
    table is added, one edit here covers "Delete all my data" and "Close my
    account" alike. This is the function CLAUDE.md's "anything holding user
    content must be wiped by DELETE /profile/data" rule now points at — a new
    table missed here leaves PII behind on two doors instead of one.

    Does NOT commit: the account close needs the wipe and the deactivation to
    land in one transaction, or a failure between them leaves a user with no
    data and a code that still works.
    """
    def _wipe(model) -> int:  # noqa: ANN001
        return db.execute(delete(model).where(model.user_id == user.id)).rowcount or 0

    # The two user-content COLUMNS on the surviving `users` row. The rule this
    # helper serves is about content, not about tables, and these two were the
    # hole in it: `writing_prefs_json` holds up to 50 phrases quoted out of the
    # user's OWN tailored bullets and `avoid_phrases()` feeds them straight
    # back into the next TAILOR prompt, so a wipe that skipped them left
    # resume-derived text driving the model over a resume that no longer
    # exists — and the Jobs page went on prefilling the wiped user's job title
    # and location from `search_prefs_json`. Cleared, not deleted: the row
    # itself stays so the invite code keeps working, which is the promise the
    # privacy copy makes verbatim. They are columns, not row counts, so
    # `DeleteMyDataResult` is unchanged and both doors get this for free.
    user.search_prefs_json = ""
    user.writing_prefs_json = ""
    # Spec 07 / R1: "leave Arabic off for jobs in Israel" implies the user's
    # ethnicity. Same column-not-row rule as the two above.
    user.resume_prefs_json = ""

    # Gmail (Phase 29 / B2): the stored grant goes back to Google FIRST, best
    # effort, so a wipe ends the access rather than only forgetting it — and then
    # the connection row (the encrypted grant) and every detected email go with
    # the rest. `inbox_sync_core.revoke_stored_grant` never raises.
    # FIXB B17: the result REPORTS whether that revoke happened, so a wipe with
    # an unreadable token never reads as a grant handed back.
    google_revoked = inbox_sync_core.revoke_stored_grant(inbox_sync_core.connection_for(db, user.id))

    # Phase 30 / B4.1: a kit still waiting in the queue was paid for when it was
    # batched and will never run now, so its use comes back BEFORE the kit rows
    # go, in this same transaction.
    kits_core.refund_queued_kits(db, user.id)

    # Phase 30 / B2: only usage_log rows from EARLIER UTC days. Today's rows are
    # the daily caps' counters, and a wipe that took them would make "Delete my
    # data" a free reset of every daily cap.
    earlier_usage = db.execute(
        delete(UsageLog).where(UsageLog.user_id == user.id, UsageLog.day < utc_day())
    ).rowcount or 0

    return DeleteMyDataResult(
        resumes=_wipe(SavedResume),
        resume_versions=_wipe(SavedResumeVersion),
        applications=_wipe(Application),
        history=_wipe(JobSearchHit),
        alerts=_wipe(JobAlert),
        usage=earlier_usage,
        feedback=_wipe(Feedback),
        kits=_wipe(TailorKit),
        inbox_events=_wipe(MailEvent),
        inbox_connections=_wipe(MailConnection),
        google_revoked=google_revoked,
    )


@router.get("/profile/me", response_model=MeOut)
def get_me(user: User = Depends(current_user)) -> MeOut:
    """Who this access code belongs to — the Settings page's Account section.

    `current_user`, not `llm_user`: this route reads one already-loaded ORM row
    and calls no model, so a cap here would charge a user's daily LLM budget
    for opening a settings page. The rule cuts the other way too — see the
    /tools/ats-scan cautionary tale in CLAUDE.md — so the thing that keeps this
    honest is that nothing reachable from here can grow a model call: there is
    no free-text input on this route to hand one.
    """
    return MeOut(name=user.name, email=user.email, is_admin=user.is_admin)


@router.post("/profile/onboarded")
def mark_onboarded(db: Session = Depends(get_db), user: User = Depends(current_user)) -> dict:
    """Record that this ACCOUNT finished or skipped the first-run questions
    (PLAN 31.1/11), so no device asks again: they were remembered per device
    and cleared on sign-out. Idempotent: the first stamp is kept.

    `current_user`, like `/profile/me`: it writes one timestamp on an already
    loaded row and takes no body, so nothing reachable from here can grow a
    model call, and a daily cap would only be theatre."""
    if user.onboarded_at is None:
        user.onboarded_at = datetime.now(timezone.utc)
        db.commit()
    return {"onboarded": True}


@router.delete("/profile/data", response_model=DeleteMyDataResult)
def delete_my_data(
    db: Session = Depends(get_db), user: User = Depends(current_user)
) -> DeleteMyDataResult:
    """Wipe everything the current user stored (PLAN 7.5) — resumes are PII
    and testers must be able to leave cleanly. The user row itself stays so
    the invite code keeps working."""
    result = _wipe_user_rows(db, user)
    db.commit()
    return result


@router.delete("/profile/account", response_model=DeleteAccountResult)
def close_my_account(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> DeleteAccountResult:
    """The same wipe, and then the access code stops resolving (PLAN 23.5).

    Two separate doors on purpose: "Delete all my data" is for a tester who
    wants to keep using the app from clean, this one is for someone leaving.
    Deactivating is what `resolve_user` filters on, so the code is dead the
    moment this commits — every later request from that device 401s into the
    AccessGate.

    An ADMIN is refused, for the same reason `admin_update_user` refuses to
    deactivate one: the admin code is the only way back into a deployed
    instance, and there is no second admin to re-enable it. Worse locally —
    with the gate OFF, `current_user` hands EVERY request the auto-created
    admin, so a self-close would either do nothing (the fallback re-creates it)
    or brick the dev instance. Pointing at Delete-all-my-data is the honest
    answer: it is the half of this route an admin can actually have.

    Since Phase 29 the account tables go in the SAME transaction: the sign-in
    address, its mailed tokens and every session. So the address can be
    registered again, and every signed-in browser 401s the way the code does.
    The auth EVENTS stay, with their user id cleared, because they are keyed on
    an email or a network and deleting them would make closing the account a
    way to reset its brute-force limits (`accounts.purge_on_close`).
    """
    if user.is_admin:
        raise HTTPException(
            400,
            "An admin account can't be closed — it's the only way back into "
            "this instance. Use Delete all my data instead.",
        )
    result = _wipe_user_rows(db, user)
    # Phase 30 / B2: the usage_log rows the wipe kept for TODAY go too, in this
    # transaction. A deactivated user can never spend them and a new signup gets
    # a new user id, so keeping them would hold usage data with no purpose and no
    # expiry. The monthly pool is keyed by the address, not the id, and stays.
    result.usage += db.execute(delete(UsageLog).where(UsageLog.user_id == user.id)).rowcount or 0
    user.is_active = False
    # FIXB B14: the row stays (a deactivated id and its dead code are what the
    # design needs), but the name and the sign-in address go with the account —
    # the privacy page says closing deletes the sign-in details, and the auth
    # events are HMAC-keyed precisely so a closed account leaves no plain email.
    user.name = ""
    user.email = ""
    accounts_core.purge_on_close(db, user.id)
    db.commit()  # one transaction: never wiped-but-still-open
    clear_session_cookie(response, request)
    return DeleteAccountResult(data=result, deactivated=True)


def _user_out(u: User, login: UserLogin | None = None, uses: int = 0) -> UserOut:
    return UserOut(
        id=u.id,
        name=u.name,
        email=u.email,
        invite_code=u.invite_code,
        is_admin=u.is_admin,
        is_active=u.is_active,
        created_at=u.created_at.isoformat() if u.created_at else "",
        last_seen_at=u.last_seen_at.isoformat() if u.last_seen_at else "",
        login_email=login.email if login is not None else "",
        verified=accounts_core.is_verified(
            u.is_admin, u.signup_source, login.email_verified_at if login is not None else None
        ),
        inbox_enabled=bool(u.inbox_enabled),
        plan=quota.plan_of(u),
        uses_this_month=uses,
    )


def _uses_this_month(db: Session, user_id: int, login: UserLogin | None) -> int:
    key = quota.key_for(user_id, login.email if login is not None else None)
    return quota.used_by_keys(db, {key}, quota.period_of(quota.utc_now())).get(key, 0)


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
    logins = {row.user_id: row for row in db.execute(select(UserLogin)).scalars().all()}
    # Phase 30 / B7: each user's pool key comes from the login already loaded, and
    # this month's counts for all of them from ONE query.
    keys = {u.id: quota.key_for(u.id, logins[u.id].email if u.id in logins else None) for u in rows}
    uses = quota.used_by_keys(db, set(keys.values()), quota.period_of(quota.utc_now()))
    return UserList(users=[_user_out(u, logins.get(u.id), uses=uses.get(keys[u.id], 0)) for u in rows])


@router.patch("/admin/users/{user_id}", response_model=UserOut)
def admin_update_user(
    user_id: int,
    body: UserUpdate,
    db: Session = Depends(get_db),
    _admin: User = Depends(admin_user),
) -> UserOut:
    """Deactivate (revoke) / reactivate / rename a user, allow Gmail, or set the
    plan. Admin accounts can't be deactivated — that would lock the owner out.

    `email` is a free contact label ONLY for an account with no sign-in row (an
    invite code, or the admin before any login was attached). For an account
    that signs in with an address, `users.email` mirrors `user_logins.email` —
    signup, Google signup and change-email all write both — so the only values
    accepted are that address (in any case or spacing: it is stored in the
    login's one spelling, which also heals a drifted label) or the label's
    current value (a client sending the list's own row back). Anything else is a
    400 (P29-ADMIN-EMAIL). Moving the sign-in address here would re-key the
    monthly pool at the next reserve, keep a "verified" mark on an address
    nobody proved, and hand /auth/forgot a mailbox the admin merely typed; a
    confirmed address has no move flow at all, and an unconfirmed one is fixed
    by its owner through /auth/change-email.
    """
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(404, "User not found.")
    # Phase 30 / B7: checked BEFORE anything is applied, so a bad plan never
    # half-applies the other fields sent beside it.
    if body.plan is not None and body.plan not in quota.PLANS:
        raise HTTPException(400, 'The plan must be "free" or "unlimited".')
    # P29-ADMIN-EMAIL: the email is judged here too, before anything is applied.
    # Compared through normalize_email — the spelling the unique index stores —
    # never quota.canonical_email, which would call a different Gmail spelling
    # "the same" although it is a different sign-in string.
    login = accounts_core.login_for(db, u.id) if body.email is not None else None
    heal_email: str | None = None
    if login is not None:
        sent = body.email.strip()
        if accounts_core.normalize_email(sent) == login.email:
            heal_email = login.email
        elif sent != (u.email or "").strip():
            raise HTTPException(
                400,
                "This account signs in with a confirmed email address, which can't be changed."
                if login.email_verified_at is not None
                else "This account signs in with an email address the admin can't change. Until it's "
                "confirmed, the user can fix it on the verify page.",
            )
    if body.is_active is not None:
        if u.is_admin and not body.is_active:
            raise HTTPException(400, "Can't deactivate an admin account.")
        u.is_active = body.is_active
        if not body.is_active:
            # Revoked, not merely filtered out by `is_active`: re-enabling the
            # account later must not bring back the cookies it had before.
            revoke_all(db, u.id)
    if body.name is not None:
        u.name = body.name.strip()
    if body.email is not None:
        if login is None:
            # No sign-in: users.email is only a label, and the pool is u:<id> whatever it says.
            u.email = body.email.strip()
        elif heal_email is not None:
            u.email = heal_email
        # Otherwise the value sent is the label's own, unchanged: nothing to write.
    if body.inbox_enabled is not None:
        # Phase 29 / B2 (O2): the Gmail allowlist. Enabling here is half of it —
        # while the Google app is in Testing, the account must also be one of its
        # test users, or Google's own consent page refuses it.
        u.inbox_enabled = body.inbox_enabled
    if body.plan is not None:
        # "unlimited" lifts the monthly limit only; the daily caps still apply.
        u.plan = body.plan
    db.commit()
    db.refresh(u)
    login = accounts_core.login_for(db, u.id)
    return _user_out(u, login, uses=_uses_this_month(db, u.id, login))


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
