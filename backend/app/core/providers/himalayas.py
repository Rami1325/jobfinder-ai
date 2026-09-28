"""Himalayas provider (2026-09-28): remote jobs open to people in Israel, for the
WORLDWIDE pass only.

`GET https://himalayas.app/jobs/api/search?q={title}&country=IL&sort=recent`
answers up to 20 remote postings (one page; newest first) whose eligibility
includes Israel: postings open worldwide and postings that name Israel among
their countries (measured 2026-09-27: 2,488 in all, 445 for "software
engineer"). The whole posting is inline (`description`, HTML), so no detail
fetch. It is an English board: a Hebrew title finds nothing, so only a title
with Latin letters is sent, and a Hebrew one is answered as "nothing matched"
without a request.

THE TERMS, AND THE OBLIGATION THEY CARRY (himalayas.app/api, read 2026-09-27):
"Our public JSON APIs can be used to backfill other remote job boards, power job
search experiences, populate internal dashboards, or feed AI agents and
automation workflows. Anyone can use the interface, but please link back to the
URL found on Himalayas AND mention Himalayas as the original source. Please do
not submit Himalayas jobs to third-party websites, including but not limited to
Jooble, Neuvoo, Google Jobs, or LinkedIn Jobs." So every hit's `url` IS its
Himalayas page (a posting without one is dropped, since it could not be linked
back), its `source` is "himalayas", and every surface that shows one names
Himalayas with that link (`providers.ATTRIBUTED`: the Jobs page's "via
Himalayas", a tracked job's "Open on Himalayas", the alert email's "via
Himalayas"). The site's own terms forbid scraping the SITE and monetising
its data without consent; the API grant is the specific permission this reads
under, and if JobFinder ever charges money, ask Himalayas in writing first
(`job-search.md`, *Himalayas*). Rate limit undisclosed (a 429 on excess); the
board refreshes daily and its CDN caches an answer for an hour, so each query is
cached here for an hour.

TWO TRAPS FOR THIS PIPELINE, both pinned:
  - It is queried ONLY by the worldwide pass (`job_search.WORLDWIDE_ONLY_BOARDS`),
    never with the user's own location, so every hit is worldwide-origin and meets
    the worldwide rules: the geo-restriction classifier reads its text, and it is
    kept only when it says it is remote, which its board field always does.
  - `locationRestrictions` (the countries a posting is OPEN TO) is NEVER written
    into `location`. `pay_market` reads a worldwide posting's location as the
    country the job is in, and a list ending "…, United States" or "…, Vietnam"
    would read as that country and could hide the job as low-pay. `location` is
    left empty (the job has no place; its work mode says Remote, and an empty
    place is one `pay_market` keeps); the list stays in `raw`, and it is what the
    eligibility filter reads.

ELIGIBILITY, belt and braces: the server's `country=IL` filter is checked again
here on each posting's own list. A posting is kept when its list is empty (open
worldwide) or names Israel; any other list (open to the US only, say) is left
out, whatever the server sent.

`parse_himalayas_jobs` is a pure function pinned by the offline smoke test against
trimmed real answers (tests/fixtures/himalayas_search.json).
"""
from __future__ import annotations

import html as _html
import json
import re
import urllib.parse
from datetime import datetime, timezone

from app.core.job_match import _html_to_text, _http_get
from app.core.lang import detect_language
from app.core.providers.base import JobHit, NoResultsError
from app.core.providers.feeds import CompanyFeeds, fresh_copy
from app.models import SearchContext

_API_URL = "https://himalayas.app/jobs/api/search"
_TIMEOUT_S = 30
_CACHE_TTL_S = 60 * 60  # the board refreshes daily; its CDN caches an hour
_FAIL_TTL_S = 10 * 60
_BUDGET_S = 20.0
_HOST_RE = re.compile(r"^(?:[a-z0-9-]+\.)*himalayas\.app$")
_LATIN_RE = re.compile(r"[A-Za-z]")

FEEDS = CompanyFeeds("himalayas", workers=2, ttl_s=_CACHE_TTL_S, fail_ttl_s=_FAIL_TTL_S)


def search_url(query: str) -> str:
    params = {"q": query.strip(), "country": "IL", "sort": "recent"}
    return f"{_API_URL}?{urllib.parse.urlencode(params)}"


def epoch_s_to_iso(value) -> str:  # noqa: ANN001
    """Himalayas' `pubDate` (epoch SECONDS) as an ISO UTC string; "" for anything
    that is not a plausible timestamp (unknown, never guessed)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return ""
    if not 1_000_000_000 <= value <= 10_000_000_000:  # 2001 .. 2286, in seconds
        return ""
    return datetime.fromtimestamp(value, tz=timezone.utc).isoformat(timespec="seconds")


def himalayas_page(url: str) -> bool:
    """Is this a page ON Himalayas (https, himalayas.app or a subdomain)? The only
    kind of link a hit may carry, since it is the link back the terms ask for."""
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    return parts.scheme == "https" and bool(_HOST_RE.match((parts.hostname or "").lower()))


def open_to_israel(restrictions) -> bool:  # noqa: ANN001
    """Kept when the posting is open worldwide (no list) or its list names Israel."""
    if not restrictions:
        return True
    if not isinstance(restrictions, list):
        return False
    return any(isinstance(c, str) and c.strip().lower() == "israel" for c in restrictions)


def _pay(job: dict) -> str:
    low, high = job.get("minSalary"), job.get("maxSalary")
    currency = str(job.get("currency") or "").strip()
    period = str(job.get("salaryPeriod") or "").strip()
    nums = [f"{int(v):,}" for v in (low, high) if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0]
    if not nums:
        return ""
    amount = " – ".join(dict.fromkeys(nums))
    return " ".join(x for x in (amount, currency, f"({period})" if period else "") if x)


def parse_himalayas_jobs(data: dict) -> list[JobHit]:
    """Parse one search answer into JobHits: postings open to Israel (or the
    world) with a Himalayas page to link back to, deduped by that page, order
    preserved. Pure; pinned by the smoke test."""
    hits: list[JobHit] = []
    seen: set[str] = set()
    for job in (data.get("jobs") if isinstance(data, dict) else None) or []:
        if not isinstance(job, dict):
            continue
        url = str(job.get("guid") or "").strip()
        if not himalayas_page(url):
            url = str(job.get("applicationLink") or "").strip()
        if not himalayas_page(url) or url in seen:
            continue
        if not open_to_israel(job.get("locationRestrictions")):
            continue
        seen.add(url)
        title = _html.unescape(str(job.get("title") or "")).strip()
        description = _html_to_text(str(job.get("description") or ""))
        pay = _pay(job)
        if pay:
            description = f"{description}\n\nCompensation: {pay}".strip()
        hits.append(
            JobHit(
                source="himalayas",
                external_id=url,
                title=title,
                company=_html.unescape(str(job.get("companyName") or "")).strip(),
                # NEVER the eligibility list (module docstring): pay_market would read
                # its last country as the posting's. Empty: the job has no place (the
                # card already says "Remote" from the work mode), and an empty place
                # is one pay_market keeps.
                location="",
                description=description,  # inline — no detail fetch needed
                url=url,  # the Himalayas page: the link back the terms ask for
                posted_at=epoch_s_to_iso(job.get("pubDate")),
                logo_url=str(job.get("companyLogo") or "").strip(),
                language=detect_language(f"{title} {description}"),
                raw=job,
                work_mode="Remote",  # a remote-only board says so for every posting
            )
        )
    return hits


def _feed(query: str):
    def fetch() -> list[JobHit]:
        data = json.loads(_http_get(search_url(query), timeout=_TIMEOUT_S))
        if not isinstance(data, dict) or not isinstance(data.get("jobs"), list):
            raise ValueError("Himalayas answered no job list")
        return parse_himalayas_jobs(data)

    return fetch


class HimalayasProvider:
    """Himalayas as a `JobProvider` (see base.py): the worldwide pass's second
    board, keyword search on the board's side, descriptions inline."""

    name = "himalayas"

    def search(self, ctx: SearchContext) -> list[JobHit]:
        query = ctx.job_title.strip()
        if not _LATIN_RE.search(query):
            raise NoResultsError(
                f"Himalayas lists jobs in English, so nothing matched '{query}' there."
            )
        got = FEEDS.gather([(query.lower(), _feed(query))], _BUDGET_S)
        if query.lower() not in got.values:
            raise ValueError("Couldn't reach Himalayas right now. Try again in a minute.")
        hits = got.values[query.lower()]
        if not hits:
            raise NoResultsError(f"No remote jobs open to Israel matching '{query}' on Himalayas.")
        return [fresh_copy(h) for h in hits[: ctx.limit]]

    def fetch_description(self, hit: JobHit) -> str:
        return hit.description  # inline from the search API — never refetch
