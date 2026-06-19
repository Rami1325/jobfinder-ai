"""Pydantic schemas shared across the app."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


# --------------------------------------------------------------------------- #
# Resume
# --------------------------------------------------------------------------- #
class Contact(BaseModel):
    name: str = ""
    email: str = ""
    phone: str = ""
    location: str = ""
    linkedin: str = ""
    website: str = ""


class Experience(BaseModel):
    company: str = ""
    title: str = ""
    location: str = ""
    start_date: str = ""
    end_date: str = ""
    bullets: list[str] = Field(default_factory=list)


class Education(BaseModel):
    institution: str = ""
    degree: str = ""
    field: str = ""
    start_date: str = ""
    end_date: str = ""
    details: str = ""


class Project(BaseModel):
    name: str = ""
    description: str = ""
    bullets: list[str] = Field(default_factory=list)


class ResumeModel(BaseModel):
    contact: Contact = Field(default_factory=Contact)
    summary: str = ""
    skills: list[str] = Field(default_factory=list)
    experience: list[Experience] = Field(default_factory=list)
    education: list[Education] = Field(default_factory=list)
    projects: list[Project] = Field(default_factory=list)
    certifications: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Job description
# --------------------------------------------------------------------------- #
class JDModel(BaseModel):
    job_title: str = ""
    company: str = ""
    seniority: str = ""
    hard_skills: list[str] = Field(default_factory=list)
    soft_skills: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    responsibilities: list[str] = Field(default_factory=list)
    qualifications: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Facts ledger (anti-fabrication)
# --------------------------------------------------------------------------- #
class FactsLedger(BaseModel):
    employers: list[str] = Field(default_factory=list)
    titles: list[str] = Field(default_factory=list)
    dates: list[str] = Field(default_factory=list)
    institutions: list[str] = Field(default_factory=list)
    degrees: list[str] = Field(default_factory=list)
    certifications: list[str] = Field(default_factory=list)
    numbers: list[str] = Field(default_factory=list)


class FabricationFlag(BaseModel):
    category: str  # employer | title | date | credential | number
    value: str
    detail: str = ""


# --------------------------------------------------------------------------- #
# Scoring
# --------------------------------------------------------------------------- #
class GapItem(BaseModel):
    keyword: str
    status: str  # covered | partial | missing
    suggestion: str = ""


class Score(BaseModel):
    keyword_coverage: float = 0.0  # 0-100
    fit_score: float = 0.0  # 0-100 (LLM holistic)
    overall: float = 0.0  # 0-100 combined
    rationale: str = ""
    gaps: list[GapItem] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Tailoring
# --------------------------------------------------------------------------- #
class ChangeLogEntry(BaseModel):
    section: str
    change: str
    reason: str = ""


class TailorResult(BaseModel):
    tailored_resume: ResumeModel
    changelog: list[ChangeLogEntry] = Field(default_factory=list)
    covered_keywords: list[str] = Field(default_factory=list)
    fabrication_flags: list[FabricationFlag] = Field(default_factory=list)
    score_before: Score = Field(default_factory=Score)
    score_after: Score = Field(default_factory=Score)


# --------------------------------------------------------------------------- #
# API request/response bodies
# --------------------------------------------------------------------------- #
class JDAnalyzeRequest(BaseModel):
    jd_text: str


class TailorRequest(BaseModel):
    resume: ResumeModel
    jd: JDModel


class CoverLetterRequest(BaseModel):
    resume: ResumeModel
    jd: JDModel
    tone: str = "professional"


class CoverLetterResponse(BaseModel):
    cover_letter: str


class RenderRequest(BaseModel):
    resume: ResumeModel
    fmt: str = "docx"  # docx | pdf


class ResumeUploadResponse(BaseModel):
    resume: ResumeModel
    ledger: FactsLedger


# --------------------------------------------------------------------------- #
# Application tracker
# --------------------------------------------------------------------------- #
class ApplicationCreate(BaseModel):
    job_title: str = ""
    company: str = ""
    jd_text: str = ""
    tailored_resume: Optional[ResumeModel] = None
    cover_letter: str = ""
    overall_score: float = 0.0
    status: str = "saved"  # saved | applied | interview | offer | rejected


class ApplicationUpdate(BaseModel):
    status: Optional[str] = None
    notes: Optional[str] = None


class ApplicationOut(BaseModel):
    id: int
    job_title: str
    company: str
    overall_score: float
    status: str
    notes: str = ""
    created_at: str


class ApplicationDetail(BaseModel):
    id: int
    job_title: str
    company: str
    jd_text: str = ""
    tailored_resume: Optional[ResumeModel] = None
    cover_letter: str = ""
    overall_score: float
    status: str
    notes: str = ""
    created_at: str
