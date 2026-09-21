"""Reading a mailbox (Phase 29 / B2): the `Mailbox` the inbox sync talks to.

The sync needs four things and nothing more: list message ids for a search, read
one message's HEADERS and snippet, read one message's text body, and name the
connected address. The body is read only for mail a rule could not decide, lives
in memory for one classification, and is never stored (see `MailEvent`).

`GmailMailbox` makes every request through `google_oauth._http`, the one door to
Google (host allowlist, https only, no redirects). This module never opens the
network itself, and the smoke test pins that. `FakeMailbox` is its in-memory twin,
driven by the smoke test, the demo mailbox and the classifier A/B harness.

Gmail quirks handled here, each a way a naive reader silently gets it wrong:
- `internalDate` is a STRING of epoch milliseconds.
- `body.data` is base64url, and Google sometimes omits the padding.
- A text/plain part is preferred; an HTML-only mail is reduced to its text.
- Header values can be RFC 2047 encoded-words, and a snippet carries HTML
  entities ("&#39;").
- A reply quotes the thread beneath it, so the quoted part is cut ("On … wrote:",
  "-----Original Message-----", and Gmail's Hebrew "בתאריך … נכתב:" / "… מאת …:").
  Without that, a rejection quoting the original "thanks for applying" reads as
  both at once.
"""
from __future__ import annotations

import base64
import html as html_lib
import re
import threading
from dataclasses import dataclass
from email.header import decode_header, make_header
from email.utils import parseaddr
from typing import Any, Protocol

from app.core import google_oauth
from app.core.inbox_rules import SPAM_OPERATOR, MessageMeta
from app.llm.limits import clip_utf8

# What one body may contribute to a classification, in UTF-8 KB. The prompt
# builder clips again to its own, smaller cap; this one bounds memory.
BODY_CAP_KB = 12
_META_HEADERS = ("From", "Subject", "Date", "Message-ID", "List-Unsubscribe")
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class MessageGone(Exception):
    """The message no longer exists — deleted between the listing and the read.
    Not an error for the sync: there is nothing left to classify."""


class Mailbox(Protocol):
    def list_ids(self, q: str, page_token: str | None = None) -> tuple[list[str], str | None]: ...

    def get_meta(self, msg_id: str) -> MessageMeta: ...

    def get_body(self, msg_id: str) -> str: ...

    def profile_email(self) -> str: ...


# --- parsing (pure) -------------------------------------------------------------------
def _decode_header(value: str) -> str:
    try:
        return str(make_header(decode_header(value)))
    except Exception:  # noqa: BLE001 - a malformed encoded-word keeps its raw form
        return value


def parse_meta(data: dict[str, Any]) -> MessageMeta:
    """A `format=metadata` message resource -> MessageMeta."""
    headers = (data.get("payload") or {}).get("headers") or []

    def header(name: str) -> str:
        for item in headers:
            if isinstance(item, dict) and str(item.get("name") or "").lower() == name.lower():
                return _decode_header(str(item.get("value") or ""))
        return ""

    name, address = parseaddr(header("From"))
    try:
        internal = int(str(data.get("internalDate") or "0"))
    except ValueError:
        internal = 0
    return MessageMeta(
        id=str(data.get("id") or ""),
        thread_id=str(data.get("threadId") or ""),
        internal_ms=internal,
        from_name=" ".join(name.split()).strip('"'),
        from_email=address.strip().lower(),
        subject=" ".join(header("Subject").split()),
        snippet=" ".join(html_lib.unescape(str(data.get("snippet") or "")).split()),
        rfc822_id=header("Message-ID").strip().strip("<>")[:255],
        list_unsubscribe=header("List-Unsubscribe")[:500],
    )


_CHARSET = re.compile(r"charset\s*=\s*\"?([A-Za-z0-9_.:-]+)", re.IGNORECASE)


def _part_charset(part: dict[str, Any]) -> str:
    for item in part.get("headers") or []:
        if isinstance(item, dict) and str(item.get("name") or "").lower() == "content-type":
            m = _CHARSET.search(str(item.get("value") or ""))
            if m:
                return m.group(1)
    return "utf-8"


def _b64_text(data: str, charset: str) -> str:
    raw = base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))
    try:
        return raw.decode(charset)
    except (LookupError, UnicodeDecodeError):
        return raw.decode("utf-8", errors="replace")


_SCRIPT_STYLE = re.compile(r"<(script|style|head)\b[^>]*>.*?</\1\s*>", re.IGNORECASE | re.DOTALL)
_BLOCK_TAG = re.compile(r"<\s*/?\s*(?:br|p|div|tr|li|h[1-6]|table)\b[^>]*>", re.IGNORECASE)
_ANY_TAG = re.compile(r"<[^>]+>")


def html_to_text(markup: str) -> str:
    text = _SCRIPT_STYLE.sub(" ", markup or "")
    text = _BLOCK_TAG.sub("\n", text)
    text = html_lib.unescape(_ANY_TAG.sub(" ", text))
    out: list[str] = []
    for line in text.splitlines():
        line = " ".join(line.split())
        if line or (out and out[-1]):
            out.append(line)
    return "\n".join(out).strip()


_BIDI_MARKS = re.compile("[‎‏‪-‮⁦-⁩]")
_QUOTE_HEADERS = (
    re.compile(r"^\s*On .{1,300}\bwrote:\s*$", re.IGNORECASE),
    re.compile(r"^\s*-{2,}\s*Original Message\s*-{2,}\s*$", re.IGNORECASE),
    re.compile(r"^\s*בתאריך .{1,300}(?:נכתב|כתב|כתבה|כתב/ה|מאת .{1,200})\s*:\s*$"),
)


def strip_quoted(text: str) -> str:
    """Cut a reply's quoted thread: from the first quote header down, and any
    trailing run of ">" lines. A header wrapped onto two lines ("On Thu, … Dana
    <" / "dana@x> wrote:") is read as one."""
    lines = (text or "").splitlines()
    clean = [_BIDI_MARKS.sub("", ln) for ln in lines]
    for i, line in enumerate(clean):
        pair = f"{line} {clean[i + 1]}" if i + 1 < len(clean) else line
        if any(p.match(line) for p in _QUOTE_HEADERS) or (
            line.strip().lower().startswith("on ") and any(p.match(pair) for p in _QUOTE_HEADERS[:1])
        ):
            lines = lines[:i]
            break
    while lines and (not lines[-1].strip() or lines[-1].lstrip().startswith(">")):
        lines.pop()
    return "\n".join(lines).strip()


def extract_body(payload: dict[str, Any]) -> str:
    """The readable text of a `format=full` payload, quoted replies cut, capped."""
    plain: list[str] = []
    markup: list[str] = []

    def walk(part: Any, depth: int = 0) -> None:
        if not isinstance(part, dict) or depth > 12 or part.get("filename"):
            return  # an attachment is never read
        mime = str(part.get("mimeType") or "").lower()
        data = (part.get("body") or {}).get("data")
        if data and mime in ("text/plain", "text/html"):
            try:
                text = _b64_text(str(data), _part_charset(part))
            except (ValueError, TypeError):
                text = ""
            (plain if mime == "text/plain" else markup).append(text)
        for child in part.get("parts") or []:
            walk(child, depth + 1)

    walk(payload)
    text = "\n".join(plain) if any(p.strip() for p in plain) else html_to_text("\n".join(markup))
    clipped, _ = clip_utf8(strip_quoted(text), BODY_CAP_KB)
    return clipped


# --- Gmail --------------------------------------------------------------------------------
def _safe_id(msg_id: str) -> str:
    """A message id goes into a URL path, so it must be one Gmail could have
    minted: the id alphabet only, which needs no escaping at all."""
    if not _ID_RE.match(msg_id or ""):
        raise MessageGone(msg_id)
    return msg_id


class GmailMailbox:
    """The real mailbox, for one access token (one sync run — tokens live an hour)."""

    def __init__(self, access_token: str) -> None:
        self._token = access_token

    def _get(self, path: str, params: Any = None) -> dict[str, Any]:
        try:
            return google_oauth._http(
                "GET", f"{google_oauth.GMAIL_API_URL}{path}", params=params, bearer=self._token
            )
        except google_oauth.GoogleAuthError as e:
            if e.status == 404:
                raise MessageGone(path) from e
            raise

    def list_ids(self, q: str, page_token: str | None = None) -> tuple[list[str], str | None]:
        params: list[tuple[str, str]] = [("q", q), ("maxResults", "500")]
        if SPAM_OPERATOR in (q or "").split():
            # P29-SPAM-RESCUE: Gmail lists no Spam (or Trash) unless asked, and a
            # query naming `in:spam` asks for exactly that. An EXACT token, never a
            # substring: `-in:spam` contains it, and switching this on for such a
            # query would list Trash — and Spam, if the operator were ever dropped —
            # into the listing the sync classifies and charges.
            params.append(("includeSpamTrash", "true"))
        if page_token:
            params.append(("pageToken", page_token))
        data = self._get("/messages", params)
        ids = [
            str(m.get("id"))
            for m in data.get("messages") or []
            if isinstance(m, dict) and _ID_RE.match(str(m.get("id") or ""))
        ]
        token = data.get("nextPageToken")
        return ids, (str(token) if token else None)

    def get_meta(self, msg_id: str) -> MessageMeta:
        params = [("format", "metadata"), *(("metadataHeaders", h) for h in _META_HEADERS)]
        return parse_meta(self._get(f"/messages/{_safe_id(msg_id)}", params))

    def get_body(self, msg_id: str) -> str:
        data = self._get(f"/messages/{_safe_id(msg_id)}", [("format", "full")])
        return extract_body(data.get("payload") or {})

    def profile_email(self) -> str:
        return str(self._get("/profile").get("emailAddress") or "").strip().lower()


# --- the in-memory twin ------------------------------------------------------------------
@dataclass
class FakeMessage:
    id: str
    internal_ms: int
    from_name: str = ""
    from_email: str = ""
    subject: str = ""
    snippet: str = ""
    body: str = ""
    thread_id: str = ""
    rfc822_id: str = ""
    # Gmail's system labels that change what a listing returns: "SPAM" or
    # "TRASH". Empty = the inbox. Mutable, so a test can move a message the way
    # "Not spam" does — same id, same internalDate.
    labels: tuple[str, ...] = ()


_AFTER = re.compile(r"(?:^|\s)after:(\d+)")
_BEFORE = re.compile(r"(?:^|\s)before:(\d+)")
_HIDDEN = frozenset({"SPAM", "TRASH"})


class FakeMailbox:
    """A mailbox in memory, behaving like Gmail where the sync can tell.

    Lists NEWEST FIRST in pages, the way `messages.list` does, and honours the
    query's `after:`/`before:` epoch-second bounds — the windowed import depends
    on both. It does not implement Gmail's vocabulary search: every message in
    the window is listed, which is the harder case for the deterministic stage.
    Like Gmail it leaves SPAM and TRASH out of a listing, and a query carrying
    the exact token `in:spam` lists Spam and nothing else (P29-SPAM-RESCUE).
    Thread-safe, because the sync reads metadata from a pool. `calls` counts every
    read, and a message id in `fail_ids` fails like a network error.
    """

    def __init__(self, messages: list[FakeMessage], *, email: str = "demo.inbox@example.com",
                 page_size: int = 500) -> None:
        self._messages = {m.id: m for m in messages}
        self.email = email
        self.page_size = max(1, page_size)
        self.fail_ids: set[str] = set()
        self.calls = {"list": 0, "meta": 0, "body": 0, "profile": 0}
        self.queries: list[str] = []
        self._lock = threading.Lock()

    def _count(self, kind: str) -> None:
        with self._lock:
            self.calls[kind] += 1

    def list_ids(self, q: str, page_token: str | None = None) -> tuple[list[str], str | None]:
        self._count("list")
        with self._lock:
            self.queries.append(q)
        after, before = _AFTER.search(q or ""), _BEFORE.search(q or "")
        lo = int(after.group(1)) * 1000 if after else None
        hi = int(before.group(1)) * 1000 if before else None
        spam = SPAM_OPERATOR in (q or "").split()
        rows = [
            m for m in self._messages.values()
            if (lo is None or m.internal_ms >= lo) and (hi is None or m.internal_ms < hi)
            and (("SPAM" in m.labels) if spam else not (_HIDDEN & set(m.labels)))
        ]
        rows.sort(key=lambda m: (-m.internal_ms, m.id))
        start = int(page_token) if page_token and page_token.isdigit() else 0
        page = rows[start:start + self.page_size]
        more = start + self.page_size < len(rows)
        return [m.id for m in page], (str(start + self.page_size) if more else None)

    def _message(self, msg_id: str) -> FakeMessage:
        if msg_id in self.fail_ids:
            raise google_oauth.GoogleAuthError("network")
        found = self._messages.get(msg_id)
        if found is None:
            raise MessageGone(msg_id)
        return found

    def get_meta(self, msg_id: str) -> MessageMeta:
        self._count("meta")
        m = self._message(msg_id)
        return MessageMeta(
            id=m.id, thread_id=m.thread_id or m.id, internal_ms=m.internal_ms,
            from_name=m.from_name, from_email=(m.from_email or "").lower(),
            subject=" ".join((m.subject or "").split()), snippet=" ".join((m.snippet or "").split()),
            rfc822_id=m.rfc822_id,
        )

    def get_body(self, msg_id: str) -> str:
        self._count("body")
        clipped, _ = clip_utf8(strip_quoted(self._message(msg_id).body), BODY_CAP_KB)
        return clipped

    def profile_email(self) -> str:
        self._count("profile")
        return self.email
