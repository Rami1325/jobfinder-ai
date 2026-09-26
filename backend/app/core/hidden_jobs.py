"""What the user said "Not for me" to (PLAN 31.5/4): a posting, a company, or a
word in a job title, applied to every search BEFORE selection, so a hidden
posting takes no slot, is never fetched and costs no model call.

**Deterministic, and pinned that way through the AST** (smoke 31.5/4): no model,
no network, no clock. It decides what a person is never shown, so nothing it
reads may be a model's opinion; and the frontend never re-derives it (one
matcher, one answer), so the Jobs page shows what the server hid, by count.

**Nothing is hidden silently.** Every caller reports how many it hid
(`JobSearchResult.hidden`, `JobSearchHistory.hidden`), and the page says so with
a way to see and undo the list.

The three kinds, each chosen for its false positives:
- a POSTING, by URL (trailing slash and case folded, like History's dedupe);
- a COMPANY, by the tracker's own normaliser (`inbox_rules.normalize_company`:
  lower case, quote marks and legal suffixes gone) and EQUAL names only, never
  containment: hiding "Wix" must not hide "Wixel" or "Wix Labs Partners";
- a TITLE WORD. A Latin word needs a word boundary on both sides ("Java" hides
  "Java Developer", never "JavaScript Developer"); a Hebrew word is a bare
  substring, because ב/ל/ה/ו/מ/ש glue onto the noun (hiding "מכירות" hides
  "נציג/ת למכירות"), the house rule a symmetric boundary would break.
"""

from __future__ import annotations

import re

from app.core.inbox_rules import normalize_company
from app.models import HiddenJobs

_HEBREW = re.compile(r"[֐-׿]")
_SPACE = re.compile(r"\s+")


def url_key(url: str) -> str:
    """A posting's identity for hiding: trimmed, no trailing slash, case folded."""
    return (url or "").strip().rstrip("/").casefold()


def word_key(word: str) -> str:
    """A title word as stored: trimmed, inner spaces collapsed, case folded."""
    return _SPACE.sub(" ", (word or "").strip()).casefold()


def canonical(hidden: HiddenJobs) -> HiddenJobs:
    """The stored form: each entry keyed as it is compared, blanks dropped,
    duplicates dropped in first-seen order. Companies are stored normalised."""

    def keep(values: list[str], key) -> list[str]:  # noqa: ANN001
        seen: set[str] = set()
        out: list[str] = []
        for value in values:
            k = key(value)
            if k and k not in seen:
                seen.add(k)
                out.append(k)
        return out

    return HiddenJobs(
        urls=keep(hidden.urls, url_key),
        companies=keep(hidden.companies, normalize_company),
        title_words=keep(hidden.title_words, word_key),
    )


def _word_in(word: str, title: str) -> bool:
    if _HEBREW.search(word):
        return word in title
    return re.search(rf"(?<!\w){re.escape(word)}(?!\w)", title) is not None


def hidden_reason(hidden: HiddenJobs | None, *, url: str, company: str, title: str) -> str:
    """Why this posting is hidden: "url", "company", "title", or "" (shown).
    `hidden` is expected in its canonical form (what `canonical` stores)."""
    if hidden is None:
        return ""
    if url and hidden.urls and url_key(url) in hidden.urls:
        return "url"
    if company and hidden.companies and normalize_company(company) in hidden.companies:
        return "company"
    if title and hidden.title_words:
        folded = title.casefold()
        if any(_word_in(w, folded) for w in hidden.title_words):
            return "title"
    return ""


def is_empty(hidden: HiddenJobs | None) -> bool:
    return hidden is None or not (hidden.urls or hidden.companies or hidden.title_words)


def parse(raw: str | None) -> HiddenJobs | None:
    """The stored set (`users.hidden_jobs_json`), or None when there is none or
    it no longer parses: a hide that cannot be read shows everything, never an
    error, on every path that reads it (the searches, History, the alerts)."""
    if not raw:
        return None
    try:
        return HiddenJobs.model_validate_json(raw)
    except Exception:  # noqa: BLE001 - a legacy/corrupt row hides nothing
        return None


def search_kw(raw: str | None) -> dict:
    """`hidden=` for `search_jobs`, and only when something is hidden, so a seam
    that replaces the search (the smoke test's fakes, an alert's `search_fn`) is
    called exactly as before for a user who never hid anything."""
    hidden = parse(raw)
    return {} if is_empty(hidden) else {"hidden": hidden}
