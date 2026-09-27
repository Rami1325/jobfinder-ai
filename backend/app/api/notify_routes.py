"""The alert channels beside the email (PLAN 32): web push, a thin door onto
app/core/webpush.py.

Rules every route here keeps:

- **Plain `Depends(current_user)`**, never `llm_user` or `metered_user`: nothing
  here reaches a model, and nothing here charges a monthly use. Pushing costs
  the owner nothing (`docs/handbook/cost-and-quota.md`). The one route that
  leaves the machine on a tap, the test notification, carries its own daily cap
  (`push_test`), because each tap is one outbound POST per device; it is classed
  `net_capped` in smoke 32.13.
- **An endpoint is a caller-supplied URL.** It is stored only when
  `webpush.push_endpoint_allowed` passes, and `webpush._post` checks it again
  before every send (`docs/handbook/notifications.md`, *The push door*).
- **Settings are read per request**, never captured at import: the smoke test
  switches VAPID on and off mid-suite.
- Refusals are structured `{"code": ...}` details, translated client-side.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import current_user
from app.config import get_settings
from app.core import webpush
from app.core.sessions import as_utc
from app.core.usage import check_and_count
from app.db.database import get_db
from app.db.models import PushSubscription, User
from app.models import (
    PushDeviceOut,
    PushDevicesOut,
    PushEndpointIn,
    PushRemoved,
    PushSubscribeIn,
    PushTestResult,
)

router = APIRouter()


def _iso(dt: datetime | None) -> str:
    moment = as_utc(dt)
    return moment.isoformat() if moment is not None else ""


def _device_out(row: PushSubscription) -> PushDeviceOut:
    return PushDeviceOut(
        id=row.id,
        endpoint=row.endpoint or "",
        lang=row.lang or "en",
        created_at=_iso(row.created_at),
        last_success_at=_iso(row.last_success_at),
        failure_count=int(row.failure_count or 0),
    )


def _lang(raw: str) -> str:
    return "he" if (raw or "").strip().lower().startswith("he") else "en"


def _require_push() -> None:
    if not webpush.configured():
        raise HTTPException(404, detail={"code": "push_unconfigured"})


def _own_device(db: Session, user: User, endpoint: str) -> PushSubscription | None:
    key = webpush.endpoint_key((endpoint or "").strip())
    return db.execute(
        select(PushSubscription).where(PushSubscription.endpoint_key == key, PushSubscription.user_id == user.id)
    ).scalars().first()


def _keep_newest(db: Session, user_id: int, keep_id: int) -> None:
    """At most `webpush.MAX_DEVICES` per user: past it, the devices that last
    worked longest ago go first (never the one just turned on)."""
    rows = webpush.devices_of(db, user_id)
    if len(rows) <= webpush.MAX_DEVICES:
        return
    epoch = datetime(1970, 1, 1)
    others = sorted(
        (r for r in rows if r.id != keep_id),
        key=lambda r: (r.last_success_at or r.created_at or epoch).replace(tzinfo=None),
    )
    for row in others[: len(rows) - webpush.MAX_DEVICES]:
        db.delete(row)


@router.get("/push/devices", response_model=PushDevicesOut)
def push_devices(
    response: Response, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> PushDevicesOut:
    """Whether this server sends notifications at all, the key a browser
    subscribes with, and the caller's devices. Nothing else when push is off."""
    response.headers["Cache-Control"] = "no-store"
    if not webpush.configured():
        return PushDevicesOut(configured=False)
    return PushDevicesOut(
        configured=True,
        public_key=webpush.public_key(),
        devices=[_device_out(r) for r in webpush.devices_of(db, user.id)],
    )


@router.post("/push/devices", response_model=PushDeviceOut)
def push_subscribe(
    body: PushSubscribeIn, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> PushDeviceOut:
    """Turn the morning alert on for this browser (or refresh its keys and
    language). The endpoint must be a push service on the allowlist; the keys
    must be a real P-256 point and a 16-byte secret. A browser holds one
    subscription, so an endpoint another account turned on moves to this one."""
    _require_push()
    endpoint = (body.endpoint or "").strip()
    if not webpush.push_endpoint_allowed(endpoint):
        raise HTTPException(400, detail={"code": "push_endpoint"})
    if not webpush.valid_client_keys(body.keys.p256dh, body.keys.auth):
        raise HTTPException(400, detail={"code": "push_keys"})
    key = webpush.endpoint_key(endpoint)
    for attempt in (1, 2):
        row = db.execute(select(PushSubscription).where(PushSubscription.endpoint_key == key)).scalars().first()
        if row is None:
            row = PushSubscription(user_id=user.id, endpoint=endpoint, endpoint_key=key)
            db.add(row)
        elif row.user_id != user.id:
            # The browser is now this account's: a new owner starts a clean record.
            row.user_id = user.id
            row.created_at = datetime.now(timezone.utc)
            row.last_success_at = None
            row.failure_count = 0
        row.endpoint = endpoint
        row.p256dh = body.keys.p256dh.strip()
        row.auth = body.keys.auth.strip()
        row.lang = _lang(body.lang)
        try:
            db.flush()
            _keep_newest(db, user.id, row.id)
            db.commit()
            break
        except IntegrityError:
            # Two taps at once on one browser: the other insert won; update it.
            db.rollback()
            if attempt == 2:
                raise
    db.refresh(row)
    return _device_out(row)


@router.delete("/push/devices", response_model=PushRemoved)
def push_unsubscribe(
    body: PushEndpointIn, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> PushRemoved:
    """Turn it off for this browser. Only the caller's own row can go; an
    endpoint that is not theirs removes nothing. Works with push switched off on
    the server too, so a device can always be turned off."""
    row = _own_device(db, user, body.endpoint)
    if row is None:
        return PushRemoved(removed=0)
    db.delete(row)
    db.commit()
    return PushRemoved(removed=1)


@router.post("/push/test", response_model=PushTestResult)
def push_test(
    body: PushEndpointIn, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> PushTestResult:
    """"Send a test notification" to one of the caller's devices. No model call
    and no use; its own daily cap, counted only once there is a device to send
    to, because each tap is a real POST to a push service."""
    _require_push()
    row = _own_device(db, user, body.endpoint)
    if row is None:
        raise HTTPException(404, detail={"code": "push_device"})
    check_and_count(db, user, "push_test", get_settings().daily_push_test_cap)
    status = webpush.send_to(row, webpush.test_payload(row.lang or "en"), ttl=webpush.TEST_TTL_S, urgency="high")
    webpush.record_result(db, row, status)
    db.commit()
    return PushTestResult(status="gone" if status == "refused" else status)
