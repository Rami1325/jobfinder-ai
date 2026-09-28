"""We Work Remotely provider (2026-09-28): remote jobs open to people in Israel,
for the WORLDWIDE pass only (and so for the freelance search, which turns the
pass on). The Jobicy pattern (providers/jobicy.py): public feeds, read at most
once an hour each, matched by title here.

THE FEEDS. WWR publishes RSS and nothing else for readers: `/remote-jobs.rss`
(the newest postings across the board) and one feed per category, all listed
on https://weworkremotely.com/remote-job-rss-feed. Each item carries `title`
("Company: Role"), `region`, `country`, `state`, `skills`, `category`, `type`
("Full-Time" or "Contract"), `description` (HTML), `pubDate`, `expires_at`,
`guid` and `link` (both the posting's WWR page), and most a `media:content`
logo. `FEED_PATHS` is the set read and why (every category feed, which
together hold every posting, and the all-jobs feed as the net for a category
added later; measured 2026-09-28: job-search.md, *The freelance search*).

THE TERMS, AND WHAT THEY ASK (the RSS page, re-read 2026-09-28 14:35 UTC):
"Anyone can use the feed, all we ask is that you attribute the links back to We
Work Remotely." The site's terms say nothing about feeds or scraping, and
robots.txt allows every path this reads (it disallows only account, admin and
token paths). So every hit's `url` IS its WWR page (a posting without one is
dropped, since it could not be attributed), `source` is "weworkremotely", and
every surface that shows one credits it "via We Work Remotely" with that link
(`providers.ATTRIBUTED`, the Himalayas machinery). Each feed is cached an hour
per instance and never asked more often (`FEEDS`, failures remembered ten
minutes), through `job_match._http_get` and its SSRF guard like every request.

WHO A POSTING IS OPEN TO, the Himalayas trap again. `region` is "Anywhere in the
World" on almost every posting (257 of 265 on 2026-09-28), but `country` then
narrows 67 of those to a list ("🇺🇸 United States of America", or seven
countries), and 2 name Israel. WWR does not document what `country` means, so
it is read the conservative way, as eligibility: a posting is kept only when
`region` is "Anywhere in the World" AND `country` is empty or names Israel.
The `country` list NEVER becomes `location` (`pay_market` reads a worldwide
posting's location as the country the job is in), and neither does `state`
(the company's headquarters): `location` stays empty and both stay in `raw`.

THE TITLE is "Company: Role", split at the FIRST colon followed by a space, so a
role with a colon of its own ("IxDF - Interaction Design Foundation: Course
Writer and Editor: UX, UI, and AI") keeps it, and "Toptal : Photoshop Artists"
reads as Toptal. A title with no such colon is all role, with no company.

THE LABEL is WWR's own `type`, and only "Contract" becomes one (contract).
"Full-Time" is plain, and any other value says nothing until it is measured:
WWR's site lists "Contract and Part-Time" together, and the feeds carried only
the two values (Full-Time 237, Contract 28).

FRESHNESS: `expires_at` is kept in `raw` and a posting past it is dropped when a
search reads the cache (`is_live`, on the search's clock), so an hour-old cache
never serves a posting that expired inside that hour; a posting with no
readable `expires_at` is kept (unknown is never "expired"). The posting date is
the feed's `pubDate`, as it gives it: a renewed listing keeps its old date.

`parse_wwr_feed` is a pure function pinned by the offline smoke test against a
trimmed real answer (tests/fixtures/wwr_feed.xml).
"""
from __future__ import annotations

import html as _html
import re
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

from app.core import employment
from app.core.job_match import _html_to_text, _http_get
from app.core.lang import detect_language
from app.core.providers.base import JobHit, NoResultsError
from app.core.providers.board_filters import title_words_match
from app.core.providers.feeds import CompanyFeeds, fresh_copy
from app.models import SearchContext

BASE_URL = "https://weworkremotely.com/"
# The feeds read, each at most once an hour. Measured 2026-09-28 (job-search.md,
# *The freelance search*): each category feed holds EVERY open posting of its
# category (the ten below: 265 postings, each in exactly one), and
# `remote-jobs.rss` only the newest ten or fewer of each (81, none that a
# category feed lacks); it is read anyway as the net for a category WWR adds
# later. Front-end held nothing that day and is read because it is a category.
# "All Programming" (`categories/remote-programming-jobs.rss`) is left out: its
# 25 postings are all in the full-stack and back-end feeds, and in an older
# shape with NO `country` and NO `type`, so a US-only posting read from it would
# look open to Israel and a contract would lose its label.
FEED_PATHS: tuple[str, ...] = (
    "remote-jobs.rss",
    "categories/remote-full-stack-programming-jobs.rss",
    "categories/remote-back-end-programming-jobs.rss",
    "categories/remote-front-end-programming-jobs.rss",
    "categories/remote-devops-sysadmin-jobs.rss",
    "categories/remote-design-jobs.rss",
    "categories/remote-product-jobs.rss",
    "categories/remote-sales-and-marketing-jobs.rss",
    "categories/remote-customer-support-jobs.rss",
    "categories/remote-management-and-finance-jobs.rss",
    "categories/all-other-remote-jobs.rss",
)
FEED_URLS: tuple[str, ...] = tuple(BASE_URL + p for p in FEED_PATHS)
_TIMEOUT_S = 30
_CACHE_TTL_S = 60 * 60  # at most once an hour per feed (the feeds say <ttl>60</ttl>)
_FAIL_TTL_S = 10 * 60
_BUDGET_S = 20.0
_HOST_RE = re.compile(r"^(?:www\.)?weworkremotely\.com$")
_LATIN_RE = re.compile(r"[A-Za-z]")
_ANYWHERE = "anywhere in the world"
_ISRAEL_RE = re.compile(r"(?i)\bisrael\b|ישראל")
# A feed never needs a DOCTYPE or an entity of its own; refusing both keeps the
# XML parser's entity expansion out of reach whatever expat the host links.
_DTD_RE = re.compile(r"<!\s*(?:DOCTYPE|ENTITY)", re.I)
_TITLE_SPLIT_RE = re.compile(r":\s+")

FEEDS = CompanyFeeds("weworkremotely", workers=2, ttl_s=_CACHE_TTL_S, fail_ttl_s=_FAIL_TTL_S)


def _utc_now() -> datetime:
    """The search's clock for `is_live` (a seam the smoke test patches)."""
    return datetime.now(timezone.utc)


def wwr_page(url: str) -> bool:
    """Is this a page ON We Work Remotely (https, weworkremotely.com)? The only
    kind of link a hit may carry: it is the attribution the feed is offered on."""
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    return parts.scheme == "https" and bool(_HOST_RE.match((parts.hostname or "").lower()))


def open_to_israel(region: object, country: object) -> bool:
    """Kept only when the posting is open anywhere in the world AND its country
    list is empty or names Israel (a list of other countries narrows it). A
    posting with NO country field (None: the "All Programming" feed's older
    shape) is not "empty": it says nothing about who it is open to, so it is
    left out, never read as open."""
    if not isinstance(region, str) or " ".join(region.split()).lower() != _ANYWHERE:
        return False
    if not isinstance(country, str):
        return False
    return not country.strip() or bool(_ISRAEL_RE.search(country))


def split_title(title: str) -> tuple[str, str]:
    """(company, role) from "Company: Role", split at the first colon followed by
    whitespace; ("", title) when there is none."""
    title = " ".join(title.split())
    parts = _TITLE_SPLIT_RE.split(title, maxsplit=1)
    if len(parts) == 2 and parts[0].strip() and parts[1].strip():
        return parts[0].strip(), parts[1].strip()
    return "", title.strip()


def rfc822_to_iso(value: object) -> str:
    """An RSS date ("Mon, 28 Sep 2026 11:01:08 +0000") as ISO with its offset
    ("2026-09-28T11:01:08+00:00", 25 characters, the frame `parse_board_date`
    reads); "" for anything that is not one (unknown, never guessed)."""
    if not isinstance(value, str) or not value.strip():
        return ""
    try:
        dt = parsedate_to_datetime(value.strip())
    except (TypeError, ValueError, IndexError):
        return ""
    if dt is None:
        return ""
    if dt.tzinfo is None:  # "-0000": UTC with no claim about the zone
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat(timespec="seconds")


def is_live(hit: JobHit, now: datetime) -> bool:
    """False only for a posting whose own `expires_at` has passed; a missing or
    unreadable one is kept."""
    expires = rfc822_to_iso((hit.raw or {}).get("expires_at") if isinstance(hit.raw, dict) else None)
    if not expires:
        return True
    return datetime.fromisoformat(expires) > now


def _label(kind: str) -> str:
    """WWR's `type` as a label: "Contract" is contract, everything else nothing."""
    return "contract" if employment.from_field(kind) == "contract" else ""


def _logo(item: ET.Element) -> str:
    for child in item:
        if isinstance(child.tag, str) and child.tag.endswith("}content"):
            url = str(child.get("url") or "").strip()
            if url.startswith("https://"):
                return url
    return ""


_FIELDS = ("title", "region", "country", "state", "skills", "category", "type", "pubDate", "expires_at", "guid", "link")


def parse_wwr_feed(xml_text: str) -> list[JobHit]:
    """Parse one RSS feed into JobHits: postings open to Israel with a WWR page,
    deduped by that page, order preserved. Pure; pinned by the smoke test.

    Raises ValueError for a document that is not an RSS channel (or carries a
    DOCTYPE), so a broken answer is a remembered failure, never an hour of
    nothing cached as "no jobs"."""
    if not isinstance(xml_text, str) or _DTD_RE.search(xml_text):
        raise ValueError("We Work Remotely answered no feed")
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        raise ValueError(f"We Work Remotely answered no feed ({e})") from None
    channel = root.find("channel") if root.tag == "rss" else None
    if channel is None:
        raise ValueError("We Work Remotely answered no feed")
    hits: list[JobHit] = []
    seen: set[str] = set()
    for item in channel.findall("item"):
        raw = {k: (item.findtext(k) or "").strip() for k in _FIELDS}
        url = raw["link"] if wwr_page(raw["link"]) else raw["guid"]
        if not wwr_page(url) or url in seen:
            continue
        if not open_to_israel(item.findtext("region"), item.findtext("country")):
            continue
        seen.add(url)
        company, role = split_title(_html.unescape(raw["title"]))
        description = _html_to_text(item.findtext("description") or "")
        hits.append(
            JobHit(
                source="weworkremotely",
                external_id=url,
                title=role,
                company=company,
                # NEVER `country` (an eligibility list) or `state` (the company's
                # headquarters): pay_market would read either as where the job is.
                location="",
                description=description,  # inline — no detail fetch needed
                url=url,  # the WWR page: the attribution the feed is offered on
                posted_at=rfc822_to_iso(raw["pubDate"]),
                logo_url=_logo(item),
                language=detect_language(f"{role} {description}"),
                raw=raw,
                work_mode="Remote",  # a remote-only board says so for every posting
                # `type`: only "Contract" is a label; never the title.
                employment=_label(raw["type"]),
            )
        )
    return hits


def _feed(url: str):
    def fetch() -> list[JobHit]:
        return parse_wwr_feed(_http_get(url, timeout=_TIMEOUT_S))

    return fetch


_NEVER = datetime.min.replace(tzinfo=timezone.utc)


def _posted_key(hit: JobHit) -> datetime:
    """Newest first across the feeds, compared as instants (never as text: two
    offsets sort wrongly as strings); an undated posting goes last."""
    iso = hit.posted_at
    return datetime.fromisoformat(iso) if iso else _NEVER


class WeWorkRemotelyProvider:
    """We Work Remotely as a `JobProvider` (see base.py): a worldwide-only board,
    its public feeds cached an hour each and matched by title here,
    descriptions inline."""

    name = "weworkremotely"

    def search(self, ctx: SearchContext) -> list[JobHit]:
        query = ctx.job_title.strip()
        if not _LATIN_RE.search(query):
            raise NoResultsError(f"We Work Remotely lists jobs in English, so nothing matched '{query}' there.")
        got = FEEDS.gather([(url, _feed(url)) for url in FEED_URLS], _BUDGET_S)
        if not got.values:
            raise ValueError("Couldn't reach We Work Remotely right now. Try again in a minute.")
        now = _utc_now()
        seen: set[str] = set()
        hits: list[JobHit] = []
        for url in FEED_URLS:
            for hit in got.values.get(url) or []:
                if hit.url in seen or not is_live(hit, now):
                    continue
                seen.add(hit.url)
                if title_words_match(query, hit.title):
                    hits.append(hit)
        if not hits:
            if got.failed or got.late:
                # Part of the board could not be read: "nothing matched" would be a claim.
                raise ValueError("Couldn't reach all of We Work Remotely right now. Try again in a minute.")
            raise NoResultsError(f"No remote jobs open to Israel matching '{query}' on We Work Remotely.")
        hits.sort(key=_posted_key, reverse=True)
        return [fresh_copy(h) for h in hits[: ctx.limit]]

    def fetch_description(self, hit: JobHit) -> str:
        return hit.description  # inline from the feed — never refetch
