"""Company Research Brief — grounded pre-apply / pre-interview homework.

Fetches the company's about/careers/team page (same fetch path job-match URLs
use) and summarizes it alongside the résumé. Honesty rules, same brand as the
fabrication guard:
- Company facts and people come ONLY from the provided text (the prompt forbids
  model memory; the UI labels everything "verify these").
- Email addresses are NEVER produced by the LLM. `extract_emails` pulls only
  addresses that literally appear in the page text, and a person only gets an
  email when its local part matches their name.
- The reach-out message is short and résumé-grounded (who you are, why you fit,
  one closing question) — the human sends it themselves.
"""
from __future__ import annotations

import re
import urllib.parse

from app.core.job_match import fetch_job_text
from app.core.lang import resume_language
from app.llm.client import get_llm_client
from app.llm import prompts
from app.models import BriefPerson, CompanyBriefResult, ResumeModel

# Keep prompt size sane on long careers pages.
_PAGE_TEXT_CAP = 12_000

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")

# Role-mailbox local parts that signal a hiring inbox rather than a person.
_HIRING_LOCALS = ("jobs", "careers", "career", "hr", "talent", "recruiting", "recruitment", "hiring", "cv", "join")


def extract_emails(text: str, cap: int = 8) -> list[str]:
    """Every distinct email address literally present in the text (order kept)."""
    seen: list[str] = []
    for m in _EMAIL_RE.finditer(text or ""):
        e = m.group(0).lower().rstrip(".")
        if e not in seen:
            seen.append(e)
        if len(seen) >= cap:
            break
    return seen


def hiring_emails(emails: list[str]) -> list[str]:
    """The subset that looks like a hiring inbox (jobs@/careers@/hr@/talent@…)."""
    out = []
    for e in emails:
        local = e.split("@", 1)[0]
        if any(tok in local for tok in _HIRING_LOCALS):
            out.append(e)
    return out


def email_for_person(name: str, emails: list[str]) -> str:
    """An address whose local part contains the person's first or last name
    (ASCII, lowercased). Deterministic: only ever returns an email that was in
    the page text — never a guessed pattern."""
    parts = [p.lower() for p in re.split(r"\s+", (name or "").strip()) if len(p) >= 3 and p.isascii()]
    if not parts:
        return ""
    for e in emails:
        local = e.split("@", 1)[0]
        if any(p in local for p in parts):
            return e
    return ""


def linkedin_people_search(name: str, company: str) -> str:
    """Deep link into LinkedIn's people search for this person at this company.
    We never scrape LinkedIn — the user opens the search logged in."""
    q = " ".join(x for x in [(name or "").strip(), (company or "").strip()] if x)
    if not q:
        return ""
    return "https://www.linkedin.com/search/results/people/?keywords=" + urllib.parse.quote(q)


def build_company_brief(
    resume: ResumeModel,
    company: str = "",
    url: str = "",
    page_text: str = "",
    jd_text: str = "",
    job_title: str = "",
) -> CompanyBriefResult:
    text = (page_text or "").strip()
    if not text and url.strip():
        # fetch_job_text raises a friendly ValueError on login walls / blocked
        # fetches; the route surfaces it as a 400 so the user can paste instead.
        text = fetch_job_text(url)
    if not text and not jd_text.strip():
        raise ValueError(
            "Provide a company page URL, pasted page text, or a job description to ground the brief."
        )

    client = get_llm_client()
    data = client.complete_json(
        prompts.with_resume_language(prompts.COMPANY_BRIEF_SYSTEM, resume_language(resume)),
        prompts.company_brief_user(
            resume.model_dump_json(), company, text[:_PAGE_TEXT_CAP], jd_text, job_title
        ),
    )

    resolved_company = str(data.get("company", "")).strip() or company
    emails = extract_emails(text)
    people: list[BriefPerson] = []
    for p in data.get("people", [])[:5]:
        if not isinstance(p, dict):
            continue
        name = str(p.get("name", "")).strip()
        if not name:
            continue
        people.append(
            BriefPerson(
                name=name,
                role=str(p.get("role", "")),
                evidence=str(p.get("evidence", "")),
                linkedin_search=linkedin_people_search(name, resolved_company),
                email=email_for_person(name, emails),
            )
        )

    return CompanyBriefResult(
        company=resolved_company,
        overview=str(data.get("overview", "")),
        products=[str(x) for x in data.get("products", [])],
        culture=[str(x) for x in data.get("culture", [])],
        interview_style=[str(x) for x in data.get("interview_style", [])],
        talking_points=[str(x) for x in data.get("talking_points", [])],
        people=people,
        hiring_emails=hiring_emails(emails),
        outreach_subject=str(data.get("outreach_subject", "")),
        outreach_message=str(data.get("outreach_message", "")),
        grounded=bool(text),
    )
