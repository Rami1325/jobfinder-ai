"""Greenhouse boards-API provider — the ATS most Israeli scale-ups host on.

Greenhouse's job board API is official and public (no auth, no token):
`GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true`
returns every open position with the full posting HTML inline (HTML-escaped in
the `content` field) — so, like Comeet, hits need no per-job detail fetch.

Like Comeet, Greenhouse is queried per company: we keep a registry of Israeli
tech companies (`greenhouse_companies` table, seeded from greenhouse_seed.py,
user-extensible via POST /jobs/greenhouse/companies), pull each board in
parallel with a short in-process TTL cache, then filter client-side by the
search title/location (with Hebrew→English aliases for the big Israeli cities —
Greenhouse location data is English).

`parse_greenhouse_jobs` and `parse_board_ref` are pure functions pinned by the
offline smoke test against a trimmed real API response
(tests/fixtures/greenhouse_jobs.json) — if Greenhouse changes shape, fix here
and keep the fixture green.
"""
from __future__ import annotations

import html as _html
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor

from app.core.job_match import _html_to_text, _http_get
from app.core.lang import detect_language
from app.core.providers.base import JobHit, NoResultsError
from app.core.providers.geo import HE_CITY_ALIASES, ISRAEL_TOKENS
from app.models import SearchContext

_API_URL = "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"
_TIMEOUT_S = 30
_MAX_WORKERS = 8  # registry-wide fan-out; keep the burst polite
_CACHE_TTL_S = 15 * 60  # boards change slowly; don't re-hit every search

# A board slug ("wizinc") or any URL that carries one:
#   https://job-boards.greenhouse.io/wizinc[/...]
#   https://boards.greenhouse.io/wizinc[/...]
#   https://boards-api.greenhouse.io/v1/boards/wizinc/jobs
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,79}$")
_URL_RE = re.compile(
    r"^https?://(?:job-boards|boards|boards-api)\.greenhouse\.io/"
    r"(?:v1/boards/)?([A-Za-z0-9_-]+)"
)

# slug -> (fetched_at, raw jobs list). In-process cache so a burst of searches
# doesn't re-hit ~16 board APIs each time.
_jobs_cache: dict[str, tuple[float, list]] = {}


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


def _fetch_jobs(slug: str) -> list:
    """One board's open jobs (cached). Raises on failure — the caller isolates."""
    now = time.time()
    cached = _jobs_cache.get(slug)
    if cached and now - cached[0] < _CACHE_TTL_S:
        return cached[1]
    data = json.loads(_http_get(_API_URL.format(slug=slug), timeout=_TIMEOUT_S))
    jobs = data.get("jobs") if isinstance(data, dict) else None
    jobs = jobs if isinstance(jobs, list) else []
    _jobs_cache[slug] = (now, jobs)
    return jobs


def register_company(db, board: str):
    """Add (or refresh) a company from its board slug / careers URL: validate
    against the live boards API, upsert into the registry. Returns a BoardRef.
    Raises ValueError with a user-facing message on any problem."""
    from app.db.greenhouse import upsert_company

    slug = parse_board_ref(board)
    try:
        data = json.loads(_http_get(_API_URL.format(slug=slug), timeout=_TIMEOUT_S))
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

        hits: list[JobHit] = []
        reached = 0
        with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
            futures = [(c, pool.submit(_fetch_jobs, c.slug)) for c in companies]
            for company, fut in futures:
                try:
                    jobs = fut.result()
                except Exception:  # noqa: BLE001 - one board must not sink the rest
                    continue
                reached += 1
                hits.extend(parse_greenhouse_jobs({"jobs": jobs}, company_name=company.name))
        if not reached:
            raise ValueError(
                "Couldn't reach any Greenhouse boards right now. Try again in a minute."
            )

        if ctx.job_title.strip():
            hits = [h for h in hits if _keyword_matches(h, ctx.job_title)]
        if ctx.location.strip():
            hits = [h for h in hits if _location_matches(h, ctx.location)]
        if not hits:
            where = f" in '{ctx.location}'" if ctx.location.strip() else ""
            raise NoResultsError(
                f"No open positions matching '{ctx.job_title}'{where} at the "
                f"{len(companies)} Greenhouse companies in your registry."
            )
        hits.sort(key=lambda h: h.posted_at, reverse=True)  # freshest first
        return hits[: ctx.limit]

    def fetch_description(self, hit: JobHit) -> str:
        return hit.description  # inline from the boards API — never refetch
