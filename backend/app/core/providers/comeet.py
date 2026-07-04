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
comeet_seed.py, user-extensible via POST /jobs/comeet/companies), pull each
company's open positions in parallel with a short in-process TTL cache, then
filter client-side by the search title/location (with Hebrew→English aliases
for the big Israeli cities, since Comeet location data is English). Tokens are
scraped from the careers page on first use, cached in the DB, and re-scraped
once on 401/403 (Comeet rotates them occasionally).

`parse_comeet_positions`, `extract_company_data`, and `parse_careers_url` are
pure functions pinned by the offline smoke test against a trimmed real API
response (tests/fixtures/comeet_positions.json) — if Comeet changes shape,
fix here and keep the fixture green.
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

from app.core.job_match import _html_to_text, _http_get
from app.core.lang import detect_language
from app.core.providers.base import JobHit
from app.models import SearchContext

_API_URL = "https://www.comeet.co/careers-api/2.0/company/{uid}/positions"
_TIMEOUT_S = 60  # the careers API is noticeably slower than the boards
_MAX_WORKERS = 8  # registry-wide fan-out; keep the burst polite
_CACHE_TTL_S = 15 * 60  # positions change slowly; don't re-hit every search

_CAREERS_URL_RE = re.compile(
    r"^https?://(?:www\.)?comeet\.com/jobs/([A-Za-z0-9_-]+)/([0-9A-Fa-f]{2}\.[0-9A-Fa-f]{3})"
)
# COMPANY_DATA = {"name": "Kaltura", …, "company_uid": "E2.00D", "token": "2EDEA1…"}
_NAME_RE = re.compile(r'COMPANY_DATA\s*=\s*\{\s*"name"\s*:\s*"([^"]+)"')
_UID_RE = re.compile(r'"company_uid"\s*:\s*"([0-9A-Fa-f]{2}\.[0-9A-Fa-f]{3})"')
_TOKEN_RE = re.compile(r'"token"\s*:\s*"([0-9A-Fa-f]{16,64})"')

# Comeet location data is English; searches from Israeli users are often
# Hebrew. Alias the common city names so "תל אביב" finds "Tel Aviv" offices.
_HE_CITY_ALIASES = {
    "תל אביב": "tel aviv",
    "תל אביב-יפו": "tel aviv",
    "ירושלים": "jerusalem",
    "חיפה": "haifa",
    "הרצליה": "herzliya",
    "רמת גן": "ramat gan",
    "בני ברק": "bnei brak",
    "באר שבע": "beer sheva",
    "פתח תקווה": "petah tikva",
    "נתניה": "netanya",
    "רעננה": "raanana",
    "כפר סבא": "kfar saba",
    "רחובות": "rehovot",
    "יקנעם": "yokneam",
    "לוד": "lod",
}
_ISRAEL_TOKENS = {"israel", "ישראל"}

# uid -> (fetched_at, raw positions list). In-process cache so a burst of
# searches doesn't re-hit ~30 company APIs each time.
_positions_cache: dict[str, tuple[float, list]] = {}


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
                language=detect_language(f"{title} {description}"),
                raw=pos,
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
    """One company's open positions (cached), plus a freshly scraped token to
    persist when the stored one was missing/rotated (None otherwise). `company`
    is an app.db.comeet.CompanyRef. Raises on failure — the caller isolates."""
    now = time.time()
    cached = _positions_cache.get(company.uid)
    if cached and now - cached[0] < _CACHE_TTL_S:
        return cached[1], None

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

    positions = data if isinstance(data, list) else []
    _positions_cache[company.uid] = (now, positions)
    return positions, new_token


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
        from app.db.comeet import list_companies, save_tokens
        from app.db.database import SessionLocal

        with SessionLocal() as db:
            companies = list_companies(db)
        if not companies:
            raise ValueError(
                "No Comeet companies registered. Add one with its careers-page URL."
            )

        boards: list[tuple] = []  # (CompanyRef, positions)
        new_tokens: dict[str, str] = {}
        failures = 0
        with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
            futures = [(c, pool.submit(_fetch_positions, c)) for c in companies]
            for company, fut in futures:
                try:
                    positions, new_token = fut.result()
                except Exception:  # noqa: BLE001 - one company must not sink the board
                    failures += 1
                    continue
                if new_token:
                    new_tokens[company.slug] = new_token
                boards.append((company, positions))
        if new_tokens:
            with SessionLocal() as db:
                save_tokens(db, new_tokens)
        if not boards:
            raise ValueError(
                "Couldn't reach any Comeet careers pages right now. Try again in a minute."
            )

        hits: list[JobHit] = []
        for company, positions in boards:
            hits.extend(parse_comeet_positions(positions, company_name=company.name))
        if ctx.job_title.strip():
            hits = [h for h in hits if _keyword_matches(h, ctx.job_title)]
        if ctx.location.strip():
            hits = [h for h in hits if _location_matches(h, ctx.location)]
        if not hits:
            where = f" in '{ctx.location}'" if ctx.location.strip() else ""
            raise ValueError(
                f"No open positions matching '{ctx.job_title}'{where} at the "
                f"{len(companies)} Comeet companies in your registry."
            )
        hits.sort(key=lambda h: h.posted_at, reverse=True)  # freshest first
        return hits[: ctx.limit]

    def fetch_description(self, hit: JobHit) -> str:
        return hit.description  # inline from the positions API — never refetch
