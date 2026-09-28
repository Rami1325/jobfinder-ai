"""Rank multiple job listings by fit against the user's master resume.

Reuses the existing JD analyzer + scorer. No mass auto-apply — the user stays in
control; this only surfaces fit and gaps so they choose where to tailor.
"""
from __future__ import annotations

import html as _html
import json
import re
import urllib.request

from app.core.geo_restriction import detect_geo_restriction
from app.core.jd_analyzer import analyze_jd
from app.config import get_settings
from app.core.net_guard import assert_fetchable, guarded_opener
# Under its old name: `providers.linkedin` and the smoke test import it from here.
# It lives in `posting_keys` now, a module a deterministic filter may import.
from app.core.posting_keys import linkedin_job_id as _linkedin_job_id
from app.llm.limits import clip_utf8
from app.core.salary import extract_salary
from app.core.scorer import score_resume, top_matched_and_gaps
from app.models import JobMatch, JobMatchResult, ResumeModel

# The most listings one ranking reads (Phase 30 / B4.3). Each listing costs two
# model calls in the serial loop below while the whole ranking costs ONE monthly
# use, so without a ceiling one use bought any number of fit readings.
# `/jobs/match` refuses more with a 400 before any call; `kits.MAX_BATCH` is the
# precedent.
MAX_MATCH_LISTINGS = 10


def match_jobs(resume: ResumeModel, listings: list[str]) -> JobMatchResult:
    matches: list[JobMatch] = []
    for text in listings:
        t = (text or "").strip()
        if len(t) < 20:
            continue
        jd = analyze_jd(t)
        score = score_resume(resume, jd)
        top_matched, top_gaps = top_matched_and_gaps(score.gaps)
        matches.append(
            JobMatch(
                title=jd.job_title,
                company=jd.company,
                overall=score.overall,
                keyword_coverage=score.keyword_coverage,
                fit_score=score.fit_score,
                top_matched=top_matched,
                top_gaps=top_gaps,
                jd_text=t,
                salary=extract_salary(t),
                # Text only — a pasted listing has no board, no location and no
                # card title, and the detector must abstain on missing input
                # rather than guess. It never FILTERS here: `blocking` is advice
                # and only job_search acts on it, so /jobs/match and /jobs/search
                # can never disagree about the same posting.
                geo_restriction=detect_geo_restriction(t),
            )
        )
    matches.sort(key=lambda m: m.overall, reverse=True)
    return JobMatchResult(matches=matches)


def _html_to_text(html: str) -> str:
    html = re.sub(r"(?is)<(script|style|head|nav|footer|svg)[^>]*>.*?</\1>", " ", html)
    html = re.sub(r"(?is)<br\s*/?>", "\n", html)
    html = re.sub(r"(?is)</(p|div|li|h[1-6])>", "\n", html)
    text = re.sub(r"(?is)<[^>]+>", " ", html)
    text = _html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def _iter_jsonld(data):
    """Yield every dict node in a parsed JSON-LD blob (handles lists + @graph)."""
    if isinstance(data, list):
        for item in data:
            yield from _iter_jsonld(item)
    elif isinstance(data, dict):
        yield data
        if "@graph" in data:
            yield from _iter_jsonld(data["@graph"])


def _extract_jobposting(html: str) -> str:
    """Prefer schema.org JobPosting markup — how LinkedIn and most ATS/career pages
    (Greenhouse, Lever, Workable…) expose the real description server-side."""
    for m in re.finditer(
        r'(?is)<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', html
    ):
        try:
            data = json.loads(m.group(1).strip())
        except Exception:  # noqa: BLE001 - skip malformed blocks
            continue
        for node in _iter_jsonld(data):
            types = node.get("@type")
            types = types if isinstance(types, list) else [types]
            if not any(str(t).lower() == "jobposting" for t in types):
                continue
            desc = node.get("description")
            if not isinstance(desc, str) or not desc.strip():
                continue
            title = node.get("title") or ""
            org = node.get("hiringOrganization")
            company = org.get("name") if isinstance(org, dict) else ""
            header = " — ".join(x for x in [str(title).strip(), str(company).strip()] if x)
            body = _html_to_text(_html.unescape(desc))
            return (f"{header}\n\n{body}" if header else body).strip()
    return ""


# Phrases that mean "you got a sign-in / bot-block page, not the posting". These
# are auth-wall specific and won't appear in a real job description, so seeing one
# is a reliable signal that extraction failed and we should tell the user to paste.
_LOGIN_WALL_MARKERS = (
    "join or sign in to find your next job",
    "new to linkedin? join now",
    "sign in to view",
    "sign in to see",
    "you need to sign in",
    "please log in",
    "enable javascript",
    "verify you are human",
    "access to this page has been denied",
    "unusual traffic from your",
)


def _looks_like_login_wall(text: str) -> bool:
    low = text.lower()
    return any(m in low for m in _LOGIN_WALL_MARKERS)


# The most `_http_get` reads of one response. A JSON board larger than this
# arrives cut off and fails to parse (Greenhouse's `elastic` board, 2026-09-28),
# so a provider that reads whole boards checks against it (providers/greenhouse.py).
HTTP_READ_CAP = 3_000_000


def _http_get(url: str, timeout: float = 15) -> str:
    """Every outbound fetch in the app funnels through here, so the SSRF guard
    lives here too rather than only on the two user-URL routes: board URLs are
    parsed out of third-party HTML, and a board that starts serving private
    addresses should be refused the same way a hand-typed one is."""
    assert_fetchable(url)  # raises BlockedURLError (a ValueError) on non-public hosts
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
            ),
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    # guarded_opener re-checks each redirect hop; urlopen's default opener would
    # follow a 302 into a private address without asking.
    with guarded_opener.open(req, timeout=timeout) as resp:  # noqa: S310 - guarded above
        return resp.read(HTTP_READ_CAP).decode("utf-8", errors="ignore")


def _first_text(html: str, cls: str) -> str:
    m = re.search(r'class="[^"]*' + re.escape(cls) + r'[^"]*"[^>]*>(.*?)<', html, re.S)
    return _html.unescape(m.group(1).strip()) if m else ""


def _extract_linkedin(url: str) -> str:
    """LinkedIn serves an auth wall (the "Join or sign in" page) to logged-out
    bots hitting /jobs/view/<id>, which is why a naive fetch returns login text.
    Its public 'jobs-guest' endpoint returns the same posting without a login."""
    jid = _linkedin_job_id(url)
    if not jid:
        return ""
    guest = f"https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{jid}"
    try:
        html = _http_get(guest)
    except Exception:  # noqa: BLE001 - closed/region-locked posting; caller shows a paste hint
        return ""
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


def _clip_jd(text: str) -> str:
    """Bound scraped posting text before it can reach a prompt.

    CLIPPED, not refused, and silently — the opposite of the resume rule, and
    for the reason that rule is about ownership: this text is a page WE fetched,
    the user never saw it, and the tail past a job ad is nav, footer and
    related-jobs boilerplate. Nothing of theirs is lost, so no notice is owed.

    This is the single choke point: `_http_get` reads up to 3 MB and the
    whole-page `_html_to_text` fallback runs whenever schema.org extraction
    finds nothing, so a JS-heavy careers site delivered megabytes of nav text
    into every prompt downstream — job match, job search, kits and the company
    brief all obtain their text through here."""
    clipped, _ = clip_utf8(text, get_settings().max_jd_kb)
    return clipped


def fetch_job_text(url: str) -> str:
    """Fetch a job posting URL and return readable text.

    LinkedIn gets a dedicated path (its public job pages auth-wall logged-out
    fetches). Everything else tries schema.org JobPosting markup first (reliable
    for most ATS/career sites: Greenhouse, Lever, Workable…), then falls back to
    stripping the whole page. If all we can see is a sign-in / bot-block page, we
    raise instead of returning that garbage so the user knows to paste the text.

    The URL is caller-supplied and the body comes back in the response, so every
    fetch below goes through `net_guard.assert_fetchable` (public hosts only,
    re-checked on each redirect hop). See app/core/net_guard.py.
    """
    u = url.strip()
    if not u.startswith(("http://", "https://")):
        u = "https://" + u

    if "linkedin.com" in u.lower():
        text = _extract_linkedin(u)
        if text and not _looks_like_login_wall(text):
            return _clip_jd(text)
        raise ValueError(
            "LinkedIn didn't return the public description for this posting (it may be "
            "closed, region-locked, or login-only). Open the job, copy the description, "
            "and paste it here instead."
        )

    raw = _http_get(u)
    text = _extract_jobposting(raw) or _html_to_text(raw)
    if len(text.strip()) < 40 or _looks_like_login_wall(text):
        raise ValueError(
            "That page needs a login or blocked the fetch, so only its sign-in text came "
            "back. Open the posting, copy the job description, and paste it here instead."
        )
    return _clip_jd(text)
