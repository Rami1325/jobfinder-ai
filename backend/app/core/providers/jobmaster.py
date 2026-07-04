"""JobMaster.co.il provider (plain server-rendered HTML — no bot manager, no
auth as of July 2026).

`GET https://www.jobmaster.co.il/jobs/?q=<kw>` returns a flat list of
`<article>` job cards (regular cards `id="misra<key>"`, promoted ones
`id="Mekudam<key>"` — both keys resolve to the same detail page, verified
live). Cards carry only a truncated snippet, so this is a scrape-style board:
`JobHit.description` stays empty and `fetch_description` pulls
`/jobs/checknum.asp?key=<key>`, whose `#jobDescriptionContent` +
`#jobRequirementsContent` divs hold the full posting.

Posted dates are Hebrew relative phrases ("פורסם לפני 8 שעות", "אתמול") —
`parse_hebrew_relative_date` converts them to ISO against a caller-supplied
clock so the conversion stays deterministic under test.

Politeness: at most two pages per search (`currPage=N`), short pause between
them, and the fan-out in job_search already throttles per-hit detail fetches.
There is no location query param, so location is filtered client-side against
the card's city list (Hebrew, tolerant substring match, country tokens
ignored — Israel-only board).

`parse_jobmaster_results` and `parse_jobmaster_detail` are pure functions
pinned by the offline smoke test against trimmed real pages
(tests/fixtures/jobmaster_search.html / jobmaster_detail.html) — if JobMaster
changes its markup, fix here and keep the fixtures green.
"""
from __future__ import annotations

import html as _html
import re
import time
import urllib.parse
from datetime import datetime, timedelta

from app.core.job_match import _html_to_text, _http_get
from app.core.lang import detect_language
from app.core.providers.base import JobHit
from app.models import SearchContext

_BASE_URL = "https://www.jobmaster.co.il"
_SEARCH_PATH = "/jobs/"
_DETAIL_URL = f"{_BASE_URL}/jobs/checknum.asp?key={{key}}"
_TIMEOUT_S = 60  # the site is server-rendered ASP and can be slow to respond
_MAX_PAGES = 2  # politeness cap — never hammer more than two pages per search
_PAGE_DELAY_S = 0.5

# Country-level tokens carry no signal on an Israel-only board (see drushim.py).
_COUNTRY_TOKENS = {"israel", "ישראל"}

_ARTICLE_RE = re.compile(
    r'(?is)<article\b[^>]*\bid="(?:misra|Mekudam)(\d+)"[^>]*>(.*?)</article>'
)
# "פורסם לפני 1 ימים" (search cards) / "פורסם אתמול" — capture up to the next tag.
_POSTED_RE = re.compile(r"פורסם\s*([^<]*)")
# Hebrew relative phrase: optional count + unit, incl. dual forms (שעתיים = 2 hours).
_RELATIVE_RE = re.compile(
    r"לפני\s+(\d+)?\s*"
    r"(דקה|דקות|שעתיים|שעה|שעות|יומיים|יום|ימים|שבועיים|שבוע|שבועות|חודשיים|חודש|חודשים)"
)
# unit word -> (timedelta of one unit, implied count for dual forms)
_UNIT_DELTAS = {
    "דקה": (timedelta(minutes=1), 1),
    "דקות": (timedelta(minutes=1), None),
    "שעה": (timedelta(hours=1), 1),
    "שעתיים": (timedelta(hours=1), 2),
    "שעות": (timedelta(hours=1), None),
    "יום": (timedelta(days=1), 1),
    "יומיים": (timedelta(days=1), 2),
    "ימים": (timedelta(days=1), None),
    "שבוע": (timedelta(days=7), 1),
    "שבועיים": (timedelta(days=7), 2),
    "שבועות": (timedelta(days=7), None),
    "חודש": (timedelta(days=30), 1),
    "חודשיים": (timedelta(days=30), 2),
    "חודשים": (timedelta(days=30), None),
}
_SUB_DAY_UNITS = {"דקה", "דקות", "שעה", "שעתיים", "שעות"}


def parse_hebrew_relative_date(text: str, now: datetime) -> str:
    """Hebrew relative posted-phrase → ISO string against the given clock
    ("" when unrecognized). Hour/minute granularity keeps the time component
    (the UI's "new < 48h" badge cares); day-and-up returns a plain date.
    Pure function pinned by the smoke test."""
    text = text.strip()
    if not text:
        return ""
    if "היום" in text:
        return now.date().isoformat()
    if "שלשום" in text:
        return (now - timedelta(days=2)).date().isoformat()
    if "אתמול" in text:
        return (now - timedelta(days=1)).date().isoformat()
    m = _RELATIVE_RE.search(text)
    if not m:
        return ""
    count_str, unit = m.group(1), m.group(2)
    one, implied = _UNIT_DELTAS[unit]
    count = int(count_str) if count_str else (implied or 1)
    moment = now - one * count
    if unit in _SUB_DAY_UNITS:
        return moment.isoformat(timespec="minutes")
    return moment.date().isoformat()


def _card_text(card_html: str, cls: str) -> str:
    """Inner text of the first element whose class contains `cls`, tags
    stripped (company names nest a <span> inside the anchor)."""
    m = re.search(
        r'(?is)<(\w+)[^>]*class="[^"]*' + re.escape(cls) + r'[^"]*"[^>]*>(.*?)</\1>', card_html
    )
    if not m:
        return ""
    text = re.sub(r"(?is)<[^>]+>", " ", m.group(2))
    return re.sub(r"\s+", " ", _html.unescape(text)).strip()


def parse_jobmaster_results(html: str, now: datetime | None = None) -> list[JobHit]:
    """Parse one search page's <article> cards into JobHits, deduped by job
    key, order preserved. Promoted (Mekudam) cards are kept — their key opens
    the same detail page. Descriptions stay empty (cards only carry a
    truncated snippet, stored in `raw` as the detail-fetch fallback).
    Pure given `now`; pinned by the smoke test against a trimmed real page."""
    now = now or datetime.now()
    hits: list[JobHit] = []
    seen: set[str] = set()
    for m in _ARTICLE_RE.finditer(html):
        key, card = m.group(1), m.group(2)
        if key in seen:
            continue
        seen.add(key)

        title = _card_text(card, "CardHeader")
        # Regular cards name the employer in a CompanyNameLink anchor; promoted
        # ones put it in a ByTitle span next to the "מקודמת" ad icon.
        company = _card_text(card, "CompanyNameLink") or _card_text(card, "ByTitle")
        location = _card_text(card, "jobLocation")
        snippet = _card_text(card, "jobShortDescription")

        posted = ""
        pm = _POSTED_RE.search(card)
        if pm:
            posted = parse_hebrew_relative_date(pm.group(1), now)

        hits.append(
            JobHit(
                source="jobmaster",
                external_id=key,
                title=title,
                company=company,
                location=location,
                description="",  # cards carry only a snippet — fetched per-hit
                url=_DETAIL_URL.format(key=key),
                posted_at=posted,
                language=detect_language(f"{title} {snippet}"),
                raw={
                    "key": key,
                    "snippet": snippet,
                    "job_type": _card_text(card, "jobType"),
                    "promoted": f'id="Mekudam{key}"' in m.group(0),
                },
            )
        )
    return hits


def parse_jobmaster_detail(html: str) -> str:
    """Full posting text from a checknum.asp detail page: the description and
    requirements divs, HTML stripped, joined like the other boards do.
    Pure function pinned by the smoke test against a trimmed real page."""
    sections: list[str] = []
    for div_id in ("jobDescriptionContent", "jobRequirementsContent"):
        m = re.search(r'(?is)\bid="' + div_id + r'"[^>]*>(.*?)</div>', html)
        if m:
            text = _html_to_text(m.group(1))
            if text:
                sections.append(text)
    return "\n\n".join(sections)


def _build_search_url(searchterm: str, page: int) -> str:
    params: dict[str, str | int] = {"q": searchterm}
    if page > 1:
        params = {"currPage": page, **params}
    return f"{_BASE_URL}{_SEARCH_PATH}?{urllib.parse.urlencode(params)}"


def _location_matches(hit: JobHit, wanted: str) -> bool:
    """Tolerant client-side filter against the card's Hebrew city list
    ("חיפה, כרמיאל, נהריה"). Cards without location data are kept —
    missing data shouldn't hide an otherwise-relevant job."""
    tokens = [t.strip().lower() for t in wanted.split(",")]
    tokens = [t for t in tokens if t and t not in _COUNTRY_TOKENS]
    if not tokens:
        return True
    cities = [c.strip().lower() for c in hit.location.split(",") if c.strip()]
    if not cities:
        return True
    return any(t in c or c in t for t in tokens for c in cities)


class JobMasterProvider:
    """JobMaster as a `JobProvider` (see base.py). Scrape-style: search cards
    carry only a snippet, so the full posting is fetched per-hit."""

    name = "jobmaster"

    def search(self, ctx: SearchContext) -> list[JobHit]:
        if not ctx.job_title.strip():
            raise ValueError("JobMaster search needs a job title.")
        hits: list[JobHit] = []
        seen: set[str] = set()
        for page in range(1, _MAX_PAGES + 1):
            if page > 1:
                time.sleep(_PAGE_DELAY_S)
            try:
                html = _http_get(
                    _build_search_url(ctx.job_title.strip(), page), timeout=_TIMEOUT_S
                )
            except Exception as e:  # noqa: BLE001 - network trouble; page 2 is optional
                if page == 1:
                    raise ValueError(
                        "Couldn't reach JobMaster's job search. Try again in a minute."
                    ) from e
                break
            page_hits = parse_jobmaster_results(html)
            if not page_hits:
                break
            if ctx.location.strip():
                page_hits = [h for h in page_hits if _location_matches(h, ctx.location)]
            for hit in page_hits:
                if hit.external_id in seen:
                    continue
                seen.add(hit.external_id)
                hits.append(hit)
            if len(hits) >= ctx.limit:
                break
        if not hits:
            where = f" in '{ctx.location}'" if ctx.location.strip() else ""
            raise ValueError(
                f"No JobMaster jobs found for '{ctx.job_title}'{where}. "
                "Check 'Customize search' and adjust the title or location."
            )
        return hits[: ctx.limit]

    def fetch_description(self, hit: JobHit) -> str:
        snippet = str(hit.raw.get("snippet") or "") if isinstance(hit.raw, dict) else ""
        try:
            text = parse_jobmaster_detail(_http_get(hit.url, timeout=_TIMEOUT_S))
        except Exception:  # noqa: BLE001 - one bad posting shouldn't sink the search
            return snippet
        # A truncated card snippet still scores better than dropping the job.
        return text or snippet
