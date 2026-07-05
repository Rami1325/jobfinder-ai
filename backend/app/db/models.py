"""ORM models for the application tracker."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.database import Base


class Application(Base):
    __tablename__ = "applications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_title: Mapped[str] = mapped_column(String(255), default="")
    company: Mapped[str] = mapped_column(String(255), default="")
    jd_text: Mapped[str] = mapped_column(Text, default="")
    tailored_resume_json: Mapped[str] = mapped_column(Text, default="")
    cover_letter: Mapped[str] = mapped_column(Text, default="")
    overall_score: Mapped[float] = mapped_column(Float, default=0.0)
    status: Mapped[str] = mapped_column(String(50), default="saved")
    notes: Mapped[str] = mapped_column(Text, default="")
    job_url: Mapped[str] = mapped_column(String(1000), default="")
    interviewed: Mapped[bool] = mapped_column(Boolean, default=False)
    excitement: Mapped[int] = mapped_column(Integer, default=0)  # 0 = unrated, 1-5 stars
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )


class JobSearchHit(Base):
    """A job surfaced by the job search, persisted as browsable history.

    Deduped by URL (re-searching refreshes the row) and capped at the newest 100
    by `app.db.history.record_search_hits`.
    """

    __tablename__ = "job_search_hits"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(255), default="")
    company: Mapped[str] = mapped_column(String(255), default="")
    location: Mapped[str] = mapped_column(String(255), default="")
    url: Mapped[str] = mapped_column(String(1000), default="", index=True)
    overall: Mapped[float] = mapped_column(Float, default=0.0)
    keyword_coverage: Mapped[float] = mapped_column(Float, default=0.0)
    fit_score: Mapped[float] = mapped_column(Float, default=0.0)
    top_gaps_json: Mapped[str] = mapped_column(Text, default="[]")
    jd_text: Mapped[str] = mapped_column(Text, default="")
    posted_at: Mapped[str] = mapped_column(String(32), default="")  # ISO date; "" when unknown
    source: Mapped[str] = mapped_column(String(32), default="linkedin")  # job board (PROVIDERS key)
    searched_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )


class ComeetCompany(Base):
    """A company whose Comeet careers board the job search queries.

    Seeded with Israeli tech companies on first use (see
    app/core/providers/comeet_seed.py); users add more via
    POST /jobs/comeet/companies with any Comeet careers-page URL. `token` is
    scraped from the careers page lazily and refreshed automatically when
    Comeet rotates it (the API answers 401/403).
    """

    __tablename__ = "comeet_companies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    slug: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    uid: Mapped[str] = mapped_column(String(16), default="")  # company_uid, e.g. "E2.00D"
    token: Mapped[str] = mapped_column(String(64), default="")  # "" until first scrape
    careers_url: Mapped[str] = mapped_column(String(500), default="")
    added_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )


class SavedResume(Base):
    """The user's persisted master résumé, reused across Tailor / Interview / Job Match.

    Single-user today (the most-recently-updated row is treated as the master), but
    carries a `label` so multiple named résumés — and a future `user_id` — slot in cleanly.
    """

    __tablename__ = "saved_resumes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    label: Mapped[str] = mapped_column(String(255), default="My résumé")
    resume_json: Mapped[str] = mapped_column(Text, default="")
    ledger_json: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
