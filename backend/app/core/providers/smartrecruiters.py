"""SmartRecruiters provider (2026-09-28): the public posting list, filtered by the
board itself.

`GET https://api.smartrecruiters.com/v1/companies/{company}/postings?country=il&q={title}&limit=100`
answers one company's published postings, filtered SERVER-SIDE by country and
keywords (measured 2026-09-27: Check Point 105 in Israel, 57 of them for
"engineer"; Wix 34; ServiceNow 11, the Armis roles). An unknown company answers
200 with `totalFound: 0`, never 404. The list carries no description, so this
is the scrape-style path over JSON: `fetch_description` reads one posting
(`/postings/{id}`, its `jobAd.sections`), a small JSON GET, only for the
postings a search selects.

THE RISK, recorded rather than hidden: SmartRecruiters' current documentation
describes its Posting API with an API key or OAuth, while this legacy
`/v1/companies/{id}/postings` path answers without one. It may be withdrawn.
So a refusal (401 or 403) is quiet and clean: it is remembered for the cache's
15 minutes like an answer (one request per company per window, never one per
keyword query), the other companies still answer, and only when every company
refuses does the board report one plain sentence into `source_errors`, the way
any board that is down does. Nothing raises past the provider.

Per company, like the other registry boards: a registry (`board_companies`,
board "smartrecruiters"; the identifier is not guessable from the name, so each
is seeded), and this board's `CompanyFeeds`, keyed by company, country and
query, since the board filters server-side. Israel is asked for as `country=il`
when the search is for Israel; any other place, or none (every office, as on
Comeet and Greenhouse), is asked for without a country. Every posting is then checked
on its OWN country and place fields (`board_filters.place_matches`): a posting
outside Israel never reaches an Israel search, whatever the server sent.

`parse_smartrecruiters_postings` and `parse_smartrecruiters_posting` are pure
functions pinned by the offline smoke test against trimmed real responses
(tests/fixtures/smartrecruiters_postings.json, smartrecruiters_posting.json).
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse

from app.core.job_match import _html_to_text, _http_get
from app.core.lang import detect_language
from app.core.providers.base import JobHit, NoResultsError
from app.core.providers.board_filters import in_israel, place_matches
from app.core.providers.feeds import CompanyFeeds, fresh_copy
from app.core.providers.smartrecruiters_seed import SEED_BATCHES
from app.models import SearchContext

_API = "https://api.smartrecruiters.com/v1/companies/{company}/postings"
_PUBLIC = "https://jobs.smartrecruiters.com/{company}/{pid}"
_TIMEOUT_S = 30
_PAGE = 100  # one page a company a query: a search keeps at most 25 jobs
_MAX_WORKERS = 3
_CACHE_TTL_S = 15 * 60
_FAIL_TTL_S = 10 * 60
_BUDGET_S = 20.0
_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
_SECTIONS = ("companyDescription", "jobDescription", "qualifications", "additionalInformation")

FEEDS = CompanyFeeds("smartrecruiters", workers=_MAX_WORKERS, ttl_s=_CACHE_TTL_S, fail_ttl_s=_FAIL_TTL_S)

REFUSED = "refused"  # what a company's feed holds while the board refuses us


def _safe(value: str) -> str:
    if not _ID_RE.match(value or ""):
        raise ValueError(f"not a SmartRecruiters identifier: {value!r}")
    return value


def postings_url(company: str, query: str, country: str) -> str:
    params = {"limit": str(_PAGE)}
    if country:
        params["country"] = country
    if query.strip():
        params["q"] = query.strip()
    return f"{_API.format(company=_safe(company))}?{urllib.parse.urlencode(params)}"


def posting_url(company: str, pid: str) -> str:
    """One posting's JSON, built from the company and posting ids, never from
    the list's `ref`, so no answer can point the detail fetch elsewhere."""
    return f"{_API.format(company=_safe(company))}/{_safe(pid)}"


def _work_mode(location: dict) -> str:
    """"Remote" or "Hybrid" when the board SAYS so; "" when both flags are false,
    which is unknown (the board sets neither on most on-site postings, and not
    every posting that sets neither is on-site)."""
    if location.get("remote") is True:
        return "Remote"
    if location.get("hybrid") is True:
        return "Hybrid"
    return ""


def parse_smartrecruiters_postings(data: dict, company_name: str = "") -> list[JobHit]:
    """Parse one `/postings` answer into JobHits (description "": fetched per
    posting), deduped by id, order preserved. Pure; pinned by the smoke test."""
    hits: list[JobHit] = []
    seen: set[str] = set()
    for p in (data.get("content") if isinstance(data, dict) else None) or []:
        if not isinstance(p, dict):
            continue
        pid = str(p.get("id") or "").strip()
        company = p.get("company") if isinstance(p.get("company"), dict) else {}
        identifier = str(company.get("identifier") or "").strip()
        if not pid or pid in seen or not _ID_RE.match(pid) or not _ID_RE.match(identifier):
            continue
        seen.add(pid)
        title = str(p.get("name") or "").strip()
        location = p.get("location") if isinstance(p.get("location"), dict) else {}
        lang = p.get("language") if isinstance(p.get("language"), dict) else {}
        hits.append(
            JobHit(
                source="smartrecruiters",
                external_id=pid,
                title=title,
                company=str(company.get("name") or company_name or "").strip(),
                location=str(location.get("fullLocation") or location.get("city") or "").strip(),
                description="",  # the list carries none: fetch_description reads the posting
                url=_PUBLIC.format(company=identifier, pid=pid),
                posted_at=str(p.get("releasedDate") or "").strip()[:32],
                language="he" if str(lang.get("code") or "").lower()[:2] in ("he", "iw") else detect_language(title),
                raw=p,
                work_mode=_work_mode(location),
            )
        )
    return hits


def parse_smartrecruiters_posting(data: dict) -> str:
    """One posting's description: its job ad's sections, in order, HTML stripped.
    Pure; pinned by the smoke test."""
    ad = data.get("jobAd") if isinstance(data, dict) else None
    sections = ad.get("sections") if isinstance(ad, dict) else None
    if not isinstance(sections, dict):
        return ""
    parts = []
    for key in _SECTIONS:
        section = sections.get(key)
        if not isinstance(section, dict):
            continue
        text = _html_to_text(str(section.get("text") or ""))
        if text:
            head = str(section.get("title") or "").strip()
            parts.append(f"{head}\n{text}" if head else text)
    return "\n\n".join(parts)


def location_matches(hit: JobHit, wanted: str) -> bool:
    loc = hit.raw.get("location") if isinstance(hit.raw, dict) else None
    loc = loc if isinstance(loc, dict) else {}
    places = [hit.location, str(loc.get("city") or ""), str(loc.get("region") or "")]
    return place_matches(wanted, places, str(loc.get("country") or ""))


def _feed(company, query: str, country: str):
    def fetch():
        try:
            body = _http_get(postings_url(company.slug, query, country), timeout=_TIMEOUT_S)
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                return REFUSED  # remembered like an answer: see the module docstring
            raise
        data = json.loads(body)
        if not isinstance(data, dict) or not isinstance(data.get("content"), list):
            raise ValueError(f"SmartRecruiters answered no postings list for {company.slug}")
        return parse_smartrecruiters_postings(data, company_name=company.name)

    return fetch


def _registry():
    from app.db.boards import registry

    return registry("smartrecruiters", SEED_BATCHES)


class SmartRecruitersProvider:
    """SmartRecruiters as a `JobProvider` (see base.py). Scrape-style over JSON:
    the list filters server-side, and a selected posting's description is one
    more JSON request."""

    name = "smartrecruiters"

    def search(self, ctx: SearchContext) -> list[JobHit]:
        from app.db.boards import list_board_companies
        from app.db.database import SessionLocal

        with SessionLocal() as db:
            companies = list_board_companies(db, _registry())
        if not companies:
            raise ValueError("No SmartRecruiters companies registered.")
        where = ctx.location.strip()
        # Israel is asked for server-side; another place, or none (every office,
        # as on Comeet and Greenhouse), is asked for without a country.
        country = "il" if where and in_israel([where]) else ""
        query = ctx.job_title.strip()
        keys = [(f"{c.slug}|{country}|{query.lower()}", c) for c in companies]
        got = FEEDS.gather([(k, _feed(c, query, country)) for k, c in keys], _BUDGET_S)
        answered = {k: v for k, v in got.values.items() if v != REFUSED}
        if not answered:
            if any(v == REFUSED for v in got.values.values()):
                raise ValueError(
                    "SmartRecruiters is refusing requests from JobFinder right now; "
                    "its jobs are left out of this search."
                )
            raise ValueError("Couldn't reach SmartRecruiters right now. Try again in a minute.")
        hits = [h for k, _c in keys for h in answered.get(k, [])]
        if where:
            hits = [h for h in hits if location_matches(h, where)]
        if not hits:
            place = f" in '{where}'" if where else ""
            raise NoResultsError(
                f"No open positions matching '{query}'{place} at the "
                f"{len(answered)} SmartRecruiters companies that answered."
            )
        hits.sort(key=lambda h: h.posted_at, reverse=True)  # freshest first
        return [fresh_copy(h) for h in hits[: ctx.limit]]

    def fetch_description(self, hit: JobHit) -> str:
        if hit.description:
            return hit.description
        company = hit.raw.get("company") if isinstance(hit.raw, dict) else None
        identifier = str((company or {}).get("identifier") or "") if isinstance(company, dict) else ""
        try:
            data = json.loads(_http_get(posting_url(identifier, hit.external_id), timeout=_TIMEOUT_S))
        except Exception:  # noqa: BLE001 - an unfetchable posting is `skipped`, never a raise
            return ""
        return parse_smartrecruiters_posting(data)
