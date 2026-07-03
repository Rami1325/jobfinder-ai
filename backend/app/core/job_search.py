"""Search LinkedIn's public guest job listings and rank them by résumé fit.

Search context (what title, where) is derived from the résumé automatically via
the SEARCH_CONTEXT LLM task, with a deterministic fallback; the user can override
any field. Listing pages come from the same unauthenticated 'jobs-guest' surface
that `job_match._extract_linkedin` already uses for single postings, so the same
caveats apply: markup can change and heavy use can get temporarily blocked —
hence the fetch throttle, the two-page cap, and the login-wall detection.
"""
from __future__ import annotations

import html as _html
import re
import time
import urllib.error
import urllib.parse

from app.core.jd_analyzer import analyze_jd
from app.core.job_match import (
    _extract_linkedin,
    _http_get,
    _linkedin_job_id,
    _looks_like_login_wall,
)
from app.core.scorer import score_resume
from app.llm import prompts
from app.llm.client import get_llm_client
from app.models import JobMatch, JobSearchResult, ResumeModel, SearchContext

_SEARCH_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
_WORK_MODE_PARAM = {"onsite": "1", "remote": "2", "hybrid": "3"}  # LinkedIn f_WT values
_PAGE_SIZE = 25  # listings per guest search page
MAX_JOBS = 25
FETCH_DELAY_S = 0.5  # pause between per-job fetches to stay under the radar


def _fallback_context(resume: ResumeModel) -> SearchContext:
    """Deterministic context when the LLM is unavailable or returns blanks."""
    title = ""
    if resume.experience:
        title = resume.experience[0].title.strip()
    if not title and resume.skills:
        title = resume.skills[0].strip()
    location = resume.contact.location.strip()
    if not location and resume.experience:
        location = resume.experience[0].location.strip()
    return SearchContext(job_title=title, location=location)


def derive_search_context(resume: ResumeModel) -> SearchContext:
    fallback = _fallback_context(resume)
    try:
        data = get_llm_client().complete_json(
            prompts.SEARCH_CONTEXT_SYSTEM, prompts.search_context_user(resume.model_dump_json())
        )
    except Exception:  # noqa: BLE001 - the deterministic fallback is always usable
        return fallback
    title = str(data.get("job_title") or "").strip()
    location = str(data.get("location") or "").strip()
    return SearchContext(
        job_title=title or fallback.job_title,
        location=location or fallback.location,
    )


def _build_search_url(job_title: str, location: str, work_mode: str, start: int) -> str:
    params = {"keywords": job_title, "location": location, "start": start}
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
    [{url, title, company, location}], deduped by posting id, order preserved.
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
            }
        )
    return cards


def _resolve_context(resume: ResumeModel, customize: SearchContext | None) -> SearchContext:
    ctx = derive_search_context(resume)
    if customize is not None:
        if customize.job_title.strip():
            ctx.job_title = customize.job_title.strip()
        if customize.location.strip():
            ctx.location = customize.location.strip()
        if customize.work_mode in _WORK_MODE_PARAM or customize.work_mode == "any":
            ctx.work_mode = customize.work_mode
        ctx.limit = customize.limit
    ctx.limit = max(1, min(MAX_JOBS, ctx.limit))
    return ctx


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


def search_linkedin_jobs(
    resume: ResumeModel, customize: SearchContext | None = None
) -> JobSearchResult:
    ctx = _resolve_context(resume, customize)
    if not ctx.job_title:
        raise ValueError(
            "Couldn't derive a job title from your résumé. "
            "Check 'Customize search' and enter one."
        )

    cards = _fetch_cards(ctx)

    matches: list[JobMatch] = []
    skipped = 0
    for i, card in enumerate(cards[: ctx.limit]):
        if i:
            time.sleep(FETCH_DELAY_S)
        try:
            jd_text = _extract_linkedin(card["url"])
        except Exception:  # noqa: BLE001 - one bad posting shouldn't sink the search
            jd_text = ""
        if not jd_text or _looks_like_login_wall(jd_text):
            skipped += 1
            continue
        jd = analyze_jd(jd_text)
        score = score_resume(resume, jd)
        top_gaps = [g.keyword for g in score.gaps if g.status != "covered"][:6]
        matches.append(
            JobMatch(
                # The scraped card is authoritative for title/company; the LLM's
                # JD extraction only fills in when the card lacks them.
                title=card["title"] or jd.job_title,
                company=card["company"] or jd.company,
                overall=score.overall,
                keyword_coverage=score.keyword_coverage,
                fit_score=score.fit_score,
                top_gaps=top_gaps,
                jd_text=jd_text,
                url=card["url"],
                location=card["location"],
            )
        )

    if not matches:
        raise ValueError(
            "Found jobs but couldn't fetch any of their descriptions (LinkedIn may be "
            "throttling). Try again shortly or lower the result count."
        )
    matches.sort(key=lambda m: m.overall, reverse=True)
    return JobSearchResult(context=ctx, matches=matches, skipped=skipped)
