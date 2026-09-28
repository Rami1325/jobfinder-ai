"""Greenhouse boards-API provider — the ATS most Israeli scale-ups host on.

Greenhouse's job board API is official and public (no auth, no token):
`GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true`
returns every open position with the full posting HTML inline (HTML-escaped in
the `content` field) — so, like Comeet, hits need no per-job detail fetch.

Like Comeet, Greenhouse is queried per company: we keep a registry of Israeli
tech companies (`greenhouse_companies` table, seeded from greenhouse_seed.py's
batches, admin-extensible via POST /jobs/greenhouse/companies), pull each board
through this board's `CompanyFeeds` (feeds.py: cache, one fetch at a time per
board, failures remembered, a time budget per query), then filter client-side
by the search title/location (with Hebrew→English aliases for the big Israeli
cities — Greenhouse location data is English).

A BOARD TOO LARGE TO READ WHOLE (2026-09-28). `_http_get` reads at most 3 MB
(`HTTP_READ_CAP`), and with every description inline Elastic's board (384 jobs)
is over it: the JSON arrived cut off and failed to parse on every search.
SentinelOne's measured 2.96 MB and NICE's 2.66. Such a board is read as its
LIST (`/jobs` without `content`, 0.45 MB for Elastic), which carries the title,
the place, the dates and the link; its postings then match on the title alone,
and the ones a search selects fetch their description one at a time
(`fetch_description`, `/jobs/<id>`), the scrape-style path.

`parse_greenhouse_jobs` and `parse_board_ref` are pure functions pinned by the
offline smoke test against a trimmed real API response
(tests/fixtures/greenhouse_jobs.json) — if Greenhouse changes shape, fix here
and keep the fixture green.
"""
from __future__ import annotations

import html as _html
import json
import re

from app.core.job_match import HTTP_READ_CAP, _html_to_text, _http_get
from app.core.lang import detect_language
from app.core.providers.base import JobHit, NoResultsError
from app.core.providers.feeds import CompanyFeeds, fresh_copy
from app.core.providers.geo import HE_CITY_ALIASES, ISRAEL_TOKENS
from app.models import SearchContext

_API_URL = "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"
_LIST_URL = "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs"  # no descriptions
_JOB_URL = "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{job_id}"
_TIMEOUT_S = 30
_MAX_WORKERS = 8  # registry-wide fan-out; keep the burst polite
_CACHE_TTL_S = 15 * 60  # boards change slowly; don't re-hit every search
_FAIL_TTL_S = 10 * 60  # a board that failed (a 404: it moved) is not asked again for ten minutes
_BUDGET_S = 20.0  # how long one query waits for the registry (feeds.py)
# The raw key a list-only posting carries its board slug under, for its
# description fetch. Never a Greenhouse field name.
_BOARD_KEY = "_jf_board"

# A board slug ("wizinc") or any URL that carries one:
#   https://job-boards.greenhouse.io/wizinc[/...]
#   https://boards.greenhouse.io/wizinc[/...]
#   https://boards-api.greenhouse.io/v1/boards/wizinc/jobs
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,79}$")
_URL_RE = re.compile(
    r"^https?://(?:job-boards|boards|boards-api)\.greenhouse\.io/"
    r"(?:v1/boards/)?([A-Za-z0-9_-]+)"
)

# Each board's parsed postings by slug, shared by every search in the process.
FEEDS = CompanyFeeds("greenhouse", workers=_MAX_WORKERS, ttl_s=_CACHE_TTL_S, fail_ttl_s=_FAIL_TTL_S)


def parse_board_ref(text: str) -> str:
    """Board slug from a slug or any Greenhouse board/API URL; raises
    ValueError otherwise. Pure function pinned by the smoke test."""
    text = text.strip().rstrip("/")
    m = _URL_RE.match(text)
    if m:
        return m.group(1).lower()
    slug = text.lower()
    if _SLUG_RE.match(slug):
        return slug
    raise ValueError(
        "That doesn't look like a Greenhouse board — paste the careers URL "
        "(https://job-boards.greenhouse.io/<company>) or just the company slug."
    )


def parse_greenhouse_jobs(data: dict, company_name: str = "") -> list[JobHit]:
    """Parse one board's /jobs?content=true JSON into JobHits, deduped by job
    id, order preserved. The `content` field arrives HTML-escaped, so it is
    unescaped before tag-stripping. Pure function pinned by the smoke test
    against a trimmed real response."""
    hits: list[JobHit] = []
    seen: set[str] = set()
    for job in (data.get("jobs") if isinstance(data, dict) else None) or []:
        if not isinstance(job, dict):
            continue
        url = str(job.get("absolute_url") or "").strip()
        job_id = str(job.get("id") or "").strip()
        if not url or (job_id or url) in seen:
            continue
        seen.add(job_id or url)

        title = str(job.get("title") or "").strip()
        location = str((job.get("location") or {}).get("name") or "").strip()
        description = _html_to_text(_html.unescape(str(job.get("content") or "")))

        hits.append(
            JobHit(
                source="greenhouse",
                external_id=job_id,
                title=title,
                company=str(job.get("company_name") or company_name or "").strip(),
                location=location,
                description=description,  # inline — no detail fetch needed
                url=url,
                posted_at=str(job.get("updated_at") or "").strip(),
                language=detect_language(f"{title} {description}"),
                raw=job,
            )
        )
    return hits


def _keyword_matches(hit: JobHit, job_title: str) -> bool:
    """Greenhouse has no keyword search — we pull whole company boards — so
    filter client-side: every word of the wanted title must appear somewhere
    in the posting (title, departments, or description)."""
    tokens = [t for t in re.split(r"[^\w+#]+", job_title.lower()) if len(t) >= 2]
    if not tokens:
        return True
    departments = ""
    if isinstance(hit.raw, dict):
        departments = " ".join(
            str((d or {}).get("name") or "") for d in hit.raw.get("departments") or []
        )
    hay = f"{hit.title} {departments} {hit.description}".lower()
    return all(t in hay for t in tokens)


def _location_matches(hit: JobHit, wanted: str) -> bool:
    """Tolerant location filter over the job's location + offices. Country
    tokens are meaningful (seeded companies are global, so "Israel" must
    actually filter). Jobs with no location data are kept — missing data
    shouldn't hide a job."""
    tokens = [t.strip().lower() for t in wanted.split(",") if t.strip()]
    if not tokens:
        return True
    candidates: set[str] = set()
    if hit.location:
        candidates.add(hit.location.lower())
    if isinstance(hit.raw, dict):
        for office in hit.raw.get("offices") or []:
            for field in ("name", "location"):
                value = str((office or {}).get(field) or "").strip().lower()
                if value:
                    candidates.add(value)
    if not candidates:
        return True
    for t in tokens:
        t = HE_CITY_ALIASES.get(t, t)
        if t in ISRAEL_TOKENS:
            t = "israel"
        if any(t in c or c in t for c in candidates):
            return True
    return False


def _jobs_of(data) -> list:
    jobs = data.get("jobs") if isinstance(data, dict) else None
    return jobs if isinstance(jobs, list) else []


def _fetch_jobs(slug: str) -> tuple[list, bool]:
    """One board's open jobs, and whether they carry their descriptions. A board
    whose inline descriptions pass the read cap is read as its list instead (see
    the module docstring). Raises on failure — the caller isolates. Uncached:
    `FEEDS` is the cache."""
    body = _http_get(_API_URL.format(slug=slug), timeout=_TIMEOUT_S)
    try:
        return _jobs_of(json.loads(body)), True
    except ValueError:
        if len(body.encode("utf-8")) < HTTP_READ_CAP - 4096:
            raise  # malformed, not cut off: a real failure
    listed = _jobs_of(json.loads(_http_get(_LIST_URL.format(slug=slug), timeout=_TIMEOUT_S)))
    return [{**job, _BOARD_KEY: slug} for job in listed if isinstance(job, dict)], False


def _feed(company):
    """The fetch `FEEDS` runs for one board: its postings, parsed once."""

    def fetch() -> list[JobHit]:
        jobs, _whole = _fetch_jobs(company.slug)
        return parse_greenhouse_jobs({"jobs": jobs}, company_name=company.name)

    return fetch


def fetch_job_description(slug: str, job_id: str) -> str:
    """One posting's description from its board (a list-only board's posting)."""
    data = json.loads(_http_get(_JOB_URL.format(slug=slug, job_id=job_id), timeout=_TIMEOUT_S))
    content = data.get("content") if isinstance(data, dict) else ""
    return _html_to_text(_html.unescape(str(content or "")))


def register_company(db, board: str):
    """Add (or refresh) a company from its board slug / careers URL: validate
    against the live boards API, upsert into the registry. Returns a BoardRef.
    Raises ValueError with a user-facing message on any problem."""
    from app.db.greenhouse import upsert_company

    slug = parse_board_ref(board)
    try:
        # The list, not the board with its descriptions: it names the company
        # just as well, and a large board's full form passes the read cap.
        data = json.loads(_http_get(_LIST_URL.format(slug=slug), timeout=_TIMEOUT_S))
    except Exception as e:  # noqa: BLE001 - 404/network, user-facing
        raise ValueError(
            f"Couldn't find a public Greenhouse board named '{slug}'. "
            "Check the slug in the company's careers URL."
        ) from e
    jobs = (data.get("jobs") if isinstance(data, dict) else None) or []
    # The API has no company-name field on the board itself; jobs carry one.
    name = ""
    for job in jobs:
        name = str((job or {}).get("company_name") or "").strip()
        if name:
            break
    return upsert_company(db, slug=slug, name=name or slug)


class GreenhouseProvider:
    """Greenhouse as a `JobProvider` (see base.py). Inline-description style;
    registry-driven fan-out across companies instead of a keyword search."""

    name = "greenhouse"

    def search(self, ctx: SearchContext) -> list[JobHit]:
        # Lazy DB imports: providers are constructed at module import, before
        # the app's lifespan hook has run init_db.
        from app.db.database import SessionLocal
        from app.db.greenhouse import list_companies

        with SessionLocal() as db:
            companies = list_companies(db)
        if not companies:
            raise ValueError(
                "No Greenhouse companies registered. Add one with its board slug."
            )

        # One board must not sink the rest (feeds.py counts failures and late
        # boards); only a registry that answered NOTHING is a board failure.
        got = FEEDS.gather([(c.slug, _feed(c)) for c in companies], _BUDGET_S)
        if not got.values:
            raise ValueError(
                "Couldn't reach any Greenhouse boards right now. Try again in a minute."
            )

        hits: list[JobHit] = [h for c in companies for h in got.values.get(c.slug, [])]
        if ctx.job_title.strip():
            hits = [h for h in hits if _keyword_matches(h, ctx.job_title)]
        if ctx.location.strip():
            hits = [h for h in hits if _location_matches(h, ctx.location)]
        if not hits:
            where = f" in '{ctx.location}'" if ctx.location.strip() else ""
            raise NoResultsError(
                f"No open positions matching '{ctx.job_title}'{where} at the "
                f"{len(got.values)} Greenhouse companies that answered."
            )
        hits.sort(key=lambda h: h.posted_at, reverse=True)  # freshest first
        # Fresh copies: the fan-out writes on a hit, and the cached ones serve
        # the next query too.
        return [fresh_copy(h) for h in hits[: ctx.limit]]

    def fetch_description(self, hit: JobHit) -> str:
        if hit.description:
            return hit.description  # inline from the boards API — never refetch
        # A posting of a board read as its list (module docstring): its own page.
        slug = hit.raw.get(_BOARD_KEY) if isinstance(hit.raw, dict) else None
        if not slug or not hit.external_id:
            return ""
        try:
            return fetch_job_description(str(slug), hit.external_id)
        except Exception:  # noqa: BLE001 - an unfetchable posting is `skipped`, never a raise
            return ""
