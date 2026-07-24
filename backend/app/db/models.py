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
    # Saved "Customize search" picks (SearchContext JSON; "" = none saved) so
    # the Jobs page prefills the panel on the next visit. Migrates onto
    # pre-existing tables via the ADD-COLUMN shim in database.py.
    search_prefs_json: Mapped[str] = mapped_column(Text, default="")
    # Writing-profile feedback loop (CV humanization spec §26): JSON list of
    # phrases this user rejected in the per-bullet review, fed to the TAILOR
    # prompt as an avoid-list. Learned only from explicit user decisions.
    # "" = none. Migrates via the ADD-COLUMN shim.
    writing_prefs_json: Mapped[str] = mapped_column(Text, default="")
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
    # When the status last changed — powers stale-application nudges. Nullable
    # for the ADD-COLUMN shim; NULL rows fall back to created_at.
    status_changed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)
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
    top_matched_json: Mapped[str] = mapped_column(Text, default="[]")
    jd_text: Mapped[str] = mapped_column(Text, default="")
    posted_at: Mapped[str] = mapped_column(String(32), default="")  # ISO date; "" when unknown
    source: Mapped[str] = mapped_column(String(32), default="linkedin")  # job board (PROVIDERS key)
    logo_url: Mapped[str] = mapped_column(String(1000), default="")  # company logo; "" when none
    # PLAN 15.1: the same posting on other boards, [{"source","url"}] JSON
    also_on_json: Mapped[str] = mapped_column(Text, default="[]")
    # sha256 of the résumé the scores were computed against (PLAN 12.4) — lets a
    # re-search tell "same résumé, reuse the scores" from "different résumé,
    # rescore". "" on pre-12.4 rows (never treated as a full-reuse match).
    resume_hash: Mapped[str] = mapped_column(String(64), default="")
    searched_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )


class TailorKit(Base):
    """A batch auto-tailor job → one reviewable "application kit" (PLAN 8.1).

    Enqueued from high-fit search results, processed one per request by
    POST /kits/process-next (client-driven sequential loop — each run fits a
    serverless invocation), reviewed in the 8.2 kits queue. `result_json` is a
    full TailorResult; `flag_count` > 0 means the fabrication guard flagged
    the tailor and the kit must never be auto-approvable.

    Review (PLAN 8.2): approving a "done" kit creates a tracker Application
    ("ready to send") and links it via `application_id`; rejecting records
    `reject_reason` so thresholds can be tuned from real review decisions.

    Auto-submit (PLAN 8.4): an approved, guard-clean Comeet kit can be sent
    through Comeet's public apply API — status becomes "submitted",
    `submitted_at` stamps it, and `submit_note` keeps the company's follow-up
    questionnaire URL when one is returned.
    """

    __tablename__ = "tailor_kits"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True, default=None)
    status: Mapped[str] = mapped_column(
        String(16), default="queued"
    )  # queued | running | done | failed | approved | rejected | submitted
    job_title: Mapped[str] = mapped_column(String(255), default="")
    company: Mapped[str] = mapped_column(String(255), default="")
    location: Mapped[str] = mapped_column(String(255), default="")
    url: Mapped[str] = mapped_column(String(1000), default="", index=True)
    source: Mapped[str] = mapped_column(String(32), default="linkedin")
    logo_url: Mapped[str] = mapped_column(String(1000), default="")
    posted_at: Mapped[str] = mapped_column(String(32), default="")
    jd_text: Mapped[str] = mapped_column(Text, default="")
    search_overall: Mapped[float] = mapped_column(Float, default=0.0)  # fit at enqueue time
    base_resume_json: Mapped[str] = mapped_column(Text, default="")  # master the tailor ran on
    base_language: Mapped[str] = mapped_column(String(8), default="")  # which master slot was used
    jd_json: Mapped[str] = mapped_column(Text, default="")  # analyzed JDModel
    result_json: Mapped[str] = mapped_column(Text, default="")  # TailorResult
    # Denormalized from result_json so the kit list renders without parsing
    # every TailorResult; meaningful only when status == done.
    score_before: Mapped[float] = mapped_column(Float, default=0.0)
    score_after: Mapped[float] = mapped_column(Float, default=0.0)
    flag_count: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str] = mapped_column(Text, default="")
    # Review outcome (PLAN 8.2). Nullable/default-empty for the ADD-COLUMN shim.
    reject_reason: Mapped[str] = mapped_column(Text, default="")
    application_id: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)
    # Auto-submit outcome (PLAN 8.4). Nullable/default-empty for the shim.
    submit_note: Mapped[str] = mapped_column(Text, default="")
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)


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


class GreenhouseCompany(Base):
    """A company whose public Greenhouse job board the job search queries.

    Same registry pattern as `ComeetCompany`, but simpler: the boards API
    (`boards-api.greenhouse.io/v1/boards/<slug>/jobs`) needs no token at all.
    Seeded with live-verified Israeli tech companies on first use (see
    app/core/providers/greenhouse_seed.py); users add more via
    POST /jobs/greenhouse/companies with a board slug or careers URL.
    """

    __tablename__ = "greenhouse_companies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    slug: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255), default="")
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
    # PLAN 11.4 — stale-application nudge emails. Opt-in lives here because the
    # row already holds the recipient address; independent of `enabled`.
    nudge_emails: Mapped[bool] = mapped_column(Boolean, default=False)
    last_nudge_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)


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
