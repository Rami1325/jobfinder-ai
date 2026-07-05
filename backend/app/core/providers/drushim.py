"""Drushim.co.il provider (unofficial JSON search API — the one their own
frontend calls; no auth, no bot wall as of July 2026).

`GET https://www.drushim.co.il/api/jobs/search?searchterm=<kw>&page=N` returns
clean JSON with the full description + requirements inline, so hits need no
per-job detail fetch (a big politeness/speed win over scrape-style boards).
Hebrew and English search terms both work. The public posting URL comes from
`JobInfo.Link` ("/job/<JobCode>/<hash>/").

Politeness: at most two pages per search, with a short pause between them.
There is no obvious location query param, so location is filtered client-side
against the posting's city names (Hebrew + English, tolerant substring match).

`parse_drushim_results` is a pure function pinned by the offline smoke test
against a trimmed real response (tests/fixtures/drushim_search.json) — if
Drushim changes its response shape, fix it here and keep the fixture green.
"""
from __future__ import annotations

import json
import time
import urllib.parse

from app.core.job_match import _html_to_text, _http_get
from app.core.lang import detect_language
from app.core.providers.base import JobHit
from app.models import SearchContext

_BASE_URL = "https://www.drushim.co.il"
_SEARCH_URL = f"{_BASE_URL}/api/jobs/search"
_MAX_PAGES = 2  # politeness cap — never hammer more than two pages per search
_PAGE_DELAY_S = 0.5

# Country-level tokens carry no signal on an Israel-only board: every posting
# would fail a substring match against them, so they're ignored by the filter.
_COUNTRY_TOKENS = {"israel", "ישראל"}

# Kept as a local alias: shared deterministic detection lives in app.core.lang.
_detect_language = detect_language


def _build_search_url(searchterm: str, page: int) -> str:
    return f"{_SEARCH_URL}?{urllib.parse.urlencode({'searchterm': searchterm, 'page': page})}"


def parse_drushim_results(data: dict) -> list[JobHit]:
    """Parse one page of /api/jobs/search JSON into JobHits, expired postings
    skipped, deduped by JobCode, order preserved. Pure function so the offline
    smoke test can pin the response-shape contract against a real fixture."""
    hits: list[JobHit] = []
    seen: set[str] = set()
    for job in data.get("ResultList") or []:
        if not isinstance(job, dict):
            continue
        content = job.get("JobContent") or {}
        info = job.get("JobInfo") or {}
        company = job.get("Company") or {}

        code = str(info.get("JobCode") or content.get("JobCode") or job.get("Code") or "").strip()
        link = str(info.get("Link") or "").strip()
        url = urllib.parse.urljoin(_BASE_URL, link) if link else (
            f"{_BASE_URL}/job/{code}/" if code else ""
        )
        if not url:
            continue
        key = code or url
        if key in seen or info.get("IsExpired"):
            continue
        seen.add(key)

        # JobContent.Name is the clean title; FullName appends the employer's
        # internal job code ("Data engineer - 36801"), so it's only a fallback.
        title = str(content.get("Name") or content.get("FullName") or "").strip()
        company_name = str(
            company.get("NameInHebrew") or company.get("CompanyDisplayName") or ""
        ).strip()

        # Companies without an uploaded logo still get a CompanyLogoLink, but it's
        # a directory stub ending in "/" (no filename) — treat those as no logo.
        logo_url = str(company.get("CompanyLogoLink") or "").strip()
        if logo_url.endswith("/"):
            logo_url = ""

        cities: list[str] = []
        for addr in content.get("Addresses") or []:
            city = str((addr or {}).get("City") or "").strip()
            if city and city not in cities:
                cities.append(city)

        description = _html_to_text(str(content.get("Description") or ""))
        requirements = _html_to_text(str(content.get("Requirements") or ""))
        full_text = "\n\n".join(part for part in (description, requirements) if part)

        hits.append(
            JobHit(
                source="drushim",
                external_id=code,
                title=title,
                company=company_name,
                location=", ".join(cities),
                description=full_text,  # inline — no detail fetch needed
                url=url,
                posted_at=str(info.get("Date") or "").strip(),
                logo_url=logo_url,
                language=_detect_language(f"{title} {full_text}"),
                raw=job,
            )
        )
    return hits


def _location_matches(hit: JobHit, wanted: str) -> bool:
    """Tolerant client-side location filter. Compares each comma-separated part
    of the user's location against the posting's city names in both Hebrew
    (`City`) and English (`CityEnglish` — which the API pads with tabs).
    Postings with no address info are kept rather than dropped: missing data
    shouldn't hide an otherwise-relevant job."""
    tokens = [t.strip().lower() for t in wanted.split(",")]
    tokens = [t for t in tokens if t and t not in _COUNTRY_TOKENS]
    if not tokens:
        return True

    candidates: set[str] = set()
    if hit.location:
        candidates.add(hit.location.lower())
    content = hit.raw.get("JobContent") or {} if isinstance(hit.raw, dict) else {}
    for addr in content.get("Addresses") or []:
        for field in ("City", "CityEnglish"):
            value = str((addr or {}).get(field) or "").strip().lower()
            if value:
                candidates.add(value)
    if not candidates:
        return True
    return any(t in c or c in t for t in tokens for c in candidates)


class DrushimProvider:
    """Drushim as a `JobProvider` (see base.py). Inline-description style:
    the search response already contains the full posting text."""

    name = "drushim"

    def search(self, ctx: SearchContext) -> list[JobHit]:
        if not ctx.job_title.strip():
            raise ValueError("Drushim search needs a job title.")
        hits: list[JobHit] = []
        seen: set[str] = set()
        page = 1
        while page <= _MAX_PAGES:
            if page > 1:
                time.sleep(_PAGE_DELAY_S)
            try:
                data = json.loads(_http_get(_build_search_url(ctx.job_title.strip(), page)))
            except Exception as e:  # noqa: BLE001 - network/JSON trouble; page 2 is optional
                if page == 1:
                    raise ValueError(
                        "Couldn't reach Drushim's job search. Try again in a minute."
                    ) from e
                break
            page_hits = parse_drushim_results(data if isinstance(data, dict) else {})
            if ctx.location.strip():
                page_hits = [h for h in page_hits if _location_matches(h, ctx.location)]
            for hit in page_hits:
                key = hit.external_id or hit.url
                if key in seen:
                    continue
                seen.add(key)
                hits.append(hit)
            if len(hits) >= ctx.limit:
                break
            # Only go to page 2 when the API says there is one and page 1 was
            # non-empty (an empty page means the term simply has no results).
            next_page = data.get("NextPageNumber") if isinstance(data, dict) else None
            if not page_hits or not isinstance(next_page, int) or next_page <= page:
                break
            page = next_page
        if not hits:
            where = f" in '{ctx.location}'" if ctx.location.strip() else ""
            raise ValueError(
                f"No Drushim jobs found for '{ctx.job_title}'{where}. "
                "Check 'Customize search' and adjust the title or location."
            )
        return hits[: ctx.limit]

    def fetch_description(self, hit: JobHit) -> str:
        return hit.description  # inline from the search response — never refetch
