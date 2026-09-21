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

SPAM IS PARKED, NEVER READ (P29-SPAM-RESCUE). `messages.list` leaves Spam out,
and "Not spam" keeps a message's id and its ORIGINAL internalDate, so a reply
rescued after the cursor passed its date was never imported — the same class of
defect as the unindexed message above. Each window is also listed for Spam, and
the job mail Gmail filed there is parked by its id alone: no read, no model, no
charge. When the default listing names a parked id again, the user rescued it:
the ordinary walk handles it in date order while the cursor has not reached it,
and the release pass (`_release_parked`) once it has — a pass that never moves
the cursor. Either way the parked row goes in the same commit as the result.

Metering (amendment I8): every model call runs inside this module's own
`metering.meter()`, from a pool whose submits carry `copy_context().run` — a
worker thread starts from an EMPTY context and would lose the tally — and the total
is written under `inbox_tokens`. The only other charge is the `inbox` daily cap,
counted before each batch of model calls. Never the `llm` cap.
"""
from __future__ import annotations

import logging
import os
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from json import JSONDecodeError
from typing import Callable
from urllib.parse import quote

from fastapi import HTTPException
from sqlalchemy import case, delete, func, or_, select, update
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
# FIXB B3: the two MailEvent actions a message that cannot be read or classified
# gets. `failed` marks the first failure (the next run retries it, uncharged);
# `skipped` is the second, and the import moves past it. Either row holds the
# provider id and an error code in `evidence` — never a subject, a snippet, a
# sender or a body.
FAILED = "failed"
SKIPPED = "skipped"
# P29-SPAM-RESCUE: job mail Gmail filed in Spam when its window was listed. The
# row holds the provider id and nothing about the mail: evidence is `spam` while
# the message has never been charged, and the error code once a release of it
# has been charged and failed (so the retry is free). `received_at` is the Spam
# listing's lower bound — a "not before" for the release listing, never shown.
PARKED = "parked"
SPAM_EVIDENCE = "spam"
# Gmail deletes Spam after 30 days, counted from when it arrived there, which is
# no later than the run that parked it; a day of slack, then the row goes.
PARK_DAYS = 31


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


def inbox_allowed(settings: Settings, user: User) -> bool:
    """O2: who may use Gmail sync. Anything but INBOX_ACCESS=all is the allowlist.

    Checked at connect time AND by every sync and the cron (FIXB B15): an owner
    who clears `inbox_enabled` — to free one of Google's Testing-mode test-user
    slots, or to end the beta for someone — must stop the mailbox being read,
    not only stop a new connect."""
    s = settings
    return (s.inbox_access or "").strip().lower() == "all" or bool(user.is_admin) or bool(user.inbox_enabled)


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
    except Exception as exc:  # noqa: BLE001 - best effort by contract
        # FIXB B17: say so, and return False — every caller now REPORTS this
        # value, so a disconnect with an unreadable token never claims a revoke.
        # The type only: the exception text is not ours to send to Sentry.
        log.warning("inbox: a stored Gmail grant could not be read (%s) and was not revoked", type(exc).__name__)
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
    outcome: str = ""  # model only: ok | gone | unclassifiable | failed | uncharged | skipped
    retried: bool = False  # model only: an earlier run failed on this message and was charged (FIXB B3)
    error: str = ""  # model only, on failure: body_failed | model_failed
    # A `failed` or `parked` row holds this id: `_apply` consumes it, whatever the
    # stage and whatever the outcome (P29-SPAM-RESCUE).
    marked: bool = False


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
    now: datetime | None = None  # the run's clock: when a row is parked, and the prune's "31 days ago"

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
        if conn.provider != "fake" and not inbox_allowed(s, user):
            # FIXB B15: no longer on the O2 allowlist — the mailbox is not read,
            # the grant is not refreshed and no model call is spent. The demo
            # mailbox reads nobody's mail, so it is exempt, as at connect time.
            result.error_code = "invite_only"
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
    except Exception as exc:  # noqa: BLE001 - never raises by contract; logged for Sentry
        # FIXB B2: the exception TYPE and where it happened, nothing more. A
        # traceback carries every frame's locals to Sentry (the settings and the
        # message metadata being handled), and an exception's own text can quote
        # a subject — neither is ours to send.
        log.error("inbox sync failed for user %s: %s", user_id, _failure_site(exc))
        db.rollback()
        result.error_code = result.error_code or "internal"
        _note_error(db, user_id, result.error_code)
    return result


def _failure_site(exc: BaseException) -> str:
    """`TypeName at file.py:123 in function` — the innermost frame's location only."""
    frames = traceback.extract_tb(exc.__traceback__)
    if not frames:
        return type(exc).__name__
    last = frames[-1]
    return f"{type(exc).__name__} at {os.path.basename(last.filename)}:{last.lineno} in {last.name}"


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
        now=now,
    )
    horizon = _ms(now) - SETTLE_MS
    if not conn.window_lo_ms:
        conn.window_lo_ms = _ms(now) - max(1, conn.backfill_days or s.inbox_backfill_days) * DAY_MS
        db.commit()
    # P29-SPAM-RESCUE: first what the user rescued from Spam after the cursor
    # passed it. A release that stops — its budget, the daily cap, a failure it
    # was charged for — stops the run, as a stuck message in a window does.
    walk = _release_parked(run, conn_id)
    if not walk:
        result.has_more = True
    while walk:
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
        # After the listing has settled the window: a halved window is parked
        # over its halved bounds, never over the ones the halving abandoned.
        _park(run, list_lo, win_hi, ids)
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


def _ids_with_rows(
    run: _Run, ids: list[str], *, ignore: tuple[str, ...] = (), only: tuple[str, ...] = ()
) -> set[str]:
    """Which of `ids` have a row — not counting rows whose action is in `ignore`,
    and only rows whose action is in `only` when that is given."""
    known: set[str] = set()
    for i in range(0, len(ids), 500):
        query = select(MailEvent.provider_message_id).where(
            MailEvent.user_id == run.user_id,
            MailEvent.provider_message_id.in_(ids[i:i + 500]),
        )
        if ignore:
            query = query.where(MailEvent.action.not_in(ignore))
        if only:
            query = query.where(MailEvent.action.in_(only))
        known.update(run.db.execute(query).scalars().all())
    return known


def _unstored(run: _Run, ids: list[str]) -> list[str]:
    """Ids with no stored row. A `failed` marker does not count as stored, so a
    message that failed once is listed again for its one retry (FIXB B3); nor
    does a `parked` row, so a message rescued from Spam before the cursor reached
    it is handled in order like any other (P29-SPAM-RESCUE)."""
    known = _ids_with_rows(run, ids, ignore=(FAILED, PARKED))
    return [i for i in ids if i not in known]


def _list_all(run: _Run, query: str) -> list[str]:
    """Every id one query lists, page by page, up to LIST_HARD_STOP."""
    ids: list[str] = []
    token: str | None = None
    while True:
        page, token = run.box.list_ids(query, token)
        ids.extend(page)
        if not token or len(ids) >= LIST_HARD_STOP:
            break
    return list(dict.fromkeys(ids))


def _park(run: _Run, list_lo: int, win_hi: int, listed: list[str]) -> None:
    """P29-SPAM-RESCUE: remember, by id alone, the job mail Gmail filed in Spam
    inside the window just listed — so that if the user rescues it after the
    cursor has passed its date, the release pass can still bring it in.

    Parked = what Gmail's own Spam listing names, minus what the default listing
    just named (`listed`), minus every id that already has a row of any kind.
    That last filter is load-bearing: a window stopped by its budget is listed
    again, and an insert over an id that already has a row (still parked, or
    imported and moved to Spam since) is refused by uq_mail_events_message, whose
    rollback takes every NEW park beside it along — a reply filed in Spam since,
    and rescued later, would then be lost for good.
    Nothing is read — no headers, no body — no model is called, and nothing is
    charged: mail that stays in Spam is never imported, exactly as before.

    Fails toward today's behaviour on every piece of Gmail behaviour the offline
    suite cannot confirm: if Google ignored `in:spam`, the default listing's ids
    are subtracted; if it ignored `includeSpamTrash`, nothing is listed; and if
    the listing fails outright, nothing is parked and the window goes on — a
    listing Gmail refuses may never stall the import.

    This listing runs AFTER the default one, because it needs the window the
    halving settled on, and that order leaves one race (accepted): a message
    RESCUED between the two listings is in neither — not in the inbox when the
    inbox was listed, no longer in Spam when Spam is — so it is never parked,
    and once the cursor passes its date it is missed. A message moved INTO Spam
    between them was already named by the default listing and is handled as
    inbox mail — read and classified although it now sits in Spam, exactly as
    before this fix."""
    query = inbox_rules.build_query(list_lo // 1000 - 1, win_hi // 1000 + 1, run.exclude, spam=True)
    try:
        spam = _list_all(run, query)
    except Exception as exc:  # noqa: BLE001 - fail toward today's behaviour, never toward a stalled import
        log.warning("inbox: the Spam listing failed (%s); nothing parked for this window", type(exc).__name__)
        return
    default = set(listed)
    candidates = [i for i in spam if i not in default]
    if not candidates:
        return
    known = _ids_with_rows(run, candidates)
    fresh = [i for i in candidates if i not in known]
    if not fresh:
        return
    bound = datetime.fromtimestamp(max(0, list_lo // 1000 - 1), timezone.utc)
    try:
        for msg_id in fresh:
            run.db.add(MailEvent(
                user_id=run.user_id, provider_message_id=msg_id[:64], action=PARKED, evidence=SPAM_EVIDENCE,
                received_at=bound, created_at=run.now or utc_now(),
            ))
        run.db.commit()
    except Exception as exc:  # noqa: BLE001 - bookkeeping; the window itself is unaffected
        run.db.rollback()
        log.warning("inbox: parked Spam ids could not be stored (%s)", type(exc).__name__)


def drop_parked(db: Session, user_id: int) -> int:
    """Delete a user's parked Spam ids. For a reconnect to a DIFFERENT mailbox
    (FIXB B8): the old mailbox's ids can never appear in the new one's listings.
    No commit."""
    return int(db.execute(
        delete(MailEvent)
        .where(MailEvent.user_id == user_id, MailEvent.action == PARKED)
        .execution_options(synchronize_session=False)
    ).rowcount or 0)


def _naive_utc(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def _read_each(run: _Run, ids: list[str]) -> list[tuple[str, str, MessageMeta | None]]:
    """(id, outcome, meta) for every id, from a pool of POOL. Unlike `_read_metas`
    a failed read does not end the batch: a released message has no cursor behind
    it that a gap could jump."""
    if not ids:
        return []
    with ThreadPoolExecutor(max_workers=POOL) as pool:
        futures = [(msg_id, pool.submit(copy_context().run, _read_meta, run.box, msg_id)) for msg_id in ids]
        return [(msg_id, *future.result()) for msg_id, future in futures]


def _release_parked(run: _Run, conn_id: int) -> bool:
    """P29-SPAM-RESCUE: import what the user rescued from Spam AFTER the cursor
    passed it. False when the run should stop here (its budget, the daily cap, or
    a failure it was charged for); `has_more` then says there is more to do.

    One default-query listing over [the oldest parked row's bound, the cursor],
    made only while the run still has budget; the ids in it that have a `parked`
    row are the rescued ones. Only those are touched, so ordinary mail below the
    cursor is never read or classified again. The listing stops at
    LIST_HARD_STOP ids and Gmail lists newest first, so past that many matching
    messages the OLDEST parked rows are not reached (accepted).
    Each rescued id goes through the ordinary stages — metadata, rules, the charge, the
    model — and `_apply` consumes its parked row in the same commit as the
    tracker write. The cursor is NEVER written here: a rewind would make the next
    run list a half-handled window again and re-charge its unstored mail.

    Anything read above the cursor is left alone — the ordinary walk owns it and
    will list it, and classifying it here too would charge it twice. A failed read
    leaves its row untouched and uncharged for the next run; a message Gmail no
    longer has takes its row with it. Rows parked more than PARK_DAYS ago are
    pruned first, unread: Gmail has deleted that Spam."""
    db = run.db
    now = run.now or utc_now()
    db.execute(
        delete(MailEvent)
        .where(
            MailEvent.user_id == run.user_id,
            MailEvent.action == PARKED,
            MailEvent.created_at < _naive_utc(now - timedelta(days=PARK_DAYS)),
        )
        .execution_options(synchronize_session=False)
    )
    db.commit()
    oldest = db.execute(
        select(func.min(MailEvent.received_at)).where(MailEvent.user_id == run.user_id, MailEvent.action == PARKED)
    ).scalar()
    oldest_at = inbox_apply.utc(oldest)
    if oldest_at is None:
        return True
    lo_ms = _ms(oldest_at)
    cursor = int(db.get(MailConnection, conn_id).cursor_ms or 0)
    if cursor <= lo_ms:
        return True  # nothing parked is behind the cursor yet — or a fresh import reset it to 0
    if run.spent():
        return False
    listed = _list_all(run, inbox_rules.build_query(lo_ms // 1000 - 1, cursor // 1000 + 1, run.exclude))
    parked = _ids_with_rows(run, listed, only=(PARKED,))
    rescued = [msg_id for msg_id in listed if msg_id in parked]
    if not rescued:
        return True
    if len(rescued) > run.meta_cap:
        rescued = rescued[:run.meta_cap]
        run.result.has_more = True
    metas: list[MessageMeta] = []
    gone: list[str] = []
    for msg_id, outcome, meta in _read_each(run, rescued):
        if outcome == "gone":
            gone.append(msg_id[:64])
        elif outcome == "ok" and meta is not None and meta.internal_ms <= cursor:
            metas.append(meta)
    if gone:
        db.execute(
            delete(MailEvent)
            .where(MailEvent.user_id == run.user_id, MailEvent.action == PARKED,
                   MailEvent.provider_message_id.in_(gone))
            .execution_options(synchronize_session=False)
        )
        db.commit()
    return _handle_ordered(run, conn_id, sorted(metas, key=lambda m: (m.internal_ms, m.id)), release=True)


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
    return _handle_ordered(run, conn_id, ordered)


def _handle_ordered(run: _Run, conn_id: int, ordered: list[MessageMeta], *, release: bool = False) -> bool:
    """Handle messages already in date order, in chunks between budget checks.
    True when all of them are done. `release` (the Spam release pass) handles
    them without ever moving the cursor."""
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
        if not _process_chunk(run, conn_id, chunk, release=release):
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


def _classify_one(box: Mailbox, meta: MessageMeta, client: LLMClient) -> tuple[str, Verdict | None, str]:
    """(outcome, verdict, error code on failure)."""
    try:
        body = box.get_body(meta.id)
    except MessageGone:
        return "gone", None, ""
    except Exception:  # noqa: BLE001 - a mailbox failure stops the run (once; see _process_chunk)
        return "failed", None, "body_failed"
    try:
        return "ok", inbox_classifier.classify(meta, body, client=client), ""
    except (OutputTruncated, ContextWindowExceeded, JSONDecodeError, ValueError, TypeError, KeyError):
        # Deterministic for this message: retrying it forever would block every
        # message after it. Skipped, unstored.
        return "unclassifiable", None, ""
    except Exception:  # noqa: BLE001 - a network or provider error stops the run (once)
        return "failed", None, "model_failed"


def _classify(run: _Run, items: list[_Staged]) -> None:
    if not items:
        return
    with metering.meter() as tally:
        with ThreadPoolExecutor(max_workers=POOL) as pool:
            futures = [pool.submit(copy_context().run, _classify_one, run.box, st.meta, run.client) for st in items]
            outcomes = [future.result() for future in futures]
    for staged, (outcome, verdict, error) in zip(items, outcomes):
        staged.outcome, staged.verdict, staged.error = outcome, verdict, error
        if outcome in ("ok", "unclassifiable"):
            run.result.llm_calls += 1
    record_tokens(run.db, run.user_id, tally.prompt, tally.completion, action=INBOX_TOKENS_ACTION)


def _markers(run: _Run, ids: list[str]) -> dict[str, tuple[str, str]]:
    """{id: (action, evidence)} for the ids a `failed` or `parked` row holds."""
    if not ids:
        return {}
    return {
        msg_id: (action, evidence or "")
        for msg_id, action, evidence in run.db.execute(
            select(MailEvent.provider_message_id, MailEvent.action, MailEvent.evidence).where(
                MailEvent.user_id == run.user_id,
                MailEvent.action.in_((FAILED, PARKED)),
                MailEvent.provider_message_id.in_([(i or "")[:64] for i in ids]),
            )
        ).all()
    }


def _charged_before(marker: tuple[str, str]) -> bool:
    """An earlier run failed on this message AND was charged for it (FIXB B3): a
    `failed` marker, or a parked row whose release failed once — its evidence is
    then the error code instead of `spam` (P29-SPAM-RESCUE)."""
    action, evidence = marker
    return action == FAILED or (action == PARKED and evidence != SPAM_EVIDENCE)


def _remember_failures(run: _Run, items: list[_Staged], *, keep_parked: bool = False) -> None:
    """Mark each message that failed for the first time — it was charged — so its
    retry is free: the id and an error code, nothing about the mail itself.

    One row per id (`uq_mail_events_message`), so a message whose id already has
    a row is UPDATED in place, never inserted over (P29-SPAM-RESCUE): a `parked`
    row becomes the `failed` marker on the ordinary walk, and keeps `parked`
    with the error as its evidence on the release pass (`keep_parked`) — which
    selects parked rows only, so a `failed` one would be stranded behind a cursor
    that has already passed it. Each row commits on its own, so one conflict can
    never roll back the others' markers. Best effort — a concurrent run that
    stored the id first changes nothing, since the next run retries anyway."""
    for staged in items:
        msg_id = (staged.meta.id or "")[:64]
        error = staged.error or "failed"
        try:
            row = run.db.execute(
                select(MailEvent).where(MailEvent.user_id == run.user_id, MailEvent.provider_message_id == msg_id)
            ).scalars().first()
            if row is None:
                run.db.add(MailEvent(user_id=run.user_id, provider_message_id=msg_id, action=FAILED, evidence=error))
            elif row.action == PARKED:
                if not keep_parked:
                    row.action = FAILED
                row.evidence = error
            else:
                continue  # stored meanwhile; the next run decides
            run.db.commit()
        except Exception:  # noqa: BLE001 - bookkeeping on the failure path
            run.db.rollback()


def _process_chunk(run: _Run, conn_id: int, chunk: list[list[_Staged]], *, release: bool = False) -> bool:
    """Classify one chunk and apply it group by group, the cursor moving with each
    — unless `release` (the Spam release pass), which never moves it.

    Failure isolation (FIXB B3). A message whose body read or model call fails
    stops the run at that message the FIRST time — a network blip must not skip
    real mail — and leaves a `failed` marker. The next run retries it WITHOUT
    charging the daily cap again; if it fails a second time it is recorded as
    `skipped` and the import moves past it. Before this, one unreadable message
    re-charged the whole chunk on every run and nothing after it was ever
    imported."""
    staged_all = [st for group in chunk for st in group]
    markers = _markers(run, [st.meta.id for st in staged_all])
    for staged in staged_all:
        marker = markers.get((staged.meta.id or "")[:64])
        staged.marked = marker is not None
        staged.retried = staged.stage == "model" and marker is not None and _charged_before(marker)
    wanted = [st for st in staged_all if st.stage == "model"]
    if wanted:
        fresh = [st for st in wanted if not st.retried]
        allowed = _charge(run, len(fresh)) if fresh else 0
        _classify(run, [st for st in wanted if st.retried] + fresh[:allowed])
        for staged in fresh[allowed:]:
            staged.outcome = "uncharged"
        for staged in wanted:
            if staged.retried and staged.outcome == "failed":
                staged.outcome = SKIPPED  # the second failure of the same message
    for index, group in enumerate(chunk):
        stuck = [st for st in group if st.stage == "model" and st.outcome in ("failed", "uncharged")]
        if stuck:
            run.db.rollback()
            run.result.error_code = "daily_limit" if any(st.outcome == "uncharged" for st in stuck) else "classify_failed"
            # Every first failure from here on was charged; mark each so its
            # retry is free.
            _remember_failures(run, [
                st for later in chunk[index:] for st in later if st.stage == "model" and st.outcome == "failed"
            ], keep_parked=release)
            return False
        for staged in group:
            _apply(run, staged)
        if not release:
            # The release pass handles mail BELOW the cursor: moving the cursor
            # there would rewind it, and the next run would list a half-handled
            # window again and re-charge its unstored mail (P29-SPAM-RESCUE).
            run.db.get(MailConnection, conn_id).cursor_ms = group[0].meta.internal_ms
        run.db.commit()  # the group and the cursor move together
    return True


def _apply(run: _Run, staged: _Staged) -> None:
    run.handled += 1
    run.result.scanned += 1
    if staged.marked or staged.retried:
        # A `failed` or `parked` row holds this id. It is consumed HERE, before
        # any early return below — noise, a skip, not a job, a message gone — and
        # in the same commit as whatever the email does (P29-SPAM-RESCUE): a
        # parked row that outlived its message would be released, classified and
        # charged again on every run, and one left beside a new event is a second
        # row for the id, which the unique constraint refuses.
        marker = run.db.execute(
            select(MailEvent).where(
                MailEvent.user_id == run.user_id,
                MailEvent.provider_message_id == (staged.meta.id or "")[:64],
                MailEvent.action.in_((FAILED, PARKED)),
            )
        ).scalars().first()
        if staged.outcome == SKIPPED:
            if marker is None:
                marker = MailEvent(user_id=run.user_id, provider_message_id=(staged.meta.id or "")[:64])
                run.db.add(marker)
            marker.action = SKIPPED
            marker.evidence = staged.error or "failed"
            return
        if marker is not None:
            # Read fine this time: the marker gives way to whatever the email is.
            run.db.execute(delete(MailEvent).where(MailEvent.id == marker.id).execution_options(
                synchronize_session=False))
            run.db.expunge(marker)
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
    # recheck: the plan came from the run-start snapshot; the card may have moved
    # since (FIXB B9).
    app = inbox_apply.execute(run.db, run.user_id, event, verdict, plan, received, recheck=True)
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
    NULLs at opposite ends, the precedent `alerts.due_user_ids` records.

    Gmail connections of users the O2 allowlist no longer names are left out
    (FIXB B15, the same rule as `inbox_allowed`); the demo mailbox is exempt."""
    query = (
        select(MailConnection.user_id)
        .join(User, User.id == MailConnection.user_id)
        .where(MailConnection.status == "active", MailConnection.auto_sync.is_(True), User.is_active.is_(True))
    )
    if (get_settings().inbox_access or "").strip().lower() != "all":
        query = query.where(or_(
            MailConnection.provider == "fake", User.is_admin.is_(True), User.inbox_enabled.is_(True)
        ))
    rows = db.execute(
        query
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
