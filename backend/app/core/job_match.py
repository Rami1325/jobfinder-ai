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
from app.core.scorer import score_resume
from app.models import JobMatch, JobMatchResult, ResumeModel


def match_jobs(resume: ResumeModel, listings: list[str]) -> JobMatchResult:
    matches: list[JobMatch] = []
    for text in listings:
        t = (text or "").strip()
        if len(t) < 20:
            continue
        jd = analyze_jd(t)
        score = score_resume(resume, jd)
        top_gaps = [g.keyword for g in score.gaps if g.status != "covered"][:6]
        matches.append(
            JobMatch(
                title=jd.job_title,
                company=jd.company,
                overall=score.overall,
                keyword_coverage=score.keyword_coverage,
                fit_score=score.fit_score,
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


def fetch_job_text(url: str) -> str:
    """Fetch a job posting URL and return readable text.

    Tries schema.org JobPosting markup first (reliable for LinkedIn public job
    pages + most ATS/career sites), then falls back to stripping the whole page.

    Single-user local tool: we accept arbitrary URLs (no SSRF allowlist). If this
    is ever exposed to multiple users, add an allowlist / block private ranges.
    """
    u = url.strip()
    if not u.startswith(("http://", "https://")):
        u = "https://" + u
    req = urllib.request.Request(
        u,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
            ),
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310 - intentional, see docstring
        raw = resp.read(3_000_000).decode("utf-8", errors="ignore")
    return _extract_jobposting(raw) or _html_to_text(raw)
