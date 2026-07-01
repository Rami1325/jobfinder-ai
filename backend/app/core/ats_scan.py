"""Standalone ATS scanner: deterministic format/content checks + optional JD keyword coverage."""
from __future__ import annotations

import re

from app.core.jd_analyzer import analyze_jd
from app.core.scorer import keyword_analysis
from app.models import ATSIssue, ATSScanResult, ResumeModel


def scan_resume(resume: ResumeModel, jd_text: str = "") -> ATSScanResult:
    issues: list[ATSIssue] = []
    c = resume.contact

    issues.append(
        ATSIssue(label="Email present", severity="good")
        if c.email
        else ATSIssue(label="Missing email", severity="bad", detail="Add a professional email address.")
    )
    issues.append(
        ATSIssue(label="Phone present", severity="good")
        if c.phone
        else ATSIssue(label="Missing phone", severity="warn", detail="Add a phone number.")
    )
    issues.append(
        ATSIssue(label="Summary present", severity="good")
        if resume.summary
        else ATSIssue(label="No summary", severity="warn", detail="A short targeted summary helps ATS and recruiters.")
    )
    issues.append(
        ATSIssue(label=f"{len(resume.skills)} skills listed", severity="good")
        if len(resume.skills) >= 5
        else ATSIssue(label="Few skills listed", severity="warn", detail="List more of your real, relevant hard skills.")
    )

    if resume.experience:
        bullets = [b for e in resume.experience for b in e.bullets]
        if bullets:
            quant = sum(1 for b in bullets if re.search(r"\d", b))
            if quant / len(bullets) >= 0.4:
                issues.append(ATSIssue(label="Bullets are quantified", severity="good"))
            else:
                issues.append(
                    ATSIssue(
                        label="Add metrics to bullets",
                        severity="warn",
                        detail=f"Only {quant} of {len(bullets)} bullets contain numbers.",
                    )
                )
        missing_dates = sum(1 for e in resume.experience if not (e.start_date or e.end_date))
        issues.append(
            ATSIssue(label="Dates present on all roles", severity="good")
            if missing_dates == 0
            else ATSIssue(label="Missing employment dates", severity="bad", detail="ATS needs start/end dates on each role.")
        )
    else:
        issues.append(ATSIssue(label="No experience section", severity="bad", detail="Add a work experience section."))

    coverage = 0.0
    gaps = []
    if jd_text.strip():
        jd = analyze_jd(jd_text)
        coverage, gaps = keyword_analysis(resume, jd)

    good = sum(1 for i in issues if i.severity == "good")
    format_health = round(100.0 * good / len(issues), 1) if issues else 0.0
    score = round(0.5 * format_health + 0.5 * coverage, 1) if jd_text.strip() else format_health

    return ATSScanResult(score=score, keyword_coverage=coverage, issues=issues, gaps=gaps)
