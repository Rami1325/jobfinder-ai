"""Job-source provider abstraction.

Each job board is a `JobProvider`: it turns a `SearchContext` into a list of
`JobHit`s and knows how to obtain the full description for one hit. Two styles
exist:

- inline-description boards (Drushim's JSON API returns the whole posting in
  the search response) — `JobHit.description` is filled and `fetch_description`
  just returns it, so scoring needs no extra network round-trips;
- scrape-style boards (LinkedIn's guest search returns only cards) —
  `description` is left empty ("" means "needs a detail fetch") and
  `fetch_description` pulls the posting per-hit.

The fan-out in `app.core.job_search` treats providers uniformly and isolates
failures, so one broken/blocked board degrades the search instead of sinking it.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from app.models import SearchContext


class NoResultsError(ValueError):
    """The board answered fine but had zero jobs matching the query.

    Distinct from a plain ValueError (blocked/unreachable/misconfigured) so the
    fan-out can report "nothing matched on X" separately from "X is down" —
    lumping them together made every empty query look like an outage in the UI.
    Still a ValueError, so anything catching board failures keeps working.
    """


@dataclass
class JobHit:
    """One job listing as returned by a provider's search, before scoring."""

    source: str = ""  # provider name, e.g. "linkedin" | "drushim"
    external_id: str = ""  # the board's own id for the posting (dedupe/debug)
    title: str = ""
    company: str = ""
    location: str = ""
    description: str = ""  # full posting text; "" means "needs fetch_description"
    url: str = ""  # public posting URL (also the cross-source dedupe key)
    posted_at: str = ""  # ISO date(-time) string, or "" when unknown
    logo_url: str = ""  # company logo image URL, "" when the board has none
    language: str = "en"  # "he" | "en" — best-effort detection by the provider
    raw: dict = field(default_factory=dict)  # provider-native payload for debugging


@runtime_checkable
class JobProvider(Protocol):
    """What every job board integration must expose."""

    name: str

    def search(self, ctx: SearchContext) -> list[JobHit]:
        """Return hits for the context. Raise ValueError with a user-facing
        message on board-level failures (blocked, unreachable, misconfigured);
        raise NoResultsError when the board worked but nothing matched."""
        ...

    def fetch_description(self, hit: JobHit) -> str:
        """Return the full posting text for one hit ("" if unavailable).
        Providers with inline descriptions return `hit.description` directly;
        scrape-style providers fetch it here (see `fetch_description_via_url`
        for the generic fallback path)."""
        ...


def fetch_description_via_url(hit: JobHit) -> str:
    """Default detail fetch for providers without a dedicated one: run the hit's
    URL through the generic extraction path (schema.org JobPosting first, then
    stripped HTML). Imported lazily to keep base.py dependency-free."""
    from app.core.job_match import fetch_job_text

    return fetch_job_text(hit.url)
