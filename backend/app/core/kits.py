"""Batch auto-tailor kits (PLAN 8.1): "Tailor my top matches".

High-fit search results are enqueued as `tailor_kits` rows, then processed
ONE per request by the client's sequential loop (POST /kits/process-next) —
each run is a single tailor pipeline call, so every invocation fits well
inside a serverless function's time budget. No queue infrastructure needed.

Each processed kit is a reviewable "application kit": the analyzed JD, the
master resume the tailor ran on (the diff baseline for the 8.2 review UI),
and the full TailorResult. The fabrication guard runs inside `tailor_resume`
as always; a kit with flags is marked (`flag_count > 0`) and must never be
auto-approvable.

**Monthly uses (Phase 30 / B4.1).** A batch is PAID when it is queued: one use
per new kit, in one reserve, and every kit queued by it carries that event's id.
A kit that fails, or is deleted or wiped while still queued, gives its one use
back through `refund_kit`, at most once (`quota_refunded`). A kit with no event
(queued before Phase 30, or by an exempt caller) never refunds: it never paid.
A kit is CLAIMED with one conditional UPDATE, and the write that ends its run is
conditional on that claim, so two process-next calls can never run one kit
twice or refund it twice.

`process_next_kit` takes injectable `analyze_fn`/`tailor_fn` (same pattern as
alerts.run_alert's `search_fn`) so the smoke test drives the whole loop
offline, including a forced-flags path. Left unset they resolve to this
module's `analyze_jd` / `tailor_resume` at CALL time, so patching those two
names here is a real seam, not one a default argument bound at import time.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Callable

from sqlalchemy import or_, select, update
from sqlalchemy.orm import Session

from app.core import quota
from app.core.jd_analyzer import analyze_jd
from app.core.job_market import stamp_market
from app.core.lang import detect_language
from app.core.tailor import tailor_resume
from app.core import resume_prefs, writing_prefs
from app.db.models import Application, SavedResume, TailorKit, User
from app.models import (
    FactsLedger,
    JDModel,
    KitDetail,
    KitJobIn,
    KitOut,
    ResumeModel,
    TailorResult,
)

logger = logging.getLogger(__name__)

MAX_BATCH = 10  # kits enqueued per call; also the ceiling the UI offers
# A "running" kit older than this is a crashed/killed invocation (serverless
# timeouts leave no chance to mark it failed) — requeue it on the next call.
STUCK_RUNNING = timedelta(minutes=10)

# The claim, the requeue and the terminal write are Core statements on the table:
# their rowcount is the decision, and none of them should wait on the ORM
# reconciling objects in memory with a row another request just changed.
_KITS = TailorKit.__table__


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
        reject_reason=row.reject_reason or "",
        application_id=row.application_id,
        submit_note=row.submit_note or "",
        submitted_at=row.submitted_at.isoformat() if row.submitted_at else "",
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
        jd_text=row.jd_text or "",
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
    charge: Callable[[int], int | None] | None = None,
) -> tuple[list[TailorKit], int]:
    """Queue tailor kits for `jobs`, deduped by URL against the user's existing
    kits: queued/running/done kits are skipped, failed ones are requeued with
    the fresh JD. Returns (queued rows, skipped count). Raises ValueError on
    unusable input — the route maps it to a 400.

    `charge` is called with the number of NEW kits (after the dedupe) BEFORE any
    row is written: the route passes the daily tailor cap and then the monthly
    reserve, and returns the reserve's event id (None for an exempt caller, and
    from a fake that returns nothing). If it raises, nothing was queued, and its
    own commit can't flush half-built kit rows. Every kit queued here, fresh or a
    requeued failure, carries that event id with `quota_refunded` False, which
    is what `refund_kit` gives back. If the commit that writes the kits fails
    after the charge, the whole charge is refunded before the error propagates:
    nothing was queued, so nothing was bought."""
    # NO geo backstop here, deliberately — one was written and removed. It ran
    # `detect_geo_restriction` on every job with no gate, while `search_jobs`
    # gates on `JobHit.origin_market`. The two therefore disagreed about the
    # SAME posting: a LinkedIn job returned by the user's own location query is
    # ranked with no badge at all, and tapping "Application kit" on it returned
    # a 400 saying it states a hiring restriction abroad. An Israeli-board job
    # requiring an Israeli security clearance failed the same way. Two surfaces
    # contradicting each other about one posting is worse than the cap it was
    # protecting, and the protection was narrow anyway: the search path already
    # filters blocking postings before they can be enqueued, and a history row
    # only exists for a posting that was scored, i.e. never filtered.
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
            skipped += 1  # opening a kit that already exists is free
            continue
        to_queue.append((row, job))
    if not to_queue:
        return [], skipped
    event_id = charge(len(to_queue)) if charge is not None else None

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
        row.reject_reason = ""
        row.application_id = None
        row.started_at = None
        row.processed_at = None
        # Phase 30 / B4.1: the charge that paid for THIS run of the kit. A
        # requeued failure was refunded under its old event, so it starts over.
        row.quota_event_id = event_id
        row.quota_refunded = False
        queued.append(row)
    try:
        db.commit()
    except Exception:
        db.rollback()
        if event_id is not None:
            try:
                quota.refund_units(db, event_id, len(to_queue), ref=f"refund:{event_id}")
            except Exception:  # noqa: BLE001 - never mask the error that failed the batch
                logger.warning("refunding a batch whose kits were never written did not complete", exc_info=True)
        raise
    return queued, skipped


def refund_kit(db: Session, kit_id: int, *, queued_only: bool = False) -> bool:
    """The per-kit refund (Phase 30 / B4.1): give back the one use a kit paid for
    at batch time, at most once. True when a use came back.

    Runs in the CALLER's transaction and never commits: the caller writes the
    kit's status (a failed run) or deletes it (a queued kit deleted or wiped) and
    commits ONCE, so the flag, the refund and that write land together. A kit
    with no charge event never refunds. `queued_only` is the delete-and-wipe
    form: a kit that is already running belongs to the call running it.

    The flag is CLAIMED first — its rowcount is what stops two calls refunding
    one kit — and taken back when the refund then cannot land (Phase 30 review,
    P30-C1): `quota_refunded` may only ever mean a use actually came back. It
    stuck at True before, so a kit whose month row had been pruned was recorded
    as refunded while nothing was given back, and every retry was refused by the
    kit's own flag.
    """
    stmt = (
        update(_KITS)
        .where(
            _KITS.c.id == kit_id,
            _KITS.c.quota_event_id.is_not(None),
            _KITS.c.quota_refunded.is_(False),
        )
        .values(quota_refunded=True)
    )
    if queued_only:
        stmt = stmt.where(_KITS.c.status == "queued")
    if db.execute(stmt).rowcount != 1:
        return False
    event_id = db.execute(select(_KITS.c.quota_event_id).where(_KITS.c.id == kit_id)).scalar()
    if quota.refund_units(db, event_id, 1, ref=f"refund:{event_id}:kit:{kit_id}", commit=False):
        return True
    db.execute(update(_KITS).where(_KITS.c.id == kit_id).values(quota_refunded=False))
    return False


def refund_queued_kits(db: Session, user_id: int) -> int:
    """`refund_kit` for every still-queued kit of one user: the privacy wipe and
    the account close, BEFORE the kit rows are deleted. Never commits; returns
    how many uses came back."""
    kit_ids = db.execute(
        select(_KITS.c.id).where(_KITS.c.user_id == user_id, _KITS.c.status == "queued")
    ).scalars().all()
    return sum(1 for kit_id in kit_ids if refund_kit(db, kit_id, queued_only=True))


def _pick_master(db: Session, user_id: int, jd_language: str) -> SavedResume | None:
    """The master resume to tailor: the JD's language slot when the user has a
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
    """Put this user's kits left "running" past STUCK_RUNNING back in the queue.

    One conditional UPDATE in the claim's own form, so a kit is only taken back
    while it is still the stuck run it looked like. A requeued kit keeps its
    charge: running it again never charges again. It always commits, even when
    nothing matched, because an open write transaction here would hold SQLite's
    write lock for the rest of the call.
    """
    cutoff = _now().replace(tzinfo=None) - STUCK_RUNNING
    db.execute(
        update(_KITS)
        .where(
            _KITS.c.user_id == user_id,
            _KITS.c.status == "running",
            or_(_KITS.c.started_at.is_(None), _KITS.c.started_at < cutoff),
        )
        .values(status="queued", started_at=None)
    )
    db.commit()


def _claim_next(db: Session, user_id: int) -> tuple[int, datetime] | None:
    """Claim the oldest queued kit this call can win: (kit id, claimed_at), or None.

    The claim is ONE conditional UPDATE (`… AND status = 'queued'`) and its rowcount
    is the decision, so two calls that picked the same kit cannot both run it (the
    old select-then-write let both in, and both refunded). The loser moves on to
    the next queued kit, and when every candidate of one batch was taken by
    someone else the candidates are SELECTED AGAIN (Phase 30 review, be2a-3):
    one select is capped at MAX_BATCH, so ten lost claims used to answer None
    while an eleventh queued kit was still there for the taking. None therefore
    means nothing is claimable, which is what the client's drain loop stops on.
    Bounded to MAX_BATCH rounds, and each round can only run at all because a
    lost claim means that kit is no longer queued.
    """
    for _ in range(MAX_BATCH):
        candidates = db.execute(
            select(_KITS.c.id)
            .where(_KITS.c.user_id == user_id, _KITS.c.status == "queued")
            .order_by(_KITS.c.id)
            .limit(MAX_BATCH)
        ).scalars().all()
        if not candidates:
            return None
        for kit_id in candidates:
            claimed_at = _now().replace(tzinfo=None)
            won = db.execute(
                update(_KITS)
                .where(_KITS.c.id == kit_id, _KITS.c.status == "queued")
                .values(status="running", started_at=claimed_at)
            ).rowcount
            if won == 1:
                db.commit()
                return int(kit_id), claimed_at
            db.rollback()
    return None


AnalyzeFn = Callable[[str], JDModel]
TailorFn = Callable[..., TailorResult]  # (resume, jd, ledger=...) -> TailorResult


def process_next_kit(
    db: Session,
    user: User,
    analyze_fn: AnalyzeFn | None = None,
    tailor_fn: TailorFn | None = None,
) -> tuple[TailorKit | None, int]:
    """Run the full tailor pipeline on the user's oldest queued kit.

    Returns (processed row, or None when no kit could be claimed; kits still
    queued). Failures mark the kit "failed" with a user-facing error instead of
    raising — the client's loop keeps going and the queue can't jam on one bad
    job — and give that kit's use back (Phase 30 / B4.1).

    The write that ends a run is conditional on THIS call's claim (`status =
    'running' AND started_at = claimed_at`). If the kit was requeued as stuck and
    claimed again while this call ran, that write matches nothing, and this call
    writes nothing and refunds nothing: the kit belongs to whoever holds it now.

    A claim whose kit has VANISHED — deleted between the claim and the read, or
    deleted while the pipeline ran — goes back for the next one instead of
    answering None (Phase 30 review, be2a-3). None stops the client's drain loop,
    so answering it with kits still queued left the rest of a batch sitting there
    until some later drain started. Bounded to MAX_BATCH attempts.
    """
    analyze = analyze_fn or analyze_jd
    tailor = tailor_fn or tailor_resume
    user_id = user.id
    _requeue_stuck(db, user_id)
    for _ in range(MAX_BATCH):
        claim = _claim_next(db, user_id)
        if claim is None:
            return None, queued_count(db, user_id)
        kit_id, claimed_at = claim
        row = db.get(TailorKit, kit_id)
        if row is None:  # deleted between the claim and this read: on to the next kit
            continue

        values: dict[str, object]
        try:
            master = _pick_master(db, user_id, detect_language(row.jd_text))
            if master is None:
                raise ValueError("No master resume saved — upload your resume first.")
            resume = ResumeModel.model_validate_json(master.resume_json)
            ledger = None
            if master.ledger_json:
                try:
                    ledger = FactsLedger.model_validate_json(master.ledger_json)
                except Exception:  # noqa: BLE001 - tailor rebuilds it from the resume
                    ledger = None
            jd = analyze(row.jd_text)
            # The market stamp, with the location the search stored beside the job.
            # AFTER the call, so the injectable `AnalyzeFn` keeps its one-argument
            # shape (the smoke fakes call it that way). Only ever UPGRADES: a stored
            # location naming Israel beats a text that named nowhere or elsewhere,
            # and an unknown stamp takes whatever the location can say.
            stamp_market(jd, row.jd_text, row.location or "")
            result = tailor(
                resume, jd, ledger=ledger,
                avoid_phrases=writing_prefs.avoid_phrases(user),
                hide_arabic_in_israel=resume_prefs.hide_arabic_in_israel(user),
            )
            values = {
                "status": "done",
                "base_resume_json": master.resume_json,
                "base_language": master.language or "en",
                "jd_json": jd.model_dump_json(),
                "result_json": result.model_dump_json(),
                "score_before": result.score_before.overall,
                "score_after": result.score_after.overall,
                "flag_count": len(result.fabrication_flags),
                "error": "",
            }
        except ValueError as e:  # user-facing (no master, bad JD)
            values = {"status": "failed", "error": str(e)}
        except Exception as e:  # noqa: BLE001 - LLM/network; keep the queue moving
            values = {"status": "failed", "error": f"Tailoring failed: {e}"}
        values["processed_at"] = _now().replace(tzinfo=None)
        db.rollback()  # the pipeline only read; start the terminal write clean

        ended = db.execute(
            update(_KITS)
            .where(_KITS.c.id == kit_id, _KITS.c.status == "running", _KITS.c.started_at == claimed_at)
            .values(**values)
        ).rowcount
        if ended != 1:
            db.rollback()
            row = db.get(TailorKit, kit_id)
            if row is None:  # deleted while this call ran; others may still be queued
                continue
            return row, queued_count(db, user_id)
        if values["status"] == "failed":
            refund_kit(db, kit_id)  # joins this transaction: the status and the refund land together
        db.commit()
        row = db.get(TailorKit, kit_id)
        if row is not None:
            db.refresh(row)
        return row, queued_count(db, user_id)
    return None, queued_count(db, user_id)


def _sent_signals(result_json: str) -> tuple[float | None, int | None]:
    """(voice score, fabrication-flag count) as actually recorded on a kit, or
    None for either one the kit predates. See approve_kit."""
    try:
        raw = json.loads(result_json or "{}")
    except ValueError:
        return None, None
    voice = raw.get("voice_report")
    flags = raw.get("fabrication_flags")
    return (
        voice.get("human_voice_score") if isinstance(voice, dict) else None,
        len(flags) if isinstance(flags, list) else None,
    )


def approve_kit(
    db: Session,
    user: User,
    row: TailorKit,
    resume: ResumeModel | None = None,
    cover_letter: str = "",
) -> TailorKit:
    """Approve a reviewed kit (PLAN 8.2): create a tracker Application carrying
    the final artifacts — the reviewer's effective resume (after per-bullet
    accept/reject; falls back to the kit's full tailored resume) and cover
    letter — as "saved" = ready to send, and link it back to the kit.

    Only a "done" kit can be approved; this is the HUMAN approval step, so
    guard-flagged kits are allowed through here (the reviewer saw the flags —
    "never auto-approvable" gates the 8.4 auto-submit path, not this one).
    Raises ValueError for state problems — the route maps it to a 400."""
    if row.status != "done":
        raise ValueError("Only a processed kit can be approved.")
    if resume is None:
        try:
            result = TailorResult.model_validate_json(row.result_json)
        except Exception:  # noqa: BLE001 - corrupt/legacy kit row
            raise ValueError("This kit has no tailored resume to approve.")
        resume = result.tailored_resume
    # PLAN 17.3: carry what was sent onto the tracker row, read from the RAW
    # result so a pre-Phase-16 kit reports "unknown" instead of the schema
    # default (100.0 would enter the conversion report as a perfect voice
    # score nobody measured). `template` stays "" — kit review has no template
    # picker, and guessing the default would record a choice nobody made.
    voice_score, flag_count = _sent_signals(row.result_json)
    app = Application(
        user_id=user.id,
        job_title=row.job_title,
        company=row.company,
        jd_text=row.jd_text,
        tailored_resume_json=resume.model_dump_json(),
        cover_letter=cover_letter,
        overall_score=row.score_after or 0.0,
        status="saved",
        job_url=row.url,
        voice_score=voice_score,
        fabrication_flag_count=flag_count,
    )
    db.add(app)
    db.flush()  # need app.id for the back-link
    row.status = "approved"
    row.application_id = app.id
    row.reject_reason = ""
    db.commit()
    db.refresh(row)
    return row


def reject_kit(db: Session, row: TailorKit, reason: str = "") -> TailorKit:
    """Reject a reviewed kit, recording why (feeds threshold tuning)."""
    if row.status != "done":
        raise ValueError("Only a processed kit can be rejected.")
    row.status = "rejected"
    row.reject_reason = reason.strip()
    db.commit()
    db.refresh(row)
    return row
