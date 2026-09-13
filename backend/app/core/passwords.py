"""Password hashing and the password rules (Phase 29 / B1).

Pure and stdlib-only on purpose: nothing here reads settings, the database or a
request, so every rule is pinned by calling it. The work factor arrives as an
argument — `accounts` passes AUTH_SCRYPT_N.

**scrypt, from `hashlib`.** It ships with Python (OpenSSL), so accounts add no
dependency, and it is memory-hard: at N=2**17, r=8 one guess costs ~128 MB as
well as ~0.28 s (measured on the owner's machine), which is what makes a stolen
table expensive to grind through on GPUs.

**The parameters live INSIDE the hash** — `scrypt$N$r$p$salt_b64$dk_b64` — so
raising the work factor never locks anyone out: a hash made at the old N still
verifies, and `verify_password` reports `needs_rehash` so the next successful
login rewrites it at the new one.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import unicodedata
from functools import lru_cache

DEFAULT_N = 2**17
_R = 8
_P = 1
_DKLEN = 64
_SALT_BYTES = 16

MIN_CHARS = 8
# Bytes, not characters — the prompt-bounds rule (Hebrew costs ~2 bytes a
# character) applied to the other input with a hard ceiling. 256 bytes is far
# past any password a person types, and it keeps the key derivation's own input
# from becoming the expensive part of a request.
MAX_BYTES = 256

# The most a STORED hash may ask for. A tampered or corrupted row must not be
# able to make the login route allocate gigabytes of scrypt memory.
_MAX_N = 2**20
_MAX_R = 32
_MAX_P = 16
_MAX_DK = 256

# Refused outright. Only entries of 8+ characters, because anything shorter is
# already `too_short`. Deliberately small: this stops the handful of passwords
# every credential-stuffing list tries first; it is not a dictionary defence.
_COMMON = frozenset({
    "password", "password1", "password12", "password123", "password!",
    "passw0rd", "p@ssw0rd", "p@ssword", "12345678", "123456789", "1234567890",
    "12341234", "11111111", "00000000", "88888888", "87654321", "qwertyui",
    "qwertyuiop", "qwerty123", "qwerty12", "1q2w3e4r", "1qaz2wsx", "zaq12wsx",
    "q1w2e3r4", "asdfghjk", "asdfghjkl", "abcd1234", "abc12345", "abcdefgh",
    "iloveyou", "iloveyou1", "sunshine", "princess", "football", "baseball",
    "superman", "starwars", "welcome1", "welcome123", "letmein1", "trustno1",
    "whatever", "computer", "internet", "michael1", "jennifer", "changeme",
    "admin123", "administrator", "jobfinder", "jobfinder1", "shalom123",
    "israel123",
})


def _encode(password: str) -> bytes:
    """NFC, then UTF-8.

    The same password typed on two keyboards can arrive as two code-point
    sequences (a precomposed letter, or a letter plus a combining mark), and a
    hash cannot know they were meant to be one password. NFC is what RFC 8265
    prescribes for passwords. `surrogatepass` keeps a lone surrogate — JSON can
    carry one — from turning a login into a 500.
    """
    return unicodedata.normalize("NFC", password).encode("utf-8", "surrogatepass")


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _scrypt(secret: bytes, salt: bytes, n: int, r: int, p: int, dklen: int) -> bytes:
    # maxmem must clear scrypt's own 128*N*r working set; 2x is safe headroom.
    return hashlib.scrypt(secret, salt=salt, n=n, r=r, p=p, maxmem=2 * 128 * n * r, dklen=dklen)


def hash_password(password: str, n: int = DEFAULT_N) -> str:
    """A fresh salted hash, with its parameters encoded into the string."""
    salt = secrets.token_bytes(_SALT_BYTES)
    dk = _scrypt(_encode(password), salt, n, _R, _P, _DKLEN)
    return f"scrypt${n}${_R}${_P}${_b64(salt)}${_b64(dk)}"


def verify_password(password: str, encoded: str, n: int = DEFAULT_N) -> tuple[bool, bool]:
    """`(ok, needs_rehash)` — `needs_rehash` only ever True alongside `ok`.

    Never raises. A malformed or tampered `encoded` answers `(False, False)`,
    exactly like a wrong password: a login route that 500s on one stored row is
    a login route that tells an attacker which row is odd.
    """
    try:
        scheme, n_s, r_s, p_s, salt_s, dk_s = (encoded or "").split("$")
        hn, hr, hp = int(n_s), int(r_s), int(p_s)
        salt = base64.b64decode(salt_s, validate=True)
        dk = base64.b64decode(dk_s, validate=True)
    except ValueError:  # wrong field count, a non-integer, or bad base64 (binascii.Error)
        return False, False
    if (
        scheme != "scrypt"
        or not salt
        or not 16 <= len(dk) <= _MAX_DK
        or hn < 2
        or hn & (hn - 1)  # scrypt's N must be a power of two
        or hn > _MAX_N
        or not 1 <= hr <= _MAX_R
        or not 1 <= hp <= _MAX_P
    ):
        return False, False
    try:
        got = _scrypt(_encode(password or ""), salt, hn, hr, hp, len(dk))
    except Exception:  # noqa: BLE001 - OpenSSL refusing the parameters is still "no"
        return False, False
    ok = hmac.compare_digest(got, dk)
    return ok, ok and (hn, hr, hp) != (n, _R, _P)


@lru_cache(maxsize=8)
def dummy_hash(n: int = DEFAULT_N) -> str:
    """A real hash of a random password, at work factor `n`.

    A login for an address that has no account verifies against THIS, so it
    spends exactly the scrypt a wrong password spends. Without it the route
    answers unknown emails ~0.3 s faster, and that difference is an
    account-existence oracle the identical error body was meant to close.
    A function rather than a constant because N is a setting.
    """
    return hash_password(secrets.token_urlsafe(16), n)


def validate_password(password: str, email: str = "") -> str | None:
    """Why this password is refused, or None when it is acceptable.

    The reasons are CODES (`weak_password{reason}` on the wire) for the frontend
    to translate, never sentences.
    """
    pw = unicodedata.normalize("NFC", password or "")
    if len(pw) < MIN_CHARS:
        return "too_short"
    if len(_encode(pw)) > MAX_BYTES:
        return "too_long"
    folded = unicodedata.normalize("NFKC", pw).strip().casefold()
    if email and folded == unicodedata.normalize("NFKC", email).strip().casefold():
        return "same_as_email"
    if folded in _COMMON:
        return "too_common"
    return None
