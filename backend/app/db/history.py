"""Persistence helpers for the job-search history (job_search_hits).

All reads/writes are scoped to one user (PLAN 7.2): history is personal,
dedupe is per (user, url), and the newest-100 cap applies per user.
"""
from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from typing import NamedTuple

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core import applied_jobs
from app.core.applied_jobs import APPLIED_STATUSES, AppliedJobs
from app.core.job_search import CachedScore
from app.core.posting_keys import url_key as _url_key
from app.db.models import Application, JobSearchHit
from app.db.sightings import _replaces as _earlier_board_date
from app.models import Applicants, JobMatch

MAX_HISTORY = 100  # newest rows kept per user; older ones are trimmed on every record
CACHE_TTL_DAYS = 7  # history rows older than this are never reused (postings change/expire)


def record_search_hits(
    db: Session, matches: list[JobMatch], user_id: int, resume_hash: str = ""
) -> None:
    """Upsert scraped matches into the user's history (deduped by URL), then
    trim that user's rows to MAX_HISTORY. `resume_hash` identifies the resume
    the scores were computed against (see load_score_cache)."""
    now = datetime.now(timezone.utc)
    pending: dict[str, JobSearchHit] = {}  # dedupe within this batch (session has autoflush=False)
    for m in matches:
        if not m.url:
            continue  # pasted listings have no URL to dedupe/re-open by
        row = pending.get(m.url) or db.execute(
            select(JobSearchHit).where(
                JobSearchHit.url == m.url, JobSearchHit.user_id == user_id
            )
        ).scalars().first()
        if row is None:
            row = JobSearchHit(url=m.url, user_id=user_id)
            db.add(row)
        pending[m.url] = row
        row.title = m.title
        row.company = m.company
        row.location = m.location
        row.overall = m.overall
        row.keyword_coverage = m.keyword_coverage
        row.fit_score = m.fit_score
        row.top_gaps_json = json.dumps(m.top_gaps)
        row.top_matched_json = json.dumps(m.top_matched)
        row.jd_text = m.jd_text
        row.posted_at = m.posted_at
        # Min-merged, never overwritten: a later search that no longer sees the
        # earlier listing sends first_posted_at == posted_at, and this row must
        # not forget a date a board once stated for the role. Compared as
        # instants through the one parser, like `posting_sightings.first_posted_at`.
        stated = m.first_posted_at or m.posted_at
        if _earlier_board_date(stated, row.first_posted_at or ""):
            row.first_posted_at = stated
        row.source = m.source
        row.logo_url = m.logo_url
        row.also_on_json = json.dumps([a.model_dump() for a in m.also_on])
        # Replaced when this search carries a reading, and LEFT ALONE when it
        # carries none: a search that could not read the line (a cached rebuild,
        # a markup change) says nothing about the count, and the stored reading
        # stops being shown on its own once it is a day old.
        if m.applicants is not None and m.applicants.read_at:
            row.applicants_json = m.applicants.model_dump_json()
        # The same rule for the employment type (2026-09-28): a label replaces the
        # stored one; a search that read none (a cached rebuild) leaves it.
        if m.employment:
            row.employment = m.employment
        row.resume_hash = resume_hash
        row.searched_at = now
    db.flush()
    keep_ids = db.execute(
        select(JobSearchHit.id)
        .where(JobSearchHit.user_id == user_id)
        .order_by(JobSearchHit.searched_at.desc(), JobSearchHit.id.desc())
        .limit(MAX_HISTORY)
    ).scalars().all()
    db.execute(
        delete(JobSearchHit).where(
            JobSearchHit.user_id == user_id, JobSearchHit.id.not_in(keep_ids)
        )
    )
    db.commit()


def list_search_hits(db: Session, user_id: int) -> list[JobSearchHit]:
    """The user's newest-first history, at most MAX_HISTORY rows."""
    return list(
        db.execute(
            select(JobSearchHit)
            .where(JobSearchHit.user_id == user_id)
            .order_by(JobSearchHit.searched_at.desc(), JobSearchHit.id.desc())
            .limit(MAX_HISTORY)
        ).scalars().all()
    )


def load_score_cache(
    db: Session, user_id: int, current_resume_hash: str
) -> dict[str, CachedScore]:
    """The user's reusable history rows for `search_jobs(cache=...)` (PLAN 12.4).

    Keyed by the search's own URL-dedupe key (`url.rstrip("/")`). Only fresh
    rows (searched_at within CACHE_TTL_DAYS) with a non-empty jd_text qualify;
    freshness is decided HERE so core never has to reason about TTLs. A row is
    a full match (scores reusable, not just text) only when it was scored
    against the current resume — pre-12.4 rows have resume_hash "" and never
    fully match. At most MAX_HISTORY rows exist per user, so this is one small
    read per search.
    """
    # searched_at is written as datetime.now(timezone.utc) into a naive DateTime
    # column, so rows read back naive-UTC (both SQLite and Neon); compare
    # against a naive-UTC cutoff and normalize the odd aware value defensively.
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=CACHE_TTL_DAYS)
    cache: dict[str, CachedScore] = {}
    for row in list_search_hits(db, user_id):
        if not (row.jd_text or "").strip() or not row.url:
            continue
        searched = row.searched_at
        if searched is None:
            continue
        if searched.tzinfo is not None:
            searched = searched.astimezone(timezone.utc).replace(tzinfo=None)
        if searched < cutoff:
            continue  # stale — the posting may have changed or expired
        cache[row.url.rstrip("/")] = CachedScore(
            jd_text=row.jd_text,
            overall=row.overall,
            keyword_coverage=row.keyword_coverage,
            fit_score=row.fit_score,
            top_matched=tuple(_json_list(row.top_matched_json)),
            top_gaps=tuple(_json_list(row.top_gaps_json)),
            title=row.title or "",
            company=row.company or "",
            location=row.location or "",
            posted_at=row.posted_at or "",
            logo_url=row.logo_url or "",
            is_full_match=bool(row.resume_hash) and row.resume_hash == current_resume_hash,
            applicants=applicants_of(row.applicants_json),
            employment=row.employment or "",
        )
    return cache


def applicants_of(raw: str | None) -> Applicants | None:
    """A row's stored competition line (Phase 32), or None for "" and for
    anything that no longer parses (unknown, never a number). Not filtered for
    currency here: every reader passes it through
    `job_search.current_applicants` with its own clock."""
    if not raw:
        return None
    try:
        return Applicants.model_validate_json(raw)
    except Exception:  # noqa: BLE001 - tolerate a corrupt or legacy value
        return None


def hit_for_url(db: Session, user_id: int, url: str) -> JobSearchHit | None:
    """The newest history row of the posting at `url`, for a job's own page:
    matched the way the tracker and History already match each other
    (`_url_key`: the LinkedIn id across hosts and slugs, else the bare URL).
    Read-only, one small query (at most MAX_HISTORY rows), no fetch."""
    key = _url_key(url or "")
    if not key:
        return None
    for row in list_search_hits(db, user_id):
        if row.url and _url_key(row.url) == key:
            return row
    return None


def applicants_for_url(db: Session, user_id: int, url: str) -> Applicants | None:
    """The competition line this user's search history holds for the posting at
    `url` (Phase 32), from `hit_for_url`'s row."""
    row = hit_for_url(db, user_id, url)
    return applicants_of(row.applicants_json) if row is not None else None


def employment_for_url(db: Session, user_id: int, url: str) -> str:
    """The board's employment type this user's search history holds for the
    posting at `url` (2026-09-28), from `hit_for_url`'s row; "" for none."""
    row = hit_for_url(db, user_id, url)
    return (row.employment or "") if row is not None else ""


def _json_list(raw: str | None) -> list[str]:
    try:
        data = json.loads(raw) if raw else []
    except Exception:  # noqa: BLE001 - tolerate legacy/corrupt rows
        return []
    return data if isinstance(data, list) else []


# Applications are matched to search results and History rows by
# `posting_keys.url_key` (imported above as `_url_key`): LinkedIn's posting id
# when the URL carries one, since the search card URL and the URL the tracker
# stored can differ in shape (slug vs bare id, regional subdomain, tracking
# query) for the same posting; otherwise the address without its trailing slash
# and its tracking query, keeping the parameters that NAME a posting (JobMaster's
# `key`, Phase 32). The applied-jobs filter matches by the same key, so a card
# marked Applied and a posting left out are one answer about one job.


class Tracked(NamedTuple):
    """The tracker row a posting maps to: its status, and its id, so a search
    card or a History row can open the job's own page (PLAN 31.4/6)."""

    status: str
    id: int


def applied_status_map(db: Session, user_id: int) -> dict[str, Tracked]:
    """Every job this user already has in the tracker, keyed by normalized URL.

    Read once and passed around as a plain dict so the SSE search can stamp
    results after it has released its pooled connection — that stream runs for
    minutes and must not hold a Neon connection open to answer this.
    Newest application wins if the same job was saved twice."""
    status_by_key: dict[str, Tracked] = {}
    rows = db.execute(
        select(Application.job_url, Application.status, Application.id)
        .where(Application.job_url != "", Application.user_id == user_id)
        .order_by(Application.id)
    ).all()
    for job_url, status, app_id in rows:
        status_by_key[_url_key(job_url)] = Tracked(status or "saved", app_id)
    return status_by_key


def applied_jobs_of(db: Session, user_id: int) -> AppliedJobs | None:
    """What this user already applied to (Phase 32): every tracker row at
    applied, interview, offer or rejected, WITH or without an address (the Gmail
    sync's cards have none), as `applied_jobs` matches them. None when there is
    none. One read, of this user's rows only."""
    rows = db.execute(
        select(Application.job_url, Application.status, Application.job_title, Application.company).where(
            Application.user_id == user_id, Application.status.in_(sorted(APPLIED_STATUSES))
        )
    ).all()
    return applied_jobs.from_rows(rows)


def applied_kw(db: Session, user_id: int) -> dict:
    """`applied=` for `search_jobs`: the searches' and the alert mornings' one
    door (Phase 32), so they cannot disagree about what was applied to. Empty
    when nothing is, so a seam that replaces the search is called as before.

    Never raises. A tracker that cannot be read leaves nothing out: showing a job
    the user applied to is the safe error, hiding one they did not is the one this
    feature may never make. Rolled back, so the caller's session stays usable."""
    try:
        return applied_jobs.search_kw(applied_jobs_of(db, user_id))
    except Exception:  # noqa: BLE001 - leave nothing out rather than fail a search
        db.rollback()
        return {}


def application_statuses(db: Session, urls: list[str], user_id: int) -> dict[str, Tracked | None]:
    """Map each history URL to its tracker row (None when never saved/applied)."""
    status_by_key = applied_status_map(db, user_id)
    return {u: status_by_key.get(_url_key(u)) for u in urls if u}


def _match_urls(m: JobMatch | dict) -> list[str]:
    if isinstance(m, dict):
        also = m.get("also_on") or []
        return [m.get("url") or "", *[(a or {}).get("url") or "" for a in also]]
    return [m.url, *(a.url for a in m.also_on)]


def stamp_applied(matches: Sequence[JobMatch | dict], status_by_key: dict[str, Tracked]) -> None:
    """Mark search results the user has already dealt with, in place: the
    tracker status, and the row's id, which the card opens (PLAN 31.4/6).

    Also checks the cross-board duplicates (`also_on`): the same posting shows
    up on LinkedIn and Comeet under different URLs, and having applied through
    one of them is exactly the reason not to look at the other again.

    Takes models OR dicts because the SSE search stamps both — the incremental
    `match` frames are already `model_dump()`ed by the time they reach the
    endpoint, while the terminal `result` still holds real JobMatch objects.
    """
    if not status_by_key:
        return
    for m in matches:
        for url in _match_urls(m):
            tracked = status_by_key.get(_url_key(url)) if url else None
            if tracked is None:
                continue
            if isinstance(m, dict):
                m["application_status"] = tracked.status
                m["application_id"] = tracked.id
            else:
                m.application_status = tracked.status
                m.application_id = tracked.id
            break


def delete_search_hit(db: Session, hit_id: int, user_id: int) -> bool:
    row = db.get(JobSearchHit, hit_id)
    if not row or row.user_id != user_id:
        return False
    db.delete(row)
    db.commit()
    return True


def clear_search_hits(db: Session, user_id: int) -> int:
    deleted = db.execute(
        delete(JobSearchHit).where(JobSearchHit.user_id == user_id)
    ).rowcount or 0
    db.commit()
    return deleted
