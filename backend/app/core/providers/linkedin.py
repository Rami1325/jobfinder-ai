"""LinkedIn job-search provider (public 'jobs-guest' surface).

Listing pages come from the same unauthenticated 'jobs-guest' endpoint that
`job_match._extract_linkedin` already uses for single postings, so the same
caveats apply: markup can change and heavy use can get temporarily blocked —
hence the fetch throttle in the search loop, the page cap here (ten cards a
page, only as many pages as the result count needs, three at most), and the
login-wall detection. Search cards carry no description, so hits are returned
with `description=""` and the posting text is fetched per-hit on demand.

`parse_search_results` and `linkedin_closed_marker` are pure functions pinned by
the offline smoke test — if LinkedIn changes its markup, fix it here and keep
the fixtures green (`tests/fixtures/linkedin_job_{open,closed}.html`).

CLOSURE (PLAN 28.2) is a LinkedIn-only concern, and that is checked rather than
assumed. Drushim's search API drops expired rows before we ever see them
(`drushim.py:65`, `if key in seen or info.get("IsExpired")`); Comeet's positions
API and Greenhouse's board API list only open positions; and none of those three
fetches anything at score time, so there is no seam on them at which a board
could tell us a posting had died. LinkedIn is the one registered board whose
search index is stale by design — its guest search happily returns cards for
postings whose detail page is a 404 or carries a "No longer accepting
applications" banner. Do not build closure detection where the board cannot
produce one: a per-board rule that can never fire is the 21.7 failure mode (a
check that passes by never firing), and here it would also be a second opinion
about liveness for `ghost_signals` to contradict.
"""
from __future__ import annotations

import html as _html
import re
import urllib.error
import urllib.parse

from app.core.geo_restriction import RAW_MAX
from app.core.job_match import (
    _first_text,
    _html_to_text,
    _http_get,
    _linkedin_job_id,
    _looks_like_login_wall,
)
from app.core.providers.base import JobHit, NoResultsError
from app.models import SearchContext, work_modes

_SEARCH_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
# The same unauthenticated detail endpoint `job_match._extract_linkedin` uses.
# We call it directly rather than through that helper because the HTTP STATUS is
# now evidence: `_extract_linkedin` swallows every HTTPError into "" (that is the
# defect this work fixes), and asking it for the text and then re-fetching the
# page ourselves for the status would double every detail request to the board
# whose throttling this module's docstring already warns about.
_JOB_POSTING_URL = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting"
# LinkedIn f_WT values; several go comma-separated ("2,3"), the form LinkedIn's own
# search page writes. IGNORED by the logged-out search this module uses, measured
# 2026-09-22: "1", "2", "3", "2,3" and no filter returned the same ten postings
# on a US query and a Tel Aviv one, through this API, the public page and a
# geoId search. Still sent, because it costs nothing and would narrow the cards
# if LinkedIn ever honours it; the filter that works is `app.core.work_mode`,
# over the posting's own words, in `job_search`.
_WORK_MODE_PARAM = {"onsite": "1", "remote": "2", "hybrid": "3"}
# Cards per guest search page, MEASURED, and `start` is a row offset — so the
# pages are start=0, 10, 20. This was 25 until 2026-09-22, and the loop asked
# for start=0 then start=25: every query needing more than ten cards jumped from
# row 10 to row 26, and rows 11-25 never reached the app (a real Pentera posting
# at row 11 was invisible). Saved pages from 2026-09-21 showed data-row 1-10 at
# start=0, 11-20 at start=10 and 26-35 at start=25, and a live pair the same day
# returned 10 + 10, contiguous, with no overlap. Re-measure before changing it.
_PAGE_SIZE = 10
# The request ceiling per query, kept as a number of its own rather than left to
# `ctx.limit`: `job_search` clamps the limit to 25 (three pages here), but this
# is the board that throttles, so no caller can make one query cost more.
_MAX_PAGES = 3


def _build_search_url(
    job_title: str, location: str, work_mode: str, start: int, max_age_days: int = 0
) -> str:
    # sortBy=DD = newest first. Without it the guest endpoint returns LinkedIn's
    # relevance mix, which looks arbitrary; we rank by fit ourselves anyway, so
    # spending the fetch budget on the freshest postings is strictly better.
    params = {"keywords": job_title, "location": location, "start": start, "sortBy": "DD"}
    params = {k: v for k, v in params.items() if v or k == "start"}
    f_wt = ",".join(_WORK_MODE_PARAM[m] for m in work_modes(work_mode))
    if f_wt:
        params["f_WT"] = f_wt
    if max_age_days > 0:
        # f_TPR = time-posted filter, "r<seconds>" — restricts server-side so
        # every fetched page holds only postings inside the freshness window.
        params["f_TPR"] = f"r{max_age_days * 86400}"
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


def _card_logo(card_html: str) -> str:
    """Company logo URL from the card's lazy-loaded <img>. LinkedIn puts the
    real media.licdn.com URL in data-delayed-url (src holds a ghost/placeholder),
    so that attribute is the only one worth reading."""
    m = re.search(r'(?is)<img[^>]*\bdata-delayed-url="([^"]+)"', card_html)
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
    [{url, title, company, location, posted_at, logo}], deduped by posting id, order preserved.
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
                "logo": _card_logo(card),
            }
        )
    return cards


def _fetch_cards(ctx: SearchContext) -> list[dict[str, str]]:
    """The query's cards, board order, reading pages start=0, 10, 20… only as
    far as `ctx.limit` needs (never past `_MAX_PAGES`), and stopping at the
    first empty or short page — a page with fewer than `_PAGE_SIZE` cards is the
    end of the index, so asking for the next one would be a wasted request.

    Deduped ACROSS pages by posting id, the way `parse_search_results` dedupes
    within one. Contiguous pages over a newest-first index can overlap: a
    posting arriving between two requests pushes the previous page's last card
    onto the next page. Not seen in either measured start=0/start=10 pair
    (2026-09-21), but it is the mechanism contiguity creates, and the repeat
    would otherwise count toward `limit`. The short-page test reads the page's
    own count, before this dedupe, so a repeat never makes a full page look
    short.

    Failure semantics are the fan-out's contract: a 429 on ANY page raises the
    rate-limit ValueError; any other failure on the first page raises; any
    other failure on a later page keeps what was already fetched."""
    cards: list[dict[str, str]] = []
    seen: set[str] = set()
    last_html = ""
    pages = min(_MAX_PAGES, -(-max(1, ctx.limit) // _PAGE_SIZE))  # ceil, at least one
    for page in range(pages):
        start = page * _PAGE_SIZE
        try:
            last_html = _http_get(
                _build_search_url(
                    ctx.job_title, ctx.location, ctx.work_mode, start, ctx.max_age_days
                )
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
        except Exception as e:  # noqa: BLE001 - network trouble; later pages are optional
            if page == 0:
                raise ValueError(
                    "Couldn't reach LinkedIn's job search. Check your connection and try again."
                ) from e
            break
        page_cards = parse_search_results(last_html)
        for card in page_cards:
            key = _linkedin_job_id(card["url"]) or card["url"]
            if key not in seen:
                seen.add(key)
                cards.append(card)
        if len(page_cards) < _PAGE_SIZE or len(cards) >= ctx.limit:
            break
    if not cards:
        if last_html and _looks_like_login_wall(last_html):
            raise ValueError(
                "LinkedIn blocked the search request (bot check). Wait a few minutes "
                "and try again."
            )
        freshness = f" posted in the last {ctx.max_age_days} days" if ctx.max_age_days else ""
        raise NoResultsError(
            f"No LinkedIn jobs found for '{ctx.job_title}' in "
            f"'{ctx.location or 'anywhere'}'{freshness}. "
            "Check 'Customize search' and adjust the title, location, or 'Posted within'."
        )
    return cards


# --------------------------------------------------------------------------- #
# The guest posting page — closure, and the description
# --------------------------------------------------------------------------- #
# WHY THE MARKER IS READ FROM RAW HTML, and why this cannot live one layer up:
# `job_match._html_to_text` replaces every tag with a space, so no class, id or
# attribute survives it — and `_extract_linkedin` slices the description
# container out BEFORE converting, so a banner that sits in the page chrome
# (above the body, inside the top card) is gone twice over. The evidence only
# exists between the socket and the first regex, which is why the fetch had to
# move into this module.
#
# LinkedIn prints closure in the top card as, verbatim from two independently
# captured dead postings (guest jobPosting/3900000000 and /3850000000, fetched
# 2026-09-03 — byte-identical markup on both):
#
#     <figure class="closed-job closed-job__flavor topcard__flavor-row">
#       <span class="closed-job__icon closed-job__icon--error-pebble lazy-load"></span>
#       <figcaption class="closed-job__flavor--closed">No longer accepting applications</figcaption>
#     </figure>
_CLOSED_CAPTION_RE = re.compile(
    r'(?is)<figcaption[^>]*\bclass="[^"]*closed-job__flavor--closed[^"]*"[^>]*>(.*?)</figcaption>'
)
# The same wording as visible text, case-insensitive so a casing change in
# LinkedIn's copy does not silently disable the fallback (the captures are
# title-case; the lower-case form is covered, not observed). Only this one
# phrase family: the authenticated /jobs/view surface prints other wordings,
# but we never fetch that surface, and a pattern that cannot fire on the page
# we actually request is a rule with no false-positive case to reason about.
_CLOSED_PHRASE_RE = re.compile(r"(?i)no longer accepting applications")
# The exact region `_extract_linkedin` slices out as the description. Removed
# before the phrase scan — see the false-positive table in the docstring below.
_DESCRIPTION_SECTION_RE = re.compile(r"(?is)show-more-less-html__markup.*?</section>")
# HTML comments, removed before EITHER anchor runs. Not hypothetical and not
# tidiness: a commented-out banner renders nothing to a reader, and the two
# captured guest pages carry 82 and 29 comments respectively (59 and 26 of them
# LinkedIn's own empty `<!---->` template markers), so commented markup on this
# surface is the norm rather than the exception. Found the hard way — the open
# fixture fired the phrase scan on its own provenance note.
_COMMENT_RE = re.compile(r"(?s)<!--.*?-->")
_TAG_RE = re.compile(r"(?is)<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _visible(fragment: str) -> str:
    """Tags stripped, entities decoded, whitespace normalised, capped.

    RAW_MAX is imported from `geo_restriction` rather than restated: this string
    lands in the same inline slot on the same 390px card as `GeoRestriction.raw`
    and `SalaryInfo.raw`, and two modules feeding one layout must not each own a
    number for it."""
    return _WS_RE.sub(" ", _html.unescape(_TAG_RE.sub(" ", fragment))).strip()[:RAW_MAX]


def linkedin_closed_marker(html: str) -> str:
    """The posting's own closed-state text, or "" if the page never says so.

    Pure function over the FULL guest page HTML — no network, no model, no
    `datetime.now()`. "" means NOT OBSERVED, never "open": a page we could not
    fetch, a markup change, and a live posting all return "" alike, and the
    caller must not read the empty string as a liveness claim.

    Both anchors run over the page CHROME — the top card and its neighbours,
    with HTML comments and the description container removed — class first:

    1. the `closed-job__flavor--closed` figcaption, LinkedIn's own banner;
    2. the visible phrase, as a fallback for a renamed class.

    The class anchor is de-scoped along with the phrase one rather than trusted
    to be unmintable by a posting body. LinkedIn's rich-text sanitiser does
    appear to strip attributes (every tag in both captured descriptions —
    `<br>`, `<strong>`, `<ul>`, `<li>` — carries none), but "appears to, in two
    samples" is not a guarantee, and the banner is never inside the description
    on any page we have seen, so scoping costs nothing and removes the need to
    be right about someone else's sanitiser.

    FALSE POSITIVES, each named because a false "closed" DELETES A LIVE JOB —
    the worst failure this feature has, and the reason `linkedin_job_open.html`
    exists beside the closed fixture ("make the closed case pass" is trivially
    satisfied by returning the marker always):

    - **A body that says it.** "We are no longer accepting applications by
      email — please apply through this posting" is ordinary ad copy. The phrase
      scan therefore runs on the page with the description container removed,
      the same region `_extract_linkedin` slices; the class branch is immune by
      construction. Pinned in the open fixture, which carries that sentence.
    - **A neighbouring figcaption.** The same top card prints "Be among the
      first 25 applicants" in a `num-applicants__caption` figcaption ABOVE the
      closed one, so a bare `<figcaption>` scan returns the wrong element on a
      closed page and fires on every open page. The class is the anchor, not the
      tag. Both fixtures carry that decoy.
    - **The substring "closed".** `disclosed`, `undisclosed salary`,
      `closed-loop control` are all real resume/JD vocabulary, which is why
      nothing here matches a bare "closed". The open fixture carries them.
    - **A commented-out banner.** Nothing a reader sees, and the guest page is
      full of LinkedIn's own `<!---->` template markers, so comments go before
      both anchors. Found the hard way: the open fixture's provenance note
      fired the phrase scan. Pinned by a commented banner in that fixture.
    - **An auth wall or bot check.** Those pages carry neither the class nor the
      phrase (checked against a live capture), so a blocked fetch abstains
      rather than reporting closure — the safe direction.

    No Hebrew variant, deliberately: this is the guest surface, which serves
    English-normalised chrome (`LinkedInProvider.search` stamps `language="en"`
    for exactly that reason), so a Hebrew pattern here could never fire. The
    same reasoning `geo_restriction` records for its absent Hebrew restriction
    rules.
    """
    if not html:
        return ""
    chrome = _DESCRIPTION_SECTION_RE.sub(" ", _COMMENT_RE.sub(" ", html))
    m = _CLOSED_CAPTION_RE.search(chrome)
    if m:
        text = _visible(m.group(1))
        if text:
            return text
        # The class is there but the caption is empty. We ABSTAIN rather than
        # substituting a sentence of our own: `raw` is quoted to the user under
        # "from the posting", and inventing the quote is the one thing the
        # SalaryInfo.raw shape exists to prevent. Fall through to the phrase.
    m = _CLOSED_PHRASE_RE.search(chrome)
    if not m:
        return ""
    # The enclosing text run, not the enclosing TAG: bounded by the nearest '>'
    # before and '<' after, so the quote can never drag markup in however the
    # banner is nested.
    lo = chrome.rfind(">", 0, m.start()) + 1
    hi = chrome.find("<", m.end())
    return _visible(chrome[lo : hi if hi >= 0 else len(chrome)]) or _visible(m.group(0))


def _description_from_html(html: str) -> str:
    """The posting text out of an already-fetched guest page.

    A DELIBERATE MIRROR of `job_match._extract_linkedin`'s tail, not a second
    opinion: it must return the same bytes for the same page, and the fixture
    pair is what pins that. It exists only because the closure evidence and the
    HTTP status live in the response `_extract_linkedin` throws away, so this
    module now owns the fetch — and calling `_extract_linkedin` as well would
    mean two guest requests per scored hit on the board that rate-limits us.
    Both helpers it uses are imported from `job_match` rather than copied, so
    the parts that actually parse cannot drift."""
    m = re.search(r"(?is)show-more-less-html__markup[^>]*>(.*?)</section>", html)
    if not m:
        return ""
    body = re.sub(r"(?im)^\s*show (more|less)\s*$", "", _html_to_text(m.group(1))).strip()
    if not body:
        return ""
    title = _first_text(html, "top-card-layout__title")
    company = _first_text(html, "topcard__org-name-link")
    header = " — ".join(x for x in [title, company] if x)
    return (f"{header}\n\n{body}" if header else body).strip()


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
                logo_url=card.get("logo", ""),
                language="en",  # guest surface serves English-normalized cards
                raw=dict(card),
            )
            for card in _fetch_cards(ctx)
        ]

    def fetch_description(self, hit: JobHit) -> str:
        """The posting text ("" when unavailable), and — as a SIDE EFFECT on the
        hit — `hit.closed` when the board itself says the posting is dead.

        THE RETURN CONTRACT IS UNCHANGED and an open posting's string is
        byte-identical to what `_extract_linkedin` produced before this change.
        Closure is reported on the hit instead, because the two are independent
        facts: a closed guest page still serves its description (verified on a
        live capture — the banner sits in the top card, the body renders below
        it untouched), so "dead" and "no text" do not imply each other in either
        direction, and `job_search._build_match` gates on `hit.closed` rather
        than on emptiness.

        WHICH FAILURES COUNT AS CLOSURE — 404 and 410 ONLY, and the narrowness is
        the point. Everything else keeps today's behaviour exactly (`closed`
        stays "", the empty string lands the posting in `skipped`, whose
        documented meaning is "not fetchable"): 429 is LinkedIn throttling us,
        a timeout or connection reset is the network, an auth wall is the board
        refusing a logged-out reader, and a `BlockedURLError` is our own SSRF
        guard. Every one of those is a statement about the REQUEST, not about
        the vacancy, and a live posting removed from the results under "no
        longer accepting applications" is worse than the wasted scoring call
        this feature exists to save.
        """
        jid = _linkedin_job_id(hit.url)
        if not jid:
            return ""
        try:
            html = _http_get(f"{_JOB_POSTING_URL}/{jid}")
        except urllib.error.HTTPError as e:
            # LinkedIn 404s a posting id it no longer serves and 410s one it has
            # explicitly retired; both are the board answering, not failing.
            if e.code in (404, 410):
                hit.closed = f"HTTP {e.code}"
            return ""
        except Exception:  # noqa: BLE001 - one bad posting shouldn't sink the search
            return ""
        # Stamped from the RAW html and BEFORE extraction, not after and not
        # conditionally: the description slice destroys the evidence, and a
        # closure we only recorded when the body happened to parse would be
        # silently disabled by the next markup change to the body container.
        hit.closed = linkedin_closed_marker(html)
        text = _description_from_html(html)
        if not text or _looks_like_login_wall(text):
            return ""
        return text
