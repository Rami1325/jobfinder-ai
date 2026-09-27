"""Jobs the user already applied to never come back (Phase 32).

A posting is left out of every job search, the saved matches (History) and the
alert mornings once the tracker holds it at `applied`, `interview`, `offer` or
`rejected`. A row still `saved` is NOT applied: saving is how a person says
"come back to this", so those keep showing, with their Saved marker.

**Deterministic, and pinned that way through the AST** (smoke, Phase 32): no
model, no network, no clock, the rule `hidden_jobs` keeps. It decides what a
person is never shown, so nothing it reads may be a model's opinion, and the
page never re-derives it (one matcher, one answer): the server counts what it
left out and the page says the count.

**It runs where "Not for me" runs, and for the same reason** (`job_search.
_split_applied`, beside `_split_hidden`): BEFORE selection, so an applied
posting takes no slot, is never fetched, costs no model call, and the freed
slot refills in the same round. A search still fills to its limit.

**Two ways a posting is the one applied to, and nothing looser:**
- its ADDRESS: `posting_keys.url_key`, the tracker's own key, which the Applied
  marker on a search card (`history.stamp_applied`) and History's status have
  always matched by: LinkedIn's posting id across URL shapes, the exact address
  otherwise;
- its ROLE: `posting_keys.content_key`, exact title + company after
  normalising case, whitespace, punctuation, Hebrew acronym marks and legal
  suffixes, and "" (never a match) when either half is missing. That is the
  search's own "same posting on another board" fingerprint, the one that folds a
  Drushim copy into a LinkedIn card as "Also on". The Gmail sync's cards carry
  no address at all, only the company and the role as the email named them, so
  the role is how they are matched; and a row WITH an address contributes its
  role too, because this runs before the fold: without it, taking the applied
  LinkedIn copy out would let its Drushim twin take the slot and bring the job
  back.

Rejected, and why: a title ALONE ("QA Engineer" at any company) and any fuzzy or
contained match ("Senior QA Engineer" for "QA Engineer"), because a different
role at the same company, or the same title somewhere else, is a job the person
has not applied to, and hiding it is the error this feature must never make.
Exact equality needs no Hebrew-prefix rule (the house rule governs SUBSTRING
matching): it never reads a word inside another.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from app.core.posting_keys import content_key, url_key

# The tracker statuses that mean the person applied at some point. `saved` is
# deliberately absent (see the docstring), and so is a blank status, which every
# reader of the tracker takes as `saved`.
APPLIED_STATUSES = frozenset({"applied", "interview", "offer", "rejected"})


@dataclass(frozen=True)
class AppliedJobs:
    """One person's applied postings, as the two keys they are matched by."""

    urls: frozenset[str] = frozenset()
    roles: frozenset[str] = frozenset()


def from_rows(rows: Iterable[tuple[str, str, str, str]]) -> AppliedJobs | None:
    """The set, from `(job_url, status, job_title, company)` tracker rows; None
    when no row is applied, so every caller can pass nothing at all."""
    urls: set[str] = set()
    roles: set[str] = set()
    for job_url, status, title, company in rows:
        if (status or "saved") not in APPLIED_STATUSES:
            continue
        key = url_key(job_url or "")
        if key:
            urls.add(key)
        role = content_key(title or "", company or "")
        if role:
            roles.add(role)
    if not urls and not roles:
        return None
    return AppliedJobs(urls=frozenset(urls), roles=frozenset(roles))


def is_empty(applied: AppliedJobs | None) -> bool:
    return applied is None or not (applied.urls or applied.roles)


def applied_reason(
    applied: AppliedJobs | None,
    *,
    url: str,
    title: str,
    company: str,
    also_on: Iterable[str] = (),
) -> str:
    """Why this posting is left out: "url", "role", or "" (shown). `also_on` is
    the posting's other addresses (a History row's other boards), matched the
    way `stamp_applied` follows them."""
    if is_empty(applied):
        return ""
    for address in (url, *also_on):
        key = url_key(address or "")
        if key and key in applied.urls:
            return "url"
    role = content_key(title or "", company or "")
    if role and role in applied.roles:
        return "role"
    return ""


def job_key(url: str, title: str, company: str) -> str:
    """One job, for COUNTING what was left out: its role when it has one, else its
    address. A search reads the same posting under several of its keywords and on
    several boards before selection folds them, and "3 jobs you applied to"
    about one job would be false."""
    return content_key(title or "", company or "") or url_key(url or "")


def search_kw(applied: AppliedJobs | None) -> dict:
    """`applied=` for `search_jobs`, and only when something IS applied, so a seam
    that replaces the search (the smoke test's fakes, an alert's `search_fn`) is
    called exactly as before for a person who has applied nowhere yet."""
    return {} if is_empty(applied) else {"applied": applied}
