"""Jobicy provider (2026-09-28): remote jobs open to people in Israel, for the
WORLDWIDE pass only (and so for the freelance search, which turns the pass on).

`GET https://jobicy.com/api/v2/remote-jobs?count=100&geo=israel` answers the
newest 100 remote postings whose eligibility includes Israel ("Anywhere", or an
EMEA list), with the whole posting inline (`jobDescription`, HTML) and the
board's own `jobType` ("Full-Time", "Contract", "Part-Time"). Measured
2026-09-28: 100 postings, 70 "Anywhere" and the rest EMEA lists, 96 Full-Time
and 4 Contract (interpreters and a motion designer); across its whole feed of
200, 177 Full-Time, 13 Contract, 10 Part-Time. There is no keyword filter worth
a request per title, so ONE feed is read and matched by title here.

THE TERMS, AND WHAT THEY ASK (read 2026-09-28):
  - The API page (jobicy.com/jobs-rss-feed): "No token or account is required for
    the public Jobs API"; "Do not present Jobicy listings as your own original
    job postings or remove source attribution"; "Automated checks must not run
    more frequently than once per hour".
  - Every answer's own `friendlyNotice`: "Please ensure Jobicy is clearly
    credited with a direct link to the source, and all application buttons
    redirect to the original job URL provided in this feed."
  - The site's terms (jobicy.com/terms) forbid harvesting or scraping "other than
    via our official API under its terms", which is what this reads.
  So: the ONE feed URL is cached for an hour per instance and never asked more
  often (`FEEDS`, ttl one hour, failures remembered ten minutes); every hit's
  `url` IS the listing URL the feed gives (a posting without a jobicy.com URL is
  dropped, since it could not be credited or applied through); `source` is
  "jobicy", credited on every surface as "via Jobicy" with that link
  (`providers.ATTRIBUTED`, the Himalayas machinery); nothing is passed on to
  another board. The robots.txt (read the same day) disallows no path this uses.
  Several Vercel instances may each read the feed within one hour; that is
  recorded (job-search.md), and a shared cache is the fix if it ever matters.

THE LOCATION TRAP, Himalayas' again: `jobGeo` is where a posting is OPEN TO
("EMEA,  Germany", "Anywhere"), never where the job is, so it never becomes
`location` (`pay_market` would read "Germany" or "USA" as the job's country).
`location` stays empty and the list stays in `raw`. Eligibility is checked again
here on the list: "Anywhere", "Worldwide", "EMEA", "Middle East" or "Israel" is
kept, anything else (a UK-only posting) is left out whatever the server sent.

`parse_jobicy_jobs` is a pure function pinned by the offline smoke test against a
trimmed real answer (tests/fixtures/jobicy_remote_jobs.json).
"""
from __future__ import annotations

import html as _html
import json
import re
import urllib.parse

from app.core import employment
from app.core.job_match import _html_to_text, _http_get
from app.core.lang import detect_language
from app.core.providers.base import JobHit, NoResultsError
from app.core.providers.board_filters import title_words_match
from app.core.providers.feeds import CompanyFeeds, fresh_copy
from app.models import SearchContext

FEED_URL = "https://jobicy.com/api/v2/remote-jobs?count=100&geo=israel"
_TIMEOUT_S = 30
_CACHE_TTL_S = 60 * 60  # the API page: automated checks "must not run more frequently than once per hour"
_FAIL_TTL_S = 10 * 60
_BUDGET_S = 20.0
_HOST_RE = re.compile(r"^(?:www\.)?jobicy\.com$")
_LATIN_RE = re.compile(r"[A-Za-z]")
_OPEN_TO_ISRAEL = re.compile(r"(?i)\b(?:anywhere|worldwide|emea|middle east|israel)\b")

FEEDS = CompanyFeeds("jobicy", workers=1, ttl_s=_CACHE_TTL_S, fail_ttl_s=_FAIL_TTL_S)


def jobicy_page(url: str) -> bool:
    """Is this a listing ON Jobicy (https, jobicy.com)? The only kind of link a hit
    may carry: it is the credit and the application link the terms ask for."""
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    return parts.scheme == "https" and bool(_HOST_RE.match((parts.hostname or "").lower()))


def open_to_israel(job_geo: object) -> bool:
    """Kept when the posting's own eligibility names the world, EMEA, the Middle
    East or Israel; a posting open to one other country is left out."""
    return isinstance(job_geo, str) and bool(_OPEN_TO_ISRAEL.search(job_geo))


def _pay(job: dict) -> str:
    low, high = job.get("salaryMin"), job.get("salaryMax")
    currency = str(job.get("salaryCurrency") or "").strip()
    period = str(job.get("salaryPeriod") or "").strip()
    nums = [f"{int(v):,}" for v in (low, high) if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0]
    if not nums:
        return ""
    amount = " – ".join(dict.fromkeys(nums))
    return " ".join(x for x in (amount, currency, f"({period})" if period else "") if x)


def _job_type(job: dict) -> str:
    """The board's `jobType`, a list of one ("Contract"), as ONE label: the first
    value the reader maps, else ""."""
    kinds = job.get("jobType")
    values = kinds if isinstance(kinds, list) else [kinds]
    for value in values:
        label = employment.from_field(value)
        if label:
            return label
    return ""


def parse_jobicy_jobs(data: dict) -> list[JobHit]:
    """Parse one feed answer into JobHits: postings open to Israel with a Jobicy
    listing URL, deduped by that URL, order preserved. Pure; pinned by the smoke
    test."""
    hits: list[JobHit] = []
    seen: set[str] = set()
    for job in (data.get("jobs") if isinstance(data, dict) else None) or []:
        if not isinstance(job, dict):
            continue
        url = str(job.get("url") or "").strip()
        if not jobicy_page(url) or url in seen or not open_to_israel(job.get("jobGeo")):
            continue
        seen.add(url)
        title = _html.unescape(str(job.get("jobTitle") or "")).strip()
        description = _html_to_text(str(job.get("jobDescription") or ""))
        pay = _pay(job)
        if pay:
            description = f"{description}\n\nCompensation: {pay}".strip()
        hits.append(
            JobHit(
                source="jobicy",
                external_id=str(job.get("id") or url),
                title=title,
                company=_html.unescape(str(job.get("companyName") or "")).strip(),
                # NEVER `jobGeo` (module docstring): an eligibility list, not a place.
                location="",
                description=description,  # inline — no detail fetch needed
                url=url,  # the Jobicy listing: the credit and the application link
                posted_at=str(job.get("pubDate") or "").strip()[:32],
                logo_url=str(job.get("companyLogo") or "").strip(),
                language=detect_language(f"{title} {description}"),
                raw=job,
                work_mode="Remote",  # a remote-only board says so for every posting
                # `jobType` ("Full-Time" / "Contract" / "Part-Time"); never the title.
                employment=_job_type(job),
            )
        )
    return hits


def _feed() -> list[JobHit]:
    data = json.loads(_http_get(FEED_URL, timeout=_TIMEOUT_S))
    if not isinstance(data, dict) or not isinstance(data.get("jobs"), list):
        raise ValueError("Jobicy answered no job list")
    return parse_jobicy_jobs(data)


class JobicyProvider:
    """Jobicy as a `JobProvider` (see base.py): a worldwide-only board, ONE cached
    feed matched by title here, descriptions inline."""

    name = "jobicy"

    def search(self, ctx: SearchContext) -> list[JobHit]:
        query = ctx.job_title.strip()
        if not _LATIN_RE.search(query):
            raise NoResultsError(f"Jobicy lists jobs in English, so nothing matched '{query}' there.")
        got = FEEDS.gather([("feed", _feed)], _BUDGET_S)
        if "feed" not in got.values:
            raise ValueError("Couldn't reach Jobicy right now. Try again in a minute.")
        hits = [h for h in got.values["feed"] if title_words_match(query, h.title)]
        if not hits:
            raise NoResultsError(f"No remote jobs open to Israel matching '{query}' on Jobicy.")
        return [fresh_copy(h) for h in hits[: ctx.limit]]

    def fetch_description(self, hit: JobHit) -> str:
        return hit.description  # inline from the feed — never refetch
