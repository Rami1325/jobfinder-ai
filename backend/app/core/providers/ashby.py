"""Ashby posting-API provider (2026-09-28): the public job-board API.

`GET https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true`
answers every published posting of one company's board, with its description
inline (`descriptionPlain`), its work mode (`workplaceType`: "OnSite", "Hybrid",
"Remote") and, where the company publishes it, its pay (`compensation`). No key:
Ashby's docs say "This API allows you to get data for all currently published
Job Postings" and "If you host your own careers page, you can use this data to
populate it" (developers.ashbyhq.com, read 2026-09-27). A board name the API
does not know answers 404. There is no server-side filter, so, like Greenhouse
and Lever, the whole board is read and filtered here.

`isRemote` IS NOT REMOTE, the Comeet trap again: Lemonade's hybrid Tel Aviv
product role carries `isRemote: true` with `workplaceType: "Hybrid"` (the
fixture). Only `workplaceType` is the board's statement, handed to
`app.core.work_mode` through `JobHit.work_mode`; `isRemote` is never read.

In Israel by the posting's own address (`address.postalAddress.addressCountry`,
and any secondary location's) or a location field naming an Israeli place
(`board_filters.place_matches`); Lemonade writes its Tel Aviv office as "TLV",
which the address says is Israel. Never by the description.

Per company like the other registry boards: `board_companies`, board "ashby",
and this board's `CompanyFeeds`. `parse_ashby_jobs` is a pure function pinned
by the offline smoke test against a trimmed real response
(tests/fixtures/ashby_board.json).
"""
from __future__ import annotations

import json
import re
import urllib.parse

from app.core import employment
from app.core.job_match import _html_to_text, _http_get
from app.core.lang import detect_language
from app.core.providers.ashby_seed import SEED_BATCHES
from app.core.providers.base import JobHit, NoResultsError
from app.core.providers.board_filters import place_matches, title_words_match
from app.core.providers.feeds import CompanyFeeds, fresh_copy
from app.models import SearchContext

_API_URL = "https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true"
_TIMEOUT_S = 30
_MAX_WORKERS = 4
_CACHE_TTL_S = 15 * 60
_FAIL_TTL_S = 10 * 60
_BUDGET_S = 20.0
_BOARD_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")

FEEDS = CompanyFeeds("ashby", workers=_MAX_WORKERS, ttl_s=_CACHE_TTL_S, fail_ttl_s=_FAIL_TTL_S)


def board_url(board: str) -> str:
    if not _BOARD_RE.match(board or ""):
        raise ValueError(f"not an Ashby job-board name: {board!r}")
    return _API_URL.format(board=urllib.parse.quote(board, safe="."))


def _address(entry: dict) -> dict:
    address = entry.get("address") if isinstance(entry, dict) else None
    postal = address.get("postalAddress") if isinstance(address, dict) else None
    return postal if isinstance(postal, dict) else {}


def _pay(job: dict) -> str:
    """The pay the posting publishes, as the board words it, or ""."""
    comp = job.get("compensation") if isinstance(job.get("compensation"), dict) else {}
    for key in ("scrapeableCompensationSalarySummary", "compensationTierSummary"):
        value = comp.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def parse_ashby_jobs(data: dict, company_name: str = "") -> list[JobHit]:
    """Parse one board's answer into JobHits: listed postings only, deduped by
    id, order preserved. Pure; pinned by the smoke test."""
    hits: list[JobHit] = []
    seen: set[str] = set()
    for job in (data.get("jobs") if isinstance(data, dict) else None) or []:
        if not isinstance(job, dict) or job.get("isListed") is False:
            continue
        url = str(job.get("jobUrl") or "").strip()
        jid = str(job.get("id") or "").strip()
        if not url or (jid or url) in seen:
            continue
        seen.add(jid or url)
        title = str(job.get("title") or "").strip()
        description = str(job.get("descriptionPlain") or "").strip() or _html_to_text(
            str(job.get("descriptionHtml") or "")
        )
        pay = _pay(job)
        if pay:
            description = f"{description}\n\nCompensation: {pay}".strip()
        hits.append(
            JobHit(
                source="ashby",
                external_id=jid,
                title=title,
                company=company_name,
                location=str(job.get("location") or "").strip(),
                description=description,  # inline — no detail fetch needed
                url=url,
                posted_at=str(job.get("publishedAt") or "").strip()[:32],
                language=detect_language(f"{title} {description}"),
                raw=job,
                # "OnSite" / "Hybrid" / "Remote"; never `isRemote` (module docstring).
                work_mode=str(job.get("workplaceType") or "").strip(),
                # "FullTime" / "PartTime" / "Intern" / "Contract" / "Temporary"; never the title.
                employment=employment.from_field(job.get("employmentType")),
            )
        )
    return hits


def _places_and_country(hit: JobHit) -> tuple[list[str], str]:
    job = hit.raw if isinstance(hit.raw, dict) else {}
    entries = [job] + [s for s in job.get("secondaryLocations") or [] if isinstance(s, dict)]
    places = [hit.location] + [str(s.get("location") or "") for s in entries[1:]]
    countries = []
    for entry in entries:
        postal = _address(entry)
        places.append(str(postal.get("addressLocality") or ""))
        countries.append(str(postal.get("addressCountry") or "").strip())
    # Israel if ANY of its offices is in Israel, else its own country.
    country = next((c for c in countries if c.lower() == "israel"), countries[0] if countries else "")
    return places, country


def location_matches(hit: JobHit, wanted: str) -> bool:
    places, country = _places_and_country(hit)
    return place_matches(wanted, places, country)


def keyword_matches(hit: JobHit, job_title: str) -> bool:
    job = hit.raw if isinstance(hit.raw, dict) else {}
    return title_words_match(
        job_title, hit.title, str(job.get("department") or ""), str(job.get("team") or ""), hit.description
    )


def _feed(company):
    def fetch() -> list[JobHit]:
        data = json.loads(_http_get(board_url(company.slug), timeout=_TIMEOUT_S))
        if not isinstance(data, dict) or not isinstance(data.get("jobs"), list):
            raise ValueError(f"Ashby answered no job list for {company.slug}")
        return parse_ashby_jobs(data, company_name=company.name)

    return fetch


def _registry():
    from app.db.boards import registry

    return registry("ashby", SEED_BATCHES)


class AshbyProvider:
    """Ashby as a `JobProvider` (see base.py). Inline-description style;
    registry-driven fan-out across companies instead of a keyword search."""

    name = "ashby"

    def search(self, ctx: SearchContext) -> list[JobHit]:
        from app.db.boards import list_board_companies
        from app.db.database import SessionLocal

        with SessionLocal() as db:
            companies = list_board_companies(db, _registry())
        if not companies:
            raise ValueError("No Ashby companies registered.")
        got = FEEDS.gather([(c.slug, _feed(c)) for c in companies], _BUDGET_S)
        if not got.values:
            raise ValueError("Couldn't reach any Ashby job boards right now. Try again in a minute.")
        hits = [h for c in companies for h in got.values.get(c.slug, [])]
        if ctx.job_title.strip():
            hits = [h for h in hits if keyword_matches(h, ctx.job_title)]
        if ctx.location.strip():
            hits = [h for h in hits if location_matches(h, ctx.location)]
        if not hits:
            where = f" in '{ctx.location}'" if ctx.location.strip() else ""
            raise NoResultsError(
                f"No open positions matching '{ctx.job_title}'{where} at the "
                f"{len(got.values)} Ashby companies that answered."
            )
        hits.sort(key=lambda h: h.posted_at, reverse=True)  # freshest first
        return [fresh_copy(h) for h in hits[: ctx.limit]]

    def fetch_description(self, hit: JobHit) -> str:
        return hit.description  # inline from the posting API — never refetch
