"""FastAPI routes wiring the pipeline together."""
from __future__ import annotations

import io
import json

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.ats_scan import scan_resume
from app.core.cover_letter import generate_cover_letter
from app.core.follow_up import write_follow_up
from app.core.interview import answer_feedback, generate_questions, model_answer
from app.core.jd_analyzer import analyze_jd
from app.core.job_match import fetch_job_text, match_jobs
from app.core.job_search import derive_search_context, search_jobs
from app.core.linkedin import optimize_linkedin
from app.core.tailor import tailor_resume
from app.db.database import get_db
from app.db.history import (
    application_statuses,
    clear_search_hits,
    delete_search_hit,
    list_search_hits,
    record_search_hits,
)
from app.db.models import Application, SavedResume
from app.models import (
    ApplicationCreate,
    ApplicationDetail,
    ApplicationOut,
    ApplicationUpdate,
    ATSScanRequest,
    ATSScanResult,
    CoverLetterRequest,
    CoverLetterResponse,
    FactsLedger,
    FollowUpRequest,
    FollowUpResult,
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
    LinkedInRequest,
    LinkedInResult,
    MasterResumeIn,
    MasterResumeOut,
    RenderRequest,
    ResumeModel,
    ResumeUploadResponse,
    SearchContext,
    SearchContextRequest,
    TailorRequest,
    TailorResult,
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
def tailor(body: TailorRequest) -> TailorResult:
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
        content = render_pdf(body.resume)
        media = "application/pdf"
        filename = "resume.pdf"
    elif fmt == "docx":
        content = render_docx(body.resume)
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
def jobs_search(body: JobSearchRequest, db: Session = Depends(get_db)) -> JobSearchResult:
    try:
        result = search_jobs(body.resume, body.customize)
    except ValueError as e:  # user-facing scrape/search problems
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Error while searching jobs: {e}")
    try:  # history persistence is best-effort — never fail the search because of it
        record_search_hits(db, result.matches)
    except Exception:  # noqa: BLE001
        pass
    return result


@router.get("/jobs/history", response_model=JobSearchHistory)
def jobs_history(db: Session = Depends(get_db)) -> JobSearchHistory:
    rows = list_search_hits(db)
    statuses = application_statuses(db, [row.url for row in rows])
    hits: list[JobSearchHitOut] = []
    for row in rows:
        try:
            top_gaps = json.loads(row.top_gaps_json) if row.top_gaps_json else []
        except Exception:  # noqa: BLE001 - tolerate legacy/corrupt rows
            top_gaps = []
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
                top_gaps=top_gaps,
                jd_text=row.jd_text,
                posted_at=row.posted_at or "",
                source=row.source or "linkedin",
                searched_at=row.searched_at.isoformat() if row.searched_at else "",
                app_status=statuses.get(row.url, ""),
            )
        )
    return JobSearchHistory(hits=hits)


@router.delete("/jobs/history/{hit_id}")
def delete_jobs_history_item(hit_id: int, db: Session = Depends(get_db)) -> dict[str, bool]:
    if not delete_search_hit(db, hit_id):
        raise HTTPException(404, "History item not found.")
    return {"deleted": True}


@router.delete("/jobs/history")
def clear_jobs_history(db: Session = Depends(get_db)) -> dict[str, int]:
    return {"deleted": clear_search_hits(db)}


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
# Master résumé (persisted, reused across Tailor / Interview / Job Match)
# --------------------------------------------------------------------------- #
def _master_row(db: Session) -> SavedResume | None:
    return db.execute(
        select(SavedResume).order_by(SavedResume.updated_at.desc())
    ).scalars().first()


@router.get("/profile/resume", response_model=MasterResumeOut | None)
def get_master_resume(db: Session = Depends(get_db)) -> MasterResumeOut | None:
    row = _master_row(db)
    if not row or not row.resume_json:
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
        updated_at=row.updated_at.isoformat() if row.updated_at else "",
    )


@router.put("/profile/resume", response_model=MasterResumeOut)
def save_master_resume(body: MasterResumeIn, db: Session = Depends(get_db)) -> MasterResumeOut:
    row = _master_row(db)
    if row is None:
        row = SavedResume()
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
        created_at=app.created_at.isoformat() if app.created_at else "",
    )


@router.get("/applications", response_model=list[ApplicationOut])
def list_applications(db: Session = Depends(get_db)) -> list[ApplicationOut]:
    rows = db.execute(select(Application).order_by(Application.created_at.desc())).scalars().all()
    return [_to_out(r) for r in rows]


@router.get("/applications/{app_id}", response_model=ApplicationDetail)
def get_application(app_id: int, db: Session = Depends(get_db)) -> ApplicationDetail:
    app = db.get(Application, app_id)
    if not app:
        raise HTTPException(404, "Application not found.")
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
        created_at=app.created_at.isoformat() if app.created_at else "",
    )


@router.post("/applications", response_model=ApplicationOut)
def create_application(body: ApplicationCreate, db: Session = Depends(get_db)) -> ApplicationOut:
    app = Application(
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
def update_application(app_id: int, body: ApplicationUpdate, db: Session = Depends(get_db)) -> ApplicationOut:
    app = db.get(Application, app_id)
    if not app:
        raise HTTPException(404, "Application not found.")
    if body.status is not None:
        app.status = body.status
    if body.notes is not None:
        app.notes = body.notes
    if body.interviewed is not None:
        app.interviewed = body.interviewed
    db.commit()
    db.refresh(app)
    return _to_out(app)


@router.delete("/applications/{app_id}")
def delete_application(app_id: int, db: Session = Depends(get_db)) -> dict[str, bool]:
    app = db.get(Application, app_id)
    if not app:
        raise HTTPException(404, "Application not found.")
    db.delete(app)
    db.commit()
    return {"deleted": True}
