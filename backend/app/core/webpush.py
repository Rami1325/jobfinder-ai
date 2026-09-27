"""Web push (PLAN 32): the morning alert on the phone's lock screen.

Three things live here, and the third is the one that matters most.

1. **VAPID** (RFC 8292). Every push is signed with the server's P-256 key as an
   ES256 JWT, `Authorization: vapid t=<jwt>, k=<public key>`. The browser bound
   the subscription to that public key when it subscribed, so a push service
   refuses a push signed by any other key, and whoever holds a subscription's
   endpoint without our private key cannot use it.
2. **Message encryption** (RFC 8291, `aes128gcm` from RFC 8188). The body is
   encrypted to the browser's own key (`p256dh`) and auth secret, so Google,
   Apple, Mozilla and Microsoft carry it without being able to read it. Pinned by
   the smoke test against RFC 8291's own Appendix A, byte for byte.
3. **The push door.** A subscription's endpoint is a URL the BROWSER hands us,
   so it is a caller-supplied URL and an SSRF risk: accepted blindly, "subscribe"
   is a way to make this server POST to any address, cloud metadata included.
   Every endpoint must pass `push_endpoint_allowed` when it is stored AND again
   inside `_post`, the only function here that opens a connection: https only,
   no userinfo, no port but 443, and a host on `PUSH_HOSTS` (exact) or under one
   of `PUSH_HOST_SUFFIXES`. A redirect is an error, never followed, and nothing
   a push service answers is read beyond its status. This is NOT
   `job_match._http_get`: that door proves an address is PUBLIC, and a push
   endpoint has to be a PUSH SERVICE, which only an allowlist can prove (the
   Google door's reasoning, `docs/handbook/notifications.md`).

Why not `pywebpush`: 2.x pulls `aiohttp`, `requests`, `py-vapid`, `http-ece` and
their dependencies into a serverless bundle to do what fifty lines of the
`cryptography` package this app already pins do, and it sends through
`requests`, a second HTTP stack outside this door. RFC 8291's appendix gives an
exact test vector, so the arithmetic here is pinned rather than trusted.

`_transport` is None in production; the smoke test swaps in a fake, so nothing
here reaches a push service offline. Pushing costs the owner nothing and never
charges a use (`docs/handbook/cost-and-quota.md`).

Keys: `python -m app.core.webpush --generate-keys` prints a fresh pair in the
form the settings read (base64url, the raw 65-byte public point and the raw
32-byte private scalar, the same form `npx web-push generate-vapid-keys` prints).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import struct
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from typing import Callable
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import PushSubscription

logger = logging.getLogger(__name__)

# The push services a browser's subscription can name (checked 2026-09-27):
# Chrome, Edge on Android, Samsung Internet, Opera and Brave use Firebase Cloud
# Messaging; Firefox uses Mozilla's autopush; Safari (macOS 13+, iOS/iPadOS 16.4+
# as a home-screen app) uses Apple's; Edge on Windows uses the Windows Push
# Notification Services, whose endpoints are per-region hosts under
# notify.windows.com. Anything else is refused: a browser we do not know yet
# gets "not supported" rather than a door to an address nobody vetted.
PUSH_HOSTS = frozenset({
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "web.push.apple.com",
})
# A suffix matches one or more whole DNS labels before it, never a bare suffix
# and never a lookalike: `evil-notify.windows.com` has no dot before the suffix.
PUSH_HOST_SUFFIXES = (".notify.windows.com", ".push.services.mozilla.com")
_LABELS = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+$")
MAX_ENDPOINT = 2048
TIMEOUT_S = 10.0
# A push's life on the push service while the phone is off: the morning's
# matches are still news by lunchtime, not tomorrow.
ALERT_TTL_S = 12 * 3600
TEST_TTL_S = 600
# Consecutive failures (not 404/410, which delete at once) before a device is
# dropped: a subscription whose VAPID key no longer matches answers 403 for ever.
MAX_FAILURES = 5
# Devices kept per user; a new one past this drops the least recently working.
MAX_DEVICES = 10
# One record, and a small one: RFC 8291 caps a push message at 4096 bytes and
# the lock screen shows two lines anyway.
MAX_PAYLOAD = 3000
_RECORD_SIZE = 4096

# (method, url, headers, body, timeout) -> HTTP status, or 0 when nothing answered.
Transport = Callable[[str, str, dict[str, str], bytes, float], int]
_transport: Transport | None = None


class PushRefused(Exception):
    """The door refused to send: the endpoint is not a push service we allow."""


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    text = (text or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]*={0,2}", text):
        raise ValueError("not base64url")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


# --- the door -------------------------------------------------------------------
def push_endpoint_allowed(url: object) -> bool:
    """Is `url` an https endpoint on a push service we allow? The one test, read
    at subscribe time and again by `_post` before every send."""
    if not isinstance(url, str) or not url or len(url) > MAX_ENDPOINT:
        return False
    if any(ch.isspace() or ord(ch) < 0x20 or ch == "\\" for ch in url):
        return False
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    if parts.scheme != "https" or parts.username is not None or parts.password is not None:
        return False
    if port not in (None, 443):
        return False
    host = parts.hostname or ""
    # urlsplit lower-cases the host; the netloc must be exactly that host (and an
    # explicit :443), so nothing can hide in the authority around it.
    if parts.netloc.lower() not in (host, f"{host}:443"):
        return False
    if len(parts.path) < 2:
        return False
    if host in PUSH_HOSTS:
        return True
    for suffix in PUSH_HOST_SUFFIXES:
        if host.endswith(suffix) and _LABELS.match(host[: -len(suffix)] + "."):
            return True
    return False


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A push service that answers with a redirect is not followed anywhere:
    returning None turns every 3xx into an HTTPError, whose status `_post` reports."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, D102
        return None


def _post(endpoint: str, headers: dict[str, str], body: bytes, timeout: float = TIMEOUT_S) -> int:
    """The only function in the app that talks to a push service. Returns the
    HTTP status, or 0 when nothing answered; never reads the response body."""
    if not push_endpoint_allowed(endpoint):
        raise PushRefused("host_not_allowed")
    if _transport is not None:
        return int(_transport("POST", endpoint, headers, body, timeout))
    request = urllib.request.Request(endpoint, data=body, headers=headers, method="POST")
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=timeout) as resp:  # noqa: S310 - endpoint allowlisted above
            return int(resp.status)
    except urllib.error.HTTPError as e:
        return int(e.code)
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0


# --- keys -------------------------------------------------------------------------
@dataclass(frozen=True)
class Vapid:
    private: ec.EllipticCurvePrivateKey
    public_b64: str
    subject: str


@lru_cache(maxsize=4)
def _load_vapid(private_text: str, public_text: str, subject: str) -> Vapid | None:
    """The configured key pair, or None when it is missing, unreadable, or the
    two halves do not belong together (a public key the browser subscribed with
    that the private key cannot sign for would fail every push with a 403)."""
    if not (private_text and public_text and subject):
        return None
    if not (subject.startswith("mailto:") or subject.startswith("https://")):
        return None
    try:
        if private_text.lstrip().startswith("-----BEGIN"):
            key = serialization.load_pem_private_key(private_text.encode("ascii"), password=None)
            if not isinstance(key, ec.EllipticCurvePrivateKey):
                return None
        else:
            raw = b64url_decode(private_text)
            if len(raw) != 32:
                return None
            key = ec.derive_private_key(int.from_bytes(raw, "big"), ec.SECP256R1())
        if not isinstance(key.curve, ec.SECP256R1):
            return None
        derived = key.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
        if b64url_decode(public_text) != derived:
            logger.warning("VAPID_PUBLIC_KEY does not belong to VAPID_PRIVATE_KEY; web push is off")
            return None
        return Vapid(private=key, public_b64=b64url(derived), subject=subject)
    except (ValueError, TypeError):
        return None


def vapid() -> Vapid | None:
    s = get_settings()
    return _load_vapid((s.vapid_private_key or "").strip(), (s.vapid_public_key or "").strip(),
                       (s.vapid_subject or "").strip())


def configured() -> bool:
    """All three VAPID settings are present and the pair is one pair."""
    return vapid() is not None


def public_key() -> str:
    """The key a browser subscribes with ("" when push is off on this server)."""
    v = vapid()
    return v.public_b64 if v is not None else ""


def generate_keys() -> tuple[str, str]:
    """(public, private) for VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, base64url."""
    key = ec.generate_private_key(ec.SECP256R1())
    public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    private = key.private_numbers().private_value.to_bytes(32, "big")
    return b64url(public), b64url(private)


def vapid_authorization(endpoint: str, v: Vapid, *, now: float | None = None) -> str:
    """`vapid t=<ES256 JWT>, k=<public key>` for one endpoint (RFC 8292): the
    audience is the endpoint's origin, and the token lives 12 hours (the RFC
    allows 24)."""
    parts = urlsplit(endpoint)
    moment = int(time.time() if now is None else now)
    header = b64url(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    claims = b64url(json.dumps(
        # The endpoint's origin; the door admits https on port 443 only, so it is
        # the scheme and the (lower-cased) host.
        {"aud": f"https://{parts.hostname or ''}", "exp": moment + 12 * 3600, "sub": v.subject},
        separators=(",", ":"),
    ).encode())
    signing_input = f"{header}.{claims}".encode("ascii")
    r, s = decode_dss_signature(v.private.sign(signing_input, ec.ECDSA(hashes.SHA256())))
    signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return f"vapid t={header}.{claims}.{b64url(signature)}, k={v.public_b64}"


# --- encryption (RFC 8291 over RFC 8188) ------------------------------------------
def _hkdf(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    """HKDF-SHA-256 for one block (every length here is at most 32)."""
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()[:length]


def valid_client_keys(p256dh: str, auth: str) -> bool:
    """The browser's P-256 point (65 bytes, uncompressed, on the curve) and its
    16-byte auth secret."""
    try:
        point = b64url_decode(p256dh)
        secret = b64url_decode(auth)
        if len(point) != 65 or point[0] != 4 or len(secret) != 16:
            return False
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), point)
        return True
    except (ValueError, TypeError):
        return False


def encrypt(
    plaintext: bytes,
    ua_public: bytes,
    auth_secret: bytes,
    *,
    salt: bytes | None = None,
    as_private: ec.EllipticCurvePrivateKey | None = None,
) -> bytes:
    """One `aes128gcm` record carrying `plaintext` to the browser that owns
    `ua_public` / `auth_secret`. `salt` and `as_private` are fresh randoms in
    production; the smoke test passes RFC 8291 Appendix A's to compare bytes."""
    salt = os.urandom(16) if salt is None else salt
    as_private = ec.generate_private_key(ec.SECP256R1()) if as_private is None else as_private
    as_public = as_private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    ecdh_secret = as_private.exchange(ec.ECDH(), ua_key)
    ikm = _hkdf(auth_secret, ecdh_secret, b"WebPush: info\x00" + ua_public + as_public, 32)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    # One record: the plaintext, then the 0x02 delimiter that marks the last one.
    ciphertext = AESGCM(cek).encrypt(nonce, plaintext + b"\x02", None)
    header = salt + struct.pack("!IB", _RECORD_SIZE, len(as_public)) + as_public
    return header + ciphertext


# --- sending --------------------------------------------------------------------
@dataclass(frozen=True)
class PushOutcome:
    sent: int = 0
    gone: int = 0
    failed: int = 0


def send_to(row: PushSubscription, payload: dict, *, ttl: int, urgency: str = "normal") -> str:
    """Encrypt and send one payload to one device: "sent", "gone" (404/410, the
    browser dropped it), "failed" (any other answer), "network" (none) or
    "refused" (its endpoint is not a push service we allow). Never raises."""
    v = vapid()
    if v is None:
        return "failed"
    body_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(body_json) > MAX_PAYLOAD:
        return "failed"
    try:
        body = encrypt(body_json, b64url_decode(row.p256dh), b64url_decode(row.auth))
        headers = {
            "Authorization": vapid_authorization(row.endpoint, v),
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "TTL": str(int(ttl)),
            "Urgency": urgency,
        }
        status = _post(row.endpoint, headers, body)
    except PushRefused:
        return "refused"
    except Exception as exc:  # noqa: BLE001 - one device's failure is a status, never a raise
        # The exception TYPE only: its text could carry a key or an endpoint.
        logger.warning("web push: one device could not be sent to (%s)", type(exc).__name__)
        return "failed"
    if 200 <= status < 300:
        return "sent"
    if status in (404, 410):
        return "gone"
    return "network" if status == 0 else "failed"


def record_result(db: Session, row: PushSubscription, status: str, *, now: datetime | None = None) -> None:
    """Keep the device table honest after a send: a working device resets its
    failures, a device its push service disowned (or whose endpoint the door
    refuses) is deleted, and one that keeps failing goes after MAX_FAILURES."""
    moment = now or datetime.now(timezone.utc)
    if status == "sent":
        row.last_success_at = moment
        row.failure_count = 0
    elif status in ("gone", "refused"):
        db.delete(row)
    else:
        row.failure_count = int(row.failure_count or 0) + 1
        if row.failure_count >= MAX_FAILURES:
            db.delete(row)


def devices_of(db: Session, user_id: int) -> list[PushSubscription]:
    return list(db.execute(
        select(PushSubscription).where(PushSubscription.user_id == user_id).order_by(PushSubscription.id)
    ).scalars())


def notify_user(
    db: Session,
    user_id: int,
    payload_for: Callable[[str], dict],
    *,
    ttl: int = ALERT_TTL_S,
    now: datetime | None = None,
) -> PushOutcome:
    """Send to every device the user turned on, each in its own language
    (`payload_for(lang)`), and prune what the push services disowned. Never
    raises and never charges: a failure here is a count, and bookkeeping is
    rolled back rather than allowed to break the caller's run."""
    if not configured():
        return PushOutcome()
    sent = gone = failed = 0
    try:
        for row in devices_of(db, user_id):
            status = send_to(row, payload_for(row.lang or "en"), ttl=ttl)
            record_result(db, row, status, now=now)
            if status == "sent":
                sent += 1
            elif status in ("gone", "refused"):
                gone += 1
            else:
                failed += 1
        db.commit()
    except Exception:  # noqa: BLE001 - the alert run must never fail over a push
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        logger.warning("web push: the device bookkeeping did not complete")
    return PushOutcome(sent=sent, gone=gone, failed=failed)


def test_payload(lang: str) -> dict:
    """"Send a test notification": says the switch works, in the device's
    language, and opens the matches."""
    if lang == "he":
        return {"title": "JobFinder", "body": "ההתראות פועלות. התראות המשרות של הבוקר יגיעו לכאן.",
                "url": "/jobs", "tag": "jobfinder-test", "lang": "he", "dir": "rtl"}
    return {"title": "JobFinder", "body": "Notifications are on. Your morning job alerts will arrive here.",
            "url": "/jobs", "tag": "jobfinder-test", "lang": "en", "dir": "ltr"}


def endpoint_key(endpoint: str) -> str:
    """How a device is found again: sha256 of its endpoint (the endpoint itself
    can be ~800 characters on Windows, too long to index everywhere)."""
    return hashlib.sha256(endpoint.encode("utf-8")).hexdigest()


if __name__ == "__main__":  # pragma: no cover - an owner's tool, never run by the app
    import sys

    if sys.argv[1:] == ["--generate-keys"]:
        pub, priv = generate_keys()
        print(f"VAPID_PUBLIC_KEY={pub}")
        print(f"VAPID_PRIVATE_KEY={priv}")
    else:
        print("usage: python -m app.core.webpush --generate-keys")
