"""The inbox sync (Phase 29 / B2): one user's mailbox -> the tracker, within a budget.

`sync_user` NEVER RAISES. Everything that goes wrong with a mailbox — a revoked
grant, a network error, the daily cap — comes back in `error_code`, and the
connection keeps an honest `last_error`. A sync that threw would turn the tracker
page's quiet background sync into an error banner about a problem the Settings
card already describes.

THE IMPORT WALKS FORWARD FROM THE OLDEST DAY (Phase 29 amendment I2). Gmail
lists newest first, 500 to a page, so "list after:<60 days ago>, take 500, sort
ascending" imports only the newest week or two of a real inbox and advances past
everything older — exactly the confirmations that carry the real date applied.
Instead the connection holds two marks, both epoch milliseconds:

  window_lo_ms — the start of the next unfinished 7-day window;
  cursor_ms    — every message at or below it has been handled.

A run lists one window at a time from the cursor, following nextPageToken, and
halves the window for that run when it holds more than 2,000 ids or more new
messages than the run could read inside its budget. It handles the window's
messages oldest first and moves `window_lo_ms` past the window only when all of
it is done. The cursor only ever advances across the CONTIGUOUS handled prefix,
with messages that share one millisecond handled together, so a run stopped by
its budget, a network error or the daily cap resumes exactly where it stopped:
nothing skipped, nothing classified twice. Once the windows reach the present the
same arithmetic is the incremental sync; the cron carries an unfinished import on,
so the UI never has to hold a phone in a foreground loop for it.

A window ends five minutes before now, so a message Gmail accepted but has not
indexed yet cannot fall behind a cursor that already moved past its timestamp.

Metering (amendment I8): every model call runs inside this module's own
`metering.meter()`, from a pool whose submits carry `copy_context().run` — a
worker thread starts from an EMPTY context and would lose the tally — and the total
is written under `inbox_tokens`. The only other charge is the `inbox` daily cap,
counted before each batch of model calls. Never the `llm` cap.
"""
from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from json import JSONDecodeError
from typing import Callable
from urllib.parse import quote

from fastapi import HTTPException
from sqlalchemy import case, or_, select, update
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.core import google_oauth, inbox_apply, inbox_classifier, inbox_fake, inbox_rules, token_crypto
from app.core.gmail_api import GmailMailbox, Mailbox, MessageGone
from app.core.inbox_rules import MessageMeta, Verdict
from app.core.usage import INBOX_TOKENS_ACTION, check_and_count, record_tokens, used_today
from app.db.models import Application, MailConnection, MailEvent, User
from app.llm import metering
from app.llm.client import LLMClient
from app.llm.limits import ContextWindowExceeded, OutputTruncated
from app.models import InboxEventOut, InboxSyncResult

log = logging.getLogger(__name__)

DAY_MS = 24 * 60 * 60 * 1000
WINDOW_MS = 7 * DAY_MS
MIN_WINDOW_MS = 60 * 60 * 1000
SETTLE_MS = 5 * 60 * 1000
LIST_CEILING = 2000
# Past the smallest window the ceiling no longer shrinks anything, so listing
# goes on — bounded here, so a pathological mailbox cannot exhaust memory.
LIST_HARD_STOP = 10_000
POOL = 4
# Model calls between budget checks. Small enough that a 25 s budget is never
# overshot by more than one batch, large enough to use the pool.
CHUNK = 8
INBOX_ACTION = "inbox"
REAUTH_AFTER = timedelta(days=7)
CRON_MESSAGE_FACTOR = 3
# Google errors that mean the grant is gone for good: only a reconnect helps.
_REAUTH_CODES = frozenset({"invalid_grant", "admin_policy_enforced"})


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


# --- who and what -------------------------------------------------------------------
def fake_enabled(settings: Settings | None = None) -> bool:
    """The demo mailbox, refused while the gate is on and the real model is in
    use — the combination that only a production deployment has."""
    s = settings or get_settings()
    return bool(s.inbox_fake_provider) and (not s.app_access_code or bool(s.use_stub_llm))


def google_ready(settings: Settings | None = None) -> bool:
    return google_oauth.configured() and token_crypto.key_configured()


def connection_for(db: Session, user_id: int) -> MailConnection | None:
    return db.execute(select(MailConnection).where(MailConnection.user_id == user_id)).scalars().first()


def reauth_due_at(conn: MailConnection, settings: Settings | None = None) -> datetime | None:
    """connected_at + 7 days while Google keeps the app in Testing (amendment O3)."""
    s = settings or get_settings()
    if not s.google_oauth_testing or conn.provider != "gmail":
        return None
    connected = inbox_apply.utc(conn.connected_at)
    return connected + REAUTH_AFTER if connected is not None else None


def own_alert_senders(settings: Settings | None = None) -> tuple[str, ...]:
    s = settings or get_settings()
    return tuple(a for a in (s.alert_email_from, s.alert_smtp_user) if (a or "").strip())


def revoke_stored_grant(conn: MailConnection | None) -> bool:
    """Hand a stored Gmail grant back to Google before our copy is deleted. Best
    effort: a key that cannot read the token, or a Google that does not answer,
    must never stop a disconnect or a privacy wipe."""
    if conn is None or conn.provider != "gmail" or not conn.refresh_token_enc:
        return False
    try:
        token = token_crypto.decrypt(conn.refresh_token_enc)
    except Exception:  # noqa: BLE001 - best effort by contract
        return False
    return google_oauth.revoke(token)


def gmail_url(event: MailEvent, mailbox_email: str) -> str:
    """A link that opens the message in Gmail. A search on its Message-ID, the one
    form that works on a cold load; `authuser` picks the right signed-in account."""
    if not event.rfc822_id or not mailbox_email:
        return ""
    return (
        "https://mail.google.com/mail/u/?authuser=" + quote(mailbox_email, safe="@")
        + "#search/rfc822msgid:" + quote(event.rfc822_id, safe="")
    )


def _iso(dt: datetime | None) -> str:
    value = inbox_apply.utc(dt)
    return value.isoformat() if value is not None else ""


def event_out(event: MailEvent, mailbox_email: str = "") -> InboxEventOut:
    return InboxEventOut(
        id=event.id,
        received_at=_iso(event.received_at),
        from_name=event.from_name or "",
        from_email=event.from_email or "",
        subject=event.subject or "",
        snippet=event.snippet or "",
        kind=event.kind or "other",
        company=event.company or "",
        job_title=event.job_title or "",
        confidence=float(event.confidence or 0.0),
        method=event.method or "",
        interview_at=event.interview_at or "",
        evidence=event.evidence or "",
        application_id=event.application_id,
        action=event.action or "",
        prev_status=event.prev_status or "",
        new_status=event.new_status or "",
        set_interviewed=bool(event.set_interviewed),
        created_at=_iso(event.created_at),
        gmail_url=gmail_url(event, mailbox_email),
    )


# --- one run -------------------------------------------------------------------------
@dataclass
class _Card:
    """A card as matching reads it — plain values, so the commit after every
    message does not turn each match into one refresh query per card."""

    id: int
    company: str
    job_title: str
    status: str
    status_source: str
    source: str
    status_changed_at: datetime | None
    created_at: datetime | None
    company_key: str = ""

    @classmethod
    def of(cls, app: Application) -> "_Card":
        return cls(
            id=app.id, company=app.company or "", job_title=app.job_title or "", status=app.status or "saved",
            status_source=app.status_source or "", source=app.source or "",
            status_changed_at=inbox_apply.utc(app.status_changed_at), created_at=inbox_apply.utc(app.created_at),
            company_key=inbox_rules.normalize_company(app.company or ""),
        )


@dataclass
class _Staged:
    meta: MessageMeta
    stage: str  # noise | rule | model | skip
    verdict: Verdict | None = None
    outcome: str = ""  # model only: ok | gone | unclassifiable | failed | uncharged


@dataclass
class _Run:
    db: Session
    user_id: int
    settings: Settings
    box: Mailbox
    client: LLMClient
    clock: Callable[[], float]
    started: float
    budget_s: float
    max_messages: int
    meta_cap: int
    result: InboxSyncResult
    cards: list[_Card]
    exclude: tuple[str, ...]
    handled: int = 0

    def over_budget(self) -> bool:
        return self.budget_s > 0 and self.clock() - self.started >= self.budget_s

    def spent(self) -> bool:
        return self.over_budget() or self.handled >= self.max_messages


def sync_user(
    db: Session,
    user_id: int,
    *,
    mailbox: Mailbox | None = None,
    budget_s: float | None = None,
    clock: Callable[[], float] = time.monotonic,
    now: datetime | None = None,
    max_messages: int | None = None,
) -> InboxSyncResult:
    """Read what is new in one user's mailbox and apply it to their tracker.

    `mailbox` replaces the provider (the smoke test); `budget_s` <= 0 means no
    time limit; `clock` and `now` are injectable so budgets and the 7-day reauth
    are testable without waiting.
    """
    s = get_settings()
    result = InboxSyncResult(user_id=user_id)
    budget = float(s.inbox_sync_budget_s if budget_s is None else budget_s)
    now = now or utc_now()
    try:
        conn = connection_for(db, user_id)
        if conn is None:
            result.error_code = "not_connected"
            return result
        user = db.get(User, user_id)
        if user is None or not user.is_active:
            result.error_code = "inactive"
            return result
        due = reauth_due_at(conn, s)
        if conn.status == "active" and due is not None and now >= due:
            # O3: Google ends a Testing-mode grant at 7 days whether or not we
            # ask; saying so on the date beats discovering it on a failed refresh.
            conn.status = "needs_reauth"
            conn.last_error = "reauth_due"
            db.commit()
        if conn.status != "active":
            result.error_code = conn.status or "error"
            return result
        conn_id = conn.id
        if not _take_lease(db, conn_id, now, budget):
            result.error_code = "sync_in_progress"
            return result
        try:
            _sync(db, conn_id, user_id, s, mailbox, budget, clock, now,
                  max_messages or s.inbox_max_messages_per_run, result)
        finally:
            _release_lease(db, conn_id)
    except Exception:  # noqa: BLE001 - never raises by contract; logged for Sentry
        log.exception("inbox sync failed for user %s", user_id)
        db.rollback()
        result.error_code = result.error_code or "internal"
        _note_error(db, user_id, result.error_code)
    return result


def _take_lease(db: Session, conn_id: int, now: datetime, budget_s: float) -> bool:
    hold = timedelta(seconds=budget_s * 2 + 60) if budget_s > 0 else timedelta(minutes=10)
    naive_now = now.astimezone(timezone.utc).replace(tzinfo=None)
    taken = db.execute(
        update(MailConnection)
        .where(
            MailConnection.id == conn_id,
            or_(MailConnection.sync_lock_until.is_(None), MailConnection.sync_lock_until < naive_now),
        )
        .values(sync_lock_until=naive_now + hold)
        .execution_options(synchronize_session=False)
    )
    db.commit()
    return bool(taken.rowcount)


def _release_lease(db: Session, conn_id: int) -> None:
    try:
        db.rollback()
        db.execute(
            update(MailConnection)
            .where(MailConnection.id == conn_id)
            .values(sync_lock_until=None)
            .execution_options(synchronize_session=False)
        )
        db.commit()
    except Exception:  # noqa: BLE001 - the lease expires on its own anyway
        db.rollback()


def _note_error(db: Session, user_id: int, code: str) -> None:
    try:
        conn = connection_for(db, user_id)
        if conn is not None:
            conn.last_error = code
            conn.last_sync_at = utc_now()
            db.commit()
    except Exception:  # noqa: BLE001 - bookkeeping on the failure path
        db.rollback()


def _fail(db: Session, conn: MailConnection, result: InboxSyncResult, code: str, *, reauth: bool = False) -> None:
    result.error_code = "needs_reauth" if reauth else code
    conn.last_error = code
    conn.last_sync_at = utc_now()
    if reauth:
        conn.status = "needs_reauth"
    db.commit()


def _open_mailbox(db: Session, conn: MailConnection, s: Settings, result: InboxSyncResult) -> Mailbox | None:
    if conn.provider == "fake":
        if not fake_enabled(s):
            _fail(db, conn, result, "fake_disabled")
            return None
        return inbox_fake.demo_mailbox(inbox_apply.utc(conn.connected_at) or utc_now())
    if not google_oauth.configured():
        _fail(db, conn, result, "google_not_configured")
        return None
    try:
        refresh_token = token_crypto.decrypt(conn.refresh_token_enc)
    except token_crypto.TokenKeyMissing:
        _fail(db, conn, result, "token_key_missing")  # the server's problem, not the user's
        return None
    except token_crypto.TokenUnreadable:
        _fail(db, conn, result, "token_unreadable", reauth=True)
        return None
    try:
        granted = google_oauth.refresh(refresh_token)
    except google_oauth.GoogleAuthError as e:
        _fail(db, conn, result, e.code, reauth=e.code in _REAUTH_CODES)
        return None
    if granted.get("scope") and not google_oauth.grants_gmail(granted):
        _fail(db, conn, result, "missing_scope", reauth=True)
        return None
    return GmailMailbox(str(granted["access_token"]))


def _sync(
    db: Session, conn_id: int, user_id: int, s: Settings, mailbox: Mailbox | None, budget: float,
    clock: Callable[[], float], now: datetime, max_messages: int, result: InboxSyncResult,
) -> None:
    started = clock()
    conn = db.get(MailConnection, conn_id)
    box = mailbox if mailbox is not None else _open_mailbox(db, conn, s, result)
    if box is None:
        return
    run = _Run(
        db=db, user_id=user_id, settings=s, box=box,
        client=inbox_classifier.get_inbox_llm_client(),
        clock=clock, started=started, budget_s=budget, max_messages=max(1, max_messages),
        meta_cap=max(2 * max_messages, 100), result=result,
        cards=[_Card.of(a) for a in db.execute(select(Application).where(Application.user_id == user_id)).scalars().all()],
        exclude=own_alert_senders(s),
    )
    horizon = _ms(now) - SETTLE_MS
    if not conn.window_lo_ms:
        conn.window_lo_ms = _ms(now) - max(1, conn.backfill_days or s.inbox_backfill_days) * DAY_MS
        db.commit()
    while True:
        conn = db.get(MailConnection, conn_id)
        lo = int(conn.window_lo_ms or 0)
        if lo >= horizon:
            break  # caught up with the present
        win_hi = min(lo + WINDOW_MS, horizon)
        list_lo = max(lo, int(conn.cursor_ms or 0) + 1)
        if list_lo >= win_hi:
            conn.window_lo_ms = win_hi  # already handled up to the window's end
            db.commit()
            continue
        if run.spent():
            result.has_more = True
            break
        ids, win_hi = _list_window(run, list_lo, win_hi)
        metas, complete = _read_metas(run, ids)
        if not complete:
            result.error_code = "gmail_error"
            result.has_more = True
            break
        if not _handle_window(run, conn_id, metas, list_lo, win_hi):
            result.has_more = True
            break
        conn = db.get(MailConnection, conn_id)
        conn.cursor_ms = max(int(conn.cursor_ms or 0), win_hi - 1)
        conn.window_lo_ms = win_hi
        db.commit()
    conn = db.get(MailConnection, conn_id)
    conn.last_sync_at = now
    conn.scanned_total = int(conn.scanned_total or 0) + result.scanned
    conn.events_total = int(conn.events_total or 0) + result.events
    if result.error_code:
        conn.last_error = result.error_code
    else:
        conn.last_success_at = now
        conn.last_error = ""
    db.commit()


def _list_window(run: _Run, lo_ms: int, hi_ms: int) -> tuple[list[str], int]:
    """The ids in [lo_ms, hi_ms) not yet stored, and the window end actually used.

    The query's second-granular bounds are widened by a second on each side and
    the exact millisecond window is applied after the metadata read, so a message
    on a boundary is listed in both windows and handled in exactly one.
    """
    while True:
        query = inbox_rules.build_query(lo_ms // 1000 - 1, hi_ms // 1000 + 1, run.exclude)
        shrinkable = hi_ms - lo_ms > MIN_WINDOW_MS
        ceiling = LIST_CEILING if shrinkable else LIST_HARD_STOP
        ids: list[str] = []
        token: str | None = None
        while True:
            page, token = run.box.list_ids(query, token)
            ids.extend(page)
            if not token or len(ids) >= ceiling:
                break
        ids = list(dict.fromkeys(ids))
        overflow = token is not None and len(ids) >= ceiling
        fresh = [] if overflow else _unstored(run, ids)
        if (overflow or len(fresh) > run.meta_cap) and shrinkable:
            hi_ms = lo_ms + (hi_ms - lo_ms) // 2
            continue
        return (fresh if not overflow else _unstored(run, ids)), hi_ms


def _unstored(run: _Run, ids: list[str]) -> list[str]:
    known: set[str] = set()
    for i in range(0, len(ids), 500):
        known.update(
            run.db.execute(
                select(MailEvent.provider_message_id).where(
                    MailEvent.user_id == run.user_id, MailEvent.provider_message_id.in_(ids[i:i + 500])
                )
            ).scalars().all()
        )
    return [i for i in ids if i not in known]


def _read_meta(box: Mailbox, msg_id: str) -> tuple[str, MessageMeta | None]:
    try:
        return "ok", box.get_meta(msg_id)
    except MessageGone:
        return "gone", None
    except Exception:  # noqa: BLE001 - classified by the caller
        return "failed", None


def _read_metas(run: _Run, ids: list[str]) -> tuple[list[MessageMeta], bool]:
    """Headers for every id, from a pool of POOL. A message that cannot be read
    at all makes the window incomplete: its date is unknown, so nothing after it
    can be handled without risking a cursor that jumps past it."""
    metas: list[MessageMeta] = []
    failed: list[str] = []
    if not ids:
        return metas, True
    with ThreadPoolExecutor(max_workers=POOL) as pool:
        futures = [(msg_id, pool.submit(copy_context().run, _read_meta, run.box, msg_id)) for msg_id in ids]
        for msg_id, future in futures:
            outcome, meta = future.result()
            if outcome == "ok" and meta is not None:
                metas.append(meta)
            elif outcome == "failed":
                failed.append(msg_id)
    for msg_id in failed:  # one retry, in order, before calling the window broken
        outcome, meta = _read_meta(run.box, msg_id)
        if outcome == "failed":
            return metas, False
        if meta is not None:
            metas.append(meta)
    return metas, True


def _stage(run: _Run, meta: MessageMeta) -> _Staged:
    """The deterministic stage for one message (inbox_rules)."""
    if inbox_rules.noise_reason(meta, run.exclude):
        return _Staged(meta, "noise")
    verdict = inbox_rules.template_verdict(meta)
    if verdict is not None:
        if not verdict.job_title and verdict.kind in ("confirmation", "viewed"):
            # I7: the role is what later mail is matched by; a Gmail read, no model.
            try:
                body = run.box.get_body(meta.id)
            except Exception:  # noqa: BLE001 - a title is worth a read, not a failure
                body = ""
            verdict = inbox_rules.template_verdict(meta, body) or verdict
        return _Staged(meta, "rule", verdict)
    if inbox_rules.candidate_reason(meta):
        return _Staged(meta, "model")
    return _Staged(meta, "skip")


def _handle_window(run: _Run, conn_id: int, metas: list[MessageMeta], list_lo: int, win_hi: int) -> bool:
    """Handle one window's messages oldest first. True when all of it is done."""
    cursor = int(run.db.get(MailConnection, conn_id).cursor_ms or 0)
    ordered = sorted(
        (m for m in metas if list_lo <= m.internal_ms < win_hi and m.internal_ms > cursor),
        key=lambda m: (m.internal_ms, m.id),
    )
    groups: list[list[MessageMeta]] = []
    for meta in ordered:
        if groups and groups[-1][0].internal_ms == meta.internal_ms:
            groups[-1].append(meta)
        else:
            groups.append([meta])
    position = 0
    while position < len(groups):
        if run.spent():
            return False
        chunk: list[list[_Staged]] = []
        model_calls = 0
        pending = 0
        while position < len(groups) and model_calls < CHUNK and run.handled + pending < run.max_messages:
            staged = [_stage(run, meta) for meta in groups[position]]
            chunk.append(staged)
            model_calls += sum(1 for st in staged if st.stage == "model")
            pending += len(staged)
            position += 1
        if not _process_chunk(run, conn_id, chunk):
            return False
    return True


def _charge(run: _Run, wanted: int) -> int:
    """Charge up to `wanted` uses of the inbox cap; returns how many are allowed.
    What is LEFT is charged, not all-or-nothing, so the last calls of a day are
    not lost to one batch that would have crossed the line."""
    user = run.db.get(User, run.user_id)
    cap = run.settings.daily_inbox_cap
    if user is None:
        return 0
    if user.is_admin or cap <= 0:
        return wanted
    allowed = max(0, min(wanted, cap - used_today(run.db, run.user_id, INBOX_ACTION)))
    if allowed:
        try:
            check_and_count(run.db, user, INBOX_ACTION, cap, count=allowed)
        except HTTPException:
            return 0
    return allowed


def _classify_one(box: Mailbox, meta: MessageMeta, client: LLMClient) -> tuple[str, Verdict | None]:
    try:
        body = box.get_body(meta.id)
    except MessageGone:
        return "gone", None
    except Exception:  # noqa: BLE001 - a mailbox failure stops the run
        return "failed", None
    try:
        return "ok", inbox_classifier.classify(meta, body, client=client)
    except (OutputTruncated, ContextWindowExceeded, JSONDecodeError, ValueError, TypeError, KeyError):
        # Deterministic for this message: retrying it forever would block every
        # message after it. Skipped, unstored.
        return "unclassifiable", None
    except Exception:  # noqa: BLE001 - a network or provider error stops the run
        return "failed", None


def _classify(run: _Run, items: list[_Staged]) -> None:
    with metering.meter() as tally:
        with ThreadPoolExecutor(max_workers=POOL) as pool:
            futures = [pool.submit(copy_context().run, _classify_one, run.box, st.meta, run.client) for st in items]
            outcomes = [future.result() for future in futures]
    for staged, (outcome, verdict) in zip(items, outcomes):
        staged.outcome, staged.verdict = outcome, verdict
        if outcome in ("ok", "unclassifiable"):
            run.result.llm_calls += 1
    record_tokens(run.db, run.user_id, tally.prompt, tally.completion, action=INBOX_TOKENS_ACTION)


def _process_chunk(run: _Run, conn_id: int, chunk: list[list[_Staged]]) -> bool:
    wanted = [st for group in chunk for st in group if st.stage == "model"]
    if wanted:
        allowed = _charge(run, len(wanted))
        if allowed:
            _classify(run, wanted[:allowed])
        for staged in wanted[allowed:]:
            staged.outcome = "uncharged"
    for group in chunk:
        stuck = [st for st in group if st.stage == "model" and st.outcome in ("failed", "uncharged")]
        if stuck:
            run.db.rollback()
            run.result.error_code = "daily_limit" if any(st.outcome == "uncharged" for st in stuck) else "classify_failed"
            return False
        for staged in group:
            _apply(run, staged)
        run.db.get(MailConnection, conn_id).cursor_ms = group[0].meta.internal_ms
        run.db.commit()  # the group and the cursor move together
    return True


def _apply(run: _Run, staged: _Staged) -> None:
    run.handled += 1
    run.result.scanned += 1
    if staged.stage == "noise":
        run.result.noise += 1
        return
    if staged.stage == "skip" or staged.verdict is None:
        return
    if staged.stage == "rule":
        run.result.rule_hits += 1
    verdict = staged.verdict
    received = inbox_apply.received_at_of(staged.meta)
    plan = inbox_apply.plan(run.cards, verdict, received, run.settings.inbox_review_threshold)
    if plan.action == "skip":
        return
    event = inbox_apply.new_event(run.user_id, staged.meta, verdict, received)
    run.db.add(event)
    app = inbox_apply.execute(run.db, run.user_id, event, verdict, plan, received)
    run.result.events += 1
    if event.action == "created" and app is not None:
        run.result.created += 1
        run.cards.append(_Card.of(app))
    elif event.action in ("updated", "linked") and app is not None:
        if event.action == "updated":
            run.result.updated += 1
        for index, card in enumerate(run.cards):
            if card.id == app.id:
                run.cards[index] = _Card.of(app)
    elif event.action == "review":
        run.result.review += 1


# --- the cron -------------------------------------------------------------------------
def due_user_ids(db: Session) -> list[int]:
    """Active auto-sync connections of active users, NEVER-SYNCED FIRST, then the
    longest-unsynced. An explicit CASE, not NULLS FIRST: SQLite and Postgres put
    NULLs at opposite ends, the precedent `alerts.due_user_ids` records."""
    rows = db.execute(
        select(MailConnection.user_id)
        .join(User, User.id == MailConnection.user_id)
        .where(MailConnection.status == "active", MailConnection.auto_sync.is_(True), User.is_active.is_(True))
        .order_by(
            case((MailConnection.last_sync_at.is_(None), 0), else_=1),
            MailConnection.last_sync_at.asc(),
            MailConnection.user_id,
        )
    ).scalars().all()
    return [uid for uid in rows if uid is not None]


def run_all_inbox(
    db: Session,
    *,
    budget_s: float | None = None,
    clock: Callable[[], float] = time.monotonic,
    mailbox_for: Callable[[int], Mailbox | None] | None = None,
    now: datetime | None = None,
) -> tuple[list[InboxSyncResult], int]:
    """One cron tick: sync every due user until the budget runs out. Returns
    (results, skipped). The budget is checked BEFORE starting a user, never
    mid-run — each user's own sync already stops cleanly at its own budget — and
    whoever is skipped is first in line on the next tick."""
    s = get_settings()
    budget = float(s.inbox_cron_budget_s if budget_s is None else budget_s)
    user_ids = due_user_ids(db)
    per_user = max(1.0, 2.0 * s.inbox_sync_budget_s)
    results: list[InboxSyncResult] = []
    started = clock()
    for i, uid in enumerate(user_ids):
        elapsed = clock() - started
        if budget > 0 and i and elapsed >= budget:
            break
        results.append(sync_user(
            db, uid,
            mailbox=mailbox_for(uid) if mailbox_for is not None else None,
            budget_s=min(per_user, max(1.0, budget - elapsed)) if budget > 0 else 0,
            clock=clock,
            now=now,
            max_messages=s.inbox_max_messages_per_run * CRON_MESSAGE_FACTOR,
        ))
    return results, len(user_ids) - len(results)
