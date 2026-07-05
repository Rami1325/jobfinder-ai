"""ORM models for the application tracker."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.database import Base


class User(Base):
    """A beta user (PLAN 7). No signup UI: the admin mints per-friend invite
    codes and each `X-App-Key` header resolves to one of these rows. The
    `APP_ACCESS_CODE` env var stays the admin's own code (synced on startup),
    so the pre-multi-user deployment keeps working unchanged.
    """

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    email: Mapped[str] = mapped_column(String(320), default="")
    invite_code: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )


class Feedback(Base):
    """In-app tester feedback (PLAN 7.0) — the whole point of the friends beta."""

    __tablename__ = "feedback"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True, default=None)
    page: Mapped[str] = mapped_column(String(255), default="")
    text: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )


class UsageLog(Base):
    """Per-user per-day action counters (PLAN 7.4) backing the daily cost caps.
    One row per (user, action, day); day is a UTC YYYY-MM-DD string."""

    __tablename__ = "usage_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True, default=None)
    action: Mapped[str] = mapped_column(String(32), default="")  # search | tailor
    day: Mapped[str] = mapped_column(String(10), default="")
    count: Mapped[int] = mapped_column(Integer, default=0)


class Application(Base):
    __tablename__ = "applications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # Nullable for the ADD-COLUMN shim on pre-multi-user DBs; init_db backfills
    # NULLs to the admin user, and every code path sets it explicitly.
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True, default=None)
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
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True, default=None)
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
    logo_url: Mapped[str] = mapped_column(String(1000), default="")  # company logo; "" when none
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


class JobAlert(Base):
    """Job-alert settings (one row per user): re-run the saved search on a
    schedule and email newly seen hits. The schedule itself lives in Vercel
    cron (or a manual "Run now"); the daily cron iterates every enabled row.
    This row holds the toggle, recipient, optional search context override,
    and the last run's outcome for the UI."""

    __tablename__ = "job_alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True, default=None)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    email: Mapped[str] = mapped_column(String(320), default="")
    context_json: Mapped[str] = mapped_column(Text, default="")  # SearchContext; "" = derive from résumé
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)
    last_new_count: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str] = mapped_column(Text, default="")


class SavedResume(Base):
    """The user's persisted master résumés, reused across Tailor / Interview / Job Match.

    One row per (user, language) so a paired Hebrew/English master can coexist —
    saving a résumé upserts the row matching its detected language, and tailoring
    picks the master matching the JD's language. The user's most-recently-updated
    row is their default master; `label` leaves room for multiple named résumés.
    """

    __tablename__ = "saved_resumes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True, default=None)
    label: Mapped[str] = mapped_column(String(255), default="My résumé")
    language: Mapped[str] = mapped_column(String(8), default="en")  # "en" | "he"
    resume_json: Mapped[str] = mapped_column(Text, default="")
    ledger_json: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
