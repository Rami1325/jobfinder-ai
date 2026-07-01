"""Rank multiple job listings by fit against the user's master résumé.

Reuses the existing JD analyzer + scorer. No mass auto-apply — the user stays in
control; this only surfaces fit and gaps so they choose where to tailor.
"""
from __future__ import annotations

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
    text = text.replace("&nbsp;", " ").replace("&amp;", "&")
    text = re.sub(r"&[a-z]+;", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def fetch_job_text(url: str) -> str:
    """Fetch a job posting URL and return readable text.

    Single-user local tool: we accept arbitrary URLs (no SSRF allowlist). If this
    is ever exposed to multiple users, add an allowlist / block private ranges.
    """
    u = url.strip()
    if not u.startswith(("http://", "https://")):
        u = "https://" + u
    req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0 (JobFinder)"})
    with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310 - intentional, see docstring
        raw = resp.read(2_000_000).decode("utf-8", errors="ignore")
    return _html_to_text(raw)
