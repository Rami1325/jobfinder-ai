"""Company Research Brief — grounded pre-apply / pre-interview homework.

Fetches the company's about/careers/team page (same fetch path job-match URLs
use) and summarizes it alongside the resume. Honesty rules, same brand as the
fabrication guard:
- Company facts and people come ONLY from the provided text (the prompt forbids
  model memory; the UI labels everything "verify these").
- Email addresses are NEVER produced by the LLM. `extract_emails` pulls only
  addresses that literally appear in the page text, and a person only gets an
  email when its local part matches their name.
- The reach-out message is short and resume-grounded (who you are, why you fit,
  one closing question) — the human sends it themselves.
- "Who to reach" is also role-aware (PLAN 11.7) but stays deterministic: a
  role→titles table maps the target role to its likely hiring chain (AI role ⇒
  CTO / Head of AI…), each title linked to the company's LinkedIn People tab
  when the page links the company's LinkedIn (real current employees, country
  filter one click away), else a people search. We never scrape LinkedIn — the
  user browses it logged in.
"""
from __future__ import annotations

import re
import urllib.parse

from app.core.job_match import fetch_job_text
from app.core.lang import resume_language
from app.llm.client import get_llm_client
from app.llm import prompts
from app.models import BriefPerson, BriefTarget, CompanyBriefResult, ResumeModel

# Keep prompt size sane on long careers pages. FETCHED text only: that is machine
# text the user neither wrote nor saw, so clipping it is allowed (limits.py rule
# 1). Text the user PASTED is theirs and is refused by the prompt guard instead
# (kind "page"): clipping it silently cut the part of the page they pasted last.
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


# --------------------------------------------------------------------------- #
# Role-aware hiring-chain targeting (PLAN 11.7). Deterministic on purpose:
# a keyword table, not the LLM — the chips must never invent an org chart.
# Titles stay English (Israeli LinkedIn titles overwhelmingly are), but the
# role keywords include Hebrew so a pasted Hebrew JD title still maps. Short
# ambiguous keywords are space-padded ("ml " would match "html") and matched
# against the space-padded role string.
# --------------------------------------------------------------------------- #
_ROLE_TARGETS: list[tuple[tuple[str, ...], list[str]]] = [
    # AI / ML / data science — before the generic engineering bucket so an
    # "AI Engineer" lands here, not on "engineer".
    ((" ai ", " ai/", "machine learning", " ml ", "mlops", "deep learning", "llm",
      "data scien", "nlp", "computer vision", "בינה מלאכותית", "מדען נתונים", "למידת מכונה"),
     ["CTO", "VP AI", "Head of AI", "Head of Data Science"]),
    (("data engineer", "analytics engineer", "data analyst", " bi ", "dba",
      "מהנדס נתונים", "אנליסט"),
     ["CTO", "VP Data", "Head of Data", "Data Team Lead"]),
    (("devops", " sre ", "site reliability", "platform engineer", "infrastructure", "cloud engineer"),
     ["CTO", "VP Engineering", "Head of DevOps"]),
    (("security", "appsec", "cyber", "אבטחת מידע", "סייבר"),
     ["CISO", "VP Security", "Head of Security"]),
    (("product manager", "product owner", " pm ", "מנהל מוצר", "מנהלת מוצר"),
     ["CPO", "VP Product", "Head of Product"]),
    (("frontend", "front end", "backend", "back end", "full stack", "fullstack",
      "software", "developer", "engineer", " qa ", "automation", "mobile",
      "android", " ios ", "תוכנה", "מפתח", "מתכנת", "פיתוח"),
     ["CTO", "VP R&D", "VP Engineering", "Engineering Team Lead"]),
    (("design", " ux ", " ui ", "ux/", "ui/", "מעצב"),
     ["VP Design", "Head of Design"]),
    (("marketing", "growth", " seo ", "content", "שיווק"),
     ["CMO", "VP Marketing", "Head of Growth"]),
    (("sales", "account executive", "account manager", " sdr ", " bdr ",
      "business development", "מכירות"),
     ["CRO", "VP Sales", "Head of Sales"]),
    (("customer success", "support", "הצלחת לקוח"),
     ["VP Customer Success", "Head of Customer Success"]),
    (("finance", "accountant", "controller", "bookkeep", "כספים", "חשב"),
     ["CFO", "VP Finance"]),
    ((" hr ", "human resources", "recruit", "talent", "משאבי אנוש", "גיוס"),
     ["VP HR", "Head of Talent Acquisition"]),
]
# Small companies often have no function head — the founders ARE the chain.
_DEFAULT_TARGETS = ["CEO", "Founder"]
_ALWAYS_TARGET = "Recruiter"  # a talent person is always worth reaching


def target_titles(role: str) -> list[str]:
    """Likely decision-maker titles for this role, first match wins. Always
    ends with a Recruiter chip. Pure — smoke-pinned."""
    padded = f" {(role or '').lower()} "
    titles = next(
        (t for keys, t in _ROLE_TARGETS if any(k in padded for k in keys)),
        _DEFAULT_TARGETS,
    )
    return [*titles, _ALWAYS_TARGET]


_LINKEDIN_COMPANY_RE = re.compile(r"linkedin\.com/company/([A-Za-z0-9\-_.%]+)", re.IGNORECASE)


def linkedin_company_slug(text: str) -> str:
    """The company's LinkedIn slug, only when a linkedin.com/company/<slug>
    link literally appears in the provided url/page text (site footers often
    print it). Never guessed from the company name — a wrong slug 404s."""
    m = _LINKEDIN_COMPANY_RE.search(text or "")
    return m.group(1).rstrip(".") if m else ""


def linkedin_company_people(slug: str, keywords: str = "") -> str:
    """The company page's People tab — the 'people bar' — optionally
    pre-filtered by a title keyword. Current employees only, and LinkedIn's
    own country filter is one click away there."""
    if not slug:
        return ""
    base = f"https://www.linkedin.com/company/{urllib.parse.quote(slug)}/people/"
    return base + (f"?keywords={urllib.parse.quote(keywords)}" if keywords else "")


def hiring_chain_links(role: str, company: str, slug: str) -> list[BriefTarget]:
    """One LinkedIn deep link per likely decision-maker title: the company
    People tab when the slug is known, else a people search with the company
    name. No slug AND no company name would search bare titles — skip that."""
    if not slug and not (company or "").strip():
        return []
    return [
        BriefTarget(
            title=title,
            url=linkedin_company_people(slug, title) if slug else linkedin_people_search(title, company),
        )
        for title in target_titles(role)
    ]


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
        text = fetch_job_text(url)[:_PAGE_TEXT_CAP]
    if not text and not jd_text.strip():
        raise ValueError(
            "Provide a company page URL, pasted page text, or a job description to ground the brief."
        )

    client = get_llm_client()
    data = client.complete_json(
        prompts.with_resume_language(prompts.COMPANY_BRIEF_SYSTEM, resume_language(resume)),
        prompts.company_brief_user(
            resume.model_dump_json(), company, text, jd_text, job_title
        ),
    )

    resolved_company = str(data.get("company", "")).strip() or company
    # Slug can appear in the URL the user gave us or as a footer link in the
    # page text — either grounds the People-tab deep links.
    slug = linkedin_company_slug(f"{url} {text}")
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
        targets=hiring_chain_links(job_title, resolved_company, slug),
        company_people_url=linkedin_company_people(slug),
        hiring_emails=hiring_emails(emails),
        outreach_subject=str(data.get("outreach_subject", "")),
        outreach_message=str(data.get("outreach_message", "")),
        grounded=bool(text),
    )
