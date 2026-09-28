"""Lever postings-API provider (2026-09-28): the official public API, on BOTH hosts.

`GET https://{host}/v0/postings/{site}?mode=json` returns every published
posting of one company with its description inline (`descriptionPlain`, the
`lists` sections and `additionalPlain`), so hits need no detail fetch. No key:
Lever documents this API "to help you create a job site", and its only stated
rate limit is on application POSTs (github.com/lever/postings-api, read
2026-09-27). The server-side `location=` filter is exact and case-sensitive,
so, like Greenhouse, the whole board is read and filtered here.

TWO HOSTS. Lever runs `api.lever.co` and an EU region, `api.eu.lever.co`, and a
site answers on one of them. The July 2026 probe that recorded "Lever: zero
Israeli tenants" (PLAN 9.3) asked only the first; Mobileye, 145 openings in
Israel on 2026-09-27, is on the EU host. The registry stores each site's host
(`lever_seed.py`), and only those two hosts are ever asked.

Per company like Comeet and Greenhouse: a registry (`board_companies`, board
"lever"), one `CompanyFeeds` (cache, one fetch at a time per company, failures
remembered, a time budget per query), then the title and place filters in
`board_filters.py`. A posting is in Israel by its own `country` ("IL") or a
location field naming an Israeli place, never by its description, so Mobileye's
Beijing postings stay out of an Israel search.

`parse_lever_postings` is a pure function pinned by the offline smoke test
against trimmed real responses (tests/fixtures/lever_postings_eu.json and
lever_postings_us.json) — if Lever changes shape, fix it here and keep the
fixtures green.
"""
from __future__ import annotations

import json
import urllib.parse
from datetime import datetime, timezone

from app.core import employment
from app.core.job_match import _html_to_text, _http_get
from app.core.lang import detect_language
from app.core.providers.base import JobHit, NoResultsError
from app.core.providers.board_filters import place_matches, title_words_match
from app.core.providers.feeds import CompanyFeeds, fresh_copy
from app.core.providers.lever_seed import SEED_BATCHES
from app.models import SearchContext

HOSTS = ("api.lever.co", "api.eu.lever.co")
_API_URL = "https://{host}/v0/postings/{site}?mode=json"
_TIMEOUT_S = 30
_MAX_WORKERS = 4  # seven sites; keep the burst polite
_CACHE_TTL_S = 15 * 60
_FAIL_TTL_S = 10 * 60
_BUDGET_S = 20.0

FEEDS = CompanyFeeds("lever", workers=_MAX_WORKERS, ttl_s=_CACHE_TTL_S, fail_ttl_s=_FAIL_TTL_S)


def epoch_ms_to_iso(value) -> str:  # noqa: ANN001
    """Lever's `createdAt` (epoch MILLISECONDS) as an ISO UTC string of at most
    32 characters, the `posted_at` shape every board uses; "" for anything that
    is not a plausible timestamp (unknown, never guessed)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return ""
    if not 1_000_000_000_000 <= value <= 10_000_000_000_000:  # 2001 .. 2286, in ms
        return ""
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat(timespec="seconds")


def _description(p: dict) -> str:
    parts = [str(p.get("descriptionPlain") or "").strip()]
    for section in p.get("lists") or []:
        if not isinstance(section, dict):
            continue
        head = str(section.get("text") or "").strip()
        body = _html_to_text(str(section.get("content") or ""))
        text = "\n".join(x for x in (head, body) if x)
        if text:
            parts.append(text)
    parts.append(str(p.get("additionalPlain") or "").strip())
    return "\n\n".join(x for x in parts if x)


def parse_lever_postings(postings: list, company_name: str = "") -> list[JobHit]:
    """Parse one site's `?mode=json` array into JobHits, deduped by posting id,
    order preserved. Pure; pinned by the smoke test."""
    hits: list[JobHit] = []
    seen: set[str] = set()
    for p in postings or []:
        if not isinstance(p, dict):
            continue
        url = str(p.get("hostedUrl") or "").strip()
        pid = str(p.get("id") or "").strip()
        if not url or (pid or url) in seen:
            continue
        seen.add(pid or url)
        title = str(p.get("text") or "").strip()
        categories = p.get("categories") if isinstance(p.get("categories"), dict) else {}
        description = _description(p)
        hits.append(
            JobHit(
                source="lever",
                external_id=pid,
                title=title,
                company=company_name,
                location=str(categories.get("location") or "").strip(),
                description=description,  # inline — no detail fetch needed
                url=url,
                posted_at=epoch_ms_to_iso(p.get("createdAt")),
                language=detect_language(f"{title} {description}"),
                raw=p,
                # "hybrid" / "onsite" / "remote": the board's own statement, which
                # `work_mode` reads before the words ("unspecified" reads as nothing).
                work_mode=str(p.get("workplaceType") or "").strip(),
                # `categories.commitment`, the company's own words ("Full-time",
                # "Contract", "Intern"), read exactly; never the title.
                employment=employment.from_field(categories.get("commitment")),
            )
        )
    return hits


def _places(hit: JobHit) -> list[str]:
    categories = hit.raw.get("categories") if isinstance(hit.raw, dict) else None
    categories = categories if isinstance(categories, dict) else {}
    places = [hit.location]
    places += [str(x) for x in categories.get("allLocations") or [] if x]
    return places


def location_matches(hit: JobHit, wanted: str) -> bool:
    country = str(hit.raw.get("country") or "") if isinstance(hit.raw, dict) else ""
    return place_matches(wanted, _places(hit), country)


def keyword_matches(hit: JobHit, job_title: str) -> bool:
    categories = hit.raw.get("categories") if isinstance(hit.raw, dict) else None
    categories = categories if isinstance(categories, dict) else {}
    return title_words_match(
        job_title, hit.title, str(categories.get("team") or ""), str(categories.get("department") or ""),
        hit.description,
    )


def api_url(host: str, site: str) -> str:
    """The postings URL for one site; refuses any host but Lever's two."""
    if host not in HOSTS:
        raise ValueError(f"not a Lever API host: {host!r}")
    return _API_URL.format(host=host, site=urllib.parse.quote(site, safe=""))


def _feed(company):
    def fetch() -> list[JobHit]:
        data = json.loads(_http_get(api_url(company.host or HOSTS[0], company.slug), timeout=_TIMEOUT_S))
        if not isinstance(data, list):
            raise ValueError(f"Lever answered no postings list for {company.slug}")
        return parse_lever_postings(data, company_name=company.name)

    return fetch


def _registry():
    from app.db.boards import registry

    return registry("lever", SEED_BATCHES)


class LeverProvider:
    """Lever as a `JobProvider` (see base.py). Inline-description style;
    registry-driven fan-out across companies instead of a keyword search."""

    name = "lever"

    def search(self, ctx: SearchContext) -> list[JobHit]:
        # Lazy DB imports: providers are constructed at module import.
        from app.db.boards import list_board_companies
        from app.db.database import SessionLocal

        with SessionLocal() as db:
            companies = list_board_companies(db, _registry())
        if not companies:
            raise ValueError("No Lever companies registered.")
        got = FEEDS.gather([(f"{c.host}/{c.slug}", _feed(c)) for c in companies], _BUDGET_S)
        if not got.values:
            raise ValueError("Couldn't reach any Lever job boards right now. Try again in a minute.")
        hits = [h for c in companies for h in got.values.get(f"{c.host}/{c.slug}", [])]
        if ctx.job_title.strip():
            hits = [h for h in hits if keyword_matches(h, ctx.job_title)]
        if ctx.location.strip():
            hits = [h for h in hits if location_matches(h, ctx.location)]
        if not hits:
            where = f" in '{ctx.location}'" if ctx.location.strip() else ""
            raise NoResultsError(
                f"No open positions matching '{ctx.job_title}'{where} at the "
                f"{len(got.values)} Lever companies that answered."
            )
        hits.sort(key=lambda h: h.posted_at, reverse=True)  # freshest first
        return [fresh_copy(h) for h in hits[: ctx.limit]]

    def fetch_description(self, hit: JobHit) -> str:
        return hit.description  # inline from the postings API — never refetch
