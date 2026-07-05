"""Batch auto-tailor kits (PLAN 8.1): "Tailor my top matches".

High-fit search results are enqueued as `tailor_kits` rows, then processed
ONE per request by the client's sequential loop (POST /kits/process-next) —
each run is a single tailor pipeline call, so every invocation fits well
inside a serverless function's time budget. No queue infrastructure needed.

Each processed kit is a reviewable "application kit": the analyzed JD, the
master résumé the tailor ran on (the diff baseline for the 8.2 review UI),
and the full TailorResult. The fabrication guard runs inside `tailor_resume`
as always; a kit with flags is marked (`flag_count > 0`) and must never be
auto-approvable.

`process_next_kit` takes injectable `analyze_fn`/`tailor_fn` (same pattern as
alerts.run_alert's `search_fn`) so the smoke test drives the whole loop
offline, including a forced-flags path.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.jd_analyzer import analyze_jd
from app.core.lang import detect_language
from app.core.tailor import tailor_resume
from app.db.models import SavedResume, TailorKit, User
from app.models import (
    FactsLedger,
    JDModel,
    KitDetail,
    KitJobIn,
    KitOut,
    ResumeModel,
    TailorResult,
)

MAX_BATCH = 10  # kits enqueued per call; also the ceiling the UI offers
# A "running" kit older than this is a crashed/killed invocation (serverless
# timeouts leave no chance to mark it failed) — requeue it on the next call.
STUCK_RUNNING = timedelta(minutes=10)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def kit_out(row: TailorKit) -> KitOut:
    return KitOut(
        id=row.id,
        status=row.status,
        job_title=row.job_title,
        company=row.company,
        location=row.location,
        url=row.url,
        source=row.source or "linkedin",
        logo_url=row.logo_url or "",
        posted_at=row.posted_at or "",
        search_overall=row.search_overall or 0.0,
        score_before=row.score_before or 0.0,
        score_after=row.score_after or 0.0,
        flag_count=row.flag_count or 0,
        base_language=row.base_language or "",
        error=row.error or "",
        created_at=row.created_at.isoformat() if row.created_at else "",
        processed_at=row.processed_at.isoformat() if row.processed_at else "",
    )


def kit_detail(row: TailorKit) -> KitDetail:
    def _parse(model, raw: str):  # noqa: ANN001 - pydantic model class
        if not raw:
            return None
        try:
            return model.model_validate_json(raw)
        except Exception:  # noqa: BLE001 - tolerate legacy/corrupt rows
            return None

    return KitDetail(
        **kit_out(row).model_dump(),
        jd=_parse(JDModel, row.jd_json),
        base_resume=_parse(ResumeModel, row.base_resume_json),
        result=_parse(TailorResult, row.result_json),
    )


def list_kits(db: Session, user_id: int) -> list[TailorKit]:
    return list(
        db.execute(
            select(TailorKit)
            .where(TailorKit.user_id == user_id)
            .order_by(TailorKit.id.desc())
        ).scalars().all()
    )


def queued_count(db: Session, user_id: int) -> int:
    return len(
        db.execute(
            select(TailorKit.id).where(
                TailorKit.user_id == user_id, TailorKit.status == "queued"
            )
        ).scalars().all()
    )


def enqueue_kits(
    db: Session,
    user: User,
    jobs: list[KitJobIn],
    charge: Callable[[int], None] | None = None,
) -> tuple[list[TailorKit], int]:
    """Queue tailor kits for `jobs`, deduped by URL against the user's existing
    kits: queued/running/done kits are skipped, failed ones are requeued with
    the fresh JD. Returns (queued rows, skipped count). Raises ValueError on
    unusable input — the route maps it to a 400.

    `charge` is called with the number of kits about to be queued BEFORE any
    row is written (the route passes the daily-cap check there): if it raises,
    nothing was queued, and its own commit can't flush half-built kit rows."""
    usable = [j for j in jobs if j.jd_text.strip() and j.url.strip()]
    if not usable:
        raise ValueError("No tailorable jobs in the batch (each needs a URL and JD text).")
    if len(usable) > MAX_BATCH:
        raise ValueError(f"Batch too large — at most {MAX_BATCH} jobs per run.")

    existing = {
        row.url.rstrip("/"): row
        for row in db.execute(
            select(TailorKit).where(TailorKit.user_id == user.id)
        ).scalars().all()
    }
    to_queue: list[tuple[TailorKit | None, KitJobIn]] = []  # (failed row to reset, job) / (None, job)
    skipped = 0
    seen_batch: set[str] = set()
    for job in usable:
        key = job.url.rstrip("/")
        if key in seen_batch:
            continue
        seen_batch.add(key)
        row = existing.get(key)
        if row is not None and row.status != "failed":
            skipped += 1
            continue
        to_queue.append((row, job))
    if not to_queue:
        return [], skipped
    if charge is not None:
        charge(len(to_queue))

    queued: list[TailorKit] = []
    for row, job in to_queue:
        if row is None:
            row = TailorKit(user_id=user.id, url=job.url)
            db.add(row)
        # Fresh enqueue and failed-kit requeue share the same reset.
        row.status = "queued"
        row.job_title = job.title
        row.company = job.company
        row.location = job.location
        row.source = job.source or "linkedin"
        row.logo_url = job.logo_url
        row.posted_at = job.posted_at
        row.jd_text = job.jd_text
        row.search_overall = job.overall
        row.base_resume_json = ""
        row.base_language = ""
        row.jd_json = ""
        row.result_json = ""
        row.score_before = 0.0
        row.score_after = 0.0
        row.flag_count = 0
        row.error = ""
        row.started_at = None
        row.processed_at = None
        queued.append(row)
    db.commit()
    return queued, skipped


def _pick_master(db: Session, user_id: int, jd_language: str) -> SavedResume | None:
    """The master résumé to tailor: the JD's language slot when the user has a
    paired master (mirrors the Tailor page's language swap), else the most
    recently updated one."""
    rows = db.execute(
        select(SavedResume)
        .where(SavedResume.user_id == user_id, SavedResume.resume_json != "")
        .order_by(SavedResume.updated_at.desc())
    ).scalars().all()
    for row in rows:
        if (row.language or "en") == jd_language:
            return row
    return rows[0] if rows else None


def _requeue_stuck(db: Session, user_id: int) -> None:
    rows = db.execute(
        select(TailorKit).where(
            TailorKit.user_id == user_id, TailorKit.status == "running"
        )
    ).scalars().all()
    cutoff = _now().replace(tzinfo=None) - STUCK_RUNNING
    changed = False
    for row in rows:
        if row.started_at is None or row.started_at < cutoff:
            row.status = "queued"
            row.started_at = None
            changed = True
    if changed:
        db.commit()


AnalyzeFn = Callable[[str], JDModel]
TailorFn = Callable[..., TailorResult]  # (resume, jd, ledger=...) -> TailorResult


def process_next_kit(
    db: Session,
    user: User,
    analyze_fn: AnalyzeFn = analyze_jd,
    tailor_fn: TailorFn = tailor_resume,
) -> tuple[TailorKit | None, int]:
    """Run the full tailor pipeline on the user's oldest queued kit.

    Returns (processed row or None when the queue is empty, kits still queued).
    Failures mark the kit "failed" with a user-facing error instead of raising —
    the client's loop keeps going and the queue can't jam on one bad job.
    """
    _requeue_stuck(db, user.id)
    row = db.execute(
        select(TailorKit)
        .where(TailorKit.user_id == user.id, TailorKit.status == "queued")
        .order_by(TailorKit.id)
    ).scalars().first()
    if row is None:
        return None, 0
    row.status = "running"
    row.started_at = _now().replace(tzinfo=None)
    db.commit()

    try:
        master = _pick_master(db, user.id, detect_language(row.jd_text))
        if master is None:
            raise ValueError("No master résumé saved — upload your résumé first.")
        resume = ResumeModel.model_validate_json(master.resume_json)
        ledger = None
        if master.ledger_json:
            try:
                ledger = FactsLedger.model_validate_json(master.ledger_json)
            except Exception:  # noqa: BLE001 - tailor rebuilds it from the résumé
                ledger = None
        jd = analyze_fn(row.jd_text)
        result = tailor_fn(resume, jd, ledger=ledger)
        row.base_resume_json = master.resume_json
        row.base_language = master.language or "en"
        row.jd_json = jd.model_dump_json()
        row.result_json = result.model_dump_json()
        row.score_before = result.score_before.overall
        row.score_after = result.score_after.overall
        row.flag_count = len(result.fabrication_flags)
        row.error = ""
        row.status = "done"
    except ValueError as e:  # user-facing (no master, bad JD)
        row.status = "failed"
        row.error = str(e)
    except Exception as e:  # noqa: BLE001 - LLM/network; keep the queue moving
        row.status = "failed"
        row.error = f"Tailoring failed: {e}"
    row.processed_at = _now().replace(tzinfo=None)
    db.commit()
    db.refresh(row)
    return row, queued_count(db, user.id)
