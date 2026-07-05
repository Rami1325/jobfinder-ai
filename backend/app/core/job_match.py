"""Rank multiple job listings by fit against the user's master résumé.

Reuses the existing JD analyzer + scorer. No mass auto-apply — the user stays in
control; this only surfaces fit and gaps so they choose where to tailor.
"""
from __future__ import annotations

import html as _html
import json
import re
import urllib.request

from app.core.jd_analyzer import analyze_jd
from app.core.scorer import score_resume, top_matched_and_gaps
from app.models import JobMatch, JobMatchResult, ResumeModel


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


def _http_get(url: str, timeout: float = 15) -> str:
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
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - see fetch_job_text docstring
        return resp.read(3_000_000).decode("utf-8", errors="ignore")


def _first_text(html: str, cls: str) -> str:
    m = re.search(r'class="[^"]*' + re.escape(cls) + r'[^"]*"[^>]*>(.*?)<', html, re.S)
    return _html.unescape(m.group(1).strip()) if m else ""


def _linkedin_job_id(url: str) -> str:
    """Pull the numeric posting id out of any LinkedIn job URL shape:
    /jobs/view/<id>, /jobs/view/<slug>-<id>, ?currentJobId=<id>, or a guest api url."""
    for pat in (
        r"/jobs/view/(?:[^/?#]*?-)?(\d{6,})",
        r"[?&]currentJobId=(\d{6,})",
        r"/jobPosting/(\d{6,})",
    ):
        m = re.search(pat, url)
        if m:
            return m.group(1)
    return ""


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


def fetch_job_text(url: str) -> str:
    """Fetch a job posting URL and return readable text.

    LinkedIn gets a dedicated path (its public job pages auth-wall logged-out
    fetches). Everything else tries schema.org JobPosting markup first (reliable
    for most ATS/career sites: Greenhouse, Lever, Workable…), then falls back to
    stripping the whole page. If all we can see is a sign-in / bot-block page, we
    raise instead of returning that garbage so the user knows to paste the text.

    Single-user local tool: we accept arbitrary URLs (no SSRF allowlist). If this
    is ever exposed to multiple users, add an allowlist / block private ranges.
    """
    u = url.strip()
    if not u.startswith(("http://", "https://")):
        u = "https://" + u

    if "linkedin.com" in u.lower():
        text = _extract_linkedin(u)
        if text and not _looks_like_login_wall(text):
            return text
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
    return text
