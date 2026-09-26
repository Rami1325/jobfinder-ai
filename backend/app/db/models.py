"""ORM models for the application tracker."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import BigInteger, Boolean, DateTime, Float, Index, Integer, String, Text, UniqueConstraint
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
    # Resume preferences (spec 07 / R1): `ResumePrefs` JSON, "" = defaults (every
    # switch OFF). SENSITIVE — "leave Arabic off for jobs in Israel" implies the
    # user's ethnicity — so `_wipe_user_rows` clears it with the two above.
    # Migrates via the ADD-COLUMN shim.
    resume_prefs_json: Mapped[str] = mapped_column(Text, default="")
    # When this user last made an authenticated API request. Stamped by the
    # access-gate middleware, so it covers EVERY request — including the
    # deliberately uncapped deterministic routes (/tools/*, /render), which
    # write no `usage_log` row and were therefore invisible.
    #
    # NULLABLE, and the distinction is the whole point: NULL means NOT
    # MEASURED, never "never visited". The five invite codes minted before
    # this column existed would otherwise read as confirmed no-shows — the
    # same "a row that predates the field means unknown" rule the tracker's
    # voice_score/fabrication_flag_count columns are nullable for. Migrates
    # via the ADD-COLUMN shim in database.py.
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True, default=None
    )
    # How this account came to exist (Phase 29): "" = an invite code the admin
    # minted, or the admin itself; "email" = self-service signup. The "" DEFAULT
    # is load-bearing, not tidy: the ADD-COLUMN shim backfills every existing row
    # with it, and "" is what the access gate reads as verified-by-construction —
    # so on deploy the friends beta keeps working without anyone verifying
    # anything. A default of "email" would lock every one of them out.
    signup_source: Mapped[str] = mapped_column(String(16), default="")
    # "en" | "he": the language this account's auth mail is written in. "" =
    # unknown, which reads as English. Migrates via the shim like the above.
    locale: Mapped[str] = mapped_column(String(8), default="")
    # Phase 29 / B2: whether the admin let this account connect Gmail while
    # INBOX_ACCESS=allowlist (an admin always may). The shim backfills False,
    # and that is the point: Google's Testing mode admits only listed test
    # users, so an account nobody added must not be offered a button Google's
    # own consent page will refuse.
    inbox_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    # Phase 30 / B2: "free" is limited to FREE_MONTHLY_USES a month
    # (app/core/quota.py); "unlimited" has no monthly limit, though the daily caps
    # still apply. The admin is exempt whatever this says, and an unknown value
    # reads as "free", failing toward the limit. The "free" DEFAULT is the owner's
    # call: the ADD-COLUMN shim backfills it onto every existing row, the invite
    # codes included.
    plan: Mapped[str] = mapped_column(String(16), default="free")
    # `onboarded_at` (PLAN 31.1/11) left the model with the first-run questions
    # in PLAN 31.5/2: the first run is the upload now, and nothing asks. The
    # column the ADD-COLUMN shim made stays in production's table, unread and
    # unwritten, since the shim only ever adds.
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
    One row per (user, action, day); day is a UTC YYYY-MM-DD string.

    Token columns (PLAN 20.8 / N2) hold what the actions actually COST, not just
    how many there were: tailoring a 126-project master and writing a follow-up
    email are both "one action" and differ by orders of magnitude. Written under
    the reserved `action="tokens"` row so the count-based caps keep working
    untouched. Both migrate via the ADD-COLUMN shim, and a row that predates
    them reads 0 — which is honest here, unlike the nullable tracker columns:
    nothing was ever measured, so nothing was spent as far as this table knows.
    """

    __tablename__ = "usage_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True, default=None)
    action: Mapped[str] = mapped_column(String(32), default="")  # search | tailor | llm | tokens
    day: Mapped[str] = mapped_column(String(10), default="")
    count: Mapped[int] = mapped_column(Integer, default=0)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)


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
    # What was actually sent (PLAN 17.3). Without these the tracker can show
    # that a reply rate exists but never which resume earned it. All three are
    # nullable/"" on purpose: rows written before 17.3 genuinely do not know,
    # and counting an unknown as "guard-clean, voice 0" would poison the report.
    template: Mapped[str] = mapped_column(String(32), default="")
    voice_score: Mapped[float | None] = mapped_column(Float, nullable=True, default=None)
    fabrication_flag_count: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)
    # When the status last changed — powers stale-application nudges. Nullable
    # for the ADD-COLUMN shim; NULL rows fall back to created_at.
    status_changed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )
    # Phase 29 / B2, the inbox scanner. All four migrate via the ADD-COLUMN
    # shim, and empty means UNKNOWN on every one of them, never a value: a row
    # from before the scanner has no source, nobody recorded who last moved it,
    # and it has no date it was sent on.
    #
    # "email" when the inbox CREATED the row; "" for every other writer.
    source: Mapped[str] = mapped_column(String(16), default="")
    # Who made the LAST status change: "created" (POST /applications), "manual"
    # (a PATCH that changed it), "email" (the inbox). The inbox reads it: an
    # email older than a row someone else owns never quietly rewrites that row
    # (inbox_apply, rule 5).
    status_source: Mapped[str] = mapped_column(String(16), default="")
    # When the application was SENT. Set from a confirmation email's date, or by
    # a writer that moves the row to applied — never from a rejection or an
    # interview invite, neither of which proves when anything was sent.
    applied_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)
    # The newest email the inbox tied to this row.
    last_email_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)
    # PLAN 31.4, the job page. The posting's place and the date its board stated,
    # carried from where the job was found (a search result, a kit). "" when the
    # writer did not know: the page prints nothing for an unknown, never a guess.
    # `posted_at` keeps the board's string as `job_search_hits.posted_at` does.
    location: Mapped[str] = mapped_column(String(255), default="")
    posted_at: Mapped[str] = mapped_column(String(32), default="")
    # The analysed posting (a JDModel as JSON) from the fit check or tailor that
    # made this row's draft, or from the kit that did. The job page's "What they
    # ask for" reads it, and the cover letter is keyed by it, so viewing the page
    # never needs a model call. "" = no analysis was ever stored for this row.
    jd_json: Mapped[str] = mapped_column(Text, default="")
    # PLAN 31.4/4: the review behind the draft on this row, so the document can
    # open it again after a reload: the tailor's result, the resume it was
    # tailored from, the changes declined and the lines typed over it (JSON).
    # Written TOGETHER with `tailored_resume_json` and cleared whenever the draft
    # is written without one, so it always describes the draft beside it or is
    # "" (a draft whose review is unknown opens as a new tailor, never a stale one).
    review_json: Mapped[str] = mapped_column(Text, default="")


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
    # The earliest date a board stated for this role (`JobMatch.first_posted_at`),
    # min-merged as instants across every search that returned this URL, so the
    # History tab stops calling a relisted role "New" from this listing's own
    # date. "" on rows no search has written since the column arrived: unknown,
    # and the page then reads `posted_at` as it always did.
    first_posted_at: Mapped[str] = mapped_column(String(32), default="")
    source: Mapped[str] = mapped_column(String(32), default="linkedin")  # job board (PROVIDERS key)
    logo_url: Mapped[str] = mapped_column(String(1000), default="")  # company logo; "" when none
    # PLAN 15.1: the same posting on other boards, [{"source","url"}] JSON
    also_on_json: Mapped[str] = mapped_column(Text, default="[]")
    # sha256 of the resume the scores were computed against (PLAN 12.4) — lets a
    # re-search tell "same resume, reuse the scores" from "different resume,
    # rescore". "" on pre-12.4 rows (never treated as a full-reuse match).
    resume_hash: Mapped[str] = mapped_column(String(64), default="")
    searched_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )


class PostingSighting(Base):
    """When we first and last saw one posting — the app's market memory (PLAN 28.3).

    Nothing in this app could say how long a posting has REALLY been open, and
    `JobSearchHit` above is exactly why: it updates its row IN PLACE and bumps
    `searched_at` on every write, so the only date it ever holds is the most
    recent one; and it is capped at the newest 100 rows per user, so a posting
    that falls off that tail takes its whole history with it. This table
    outlives both — one row per (board, posting), `first_seen_at` written once
    and then left alone, trimmed only by a 180-day retention sweep.

    **NO `user_id`, deliberately — this is the one privacy decision in Phase 28.**
    A row here is metadata a BOARD published: which board, the title+company
    fingerprint, when we first and last saw it, its URLs, a count. It is not
    user content, nothing in it is derived from a resume, and several users
    searching the same market legitimately SHARE one row. It therefore does not
    belong in `routes._wipe_user_rows` and **must not be added there**: that
    helper deletes rows `WHERE model.user_id == user.id`, so a table with no
    such column cannot even be expressed in it — and wiping by any other key
    would destroy market memory that other users' searches wrote, while saying
    nothing whatsoever about the user who left. `jd_text`, the raw title and
    every other posting BODY field are absent for the same reason: the moment
    this table holds a description it is a content store with no owner.

    Created by `create_all`; no ADD-COLUMN shim entry is needed, because
    `_migrate_missing_columns` skips any table the inspector does not already
    have ("create_all handles brand-new tables") — the shim exists for columns
    added to tables that already exist in a live DB.

    Written and read by `app.db.sightings`, which owns the continuity rule that
    makes `first_seen_at` mean "since the start of the CURRENT run" rather than
    "the first time we ever saw this title at this company".
    """

    __tablename__ = "posting_sightings"
    # A posting is identified by (board, title+company fingerprint), never by
    # URL: boards mint a fresh listing id for a relisted role, which is the
    # `reposted` signal itself — keying on the URL would file the relist as a
    # brand-new posting and lose the very fact we are here to record.
    __table_args__ = (
        UniqueConstraint("source", "content_key", name="uq_posting_sightings_key"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source: Mapped[str] = mapped_column(String(32), default="", index=True)  # PROVIDERS key
    # app.core.job_search.content_key(title, company) — normalized title|company.
    # NEVER "" in a stored row: content_key returns "" when either half is
    # missing, and one shared "" row would fuse every keyless posting on a board
    # into a single sighting whose first_seen_at is the oldest of them. The skip
    # lives in db.sightings.record_sightings.
    content_key: Mapped[str] = mapped_column(String(255), default="", index=True)
    # The start of the CURRENT run, not of all time. A gap longer than
    # SIGHTING_GAP_DAYS resets this and bumps `relist_count`, so a role relisted
    # after a quiet quarter is never reported as "open 200 days".
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )
    # Deliberately NOT indexed: the retention sweep in `db.sightings` scans it
    # once per search, but the table is bounded at ~25 rows per searching user
    # per day for 180 days, so the scan is free and the index is one more thing
    # to keep true. Add it if this ever holds a market rather than a beta.
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )
    # The listing URL at the start of this run vs. the newest one. `reposted`
    # reads exactly this difference: same board, same title+company, new id.
    first_url: Mapped[str] = mapped_column(String(1000), default="")
    last_url: Mapped[str] = mapped_column(String(1000), default="")
    # How many searches have observed this posting during the current run — one
    # increment per search, not per result row.
    seen_count: Mapped[int] = mapped_column(Integer, default=1)
    # The earliest date the BOARD itself stated for this run ("" = it never
    # said, which is unknown and never "posted today"). Kept beside our own
    # first_seen_at because the two answer different questions: this is the
    # board's claim, ours is a lower bound from when someone first searched.
    first_posted_at: Mapped[str] = mapped_column(String(32), default="")
    # How many completed runs preceded this one, i.e. how often this exact role
    # has been taken down and put back up. 0 on a posting we have only ever
    # seen once.
    relist_count: Mapped[int] = mapped_column(Integer, default=0)


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
    # The cover letter last generated on the kit's review page. It lived in that
    # page's state alone, so a reload of /kits/:id lost a letter the user had paid
    # a use for. Written by PUT /kits/{id}/cover-letter and by approve, cleared by
    # a requeue with the rest of the run. "" for the ADD-COLUMN shim.
    cover_letter: Mapped[str] = mapped_column(Text, default="")
    # Phase 30 / B4.1: the batch charge that paid for this kit, and whether its
    # use already came back. NULL for a kit queued before Phase 30 and for an
    # exempt caller's kit, and a kit with no event is never refunded: it never paid.
    quota_event_id: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)
    quota_refunded: Mapped[bool] = mapped_column(Boolean, default=False)
    # Phase 30 review (COST-4): how many times a killed run of this kit has been
    # put back in the queue. A requeue never charges again (B4.1), so this count
    # is the only bound on re-running it; `kits._requeue_stuck` fails the kit and
    # gives its use back once the retries are spent, and a re-batch resets it to
    # 0. `default=0` so the ADD-COLUMN shim backfills 0, which is honest on a
    # legacy row: nothing had been counted there.
    attempts: Mapped[int] = mapped_column(Integer, default=0)
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
    context_json: Mapped[str] = mapped_column(Text, default="")  # SearchContext; "" = derive from resume
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)
    last_new_count: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str] = mapped_column(Text, default="")
    # The fit bar: a new posting is emailed only when its ROUNDED overall fit is
    # at least this (0 = email every new posting, the pre-bar behaviour). The
    # alert used to email everything the search returned, which on a good day is
    # 20 postings most of which the user would never open. Below-bar postings are
    # still RECORDED in history (see alerts.run_alert) — they are hidden from the
    # inbox, not from the app. Existing rows pick 75 up from the ADD COLUMN
    # DEFAULT, so this DOES change behaviour on deploy: that is the point, and
    # the card states the bar and lets it be changed or turned off.
    min_score: Mapped[int] = mapped_column(Integer, default=75)
    # Of `last_new_count`, how many cleared `min_score` — i.e. what the email
    # carried. Stored because without it the card says "12 new" on a morning
    # that sent no email, which reads as a broken alert.
    #
    # NULLABLE with no default, deliberately: a run that happened before the bar
    # existed never measured this, and a row that predates the field means
    # UNKNOWN, never zero. With `default=0` the ADD COLUMN shim backfills every
    # historical row with 0 and the card asserts "6 new jobs, 0 above your 75%
    # bar" about a morning that had no bar — seen on the real page, which is why
    # this is nullable. 0 stays a legitimate stored value ("6 new, none cleared
    # it"), so the two must not share a representation.
    last_above_min: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)
    # PLAN 11.4 — stale-application nudge emails. Opt-in lives here because the
    # row already holds the recipient address; independent of `enabled`.
    nudge_emails: Mapped[bool] = mapped_column(Boolean, default=False)
    last_nudge_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)
    # Phase 30 / B6: why the last scheduled morning did not run ("monthly_limit"),
    # "" when it ran. Only a "Last morning skipped" line reads it: whether the
    # alert is paused NOW is worked out from the pool when the card is read.
    last_skip: Mapped[str] = mapped_column(String(24), default="")


class SavedResumeVersion(Base):
    """A previous state of a master resume (PLAN 20.8 / N1).

    `PUT /profile/resume` overwrites `SavedResume` in place, so until this
    existed there was no undo for the single most valuable object a user owns —
    and the Builder autosaves, the Skills editor saves, and a re-upload
    replaces. One bad save was unrecoverable.

    A snapshot of the OUTGOING row is taken before each overwrite, so the
    newest version here is always the state just before the current one.
    Identical consecutive saves are skipped (see `db.resume_versions.snapshot`)
    and only the newest `MAX_VERSIONS` per (user, language) are kept — this is
    an undo buffer, not an archive.
    """

    __tablename__ = "saved_resume_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True, default=None)
    label: Mapped[str] = mapped_column(String(255), default="")
    language: Mapped[str] = mapped_column(String(8), default="en")
    resume_json: Mapped[str] = mapped_column(Text, default="")
    ledger_json: Mapped[str] = mapped_column(Text, default="")
    # When this content STOPPED being current, i.e. when it was superseded —
    # that is what the UI needs to label a restore point ("saved until …"),
    # and it is the snapshot time, not the original authoring time.
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )


class SavedResume(Base):
    """The user's persisted master resumes, reused across Tailor / Interview / Job Match.

    One row per (user, language) so a paired Hebrew/English master can coexist —
    saving a resume upserts the row matching its detected language, and tailoring
    picks the master matching the JD's language. The user's most-recently-updated
    row is their default master; `label` leaves room for multiple named resumes.
    """

    __tablename__ = "saved_resumes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True, default=None)
    label: Mapped[str] = mapped_column(String(255), default="My resume")
    language: Mapped[str] = mapped_column(String(8), default="en")  # "en" | "he"
    resume_json: Mapped[str] = mapped_column(Text, default="")
    ledger_json: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


# --------------------------------------------------------------------------- #
# Accounts (Phase 29 / B1): email sign-in beside the invite codes. All four are
# NEW tables, so `create_all` makes them WITH their unique constraints and
# indexes — the ADD-COLUMN shim cannot add either to a table that already
# exists, which is exactly why login identity is not a set of columns on `users`.
# --------------------------------------------------------------------------- #
class UserLogin(Base):
    """How a user signs in with an email address. At most one per user.

    Its own table because `users.email` cannot carry the constraint: it is
    non-unique, many friend rows hold "", and a UNIQUE declared on an existing
    column is silently ignored by the shim — Neon would get a non-unique column
    and two accounts could share one address. A legacy invite-code user simply
    has no row here.

    `email` is normalised (NFKC, stripped, lower-cased) before it is written, so
    the unique index is the one place "Maya@Example.com" and "maya@example.com"
    are the same person.
    """

    __tablename__ = "user_logins"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    # `scrypt$N$r$p$salt$dk` (app/core/passwords.py); "" = no password set.
    password_hash: Mapped[str] = mapped_column(Text, default="")
    # NULL until the address is proven. The gate refuses every feature to an
    # email signup while this is NULL (users.signup_source "" never needs it).
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)
    # Google's account id (`sub`), set when Continue with Google creates this
    # login or links it (Phase 30 / E3). A Google sign-in is resolved by it and
    # nothing else: an address that later changes at Google never re-keys it.
    google_sub: Mapped[str | None] = mapped_column(String(255), nullable=True, unique=True, default=None)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )
    password_changed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)


class AuthSession(Base):
    """One signed-in browser (app/core/sessions.py).

    The cookie carries a random token; this row stores only its sha256, so a
    leaked table cannot be replayed as cookies. Revoking is one column write,
    which is what makes logout, "sign out of other devices", a password reset
    and an account close real rather than cosmetic.
    """

    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )
    # Written at most every 12 h (sessions.RENEW_EVERY), not per request.
    last_used_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    user_agent: Mapped[str] = mapped_column(String(255), default="")
    # Deliberately coarse ("84.229.x.x"), never the address itself.
    ip_hint: Mapped[str] = mapped_column(String(64), default="")
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)


class AuthToken(Base):
    """A single-use secret mailed to an address: a verification code + link,
    or a password-reset link (app/core/accounts.py).

    Both secrets are stored hashed. `payload` records the address the token was
    SENT to, and consuming it requires that address to still be the account's —
    the rule that stops "sign up as me@, switch the address to victim@, enter
    the code I received at me@" from verifying an address nobody proved.
    """

    __tablename__ = "auth_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True, default=None)
    purpose: Mapped[str] = mapped_column(String(24), default="", index=True)  # verify_email | reset_password
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    # HMAC of the 6-digit code ("" for a link-only token). Keyed, because an
    # unkeyed hash of a million possible codes is not a hash at all.
    code_hash: Mapped[str] = mapped_column(String(64), default="")
    payload: Mapped[str] = mapped_column(Text, default="")  # JSON: {"email": ...}
    attempts: Mapped[int] = mapped_column(Integer, default=0)  # wrong codes against THIS token
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )


class AuthEvent(Base):
    """One auth attempt or action — the throttle counter AND the sign-in
    security log (app/core/auth_throttle.py).

    `key` is an HMAC of a normalised email ("em:…"), of an IP bucket ("ip:…"),
    or a user id ("u:…") — never a raw address. Rows outlive the account they
    describe on purpose: closing an account NULLs `user_id` rather than deleting
    rows keyed on an email or IP, or "close the account and sign up again"
    would reset every brute-force limit. Pruned after 30 days.
    """

    __tablename__ = "auth_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True, default=None)
    kind: Mapped[str] = mapped_column(String(32), default="", index=True)
    key: Mapped[str] = mapped_column(String(128), default="", index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc), index=True
    )


# --------------------------------------------------------------------------- #
# The Gmail inbox scanner (Phase 29 / B2). Both are NEW tables, so create_all
# makes them with their unique constraints; both hold user content, so both are
# wiped by `routes._wipe_user_rows`.
# --------------------------------------------------------------------------- #
class MailConnection(Base):
    """One user's connected mailbox (at most one per user).

    `refresh_token_enc` is the Google refresh token ENCRYPTED with
    INBOX_TOKEN_KEY (app/core/token_crypto.py) and never leaves the server: no
    response model carries it. "" for the demo mailbox, which has no grant.

    The import walks the mailbox in bounded windows from the OLDEST day forward
    (Phase 29 amendment I2), and two columns carry where it is:
    `window_lo_ms` is the start of the next unfinished window, and `cursor_ms`
    the internalDate below which every message has been handled. Both are epoch
    milliseconds, Gmail's own unit.
    """

    __tablename__ = "mail_connections"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    provider: Mapped[str] = mapped_column(String(16), default="gmail")  # gmail | fake
    email_address: Mapped[str] = mapped_column(String(320), default="")
    refresh_token_enc: Mapped[str] = mapped_column(Text, default="")
    scope: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="active")  # active | needs_reauth | error
    # A short CODE ("invalid_grant", "daily_limit"), translated client-side.
    last_error: Mapped[str] = mapped_column(Text, default="")
    connected_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)
    cursor_ms: Mapped[int] = mapped_column(BigInteger, default=0)
    window_lo_ms: Mapped[int] = mapped_column(BigInteger, default=0)
    backfill_days: Mapped[int] = mapped_column(Integer, default=60)
    auto_sync: Mapped[bool] = mapped_column(Boolean, default=True)
    scanned_total: Mapped[int] = mapped_column(Integer, default=0)
    events_total: Mapped[int] = mapped_column(Integer, default=0)
    # A lease, not a lock: set atomically when a sync starts and cleared when it
    # ends, so the cron and a "Sync now" tap cannot read the same messages twice
    # at once. It expires on its own, so a killed function never wedges a user.
    sync_lock_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, default=None)


class MailEvent(Base):
    """One job email the scanner recognised: the EXTRACTION, never the body.

    There is no body column and there must never be one — the body lives in
    memory for one classification and is gone. What is kept is what the tracker
    and the review sheet show: sender, date, the subject and Gmail's snippet
    (each clipped to 300), what the email is (`kind`), who and what it is about,
    and a verbatim quote of at most 200 characters that justified the verdict.
    Mail the scanner decided is NOT about a job is never stored at all.

    `action` is what the email did to the tracker, and every one of these is
    undoable or resolvable from the app: created | updated | linked | review |
    dismissed | undone. `prev_status` / `new_status` / `set_interviewed` are
    exactly what an Undo needs to put a card back.

    Three more actions are id-only markers the sync keeps for itself — the
    provider id and a code in `evidence`, never a subject, snippet, sender or
    company — and every reader and every action in the app ignores them, because
    each one works off an allow-list of the actions above: `failed` (FIXB B3: a
    message that failed once, charged; its retry is free), `skipped` (it failed
    twice and the import moved past it), and `parked` (P29-SPAM-RESCUE: job mail
    Gmail filed in Spam, never read; `evidence` is `spam` until a release of it
    has been charged, `received_at` is the listing's lower bound).
    """

    __tablename__ = "mail_events"
    __table_args__ = (
        UniqueConstraint("user_id", "provider_message_id", name="uq_mail_events_message"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    provider_message_id: Mapped[str] = mapped_column(String(64), default="")
    thread_id: Mapped[str] = mapped_column(String(64), default="")
    rfc822_id: Mapped[str] = mapped_column(String(255), default="")
    received_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )
    from_name: Mapped[str] = mapped_column(String(255), default="")
    from_email: Mapped[str] = mapped_column(String(320), default="")
    subject: Mapped[str] = mapped_column(String(300), default="")
    snippet: Mapped[str] = mapped_column(String(300), default="")
    kind: Mapped[str] = mapped_column(String(16), default="other")
    company: Mapped[str] = mapped_column(String(255), default="")
    job_title: Mapped[str] = mapped_column(String(255), default="")
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    method: Mapped[str] = mapped_column(String(8), default="rule")  # rule | llm
    interview_at: Mapped[str] = mapped_column(String(40), default="")
    evidence: Mapped[str] = mapped_column(String(300), default="")
    application_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True, default=None)
    action: Mapped[str] = mapped_column(String(16), default="")
    prev_status: Mapped[str] = mapped_column(String(32), default="")
    new_status: Mapped[str] = mapped_column(String(32), default="")
    set_interviewed: Mapped[bool] = mapped_column(Boolean, default=False)
    # Whether THIS email filled the card's `applied_at`, so an Undo can take the
    # date back out instead of leaving a "saved" card that says it was sent.
    set_applied_at: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )


# --------------------------------------------------------------------------- #
# Monthly uses (Phase 30 / B2, app/core/quota.py). Three NEW tables, so
# create_all makes them with their unique constraint and index. None of them
# holds user content (a keyed hash, a user id, a month, feature names, counts),
# and that is why neither privacy door touches them: a wipe or a close that
# reset the pool would make "Delete my data", or closing and signing up again, a
# free reset of the limit (the Phase 29 A7 rule). `quota.prune` deletes them once
# they are older than the previous month.
# --------------------------------------------------------------------------- #
class UsageMonth(Base):
    """How many uses one pool spent in one UTC month.

    Keyed by `quota_key`, never by user: a pool is a person (a keyed hash of the
    canonical sign-in address), so a closed account's successor on the same
    address finds the same row. `used` only moves through one conditional UPDATE
    each way, and always equals SUM(delta) of that month's ledger events.
    """

    __tablename__ = "usage_months"
    __table_args__ = (UniqueConstraint("quota_key", "period", name="uq_usage_months_key_period"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    quota_key: Mapped[str] = mapped_column(String(40), nullable=False)
    # The user whose write created the row. A plain column, not the key: the pool
    # outlives any one account.
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)
    period: Mapped[str] = mapped_column(String(7), default="")  # "YYYY-MM", UTC
    used: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )


class UsageEvent(Base):
    """The append-only ledger behind `usage_months.used`.

    `delta` is +n for a charge and -n for a refund or a fit-ride
    reclassification; `refunded` holds how many units of a charge already came
    back, which is what makes a refund happen at most once. The breakdown
    /auth/me shows is SUM(delta) GROUP BY feature for one pool and month.
    """

    __tablename__ = "usage_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True, default=None)
    quota_key: Mapped[str] = mapped_column(String(40), default="", index=True)
    period: Mapped[str] = mapped_column(String(7), default="")
    feature: Mapped[str] = mapped_column(String(24), default="")
    delta: Mapped[int] = mapped_column(Integer, default=0)
    refunded: Mapped[int] = mapped_column(Integer, default=0)
    # "" for a charge, "refund:<event id>" (":kit:<kit id>" added for a kit) for a
    # refund, "ride:<pass id>" for a fit ride's reclassification.
    ref: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )


class UsagePass(Base):
    """A session pass: one use covering a run of calls (interview practice,
    screening answers, a cover letter's changes), or a fit check's one-tailor
    ride (`feature = "tailor_after_fit"`).

    Per USER, while the use that opened it is charged to the pool. `calls` bounds
    the calls MADE, failed ones included; `succeeded`, `failed` and
    `opener_failed` decide whether a pass on which nothing was served gets its
    use back (quota.pass_charged).
    """

    __tablename__ = "usage_passes"
    __table_args__ = (Index("ix_usage_passes_lookup", "user_id", "feature", "ref", "expires_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True, default=None)
    feature: Mapped[str] = mapped_column(String(24), default="")
    # "" for interview practice and screening answers; the analysed JD's hash for a
    # cover letter and a fit ride, which each belong to one posting.
    ref: Mapped[str] = mapped_column(String(64), default="")
    opened_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    calls: Mapped[int] = mapped_column(Integer, default=0)
    max_calls: Mapped[int] = mapped_column(Integer, default=1)
    event_id: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)
    succeeded: Mapped[int] = mapped_column(Integer, default=0)
    failed: Mapped[int] = mapped_column(Integer, default=0)
    opener_failed: Mapped[bool] = mapped_column(Boolean, default=False)
