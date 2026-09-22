"""Bounds on what reaches the model, and honest errors when a bound is hit.

A production Sentry issue was a token-limit failure on a large master resume.
The cause was not the model: NOTHING in this backend bounded prompt input. The
only ceiling anywhere was `max_upload_mb = 10` — a FILE byte cap, not an input
cap — and a 10 MB PDF extracts to megabytes of text that went into the prompt
whole (`prompts.structure_resume_user`). The single exception was
`company_brief._PAGE_TEXT_CAP`, covering one of that prompt's three payloads.

THREE RULES, and the first is the one that decides the other two.

1. NEVER TRUNCATE THE USER'S OWN DOCUMENT — REFUSE IT. Truncate only text the
   user neither wrote nor ever saw (a scraped careers page). A silently
   shortened resume is data loss in the most valuable object the user owns, and
   in this app it does not stay a warning: the parsed `ResumeModel` is live in
   the store the moment it returns, `PUT /profile/resume` versions it into one
   of 20 evictable slots, `useSaveMasterResume` swallows every error, and nine
   pages then read it from a module-level cache. By the time anyone read a
   "we shortened this" notice, the damaged CV would BE the master. Refusal is
   the only disposition where the bad state cannot be persisted.

2. MEASURE IN UTF-8 BYTES, NEVER CHARACTERS. Hebrew is the primary market and
   costs ~1.9 bytes/char against English's 1.0 (measured: "ניהול מערכות" is 12
   chars, 23 bytes), and roughly 2-2.5x the tokens for the same character count.
   A character cap therefore silently grants a Hebrew CV far more tokens than an
   English one — under-protecting exactly the users this app is for. Bytes
   normalise that continuously, with no `detect_language` branch to get wrong on
   the mixed Hebrew-prose/Latin-skills resume that is the Israeli norm.

3. A CAP IS A GUARD RAIL, NOT A BUDGET. It must fire on a 500-page PDF and never
   on a real CV — `config.py` already records that a master can legitimately run
   ~30 rendered pages. A legitimate-but-still-too-big document is caught by
   `ContextWindowExceeded` instead, which can say something actionable. CLAUDE.md
   states the principle: a guard that also fires on legitimate input is worse
   than no guard.
"""
from __future__ import annotations

import re

# Everything below is byte-oriented. KB means 1024 UTF-8 bytes.
KB = 1024


def utf8_bytes(text: str) -> int:
    return len(text.encode("utf-8"))


class InputTooLarge(Exception):
    """A user-owned document exceeded its cap, before any model call was made.

    Carries the numbers rather than a sentence: the routes translate this into a
    structured `detail` so the message can be composed client-side, which is the
    house pattern for a server-originated user-facing message (see
    `usage.check_and_count`'s daily-cap detail and `apiErrorMessage`)."""

    def __init__(self, kind: str, size_kb: int, cap_kb: int) -> None:
        # "resume" | "jd" | "transcript" | "session" | "answer" | "question".
        # Each kind has its OWN sentence client-side (`apiErrorMessage`), because
        # each needs different advice, and check-mirrors 34 reads every kind the
        # backend can raise out of the source and fails a build that has no
        # sentence for one. An unknown kind gets a generic sentence, never the
        # resume's ("It was NOT saved... upload again").
        self.kind = kind
        self.size_kb = size_kb
        self.cap_kb = cap_kb
        super().__init__(f"{kind} is {size_kb} KB; the limit is {cap_kb} KB")


class ContextWindowExceeded(Exception):
    """The model refused the request because the prompt did not fit.

    Distinct from InputTooLarge: this one survived our caps and was still too
    big, which is the honest case for "your CV is legitimately enormous". Raised
    ONLY for `BadRequestError` carrying `code == "context_length_exceeded"` —
    keying on the exception type alone would report every malformed-parameter
    bug to the user as "your resume is too long", a guard firing on legitimate
    input.

    `kind` says what else was in the prompt, for a route where the resume is not
    the only large part. Empty means the resume (and the job ad) alone, which is
    every route but the mock interview's two: there the transcript can be the
    larger part, and "your CV is too long" was false. A kind is set only by a
    route re-raising, never here, and each has its own sentence in both
    locales (check-mirrors 39)."""

    def __init__(self, message: str = "", kind: str = "") -> None:
        self.kind = kind
        super().__init__(message)


class OutputTruncated(Exception):
    """The model stopped because it hit the output cap (`finish_reason ==
    "length"`), so the completion is incomplete.

    This MUST be detected by hand. `chat.completions.create` never raises on a
    truncated completion — it returns a normal response with partial content,
    and the SDK's own `LengthFinishReasonError` is raised only by `.parse()` and
    `.stream()`, neither of which this client uses. Without this check an output
    cap turns a working request into `json.loads` failing on half an object, and
    the user is shown "Unterminated string starting at: line 1 column 892" —
    strictly worse than the token-limit error it replaced, because it reads as
    our bug rather than a limit. For `complete_text` (the cover letter) there is
    no parse error at all: the letter just silently ends mid-sentence."""


# Whitespace to back off to, so a cut never lands mid-word. `free_scan.py`
# records why this matters beyond tidiness: a shortened Hebrew word can BE a
# different real word (בנק -> נק), which hands the model a plausible term the
# candidate never wrote.
_TRAILING = re.compile(r"\s\S*$")


def clip_utf8(text: str, cap_kb: int) -> tuple[str, bool]:
    """(text, was_clipped), bounded to `cap_kb` UTF-8 KB.

    ONLY for machine-fetched text the user never saw — see rule 1. Cuts on a
    character boundary (`errors="ignore"` drops a partial trailing code point,
    since slicing raw bytes mid-character yields a replacement glyph), then
    backs off to the last whitespace so no word is halved.
    """
    if cap_kb <= 0:
        return text, False
    cap = cap_kb * KB
    raw = text.encode("utf-8")
    if len(raw) <= cap:
        return text, False
    cut = raw[:cap].decode("utf-8", errors="ignore")
    backed = _TRAILING.sub("", cut)
    # Only accept the back-off if it kept most of the text: a single enormous
    # "word" (minified HTML, a base64 blob) has no whitespace to find, and
    # returning "" there would silently drop the whole document.
    return (backed if len(backed) >= len(cut) * 0.8 else cut), True


def require_within(text: str, cap_kb: int, kind: str) -> None:
    """Raise InputTooLarge unless `text` fits. For user-owned documents only."""
    if cap_kb <= 0:
        return
    size = utf8_bytes(text)
    if size > cap_kb * KB:
        raise InputTooLarge(kind, size_kb=-(-size // KB), cap_kb=cap_kb)
