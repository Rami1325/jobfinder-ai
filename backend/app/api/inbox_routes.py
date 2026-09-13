"""The Gmail inbox routes (Phase 29 / B2): a thin door onto app/core/inbox_*.

Rules every route here keeps:

- **Every /inbox route takes plain `Depends(current_user)`** (amendment I8), never
  `llm_user` or `metered_user`. A sync bills itself — the `inbox` daily cap and
  the `inbox_tokens` row — so opening the tracker never spends the per-day `llm`
  cap that the interview and cover-letter routes need. The callback and the cron
  are the two exceptions, because neither can carry a credential header: both are
  `_AUTH_OPTIONAL` in app/main.py and each authenticates itself (the OAuth state
  plus its binding cookie; the cron's Bearer secret).
- **Settings are read per request**, never captured at import: the smoke test
  flips the demo mailbox, the Google client and CRON_SECRET mid-suite.
- Refusals are structured `{"code": ...}` details, translated client-side.
- **No response carries a refresh token**, encrypted or not.
"""
from __future__ import annotations

import hmac
import json
import secrets
from datetime import timedelta
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.config import Settings, get_settings
from app.core import accounts, google_oauth, inbox_apply, inbox_sync, token_crypto
from app.core.gmail_api import GmailMailbox, MessageGone
from app.core.inbox_fake import DEMO_EMAIL
from app.core.sessions import cookie_path, hkey, is_https, token_hash
from app.db.database import get_db
from app.db.models import AuthToken, MailConnection, MailEvent, User
from app.db.users import ensure_admin
from app.models import (
    InboxCronResult,
    InboxDisconnectOut,
    InboxEventOut,
    InboxResolveIn,
    InboxSettingsIn,
    InboxStartIn,
    InboxStartOut,
    InboxStatus,
    InboxSyncResult,
)

router = APIRouter()

INBOX_CONNECT = "inbox_connect"
# Binds the Google round trip to the browser that started it (amendment O1).
OAUTH_COOKIE = "jf_oauth"
STATE_TTL = timedelta(minutes=10)
MIN_DAYS, MAX_DAYS = 7, 180


def _private(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


def _allowed(s: Settings, user: User) -> bool:
    """O2: who may connect Gmail. Anything but INBOX_ACCESS=all is the allowlist."""
    return (s.inbox_access or "").strip().lower() == "all" or bool(user.is_admin) or bool(user.inbox_enabled)


def _days(value: int | None, s: Settings) -> int:
    return max(MIN_DAYS, min(MAX_DAYS, int(value or s.inbox_backfill_days or 60)))


def _status(db: Session, user: User) -> InboxStatus:
    s = get_settings()
    fake = inbox_sync.fake_enabled(s)
    configured = inbox_sync.google_ready(s)
    google = configured and _allowed(s, user)
    ready = fake or google
    out = InboxStatus(
        ready=ready,
        reason="" if ready else ("invite_only" if configured else ""),
        google_ready=google,
        oauth_testing=bool(s.google_oauth_testing),
        backfill_days=_days(None, s),
    )
    conn = inbox_sync.connection_for(db, user.id)
    if conn is None:
        return out
    connected = inbox_apply.utc(conn.connected_at)
    due = inbox_sync.reauth_due_at(conn, s)
    out.connected = True
    out.provider = conn.provider or ""
    out.email = conn.email_address or ""
    out.status = conn.status or ""
    out.last_sync_at = conn.last_sync_at and inbox_apply.utc(conn.last_sync_at).isoformat()
    out.auto_sync = bool(conn.auto_sync)
    out.backfill_days = int(conn.backfill_days or out.backfill_days)
    out.review_count = int(db.execute(
        select(func.count()).select_from(MailEvent).where(MailEvent.user_id == user.id, MailEvent.action == "review")
    ).scalar() or 0)
    out.events_total = int(conn.events_total or 0)
    out.last_error_code = conn.last_error or ""
    out.reauth_due_at = due.isoformat() if due is not None else None
    if connected is not None and conn.window_lo_ms:
        out.backfilling = int(conn.window_lo_ms) < int(connected.timestamp() * 1000) - inbox_sync.SETTLE_MS
    return out


@router.get("/inbox/status", response_model=InboxStatus)
def inbox_status(
    response: Response, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> InboxStatus:
    _private(response)
    return _status(db, user)


# --- connecting --------------------------------------------------------------------
@router.post("/inbox/google/start", response_model=InboxStartOut)
def inbox_google_start(
    request: Request,
    response: Response,
    body: InboxStartIn | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> InboxStartOut:
    """The Google consent URL, and a short-lived `jf_oauth` cookie binding the
    round trip to THIS browser (O1): the state row keeps only an HMAC of the
    cookie, so a consent URL started anywhere else is useless without it."""
    _private(response)
    s = get_settings()
    if not inbox_sync.google_ready(s):
        raise HTTPException(404, detail={"code": "inbox_google_disabled"})
    if not _allowed(s, user):
        raise HTTPException(403, detail={"code": "invite_only"})
    now = inbox_sync.utc_now()
    verifier, challenge = google_oauth.pkce_pair()
    binding = secrets.token_urlsafe(32)
    raw_state = secrets.token_urlsafe(32)
    method = getattr(request.state, "auth_method", "") or ("dev" if not s.app_access_code else "invite_code")
    accounts.consume_tokens(db, user.id, (INBOX_CONNECT,), now)  # one live connect per account
    db.add(AuthToken(
        user_id=user.id,
        purpose=INBOX_CONNECT,
        token_hash=token_hash(raw_state),
        payload=json.dumps({
            "verifier": verifier,
            "binding": hkey("inbox-oauth", binding),
            "days": _days(body.backfill_days if body else None, s),
            "method": method,
        }),
        expires_at=now + STATE_TTL,
        created_at=now,
    ))
    login = accounts.login_for(db, user.id)
    hint = (login.email if login is not None else "") or user.email or ""
    db.commit()
    response.set_cookie(
        OAUTH_COOKIE, binding, max_age=int(STATE_TTL.total_seconds()), path=cookie_path(request),
        secure=is_https(request), httponly=True, samesite="lax",
    )
    return InboxStartOut(url=google_oauth.authorize_url(state=raw_state, code_challenge=challenge, login_hint=hint))


def _caller_id(request: Request, db: Session, s: Settings) -> int | None:
    """Who is completing the callback: the session the gate resolved, or — with
    the gate off, locally — the dev admin, the same fallback `current_user` makes."""
    user_id = getattr(request.state, "user_id", None)
    if user_id is not None:
        user = db.get(User, user_id)
        return user_id if user is not None and user.is_active else None
    if not s.app_access_code:
        return ensure_admin(db).id
    return None


@router.get("/inbox/google/callback")
def inbox_google_callback(
    request: Request,
    db: Session = Depends(get_db),
    code: str = "",
    state: str = "",
    error: str = "",
    iss: str = "",
) -> RedirectResponse:
    """Google sends the browser back here; it always leaves with a redirect.

    Refused unless ALL of (O1): the state row is live, the `jf_oauth` cookie
    matches it (constant time), and the browser is signed in as the account that
    started — no session sends a session-started flow to /login, another account
    is `state_mismatch`. One deliberate exception, recorded as a deviation: a flow
    STARTED with an invite code (the admin, the friends beta) can carry no session
    back, because that credential is a header a redirect cannot send, so for it
    the binding cookie is the proof — an attacker who never had the cookie cannot
    complete a flow in anyone else's browser either way.
    """
    s = get_settings()

    def leave(path: str) -> RedirectResponse:
        out = RedirectResponse(path, status_code=302)
        out.headers["Cache-Control"] = "no-store"
        out.delete_cookie(OAUTH_COOKIE, path=cookie_path(request), secure=is_https(request),
                          httponly=True, samesite="lax")
        return out

    def fail(reason: str) -> RedirectResponse:
        return leave("/settings?inbox=" + quote(reason, safe=""))

    if not inbox_sync.google_ready(s):
        return fail("not_configured")
    now = inbox_sync.utc_now()
    row = db.execute(
        select(AuthToken).where(AuthToken.token_hash == token_hash(state or ""), AuthToken.purpose == INBOX_CONNECT)
    ).scalars().first() if state and len(state) <= 128 else None
    if row is None or row.consumed_at is not None or row.user_id is None:
        return fail("state_invalid")
    if (inbox_apply.utc(row.expires_at) or now) <= now:
        return fail("state_expired")
    try:
        payload = json.loads(row.payload or "{}")
    except ValueError:
        payload = {}
    binding = request.cookies.get(OAUTH_COOKIE, "")
    expected = str(payload.get("binding") or "")
    if not binding or not expected or not hmac.compare_digest(hkey("inbox-oauth", binding), expected):
        return fail("state_mismatch")
    if iss and iss != "https://accounts.google.com":
        return fail("state_mismatch")
    caller = _caller_id(request, db, s)
    if caller is None:
        if payload.get("method") != "invite_code":
            return leave("/login?next=" + quote("/settings", safe=""))
    elif caller != row.user_id:
        return fail("state_mismatch")
    claimed = db.execute(
        update(AuthToken)
        .where(AuthToken.id == row.id, AuthToken.consumed_at.is_(None))
        .values(consumed_at=now)
        .execution_options(synchronize_session=False)
    ).rowcount
    db.commit()
    if not claimed:
        return fail("state_invalid")
    user = db.get(User, row.user_id)
    if user is None or not user.is_active:
        return fail("state_invalid")
    if not _allowed(s, user):
        return fail("invite_only")
    if error:
        return fail("access_denied" if error == "access_denied" else "google_error")
    if not code:
        return fail("state_invalid")
    try:
        tokens = google_oauth.exchange_code(code, str(payload.get("verifier") or ""))
    except google_oauth.GoogleAuthError:
        return fail("exchange_failed")
    if not google_oauth.grants_gmail(tokens):
        return fail("missing_scope")
    try:
        address = GmailMailbox(str(tokens.get("access_token") or "")).profile_email()
    except (google_oauth.GoogleAuthError, MessageGone):
        return fail("profile_failed")
    refresh_token = str(tokens.get("refresh_token") or "")
    conn = inbox_sync.connection_for(db, user.id)
    fresh = conn is None or conn.provider != "gmail"
    if fresh and not refresh_token:
        return fail("no_refresh_token")
    if conn is None:
        conn = MailConnection(user_id=user.id)
        db.add(conn)
    if fresh:
        days = _days(payload.get("days"), s)
        conn.backfill_days = days
        conn.cursor_ms = 0
        conn.window_lo_ms = int(now.timestamp() * 1000) - days * inbox_sync.DAY_MS
    if refresh_token:
        # Never overwritten with an empty value: a consent Google does not treat
        # as first returns no refresh token, and the stored one still works.
        conn.refresh_token_enc = token_crypto.encrypt(refresh_token)
    conn.provider = "gmail"
    conn.email_address = address[:320]
    conn.scope = str(tokens.get("scope") or "")
    conn.status = "active"
    conn.last_error = ""
    conn.connected_at = now
    conn.sync_lock_until = None
    db.commit()
    return leave("/tracker?inbox=connected")


@router.post("/inbox/fake/connect", response_model=InboxStatus)
def inbox_fake_connect(
    body: InboxStartIn | None = None, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> InboxStatus:
    """Connect the demo mailbox (app/core/inbox_fake.py). Always allowed where it
    exists — it reads no one's mail (O2)."""
    s = get_settings()
    if not inbox_sync.fake_enabled(s):
        raise HTTPException(404, detail={"code": "inbox_fake_disabled"})
    now = inbox_sync.utc_now()
    conn = inbox_sync.connection_for(db, user.id)
    if conn is None or conn.provider != "fake":
        inbox_sync.revoke_stored_grant(conn)
        if conn is None:
            conn = MailConnection(user_id=user.id)
            db.add(conn)
        days = _days(body.backfill_days if body else None, s)
        conn.provider = "fake"
        conn.email_address = DEMO_EMAIL
        conn.refresh_token_enc = ""
        conn.scope = ""
        conn.connected_at = now
        conn.backfill_days = days
        conn.cursor_ms = 0
        conn.window_lo_ms = int(now.timestamp() * 1000) - days * inbox_sync.DAY_MS
    conn.status = "active"
    conn.last_error = ""
    conn.sync_lock_until = None
    db.commit()
    return _status(db, user)


# --- using it ------------------------------------------------------------------------
@router.post("/inbox/sync", response_model=InboxSyncResult)
def inbox_sync_now(db: Session = Depends(get_db), user: User = Depends(current_user)) -> InboxSyncResult:
    return inbox_sync.sync_user(db, user.id, budget_s=get_settings().inbox_sync_budget_s)


def _mailbox_email(db: Session, user_id: int) -> str:
    conn = inbox_sync.connection_for(db, user_id)
    return (conn.email_address or "") if conn is not None and conn.provider == "gmail" else ""


@router.get("/inbox/events", response_model=list[InboxEventOut])
def inbox_events(
    view: str = "recent", limit: int = 50, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> list[InboxEventOut]:
    """`review`: emails waiting for the user. `recent`: what emails changed on
    the board, newest first — a card created, a status moved, an interview flag set."""
    query = select(MailEvent).where(MailEvent.user_id == user.id)
    if view == "review":
        query = query.where(MailEvent.action == "review").order_by(MailEvent.received_at.desc(), MailEvent.id.desc())
    else:
        query = query.where(or_(
            MailEvent.action.in_(("created", "updated")),
            (MailEvent.action == "linked") & MailEvent.set_interviewed.is_(True),
        )).order_by(MailEvent.id.desc())
    rows = db.execute(query.limit(max(1, min(200, limit)))).scalars().all()
    email = _mailbox_email(db, user.id)
    return [inbox_sync.event_out(e, email) for e in rows]


def _owned_event(db: Session, event_id: int, user: User) -> MailEvent:
    event = db.get(MailEvent, event_id)
    if event is None or event.user_id != user.id:
        raise HTTPException(404, detail={"code": "inbox_event_not_found"})
    return event


def _finish(db: Session, event: MailEvent, user: User, refusal: str) -> InboxEventOut:
    if refusal:
        db.rollback()
        status = 404 if refusal in ("not_found", "application_not_found") else 409
        raise HTTPException(status, detail={"code": f"inbox_{refusal}"})
    db.commit()
    db.refresh(event)
    return inbox_sync.event_out(event, _mailbox_email(db, user.id))


@router.post("/inbox/events/{event_id}/undo", response_model=InboxEventOut)
def inbox_event_undo(event_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)) -> InboxEventOut:
    event = _owned_event(db, event_id, user)
    return _finish(db, event, user, inbox_apply.undo(db, user.id, event))


@router.post("/inbox/events/{event_id}/dismiss", response_model=InboxEventOut)
def inbox_event_dismiss(event_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)) -> InboxEventOut:
    event = _owned_event(db, event_id, user)
    return _finish(db, event, user, inbox_apply.dismiss(user.id, event))


@router.post("/inbox/events/{event_id}/resolve", response_model=InboxEventOut)
def inbox_event_resolve(
    event_id: int, body: InboxResolveIn, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> InboxEventOut:
    event = _owned_event(db, event_id, user)
    if not body.create and body.application_id is None:
        raise HTTPException(400, detail={"code": "inbox_resolve_target"})
    refusal = inbox_apply.resolve(db, user.id, event, application_id=body.application_id, create=body.create)
    return _finish(db, event, user, refusal)


@router.patch("/inbox/settings", response_model=InboxStatus)
def inbox_settings(
    body: InboxSettingsIn, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> InboxStatus:
    conn = inbox_sync.connection_for(db, user.id)
    if conn is None:
        raise HTTPException(404, detail={"code": "inbox_not_connected"})
    if body.auto_sync is not None:
        conn.auto_sync = body.auto_sync
    if body.backfill_days is not None:
        conn.backfill_days = body.backfill_days
        connected = inbox_apply.utc(conn.connected_at)
        if not conn.cursor_ms and connected is not None:
            # Nothing read yet, so the import starts from the new depth. After the
            # first message the depth is history and changing it moves nothing.
            conn.window_lo_ms = int(connected.timestamp() * 1000) - body.backfill_days * inbox_sync.DAY_MS
    db.commit()
    return _status(db, user)


@router.delete("/inbox/connection", response_model=InboxDisconnectOut)
def inbox_disconnect(
    purge: bool = False, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> InboxDisconnectOut:
    """Give the grant back to Google (best effort) and delete our copy of it.
    `purge` also deletes the detected emails; tracker cards stay either way."""
    conn = inbox_sync.connection_for(db, user.id)
    if conn is not None:
        inbox_sync.revoke_stored_grant(conn)
        db.delete(conn)
    accounts.consume_tokens(db, user.id, (INBOX_CONNECT,), inbox_sync.utc_now())
    deleted = 0
    if purge:
        deleted = db.execute(delete(MailEvent).where(MailEvent.user_id == user.id)).rowcount or 0
    db.commit()
    return InboxDisconnectOut(disconnected=conn is not None, events_deleted=deleted)


@router.get("/inbox/cron", response_model=InboxCronResult)
def inbox_cron(request: Request, db: Session = Depends(get_db)) -> InboxCronResult:
    """Vercel cron entrypoint, twice a day (vercel.json). `_AUTH_OPTIONAL` in
    main.py; authenticates with the Bearer CRON_SECRET like the alert crons —
    except that it FAILS CLOSED (amendment A12): with the gate on and no secret it
    refuses, because an open copy of this route would refresh every user's Gmail
    grant and spend model calls for anyone who found the URL."""
    s = get_settings()
    secret = s.cron_secret
    if not secret:
        if s.app_access_code:
            raise HTTPException(503, detail={"code": "cron_unconfigured"})
    else:
        auth = request.headers.get("authorization", "")
        if not hmac.compare_digest(auth.encode("utf-8"), f"Bearer {secret}".encode("utf-8")):
            raise HTTPException(401, "Bad cron secret.")
    results, skipped = inbox_sync.run_all_inbox(db)
    return InboxCronResult(users=len(results) + skipped, results=results, skipped=skipped)
