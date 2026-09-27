"""Comeet careers-API provider — the ATS most Israeli tech/startups host on.

Every Comeet company has a public careers page at
`https://www.comeet.com/jobs/<slug>/<uid>` that embeds a `COMPANY_DATA` JS
object holding the company uid and an API token. With those,
`GET https://www.comeet.co/careers-api/2.0/company/{uid}/positions?token=…&details=true`
(note the **.co** host; can be slow, hence the 60s timeout) returns every open
position with the full posting HTML inline — so, like Drushim, hits need no
per-job detail fetch.

Unlike keyword-search boards, Comeet is queried per company: we keep a
registry of Israeli tech companies (`comeet_companies` table, seeded from
comeet_seed.py's batches, admin-extensible via POST /jobs/comeet/companies),
pull each company's open positions through this board's `CompanyFeeds`
(feeds.py: a 15-minute cache, one fetch at a time per company, a failure
remembered for ten minutes, and a time budget per query, so one slow company
never stalls a search), then filter client-side by the search title/location
(with Hebrew→English aliases for the big Israeli cities, since Comeet location
data is English). Tokens are scraped from the careers page on first use,
cached in the DB, and re-scraped once on 401/403 (Comeet rotates them
occasionally).

`parse_comeet_positions`, `extract_company_data`, and `parse_careers_url` are
pure functions pinned by the offline smoke test against a trimmed real API
response (tests/fixtures/comeet_positions.json) — if Comeet changes shape,
fix here and keep the fixture green.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse

from app.core.job_match import _html_to_text, _http_get
from app.core.lang import detect_language
from app.core.providers.base import JobHit, NoResultsError
from app.core.providers.feeds import CompanyFeeds, fresh_copy
from app.core.providers.geo import HE_CITY_ALIASES, ISRAEL_TOKENS
from app.models import SearchContext

_API_URL = "https://www.comeet.co/careers-api/2.0/company/{uid}/positions"
_TIMEOUT_S = 60  # the careers API is noticeably slower than the boards
_MAX_WORKERS = 8  # registry-wide fan-out; keep the burst polite
_CACHE_TTL_S = 15 * 60  # positions change slowly; don't re-hit every search
_FAIL_TTL_S = 10 * 60  # a company that failed is not asked again for ten minutes
# How long one query waits for the registry before it answers with what came
# back (feeds.py). Measured 2026-09-28 from Israel: the whole 79-company
# registry answers in under 10 s cold; the budget is for the hung company.
_BUDGET_S = 20.0

_CAREERS_URL_RE = re.compile(
    r"^https?://(?:www\.)?comeet\.com/jobs/([A-Za-z0-9_-]+)/([0-9A-Fa-f]{2}\.[0-9A-Fa-f]{3})"
)
# COMPANY_DATA = {"name": "Kaltura", …, "company_uid": "E2.00D", "token": "2EDEA1…"}
_NAME_RE = re.compile(r'COMPANY_DATA\s*=\s*\{\s*"name"\s*:\s*"([^"]+)"')
_UID_RE = re.compile(r'"company_uid"\s*:\s*"([0-9A-Fa-f]{2}\.[0-9A-Fa-f]{3})"')
_TOKEN_RE = re.compile(r'"token"\s*:\s*"([0-9A-Fa-f]{16,64})"')

# Comeet location data is English; searches from Israeli users are often
# Hebrew. Alias the common city names so "תל אביב" finds "Tel Aviv" offices.
# Shared with the Greenhouse provider via providers/geo.py.
_HE_CITY_ALIASES = HE_CITY_ALIASES
_ISRAEL_TOKENS = ISRAEL_TOKENS

# One company's positions by uid: the cache, the in-flight fetches and the
# failure memory, shared by every search in this process.
FEEDS = CompanyFeeds("comeet", workers=_MAX_WORKERS, ttl_s=_CACHE_TTL_S, fail_ttl_s=_FAIL_TTL_S)


def parse_careers_url(url: str) -> tuple[str, str]:
    """(slug, uid) from a Comeet careers-page URL; raises ValueError otherwise.
    Pure function pinned by the smoke test."""
    m = _CAREERS_URL_RE.match(url.strip())
    if not m:
        raise ValueError(
            "That doesn't look like a Comeet careers URL "
            "(expected https://www.comeet.com/jobs/<company>/<code>)."
        )
    return m.group(1), m.group(2)


def extract_company_data(html: str) -> dict[str, str]:
    """{name, uid, token} from a careers page's embedded COMPANY_DATA (empty
    strings when absent). Pure function pinned by the smoke test."""
    name = _NAME_RE.search(html)
    uid = _UID_RE.search(html)
    token = _TOKEN_RE.search(html)
    return {
        "name": name.group(1) if name else "",
        "uid": uid.group(1) if uid else "",
        "token": token.group(1) if token else "",
    }


def parse_comeet_positions(positions: list, company_name: str = "") -> list[JobHit]:
    """Parse one company's /positions?details=true JSON into JobHits, internal
    postings skipped, deduped by position uid, order preserved. Pure function
    pinned by the smoke test against a trimmed real response."""
    hits: list[JobHit] = []
    seen: set[str] = set()
    for pos in positions or []:
        if not isinstance(pos, dict) or pos.get("is_internal") is True:
            continue
        url = str(pos.get("url_comeet_hosted_page") or pos.get("url_active_page") or "").strip()
        uid = str(pos.get("uid") or "").strip()
        if not url or (uid or url) in seen:
            continue
        seen.add(uid or url)

        title = str(pos.get("name") or "").strip()
        loc = pos.get("location") or {}
        # "Bnei Brak, Israel" — city plus the office's display name when they differ.
        parts = [str(loc.get(k) or "").strip() for k in ("city", "name")]
        location = ", ".join(dict.fromkeys(p for p in parts if p))

        # details is [{name: "Description", value: "<p>…"}, {name: "Requirements", …}]
        sections = []
        for d in pos.get("details") or []:
            text = _html_to_text(str((d or {}).get("value") or ""))
            if text:
                sections.append(text)
        description = "\n\n".join(sections)

        hits.append(
            JobHit(
                source="comeet",
                external_id=uid,
                title=title,
                company=str(pos.get("company_name") or company_name or "").strip(),
                location=location,
                description=description,  # inline — no detail fetch needed
                url=url,
                posted_at=str(pos.get("time_updated") or "").strip(),
                logo_url=str(pos.get("picture_url") or "").strip(),
                language=detect_language(f"{title} {description}"),
                raw=pos,
                # "Hybrid" / "Remote" / "On-site". NOT `location.is_remote`, which
                # the fixture's hybrid Bnei Brak office carries as true.
                work_mode=str(pos.get("workplace_type") or "").strip(),
            )
        )
    return hits


def _keyword_matches(hit: JobHit, job_title: str) -> bool:
    """Comeet has no keyword search — we pull whole company boards — so filter
    client-side: every word of the wanted title must appear somewhere in the
    posting (title, department, or description). Word chars include Hebrew."""
    tokens = [t for t in re.split(r"[^\w+#]+", job_title.lower()) if len(t) >= 2]
    if not tokens:
        return True
    department = str(hit.raw.get("department") or "") if isinstance(hit.raw, dict) else ""
    hay = f"{hit.title} {department} {hit.description}".lower()
    return all(t in hay for t in tokens)


def _location_matches(hit: JobHit, wanted: str) -> bool:
    """Tolerant location filter over the position's location fields. Unlike
    Drushim (Israel-only board), country tokens are meaningful here: seeded
    companies have offices abroad, so "Israel" must actually filter. Positions
    with no location data are kept — missing data shouldn't hide a job."""
    tokens = [t.strip().lower() for t in wanted.split(",") if t.strip()]
    if not tokens:
        return True
    loc = (hit.raw.get("location") or {}) if isinstance(hit.raw, dict) else {}
    candidates = {str(loc.get(k) or "").strip().lower() for k in ("name", "city", "state", "country")}
    candidates.discard("")
    if hit.location:
        candidates.add(hit.location.lower())
    if not candidates:
        return True
    for t in tokens:
        t = _HE_CITY_ALIASES.get(t, t)
        if t in _ISRAEL_TOKENS and candidates & {"il", "israel"}:
            return True
        if any(t in c or c in t for c in candidates):
            return True
    return False


def _api_url(uid: str, token: str) -> str:
    query = urllib.parse.urlencode({"token": token, "details": "true"})
    return f"{_API_URL.format(uid=uid)}?{query}"


def _scrape_token(careers_url: str) -> str:
    token = extract_company_data(_http_get(careers_url, timeout=_TIMEOUT_S))["token"]
    if not token:
        raise ValueError(f"no API token found on {careers_url}")
    return token


def _fetch_positions(company) -> tuple[list, str | None]:
    """One company's open positions, plus a freshly scraped token to persist
    when the stored one was missing/rotated (None otherwise). `company` is an
    app.db.comeet.CompanyRef. Raises on failure — the caller isolates. Uncached:
    `FEEDS` is the cache."""
    token, new_token = company.token, None
    if not token:
        token = new_token = _scrape_token(company.careers_url)
    try:
        data = json.loads(_http_get(_api_url(company.uid, token), timeout=_TIMEOUT_S))
    except urllib.error.HTTPError as e:
        if e.code not in (401, 403) or new_token:
            raise
        # Stored token rotated out from under us — re-scrape once and retry.
        token = new_token = _scrape_token(company.careers_url)
        data = json.loads(_http_get(_api_url(company.uid, token), timeout=_TIMEOUT_S))
    return (data if isinstance(data, list) else []), new_token


def _feed(company):
    """The fetch `FEEDS` runs for one company, on its pool: the positions,
    parsed ONCE into hits (the cache holds hits, so a query parses nothing),
    with a newly scraped token saved on the way (on a session of its own, since
    this runs on a worker thread and may finish after the search started it)."""

    def fetch() -> list[JobHit]:
        positions, new_token = _fetch_positions(company)
        if new_token:
            from app.db.comeet import save_tokens
            from app.db.database import SessionLocal

            try:
                with SessionLocal() as db:
                    save_tokens(db, {company.slug: new_token})
            except Exception:  # noqa: BLE001 - a token not saved is scraped again next time
                pass
        return parse_comeet_positions(positions, company_name=company.name)

    return fetch


def register_company(db, careers_url: str):
    """Add (or refresh) a company from its public careers-page URL: validate,
    scrape COMPANY_DATA, upsert into the registry. Returns a CompanyRef.
    Raises ValueError with a user-facing message on any problem."""
    from app.db.comeet import upsert_company

    slug, uid = parse_careers_url(careers_url)
    canonical = f"https://www.comeet.com/jobs/{slug}/{uid}"
    try:
        html = _http_get(canonical, timeout=_TIMEOUT_S)
    except Exception as e:  # noqa: BLE001 - network trouble, user-facing
        raise ValueError(f"Couldn't fetch that careers page ({canonical}). Check the URL.") from e
    data = extract_company_data(html)
    if not data["token"]:
        raise ValueError(
            "Couldn't find the Comeet API token on that page — "
            "is it a Comeet-hosted careers page?"
        )
    return upsert_company(
        db,
        slug=slug,
        name=data["name"] or slug,
        uid=data["uid"] or uid,
        token=data["token"],
        careers_url=canonical,
    )


class ComeetProvider:
    """Comeet as a `JobProvider` (see base.py). Inline-description style;
    registry-driven fan-out across companies instead of a keyword search."""

    name = "comeet"

    def search(self, ctx: SearchContext) -> list[JobHit]:
        # Lazy DB imports: providers are constructed at module import, before
        # the app's lifespan hook has run init_db.
        from app.db.comeet import list_companies
        from app.db.database import SessionLocal

        with SessionLocal() as db:
            companies = list_companies(db)
        if not companies:
            raise ValueError(
                "No Comeet companies registered. Add one with its careers-page URL."
            )

        # One company, one board: failures and slow companies are counted and
        # left out (feeds.py), and only a registry that answered NOTHING is a
        # board failure.
        got = FEEDS.gather([(c.uid, _feed(c)) for c in companies], _BUDGET_S)
        if not got.values:
            raise ValueError(
                "Couldn't reach any Comeet careers pages right now. Try again in a minute."
            )

        hits: list[JobHit] = [h for c in companies for h in got.values.get(c.uid, [])]
        if ctx.job_title.strip():
            hits = [h for h in hits if _keyword_matches(h, ctx.job_title)]
        if ctx.location.strip():
            hits = [h for h in hits if _location_matches(h, ctx.location)]
        if not hits:
            where = f" in '{ctx.location}'" if ctx.location.strip() else ""
            raise NoResultsError(
                f"No open positions matching '{ctx.job_title}'{where} at the "
                f"{len(got.values)} Comeet companies that answered."
            )
        hits.sort(key=lambda h: h.posted_at, reverse=True)  # freshest first
        # Fresh copies: the fan-out writes on a hit (its market stamp, the
        # boards it is also on), and the cached ones serve the next query too.
        return [fresh_copy(h) for h in hits[: ctx.limit]]

    def fetch_description(self, hit: JobHit) -> str:
        return hit.description  # inline from the positions API — never refetch
