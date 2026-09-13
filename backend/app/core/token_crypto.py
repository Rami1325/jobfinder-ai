"""Google refresh tokens at rest (Phase 29 / B2).

A Gmail refresh token is a standing key to someone's mailbox, so the database
never holds one in the clear: `MailConnection.refresh_token_enc` is Fernet
ciphertext under INBOX_TOKEN_KEY, and no response model carries even that.

`MultiFernet`, so the key can be rotated without disconnecting anyone:
INBOX_TOKEN_KEY is a comma-separated list, NEWEST FIRST. Encrypting always uses
the first key; decrypting tries every one. Rotate by prepending a new key and
redeploying; drop the old one once the tokens have been rewritten under it.

Two failures, deliberately different: `TokenKeyMissing` is the server's problem
(no key configured, or a malformed one) and must not be blamed on the user;
`TokenUnreadable` means no configured key can read THIS token (it was written
under a key that has since been dropped), which the sync reports as
needs_reauth — the user reconnecting is the only thing that fixes it.
"""
from __future__ import annotations

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from app.config import get_settings


class TokenKeyMissing(Exception):
    """INBOX_TOKEN_KEY is unset or is not a valid Fernet key."""


class TokenUnreadable(Exception):
    """No configured key can decrypt this token."""


def _keys() -> list[str]:
    raw = get_settings().inbox_token_key or ""
    return [k.strip() for k in raw.split(",") if k.strip()]


def _multi() -> MultiFernet:
    keys = _keys()
    if not keys:
        raise TokenKeyMissing("INBOX_TOKEN_KEY is not set")
    try:
        return MultiFernet([Fernet(k.encode("ascii")) for k in keys])
    except (ValueError, TypeError, UnicodeEncodeError) as e:
        # A key that is not 32 url-safe base64 bytes. Reported as missing
        # rather than raised raw: the server cannot store a token either way.
        raise TokenKeyMissing("INBOX_TOKEN_KEY is not a valid Fernet key") from e


def key_configured() -> bool:
    """Whether tokens can be stored at all — part of `google_ready`."""
    try:
        _multi()
    except TokenKeyMissing:
        return False
    return True


def encrypt(plain: str) -> str:
    return _multi().encrypt(plain.encode("utf-8")).decode("ascii")


def decrypt(token: str) -> str:
    multi = _multi()
    try:
        return multi.decrypt((token or "").encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeEncodeError, UnicodeDecodeError) as e:
        raise TokenUnreadable("no configured key can read this token") from e
