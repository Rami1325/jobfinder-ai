"""The inbox scanner's tracker writes (Phase 29 / B2): what an email may do to a card.

Deterministic, like the rules stage before it — no model, no network — because
every write here must be explainable in a sentence and undoable in a tap. The
Phase 29 overview's decision 14, as this module enforces it (with amendments
I3-I7 folded in):

- MONOTONIC. A status moves forward (saved -> applied -> interview -> offer) or
  to rejected. An email never moves a card backwards, and never changes a card
  that already reads offer or rejected — a different verdict waits in review.
- THE OWNER'S NEWER WORD WINS (rule 5, I4). A card the inbox did not write is
  never changed by an email OLDER than the card's own last change or creation.
  That covers legacy rows (status_source "") and kit or extension rows too, not
  just manual edits: a first 60-day import otherwise lands a two-month-old
  rejection from a PREVIOUS application on the card the user made today.
- WHEN UNSURE, ASK. Low confidence, several cards it could be, a title that
  names a different role, a blank or agency-hidden company, a conflict with a
  terminal card: the email waits in Needs review and no card is touched.
- HONEST NUMBERS (I5). An interview email sets `interviewed` on the card it
  matches even when the status does not move, and nothing here ever clears it,
  so the header's interview tile and the analytics funnel agree about every card
  an email touched. An assessment is not an interview and moves nothing.
- HONEST DATES (I3). A card the inbox creates is dated by its earliest email,
  and `applied_at` comes only from a confirmation — a rejection proves nobody's
  send date.

Every status string written here is one of the five tracker keys.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.inbox_rules import (
    KINDS,
    STATUSES,
    MessageMeta,
    Verdict,
    company_matches,
    normalize_company,
    title_similarity,
)
from app.db.models import Application, MailEvent

RANK = {"saved": 0, "applied": 1, "interview": 2, "offer": 3}
TERMINAL = frozenset({"offer", "rejected"})
# Statuses that say an application was sent, so a card in one keeps its applied_at.
SENT_STATUSES = frozenset({"applied", "interview", "offer", "rejected"})
# The status each kind asks for. viewed / recruiter / other / assessment ask for
# none (I5: an assessment is a task, not an interview).
TARGET = {"confirmation": "applied", "interview": "interview", "offer": "offer", "rejection": "rejected"}
# A card made BY HAND from a review item ("Add to tracker"): the user chose to
# track it, so a kind with no target still gets a sensible column.
RESOLVE_STATUS = {**TARGET, "assessment": "applied", "viewed": "applied", "recruiter": "saved", "other": "saved"}
TRACKER_ACTIONS = ("created", "updated", "linked")
TITLE_MATCH = 0.5


def utc(dt: datetime | None) -> datetime | None:
    """DateTime columns read back naive; everything here compares aware UTC."""
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def received_at_of(meta: MessageMeta) -> datetime:
    if meta.internal_ms > 0:
        try:
            return datetime.fromtimestamp(meta.internal_ms / 1000, timezone.utc)
        except (OverflowError, OSError, ValueError):
            pass
    return datetime.now(timezone.utc)


@dataclass
class Match:
    app: Any
    outcome: str  # matched | none | no_company | ambiguous | title_mismatch


@dataclass
class Plan:
    action: str  # created | updated | linked | review | skip
    app: Any = None
    status: str = ""
    reason: str = ""


# --- deciding (pure over anything with the Application attributes) ------------------
def _company_key(app: Any) -> str:
    """A card's normalised company — precomputed on the sync's snapshots, where a
    backfill matches hundreds of messages against hundreds of cards."""
    cached = getattr(app, "company_key", None)
    return cached if isinstance(cached, str) else normalize_company(app.company or "")


def match(apps: list[Any], company: str, title: str) -> Match:
    """Which of the user's cards an email is about (I6).

    Company first: normalised-equal, or whole-word containment (a name under 4
    characters must be one whole word of the longer name). Then the title,
    whenever BOTH sides have one — for a
    single company match too, because someone who applied to two roles at one
    company and tracked only one must not have role B's rejection close role A.
    Several cards and no way to choose is `ambiguous`, never a guess.
    """
    key = normalize_company(company)
    if not key:
        return Match(None, "no_company")
    hits = [a for a in apps if company_matches(key, _company_key(a))]
    if not hits:
        return Match(None, "none")
    title = (title or "").strip()
    if len(hits) == 1:
        only = hits[0]
        if title and (only.job_title or "").strip() and title_similarity(title, only.job_title) < TITLE_MATCH:
            return Match(None, "title_mismatch")
        return Match(only, "matched")
    if not title:
        return Match(None, "ambiguous")
    scored = sorted(
        ((title_similarity(title, a.job_title or ""), a.id, a) for a in hits),
        key=lambda row: (-row[0], row[1]),
    )
    best = scored[0][0]
    if best < TITLE_MATCH:
        titled = all((a.job_title or "").strip() for a in hits)
        return Match(None, "title_mismatch" if titled else "ambiguous")
    if scored[1][0] == best:
        return Match(None, "ambiguous")
    return Match(scored[0][2], "matched")


def plan(apps: list[Any], verdict: Verdict, received_at: datetime, threshold: float) -> Plan:
    """What one email does to the tracker. Pure: `execute` performs it."""
    kind = verdict.kind if verdict.kind in KINDS else "other"
    if not verdict.is_job_related:
        return Plan("skip", reason="not_job")
    # 1. Unsure of the reading itself: ask.
    if verdict.confidence < threshold:
        return Plan("review", reason="low_confidence")
    target = TARGET.get(kind)
    found = match(apps, verdict.company, verdict.job_title)
    if found.app is not None:
        # 2. No status to ask for: the email just joins the card's timeline.
        if target is None:
            return Plan("linked", found.app, reason=kind)
        return _plan_matched(found.app, kind, target, received_at)
    if target is None:
        if kind == "assessment":
            # I5: a task for a company with no card yet means an application exists.
            if found.outcome == "none":
                return Plan("created", status="applied", reason="assessment_first")
            return Plan("review", reason=found.outcome)
        if kind == "recruiter":
            return Plan("review", reason="recruiter")
        return Plan("skip", reason=f"{kind}_unmatched")  # an unmatched "viewed" is not worth a row
    # 3. Asks for a status and matches no card.
    if found.outcome == "title_mismatch" and kind == "confirmation":
        return Plan("created", status="applied", reason="another_role")
    if found.outcome in ("no_company", "ambiguous", "title_mismatch"):
        return Plan("review", reason=found.outcome)
    return Plan("created", status=target, reason="first_email")


def _plan_matched(app: Any, kind: str, target: str, received_at: datetime) -> Plan:
    status = app.status or "saved"
    if status not in STATUSES:
        return Plan("review", app, reason="unknown_status")  # never overwrite what we cannot read
    # 4. A terminal card is never changed by an email.
    if status in TERMINAL:
        return Plan("linked" if target == status else "review", app, reason="terminal")
    # 5. (I4) An email older than a card someone else owns. The marker is the
    # card's last status change, else its creation — kit and extension rows
    # carry no status_changed_at, and a NULL compared against a date is no rule.
    marker = utc(app.status_changed_at) or utc(app.created_at)
    if (app.status_source or "") != "email" and marker is not None and received_at < marker:
        if kind == "confirmation" and status == "saved":
            # Saving a job and applying later is the normal order; the
            # confirmation is still the truth about the application.
            chosen = Plan("updated", app, status="applied", reason="older_confirmation")
        elif kind in ("interview", "offer", "rejection"):
            return Plan("review", app, reason="older_than_card")
        else:
            return Plan("linked", app, reason="older_than_card")
    # 6. Forward, or to rejected.
    elif target == "rejected" or RANK[target] > RANK[status]:
        chosen = Plan("updated", app, status=target)
    # 7. Nothing to move ("applied" confirmation on an interview card, say).
    else:
        chosen = Plan("linked", app, reason="no_forward_move")
    # I7: a card the inbox made without a title cannot tell two roles at one
    # company apart, so a later status change for it is the user's call.
    if chosen.action == "updated" and (app.source or "") == "email" and not (app.job_title or "").strip():
        return Plan("review", app, reason="untitled_card")
    return chosen


# --- performing ------------------------------------------------------------------------
def new_event(user_id: int, meta: MessageMeta, verdict: Verdict, received_at: datetime) -> MailEvent:
    """The stored extraction for one email, every field clipped to its column.
    No body: there is no column to put one in."""
    return MailEvent(
        user_id=user_id,
        provider_message_id=(meta.id or "")[:64],
        thread_id=(meta.thread_id or "")[:64],
        rfc822_id=(meta.rfc822_id or "")[:255],
        received_at=received_at,
        from_name=(meta.from_name or "")[:255],
        from_email=(meta.from_email or "")[:320],
        subject=(meta.subject or "")[:300],
        snippet=(meta.snippet or "")[:300],
        kind=verdict.kind if verdict.kind in KINDS else "other",
        company=(verdict.company or "")[:255],
        job_title=(verdict.job_title or "")[:255],
        confidence=float(verdict.confidence),
        method=verdict.method if verdict.method in ("rule", "llm") else "llm",
        interview_at=(verdict.interview_at or "")[:40],
        evidence=(verdict.evidence or "")[:200],
    )


def _touch(app: Application, kind: str, received_at: datetime, event: MailEvent) -> None:
    """What any email tied to a card does besides its status."""
    if kind == "interview" and not app.interviewed:
        app.interviewed = True
        event.set_interviewed = True
    if kind == "confirmation" and app.applied_at is None:
        app.applied_at = received_at
        event.set_applied_at = True
    last = utc(app.last_email_at)
    if last is None or received_at > last:
        app.last_email_at = received_at
    if (app.source or "") == "email":
        created = utc(app.created_at)
        if created is not None and received_at < created:
            app.created_at = received_at  # I3: a card the inbox made is dated by its earliest email
    event.application_id = app.id


def execute(
    db: Session, user_id: int, event: MailEvent, verdict: Verdict, p: Plan, received_at: datetime,
    *, recheck: bool = False,
) -> Application | None:
    """Carry out a plan on the tracker and record it on the event. No commit.

    `recheck` (the sync passes it) re-plans an update or link against the card
    AS IT IS NOW, never the snapshot the plan was made from (FIXB B9). A sync
    runs for up to 25 s in the foreground and 240 s in the cron, and a user who
    drags the card to Offer in that window has made the newer, terminal change —
    rules 4 and 5 then send the email to review instead of overwriting it. A
    Needs-review resolution does not pass it: there the user's own choice
    replaces the checks."""
    event.action = p.action
    if p.action == "created":
        status = p.status if p.status in STATUSES else "saved"
        app = Application(
            user_id=user_id,
            job_title=(verdict.job_title or "")[:255],
            company=(verdict.company or "")[:255],
            status=status,
            source="email",
            status_source="email",
            status_changed_at=received_at,
            created_at=received_at,
            applied_at=received_at if verdict.kind == "confirmation" else None,
            interviewed=verdict.kind == "interview",
            last_email_at=received_at,
        )
        db.add(app)
        db.flush()
        event.application_id = app.id
        event.new_status = status
        event.set_interviewed = bool(app.interviewed)
        event.set_applied_at = app.applied_at is not None
        return app
    if p.action not in ("updated", "linked") or p.app is None:
        return None
    app = db.get(Application, p.app.id)
    if app is None or app.user_id != user_id:
        event.action = "review"
        return None
    if recheck:
        kind = verdict.kind if verdict.kind in KINDS else "other"
        target = TARGET.get(kind)
        if target is not None:
            p = _plan_matched(app, kind, target, received_at)
            event.action = p.action
            if p.action not in ("updated", "linked"):
                return None
    if p.action == "updated" and p.status in STATUSES:
        event.prev_status = app.status if app.status in STATUSES else "saved"
        event.new_status = p.status
        app.status = p.status
        app.status_source = "email"
        app.status_changed_at = received_at
    elif p.action == "updated":
        event.action = "linked"
    _touch(app, verdict.kind, received_at, event)
    return app


def verdict_of(event: MailEvent) -> Verdict:
    return Verdict(
        kind=event.kind if event.kind in KINDS else "other",
        company=event.company or "",
        job_title=event.job_title or "",
        confidence=float(event.confidence or 0.0),
        method=event.method or "llm",
        evidence=event.evidence or "",
        interview_at=event.interview_at or "",
        is_job_related=True,
    )


def _refresh_email_dates(db: Session, user_id: int, app: Application, undone: MailEvent) -> None:
    """After an Undo, re-derive what the remaining emails say about the card."""
    rows = db.execute(
        select(MailEvent.received_at, MailEvent.kind).where(
            MailEvent.user_id == user_id,
            MailEvent.application_id == app.id,
            MailEvent.action.in_(TRACKER_ACTIONS),
        )
    ).all()
    dates = [utc(r[0]) for r in rows if r[0] is not None]
    app.last_email_at = max(dates) if dates else None
    if undone.set_applied_at:
        confirmations = [utc(r[0]) for r in rows if r[1] == "confirmation" and r[0] is not None]
        if confirmations:
            app.applied_at = min(confirmations)
        elif (app.status or "") not in SENT_STATUSES:
            app.applied_at = None
        # else (FIXB B12): the card still reads as sent, so it keeps the date it
        # has. Blanking it dropped a kept card out of every applied_at bucket, and
        # no later write would restore it — a PATCH to the status it already has
        # changes nothing, so it stamps nothing.
    if (app.source or "") == "email" and dates:
        app.created_at = min(dates)


def _touched(app: Application, event: MailEvent) -> bool:
    """Has anyone but the inbox changed this card since `event` created it? Then
    an Undo of that email may not delete it (FIXB B12). A rating, a hand-toggled
    interview flag, a link, a job ad, a cover letter, notes, a tailored resume
    or a status someone else set each count; the scanner writes none of them."""
    return (
        (app.status_source or "") != "email"
        or bool((app.notes or "").strip())
        or bool(app.tailored_resume_json or "")
        or bool((app.cover_letter or "").strip())
        or bool((app.jd_text or "").strip())
        or bool((app.job_url or "").strip())
        or int(app.excitement or 0) != 0
        or bool(app.interviewed) != bool(event.set_interviewed)
    )


def _interview_remains(db: Session, user_id: int, app_id: int) -> bool:
    """Does an interview email still stand on this card (FIXB B11)?"""
    return bool(db.execute(
        select(func.count()).select_from(MailEvent).where(
            MailEvent.user_id == user_id,
            MailEvent.application_id == app_id,
            MailEvent.action.in_(TRACKER_ACTIONS),
            MailEvent.kind == "interview",
        )
    ).scalar())


def undo(db: Session, user_id: int, event: MailEvent, now: datetime | None = None) -> str:
    """Put a card back the way this email found it. "" on success, else a code.

    `updated`: only while the card still shows the status this email wrote —
    after the user moved it again, an Undo would overwrite THEM (`changed_since`).
    The card is then the user's (status_source manual). `created`: the card is
    deleted only while nobody has touched it (`_touched`, and no other email
    tied to it); otherwise it stays and only the event is undone. `interviewed`
    is cleared only when no other interview email still stands on the card
    (FIXB B11 — I5 says nothing clears it while an email proves it). No commit.
    """
    now = now or datetime.now(timezone.utc)
    if event.user_id != user_id:
        return "not_found"
    if event.action not in TRACKER_ACTIONS:
        return "not_undoable"
    was = event.action
    app = db.get(Application, event.application_id) if event.application_id else None
    if app is not None and app.user_id != user_id:
        app = None
    if was == "updated":
        if app is None or app.status != event.new_status:
            return "changed_since"
        app.status = event.prev_status if event.prev_status in STATUSES else "saved"
        app.status_source = "manual"
        app.status_changed_at = now
    remove = False
    if was == "created" and app is not None:
        others = db.execute(
            select(func.count()).select_from(MailEvent).where(
                MailEvent.user_id == user_id,
                MailEvent.application_id == app.id,
                MailEvent.id != event.id,
                MailEvent.action.in_(TRACKER_ACTIONS),
            )
        ).scalar() or 0
        remove = not others and not _touched(app, event)
    event.action = "undone"
    if remove:
        db.delete(app)
        event.application_id = None
        return ""
    if app is not None:
        db.flush()
        if was in ("updated", "linked") and event.set_interviewed:
            app.interviewed = _interview_remains(db, user_id, app.id)
        _refresh_email_dates(db, user_id, app, event)
    return ""


def resolve(
    db: Session, user_id: int, event: MailEvent, *, application_id: int | None = None, create: bool = False
) -> str:
    """File a Needs-review email where the user says it belongs. The user's
    choice replaces the checks that sent it to review, but not monotonicity:
    linking never moves a card backwards. No commit."""
    if event.user_id != user_id:
        return "not_found"
    if event.action != "review":
        return "not_review"
    verdict = verdict_of(event)
    received_at = utc(event.received_at) or datetime.now(timezone.utc)
    if create:
        p = Plan("created", status=RESOLVE_STATUS.get(verdict.kind, "saved"), reason="resolved")
    else:
        app = db.get(Application, application_id) if application_id else None
        if app is None or app.user_id != user_id:
            return "application_not_found"
        target = TARGET.get(verdict.kind)
        status = app.status if app.status in STATUSES else ""
        forward = bool(target and status and target != status) and (
            target == "rejected" or RANK.get(target, -1) > RANK.get(status, 99)
        )
        p = Plan("updated", app, status=target or "", reason="resolved") if forward else Plan("linked", app, reason="resolved")
    execute(db, user_id, event, verdict, p, received_at)
    return ""


def dismiss(user_id: int, event: MailEvent) -> str:
    if event.user_id != user_id:
        return "not_found"
    if event.action != "review":
        return "not_review"
    event.action = "dismissed"
    return ""


# --- reading ------------------------------------------------------------------------------
def latest_kinds(db: Session, user_id: int) -> dict[int, str]:
    """Each card's newest email kind, for the tracker list's badge."""
    rows = db.execute(
        select(MailEvent.application_id, MailEvent.kind, MailEvent.received_at, MailEvent.id).where(
            MailEvent.user_id == user_id,
            MailEvent.application_id.is_not(None),
            MailEvent.action.in_(TRACKER_ACTIONS),
        )
    ).all()
    best: dict[int, tuple[tuple[datetime, int], str]] = {}
    for app_id, kind, received, event_id in rows:
        key = (utc(received) or datetime.min.replace(tzinfo=timezone.utc), event_id)
        if app_id not in best or key > best[app_id][0]:
            best[app_id] = (key, kind)
    return {app_id: kind for app_id, (_, kind) in best.items()}


def events_for_application(db: Session, user_id: int, app_id: int) -> list[MailEvent]:
    """Every email tied to one card, newest first."""
    return list(
        db.execute(
            select(MailEvent)
            .where(
                MailEvent.user_id == user_id,
                MailEvent.application_id == app_id,
                MailEvent.action.in_(TRACKER_ACTIONS),
            )
            .order_by(MailEvent.received_at.desc(), MailEvent.id.desc())
        ).scalars().all()
    )
