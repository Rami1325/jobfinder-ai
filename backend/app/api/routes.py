"""FastAPI routes wiring the pipeline together."""
from __future__ import annotations

import io

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.cover_letter import generate_cover_letter
from app.core.jd_analyzer import analyze_jd
from app.core.tailor import tailor_resume
from app.db.database import get_db
from app.db.models import Application
from app.models import (
    ApplicationCreate,
    ApplicationDetail,
    ApplicationOut,
    ApplicationUpdate,
    CoverLetterRequest,
    CoverLetterResponse,
    JDAnalyzeRequest,
    JDModel,
    RenderRequest,
    ResumeModel,
    ResumeUploadResponse,
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
