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
    # Cross-board duplicates merged into this hit (PLAN 15.1): the same posting
    # found on other boards, as {"source": ..., "url": ...}. Filled by the
    # fan-out's dedupe, never by providers.
    also_on: list = field(default_factory=list)
    # Older than the search's max_age_days but kept because its title matches
    # the searched keywords (PLAN 15.6 backfill). Set by the fan-out's tiering,
    # never by providers; the UI marks these with the post date.
    stale: bool = False
    # The worldwide-remote market this hit came back from ("United States",
    # "United Kingdom", "European Union"), or "" for the context's own
    # location. Set by the fan-out's _search_board, NEVER by providers — the
    # remote-ness and the market live in the QUERY (f_WT=2 + location) and
    # nothing in a LinkedIn card echoes them back. This is the gate on the
    # geo-restriction classifier: with include_worldwide off every stamp is ""
    # and the classifier is never called, so a normal search and every
    # Israeli-board posting are structurally out of its reach.
    origin_market: str = ""
    # Evidence text set by `fetch_description` when the BOARD ITSELF says the
    # posting is dead — the guest page's own banner ("No longer accepting
    # applications"), or "HTTP 404" / "HTTP 410" on the detail endpoint.
    #
    # "" means NOT OBSERVED, which is NOT the same as "open". Most boards can
    # never say: Drushim's search API drops `IsExpired` rows before we see them
    # (drushim.py:65), Comeet's positions API and Greenhouse's board API list
    # only open roles, and none of the three fetches anything at score time — so
    # on those boards this field is "" for a live posting and "" for a dead one
    # alike, and nothing downstream may read "" as a liveness claim. It is
    # LinkedIn-only by construction (PLAN 28.2): the one registered board whose
    # search index is stale by design. Set by providers, never by the fan-out.
    closed: str = ""


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
