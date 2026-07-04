"""LinkedIn job-search provider (public 'jobs-guest' surface).

Listing pages come from the same unauthenticated 'jobs-guest' endpoint that
`job_match._extract_linkedin` already uses for single postings, so the same
caveats apply: markup can change and heavy use can get temporarily blocked —
hence the fetch throttle in the search loop, the two-page cap here, and the
login-wall detection. Search cards carry no description, so hits are returned
with `description=""` and the posting text is fetched per-hit on demand.

`parse_search_results` is a pure function pinned by the offline smoke test —
if LinkedIn changes its markup, fix it here and keep the fixture green.
"""
from __future__ import annotations

import html as _html
import re
import urllib.error
import urllib.parse

from app.core.job_match import (
    _extract_linkedin,
    _http_get,
    _linkedin_job_id,
    _looks_like_login_wall,
)
from app.core.providers.base import JobHit
from app.models import SearchContext

_SEARCH_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
_WORK_MODE_PARAM = {"onsite": "1", "remote": "2", "hybrid": "3"}  # LinkedIn f_WT values
_PAGE_SIZE = 25  # listings per guest search page


def _build_search_url(job_title: str, location: str, work_mode: str, start: int) -> str:
    # sortBy=DD = newest first. Without it the guest endpoint returns LinkedIn's
    # relevance mix, which looks arbitrary; we rank by fit ourselves anyway, so
    # spending the fetch budget on the freshest postings is strictly better.
    params = {"keywords": job_title, "location": location, "start": start, "sortBy": "DD"}
    params = {k: v for k, v in params.items() if v or k == "start"}
    f_wt = _WORK_MODE_PARAM.get(work_mode)
    if f_wt:
        params["f_WT"] = f_wt
    return f"{_SEARCH_URL}?{urllib.parse.urlencode(params)}"


def _card_text(card_html: str, cls: str) -> str:
    """Inner text of the first element whose class contains `cls`, tags stripped
    (the company subtitle nests an <a>, so we can't stop at the first '<')."""
    m = re.search(
        r'(?is)<(\w+)[^>]*class="[^"]*' + re.escape(cls) + r'[^"]*"[^>]*>(.*?)</\1>', card_html
    )
    if not m:
        return ""
    text = re.sub(r"(?is)<[^>]+>", " ", m.group(2))
    return re.sub(r"\s+", " ", _html.unescape(text)).strip()


def _card_posted(card_html: str) -> str:
    """ISO date from the card's <time datetime="..."> — LinkedIn's posted-on date
    (class is job-search-card__listdate, or __listdate--new for fresh posts)."""
    m = re.search(r'(?is)<time[^>]*\bdatetime="([^"]+)"', card_html)
    return _html.unescape(m.group(1)).strip() if m else ""


def _card_url(card_html: str) -> str:
    """The posting URL from the card's base-card__full-link anchor, tracking
    query stripped. Handles either attribute order (href/class)."""
    for a in re.finditer(r"(?is)<a\s[^>]*>", card_html):
        tag = a.group(0)
        if not re.search(r'class="[^"]*base-card__full-link[^"]*"', tag):
            continue
        href = re.search(r'href="([^"]+)"', tag)
        if href:
            return _html.unescape(href.group(1)).split("?")[0]
    return ""


def parse_search_results(html: str) -> list[dict[str, str]]:
    """Parse the guest search-results HTML (a flat <li> list of job cards) into
    [{url, title, company, location, posted_at}], deduped by posting id, order preserved.
    Pure function so the offline smoke test can pin the markup contract."""
    cards: list[dict[str, str]] = []
    seen: set[str] = set()
    for m in re.finditer(r"(?is)<li[^>]*>(.*?)</li>", html):
        card = m.group(1)
        url = _card_url(card)
        if not url:
            continue
        key = _linkedin_job_id(url) or url
        if key in seen:
            continue
        seen.add(key)
        cards.append(
            {
                "url": url,
                "title": _card_text(card, "base-search-card__title"),
                "company": _card_text(card, "base-search-card__subtitle"),
                "location": _card_text(card, "job-search-card__location"),
                "posted_at": _card_posted(card),
            }
        )
    return cards


def _fetch_cards(ctx: SearchContext) -> list[dict[str, str]]:
    cards: list[dict[str, str]] = []
    last_html = ""
    for page, start in enumerate((0, _PAGE_SIZE)):
        try:
            last_html = _http_get(
                _build_search_url(ctx.job_title, ctx.location, ctx.work_mode, start)
            )
        except urllib.error.HTTPError as e:
            if e.code == 429:
                raise ValueError(
                    "LinkedIn is rate-limiting job searches right now. "
                    "Wait a minute and try again."
                ) from e
            if page == 0:
                raise ValueError(
                    "Couldn't reach LinkedIn's job search (it may have blocked the request). "
                    "Try again in a minute."
                ) from e
            break
        except Exception as e:  # noqa: BLE001 - network trouble; page 2 is optional
            if page == 0:
                raise ValueError(
                    "Couldn't reach LinkedIn's job search. Check your connection and try again."
                ) from e
            break
        page_cards = parse_search_results(last_html)
        if not page_cards:
            break
        cards.extend(page_cards)
        if len(cards) >= ctx.limit:
            break
    if not cards:
        if last_html and _looks_like_login_wall(last_html):
            raise ValueError(
                "LinkedIn blocked the search request (bot check). Wait a few minutes "
                "and try again."
            )
        raise ValueError(
            f"No LinkedIn jobs found for '{ctx.job_title}' in '{ctx.location or 'anywhere'}'. "
            "Check 'Customize search' and adjust the title or location."
        )
    return cards


class LinkedInProvider:
    """LinkedIn as a `JobProvider` (see base.py). Scrape-style: search returns
    cards only, so descriptions are fetched per-hit via the guest posting page."""

    name = "linkedin"

    def search(self, ctx: SearchContext) -> list[JobHit]:
        return [
            JobHit(
                source=self.name,
                external_id=_linkedin_job_id(card["url"]),
                title=card["title"],
                company=card["company"],
                location=card["location"],
                description="",  # cards carry no body — fetched per-hit
                url=card["url"],
                posted_at=card.get("posted_at", ""),
                language="en",  # guest surface serves English-normalized cards
                raw=dict(card),
            )
            for card in _fetch_cards(ctx)
        ]

    def fetch_description(self, hit: JobHit) -> str:
        try:
            text = _extract_linkedin(hit.url)
        except Exception:  # noqa: BLE001 - one bad posting shouldn't sink the search
            return ""
        if not text or _looks_like_login_wall(text):
            return ""
        return text
