"""Offline end-to-end smoke test using the stub LLM (no API key needed).

DB checks run against a throwaway temp SQLite file (DATABASE_URL override below),
so the repo's jobfinder.db is never touched.

Run from the backend dir:
    .venv\\Scripts\\python.exe -m tests.smoke_test
"""
from __future__ import annotations

import os
import sys
import tempfile

# Hebrew shows up in check output (Israeli boards, Hebrew-pipeline checks);
# Windows consoles default to cp1252 which can't print it. Never let printing
# be the thing that fails the suite.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]

os.environ["USE_STUB_LLM"] = "true"
# Must be set before any app.* import — app.db.database builds the engine at import time.
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(tempfile.mkdtemp(), "smoke.db").replace("\\", "/")
# Turn the access-code gate ON for the whole suite so the HTTP checks in
# section 17 can prove /public/scan is exempt while everything else 401s.
# Harmless elsewhere: only requests through the ASGI middleware see the gate.
os.environ["APP_ACCESS_CODE"] = "smoke-gate-code"
# Tiny tailor cap so section 19 can hit the daily limit offline via the stub
# LLM; admins are exempt, so only the minted friend user feels it.
os.environ["DAILY_TAILOR_CAP"] = "2"
# Submit cap of 1 so section 22b can prove the auto-submit daily limit with a
# single real (mocked-transport) send.
os.environ["DAILY_SUBMIT_CAP"] = "1"
# Keep the suite hermetic: real SMTP creds in .env would make the alert-run
# checks send actual email and fail the "unconfigured" expectations. Env vars
# outrank .env in pydantic-settings, so blanking them here wins.
for _smtp_var in ("ALERT_SMTP_HOST", "ALERT_SMTP_USER", "ALERT_SMTP_PASSWORD", "ALERT_EMAIL_FROM", "CRON_SECRET"):
    os.environ[_smtp_var] = ""

from app.config import get_settings  # noqa: E402

get_settings.cache_clear()  # ensure env override is picked up

from app.core.ats_scan import scan_resume  # noqa: E402
from app.core.cover_letter import generate_cover_letter  # noqa: E402
from app.core.fabrication_guard import check_fabrication  # noqa: E402
from app.core.follow_up import write_follow_up  # noqa: E402
from app.core.interview import answer_feedback, generate_questions, model_answer  # noqa: E402
from app.core.jd_analyzer import analyze_jd  # noqa: E402
from app.core.job_match import match_jobs  # noqa: E402
from app.core.linkedin import optimize_linkedin  # noqa: E402
from app.core.tailor import tailor_resume  # noqa: E402
from app.models import Experience, FactsLedger, ResumeModel  # noqa: E402
from app.parsers.structurer import build_facts_ledger, structure_resume  # noqa: E402
from app.render.docx_renderer import render_docx  # noqa: E402
from app.render.pdf_renderer import render_pdf  # noqa: E402

failures: list[str] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" — {extra}" if extra else ""))
    if not cond:
        failures.append(name)


# 1. Structure a resume from raw text
resume = structure_resume("John Doe\nEngineer at Acme Corp 2020-Present\n- Built things")
check("structure_resume returns ResumeModel", isinstance(resume, ResumeModel))
check("resume has experience", len(resume.experience) > 0)

# 1b. LinkedIn profile import (PLAN 6): the "Save to PDF" export cleaner is a
# pure no-op for regular resumes and strips footers/labels from exports.
from app.llm import prompts as _li_prompts  # noqa: E402
from app.parsers.resume_parser import clean_linkedin_profile_text, is_linkedin_profile_export  # noqa: E402

_LI_EXPORT_TEXT = (
    "Contact\nwww.linkedin.com/in/dana-levi (LinkedIn)\nTop Skills\nPython\nSQL\n"
    "Dana Levi\nData Engineer at Example Corp\nTel Aviv, Israel\n"
    "Page 1 of 2\n"
    "Experience\nExample Corp\nData Engineer\nJanuary 2021 - Present\n"
    "Page 2 of 2"
)
check("linkedin export detected", is_linkedin_profile_export(_LI_EXPORT_TEXT))
_li_cleaned = clean_linkedin_profile_text(_LI_EXPORT_TEXT)
check(
    "linkedin export cleaned: footers + url label gone, content intact",
    "Page 1 of 2" not in _li_cleaned
    and "(LinkedIn)" not in _li_cleaned
    and "Data Engineer" in _li_cleaned
    and "www.linkedin.com/in/dana-levi" in _li_cleaned,
    _li_cleaned[:80],
)
_NOT_EXPORT = "Jane Roe\nEngineer\nSee my profile: linkedin.com/in/janeroe"
check(
    "non-export text passes through unchanged (even with a linkedin url)",
    clean_linkedin_profile_text(_NOT_EXPORT) == _NOT_EXPORT
    and not is_linkedin_profile_export(_NOT_EXPORT),
)
check(
    "STRUCTURE prompt knows about linkedin exports (Task tag still first)",
    "LinkedIn profile export" in _li_prompts.STRUCTURE_RESUME_SYSTEM
    and _li_prompts.STRUCTURE_RESUME_SYSTEM.startswith("Task: STRUCTURE_RESUME."),
)

# 1c. LinkedIn export column split: a synthetic two-column PDF (sidebar at
# x=30, main at x=250 — the real export's geometry) must extract as two clean
# streams, not interleaved lines. Layout ratios measured from a real export.
import io as _li_io  # noqa: E402
from reportlab.lib.pagesizes import letter as _li_letter  # noqa: E402
from reportlab.pdfgen import canvas as _li_canvas  # noqa: E402

from app.parsers.resume_parser import extract_text as _li_extract_text  # noqa: E402

_li_buf = _li_io.BytesIO()
_li_c = _li_canvas.Canvas(_li_buf, pagesize=_li_letter)  # 612x792, like the export
_li_c.drawString(30, 700, "Top Skills")       # sidebar…
_li_c.drawString(30, 685, "Python")
_li_c.drawString(30, 650, "www.linkedin.com/in/janedoe")
_li_c.drawString(250, 700, "Jane Doe")        # …main column at the same heights
_li_c.drawString(250, 685, "Data Engineer at Acme")
_li_c.drawString(250, 50, "Page 1 of 1")
_li_c.save()
_li_pdf_text = _li_extract_text("Profile.pdf", _li_buf.getvalue())
_li_lines = [ln.strip() for ln in _li_pdf_text.splitlines()]
check(
    "linkedin pdf columns split — sidebar and main not interleaved",
    "Top Skills" in _li_lines and "Jane Doe" in _li_lines,  # naive would give "Top Skills Jane Doe"
    str(_li_lines),
)
check(
    "linkedin pdf sidebar stream precedes main stream, footer stripped",
    _li_pdf_text.index("Top Skills") < _li_pdf_text.index("Jane Doe")
    and "Page 1 of 1" not in _li_pdf_text,
)

# 2. Facts ledger
ledger = build_facts_ledger(resume)
check("ledger captured employers", "Acme Corp" in ledger.employers, str(ledger.employers))
check("ledger captured numbers", "20%" in ledger.numbers, str(ledger.numbers))

# 3. JD analysis
jd = analyze_jd("We need a Software Engineer with Python, REST APIs and SQL.")
check("jd has keywords", len(jd.keywords) > 0, str(jd.keywords))

# 4. Tailor (score -> rewrite -> guard -> rescore)
result = tailor_resume(resume, jd, ledger)
check("tailor produced resume", isinstance(result.tailored_resume, ResumeModel))
check("score_before computed", result.score_before.overall >= 0)
check("score_after computed", result.score_after.overall >= 0)
check("changelog present", len(result.changelog) > 0)
check("no false fabrication flags on honest tailor", len(result.fabrication_flags) == 0, str(result.fabrication_flags))
check("keyword coverage is a percentage", 0 <= result.score_after.keyword_coverage <= 100)
check("gap analysis present", len(result.score_after.gaps) > 0)

# 5. Fabrication guard catches an injected fake employer
fake = result.tailored_resume.model_copy(deep=True)
fake.experience.append(Experience(company="FAKE Industries Ltd", title="CEO", start_date="2010", end_date="2019"))
flags = check_fabrication(fake, ledger)
flagged_employers = [f.value for f in flags if f.category == "employer"]
check("guard flags fabricated employer", "FAKE Industries Ltd" in flagged_employers, str(flagged_employers))

# 6. Renderers produce valid files
docx_bytes = render_docx(result.tailored_resume)
check("docx renders (zip/PK header)", docx_bytes[:2] == b"PK", f"{len(docx_bytes)} bytes")
pdf_bytes = render_pdf(result.tailored_resume)
check("pdf renders (%PDF header)", pdf_bytes[:4] == b"%PDF", f"{len(pdf_bytes)} bytes")

# 7. Cover letter
letter = generate_cover_letter(result.tailored_resume, jd)
check("cover letter non-empty", len(letter) > 20)

# 8. Interview prep (each routes through the stub via its Task tag)
questions = generate_questions(resume, jd)
check("interview questions generated", len(questions.questions) > 0, str(len(questions.questions)))
ans = model_answer(resume, jd, "Tell me about a challenging project.")
check("interview model answer non-empty", len(ans.answer) > 10)
fb = answer_feedback(resume, "Tell me about a challenging project.", "I built a service that scaled.")
check("interview feedback scored", 0 <= fb.score <= 100, str(fb.score))

# 9. Job match (reuses jd_analyzer + scorer, ranks by fit)
jm = match_jobs(resume, ["We need a Python engineer with SQL and REST APIs at Acme."])
check("job match ranked", len(jm.matches) == 1 and 0 <= jm.matches[0].overall <= 100, str(jm.matches))
check(
    "job match splits matched vs gap keywords (PLAN 9.1)",
    "Python" in jm.matches[0].top_matched
    and set(jm.matches[0].top_matched).isdisjoint(jm.matches[0].top_gaps)
    and len(jm.matches[0].top_matched) <= 6
    and len(jm.matches[0].top_gaps) <= 6,
    f"matched={jm.matches[0].top_matched} gaps={jm.matches[0].top_gaps}",
)

# 9c. Merged JD+fit (PLAN 12.1): analyze_and_score is ONE LLM call doing
# ANALYZE_JD's extraction + FIT_SCORE's fit — the parallel job search depends
# on it staying one call; language stays deterministic (never the LLM's claim).
from app.core.scorer import analyze_and_score  # noqa: E402
from app.llm.prompts import jd_fit_system  # noqa: E402

_jf_jd, _jf_score = analyze_and_score(resume, "We need a Python engineer with SQL and REST APIs.")
check(
    "JD_FIT: one call yields a JDModel with keywords + a Score with fit > 0",
    len(_jf_jd.keywords) > 0 and _jf_score.fit_score > 0 and len(_jf_score.gaps) > 0,
    f"kw={_jf_jd.keywords} fit={_jf_score.fit_score}",
)
check(
    "JD_FIT: overall combines coverage+fit exactly like score_resume",
    _jf_score.overall == round(0.5 * _jf_score.keyword_coverage + 0.5 * _jf_score.fit_score, 1),
    f"overall={_jf_score.overall} cov={_jf_score.keyword_coverage} fit={_jf_score.fit_score}",
)
check(
    "JD_FIT: language detected deterministically (hebrew regex, not the LLM)",
    _jf_jd.language == "en" and analyze_and_score(resume, "דרוש מהנדס פייתון")[0].language == "he",
)
check(
    "JD_FIT: Task tag stays inside the stub's 40-char routing window (hebrew note appended)",
    "JD_FIT" in jd_fit_system("he")[:40].upper(),
)

# 10. ATS scanner (deterministic checks + optional coverage)
ats = scan_resume(resume, "Python, SQL, REST APIs required.")
check("ats scan produced issues + score", len(ats.issues) > 0 and 0 <= ats.score <= 100, str(ats.score))

# 11. LinkedIn optimizer
li = optimize_linkedin(resume)
check("linkedin headline non-empty", len(li.headline) > 0)

# 12. Follow-up email
fu = write_follow_up("Acme", "Software Engineer", "after applying", "strong Python fit")
check("follow-up email has subject + body", len(fu.subject) > 0 and len(fu.body) > 0)
# Stage-aware: a thank-you still routes through the stub and the note keeps the Task tag first.
_thanks = write_follow_up("Acme", "Software Engineer", "after an interview", "great chat")
check("thank-you follow-up has subject + body", len(_thanks.subject) > 0 and len(_thanks.body) > 0)
check(
    "FOLLOW_UP stage note keeps Task tag first",
    _li_prompts.follow_up_system("after an interview").startswith("Task: FOLLOW_UP."),
)

# 12b. Outreach Studio (new LLM task): connection note + InMail + referral
from app.core.outreach import generate_outreach  # noqa: E402

_outreach = generate_outreach(
    resume, jd_text="Backend role: Python, REST APIs.", company="Acme", job_title="Backend Engineer"
)
check(
    "outreach produced all three messages",
    len(_outreach.connection_note) > 0
    and len(_outreach.inmail_body) > 0
    and len(_outreach.referral_message) > 0,
)
check("OUTREACH prompt Task tag still first", _li_prompts.OUTREACH_SYSTEM.startswith("Task: OUTREACH."))

# 12c. Screening-question answerer (new LLM task)
from app.core.screening import answer_screening_question  # noqa: E402

_screen = answer_screening_question(resume, "Python backend role.", "Why do you want this role?")
check("screening answer non-empty", len(_screen.answer) > 0)
check(
    "SCREENING_ANSWER prompt Task tag still first",
    _li_prompts.SCREENING_ANSWER_SYSTEM.startswith("Task: SCREENING_ANSWER."),
)

# 12d. Recruiter phone-screen prep (new LLM task)
from app.core.interview import recruiter_screen  # noqa: E402

_rec = recruiter_screen(resume, "Backend engineer role: Python, REST APIs.")
check(
    "recruiter screen has pitch + items + salary note",
    len(_rec.pitch) > 0 and len(_rec.items) > 0 and len(_rec.salary_note) > 0,
)
check(
    "RECRUITER_SCREEN prompt Task tag still first",
    _li_prompts.RECRUITER_SCREEN_SYSTEM.startswith("Task: RECRUITER_SCREEN."),
)

# 12d-2. Multi-turn mock interview (PLAN 11.3, two new LLM tasks): the chat
# turn returns the interviewer's next message; the scorecard evaluates the
# whole transcript. Stateless — the transcript rides in the request.
from app.core.interview import chat_turn as _mi_chat, session_scorecard as _mi_score  # noqa: E402
from app.models import ChatTurn as _ChatTurn  # noqa: E402

_mi_transcript = [
    _ChatTurn(role="interviewer", text="Tell me about yourself."),
    _ChatTurn(role="candidate", text="I'm a backend engineer working with Python and SQL."),
]
_mi_turn = _mi_chat(resume, "Backend engineer: Python, REST APIs.", _mi_transcript)
check(
    "mock interview turn returns a message + done flag",
    len(_mi_turn.message) > 0 and _mi_turn.done is False,
    _mi_turn.message[:60],
)
_mi_card = _mi_score(resume, "Backend engineer: Python, REST APIs.", _mi_transcript)
check(
    "mock interview scorecard has overall + summary + feedback",
    0 <= _mi_card.overall <= 100
    and len(_mi_card.summary) > 0
    and len(_mi_card.strengths) > 0
    and len(_mi_card.question_feedback) > 0,
    str(_mi_card.overall),
)
check(
    "INTERVIEW_CHAT / INTERVIEW_SCORECARD Task tags still first (hebrew note appended)",
    _li_prompts.INTERVIEW_CHAT_SYSTEM.startswith("Task: INTERVIEW_CHAT.")
    and _li_prompts.INTERVIEW_SCORECARD_SYSTEM.startswith("Task: INTERVIEW_SCORECARD.")
    and "INTERVIEW_CHAT" in _li_prompts.with_resume_language(
        _li_prompts.INTERVIEW_CHAT_SYSTEM, "he"
    )[:40].upper(),
)

# 12e. Company Research Brief (PLAN 11.1, new LLM task): grounded people +
# deterministic email extraction (LLM never guesses an address).
from app.core.company_brief import (  # noqa: E402
    build_company_brief,
    email_for_person,
    extract_emails,
    hiring_emails,
    linkedin_people_search,
)

_PAGE = (
    "About Example Inc. We build a data-pipeline platform. "
    "Founded by Dana Levi. Contact: dana.levi@example.com or careers@example.com."
)
_emails = extract_emails(_PAGE)
check("extract_emails finds only page-present addresses", _emails == ["dana.levi@example.com", "careers@example.com"], str(_emails))
check("hiring_emails keeps the hiring inbox only", hiring_emails(_emails) == ["careers@example.com"])
check("email_for_person matches by name in the local part", email_for_person("Dana Levi", _emails) == "dana.levi@example.com")
check("email_for_person never invents (no match ⇒ empty)", email_for_person("Yossi Cohen", _emails) == "")
check(
    "linkedin people-search link is a deterministic deep link",
    linkedin_people_search("Dana Levi", "Example Inc")
    == "https://www.linkedin.com/search/results/people/?keywords=Dana%20Levi%20Example%20Inc",
)
_brief = build_company_brief(resume, company="Example Inc", page_text=_PAGE, jd_text="Backend role.")
check(
    "company brief: overview + talking points + grounded",
    len(_brief.overview) > 0 and len(_brief.talking_points) > 0 and _brief.grounded,
)
check(
    "brief person carries the page email + a linkedin search link",
    len(_brief.people) > 0
    and _brief.people[0].name == "Dana Levi"
    and _brief.people[0].email == "dana.levi@example.com"
    and _brief.people[0].linkedin_search.startswith("https://www.linkedin.com/search/results/people/"),
)
check("brief surfaces the hiring inbox from the page", _brief.hiring_emails == ["careers@example.com"])
check(
    "brief reach-out message + subject non-empty",
    len(_brief.outreach_message) > 0 and len(_brief.outreach_subject) > 0,
)
try:
    build_company_brief(resume)
    check("brief with no grounding input raises", False)
except ValueError:
    check("brief with no grounding input raises", True)
check("COMPANY_BRIEF prompt Task tag still first", _li_prompts.COMPANY_BRIEF_SYSTEM.startswith("Task: COMPANY_BRIEF."))

# Role-aware hiring-chain links (PLAN 11.7): deterministic role→titles table +
# company-slug extraction; People-tab deep links when the page names the
# company's LinkedIn, people-search fallback otherwise. Never the LLM.
from app.core.company_brief import (  # noqa: E402
    hiring_chain_links,
    linkedin_company_slug,
    target_titles,
)

_t_ai = target_titles("AI Engineer")
check("ai role targets the AI chain + recruiter", "Head of AI" in _t_ai and _t_ai[-1] == "Recruiter", str(_t_ai))
check("hebrew role maps too (מדען נתונים ⇒ AI chain)", "Head of AI" in target_titles("מדען נתונים"))
check("sales role targets the sales chain", "VP Sales" in target_titles("Senior Account Executive"))
check("unknown/empty role falls back to founders + recruiter", target_titles("") == ["CEO", "Founder", "Recruiter"])
check(
    "substring guard: html engineer is NOT an ML role",
    "Head of AI" not in target_titles("html engineer") and "VP R&D" in target_titles("html engineer"),
    str(target_titles("html engineer")),
)
check(
    "company slug extracted from a page linkedin link",
    linkedin_company_slug("Follow us: https://www.linkedin.com/company/example-inc/about/") == "example-inc",
)
check("no linkedin link ⇒ no slug (never guessed from the name)", linkedin_company_slug(_PAGE) == "")
_chain = hiring_chain_links("AI Engineer", "Example Inc", "example-inc")
check(
    "chain links hit the company People tab when the slug is known",
    len(_chain) > 0
    and all(t.url.startswith("https://www.linkedin.com/company/example-inc/people/?keywords=") for t in _chain),
    _chain[0].url if _chain else "no links",
)
_chain_ns = hiring_chain_links("AI Engineer", "Example Inc", "")
check(
    "chain links fall back to people search without a slug",
    len(_chain_ns) > 0
    and all(t.url.startswith("https://www.linkedin.com/search/results/people/") for t in _chain_ns),
)
check("no slug and no company ⇒ no chain links (bare-title search is useless)", hiring_chain_links("AI Engineer", "", "") == [])
_brief2 = build_company_brief(
    resume,
    company="Example Inc",
    page_text=_PAGE + " Follow us at https://www.linkedin.com/company/example-inc/.",
    job_title="AI Engineer",
)
check(
    "brief carries role-aware targets + the company People-tab url",
    len(_brief2.targets) > 0 and _brief2.targets[0].title == "CTO"
    and _brief2.company_people_url == "https://www.linkedin.com/company/example-inc/people/",
    str([t.title for t in _brief2.targets]),
)

# 12f. Résumé health-check (PLAN 11.2): deterministic checks drive the score;
# the LLM only writes critique text.
from app.core.resume_health import (  # noqa: E402
    check_resume_health,
    deterministic_checks,
    health_score,
    parse_month,
)

_weak_resume = ResumeModel(
    summary="Results-driven professional.",
    skills=["Python"],
    experience=[
        Experience(
            company="Acme", title="Dev", start_date="Jan 2015", end_date="2018",
            bullets=[
                "Responsible for maintaining the internal reporting system and also handling "
                "assorted requests from several departments across the organization on a very "
                "regular recurring basis whenever they came up during the year"
            ],
        ),
        Experience(
            company="Beta", title="Dev", start_date="March 2020", end_date="Present",
            bullets=[
                "Worked on various tasks",
                "Helped the team with testing",
                "Helped with deployments",
                "Helped with code reviews",
            ],
        ),
    ],
)
_weak_checks = deterministic_checks(_weak_resume)


def _hc(checks, cid):
    return next((c for c in checks if c.id == cid), None)


check("weak openers flagged with verbatim examples", _hc(_weak_checks, "weak-openers").severity == "bad" and len(_hc(_weak_checks, "weak-openers").examples) > 0)
check("unquantified bullets flagged", _hc(_weak_checks, "quantified").severity == "bad" and _hc(_weak_checks, "quantified").count == 0)
check("buzzword bloat flagged (results-driven)", _hc(_weak_checks, "buzzwords").count == 1 and "results-driven" in _hc(_weak_checks, "buzzwords").examples)
check("over-long bullet flagged", _hc(_weak_checks, "long-bullets").count == 1)
check("employment gap 2018→2020 detected", _hc(_weak_checks, "gaps").severity == "warn" and "Acme" in _hc(_weak_checks, "gaps").examples[0])
check("repeated opening verb flagged (helped ×3)", "helped" in _hc(_weak_checks, "repeated-verbs").examples)

_strong_resume = ResumeModel(
    summary="Backend engineer building Python services.",
    skills=["Python", "SQL"],
    experience=[
        Experience(company="Acme", title="Engineer", start_date="Jan 2019", end_date="2020",
                   bullets=["Cut the nightly batch from 4h to 40min", "Built a REST API serving 2M requests/day"]),
        Experience(company="Beta", title="Engineer", start_date="January 2021", end_date="Present",
                   bullets=["Led a team of 3 engineers", "Shipped 12 releases with zero rollbacks"]),
    ],
)
_strong_checks = deterministic_checks(_strong_resume)
check(
    "year-only end date reads as December (2020→Jan 2021 is NOT a gap)",
    _hc(_strong_checks, "gaps").severity == "good",
    str(_hc(_strong_checks, "gaps").examples),
)
check(
    "strong resume outscores weak resume deterministically",
    health_score(_strong_checks) > health_score(_weak_checks),
    f"{health_score(_strong_checks)} vs {health_score(_weak_checks)}",
)
check("parse_month start defaults to January", parse_month("2021") % 12 == 0)
check("parse_month hebrew month + present handled", parse_month("מרץ 2020") % 12 == 2 and parse_month("היום") is not None)
_health = check_resume_health(_weak_resume)
check(
    "resume health result: score + checks + stub critique",
    _health.score == health_score(_weak_checks)
    and len(_health.checks) > 0
    and len(_health.strengths) > 0
    and len(_health.improvements) > 0
    and len(_health.rewrites) > 0,
)
check("RESUME_HEALTH prompt Task tag still first", _li_prompts.RESUME_HEALTH_SYSTEM.startswith("Task: RESUME_HEALTH."))

# 13. Job-link fetch helpers (pure, offline): LinkedIn id parsing + login-wall guard
from app.core.job_match import _linkedin_job_id, _looks_like_login_wall  # noqa: E402

check(
    "linkedin id parsed from /jobs/view/<id>",
    _linkedin_job_id("https://www.linkedin.com/jobs/view/4406118990") == "4406118990",
)
check(
    "linkedin id parsed from slug url",
    _linkedin_job_id("https://www.linkedin.com/jobs/view/software-engineer-at-notion-4406118990") == "4406118990",
)
check(
    "linkedin id parsed from currentJobId query",
    _linkedin_job_id("https://www.linkedin.com/jobs/search/?currentJobId=4406118990&keywords=x") == "4406118990",
)
check(
    "login-wall text is detected",
    _looks_like_login_wall("Join or sign in to find your next job. Email or phone. Password."),
)
check(
    "real jd text is not flagged as login wall",
    not _looks_like_login_wall("We are hiring a Python engineer to build REST APIs and CI/CD pipelines."),
)

# 14. LinkedIn job search helpers (pure, offline): card parser + url builder + context
from app.core.job_search import (  # noqa: E402
    _build_search_url,
    _fallback_context,
    derive_search_context,
    parse_search_results,
)
from app.models import JobMatch  # noqa: E402

_SEARCH_FIXTURE = """<ul><li>
  <a class="base-card__full-link" href="https://il.linkedin.com/jobs/view/backend-engineer-at-acme-4406118990?refId=abc&amp;trackingId=xyz">x</a>
  <img class="artdeco-entity-image artdeco-entity-image--square-4" data-delayed-url="https://media.licdn.com/dms/image/v2/AAA/company-logo_100_100/0?e=1&amp;v=beta" data-ghost-url="https://static.licdn.com/ghost.png" alt="">
  <h3 class="base-search-card__title"> Backend Engineer </h3>
  <h4 class="base-search-card__subtitle"><a class="hidden-nested-link">Acme Ltd</a></h4>
  <span class="job-search-card__location">Tel Aviv, Israel</span>
  <time class="job-search-card__listdate" datetime="2026-06-25">1 week ago</time>
</li><li>
  <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/9912345678">y</a>
  <h3 class="base-search-card__title">Data Engineer</h3>
  <h4 class="base-search-card__subtitle"><a>Beta Inc</a></h4>
  <span class="job-search-card__location">Haifa, Israel</span>
</li></ul>"""

cards = parse_search_results(_SEARCH_FIXTURE)
check("search parser found both cards", len(cards) == 2, str(len(cards)))
check(
    "search card fields extracted",
    cards[0]["title"] == "Backend Engineer"
    and cards[0]["company"] == "Acme Ltd"
    and cards[0]["location"] == "Tel Aviv, Israel",
    str(cards[0]) if cards else "",
)
check(
    "search card url stripped of tracking query",
    cards[0]["url"].endswith("backend-engineer-at-acme-4406118990"),
    cards[0]["url"] if cards else "",
)
check(
    "search card logo from lazy-loaded img (missing => empty)",
    cards[0]["logo"] == "https://media.licdn.com/dms/image/v2/AAA/company-logo_100_100/0?e=1&v=beta"
    and cards[1]["logo"] == "",
    str([c["logo"] for c in cards]),
)
check("empty html parses to empty card list", parse_search_results("<html></html>") == [])
check(
    "duplicate job ids deduped",
    len(parse_search_results(_SEARCH_FIXTURE + _SEARCH_FIXTURE)) == 2,
)

_u = _build_search_url("Backend Engineer", "Tel Aviv, Israel", "remote", 0)
check(
    "search url has keywords + location + f_WT",
    "keywords=Backend+Engineer" in _u and "location=Tel+Aviv%2C+Israel" in _u and "f_WT=2" in _u,
    _u,
)
check("search url requests newest-first (sortBy=DD)", "sortBy=DD" in _u, _u)
check(
    "posted date parsed from card <time> (missing => empty)",
    cards[0]["posted_at"] == "2026-06-25" and cards[1]["posted_at"] == "",
    str([c["posted_at"] for c in cards]),
)
check("work mode 'any' omits f_WT", "f_WT" not in _build_search_url("X", "Y", "any", 0))
_u_fresh = _build_search_url("X", "Y", "any", 0, max_age_days=30)
check(
    "max_age_days becomes LinkedIn's f_TPR seconds filter",
    "f_TPR=r2592000" in _u_fresh,
    _u_fresh,
)
check(
    "max_age_days 0 omits f_TPR (any age)",
    "f_TPR" not in _build_search_url("X", "Y", "any", 0, max_age_days=0),
)

_fb = _fallback_context(resume)  # stub resume: Engineer at Acme Corp
check("fallback context uses most recent title", _fb.job_title == "Engineer", _fb.job_title)
_ctx = derive_search_context(resume)  # routes through the SEARCH_CONTEXT stub branch
check("stub search context derived", _ctx.job_title != "", str(_ctx))
check(
    "JobMatch back-compat: url + posted_at default empty",
    JobMatch().url == "" and JobMatch().posted_at == "",
)
check("JobMatch back-compat: source defaults to linkedin", JobMatch().source == "linkedin")
check("JobMatch back-compat: logo_url defaults empty", JobMatch().logo_url == "")

# 14b. Provider registry + multi-source context resolution (pure, offline)
from app.core.job_search import (  # noqa: E402
    _interleave_and_dedupe,
    _resolve_context,
    freshest_first,
)
from app.core.providers import DEFAULT_SOURCES, PROVIDERS, JobHit  # noqa: E402
from app.core.scorer import score_resume  # noqa: E402
from app.models import SearchContext  # noqa: E402

check(
    "provider registry has linkedin + drushim + comeet + jobmaster + greenhouse (jooble retired)",
    {"linkedin", "drushim", "comeet", "jobmaster", "greenhouse"} <= set(PROVIDERS)
    and "jooble" not in PROVIDERS  # Jooble dropped Israel — retired 2026-07-05
    and set(DEFAULT_SOURCES) == set(PROVIDERS),
    str(sorted(PROVIDERS)),
)
_rc = _resolve_context(resume, SearchContext(sources=["drushim", "bogus-board"]))
check("unknown sources filtered out", _rc.sources == ["drushim"], str(_rc.sources))
_rc = _resolve_context(resume, SearchContext(sources=["bogus-board"]))
check("all-unknown sources fall back to defaults", _rc.sources == list(DEFAULT_SOURCES), str(_rc.sources))
check(
    "SearchContext back-compat: empty sources resolve to every board",
    SearchContext().sources == []
    and _resolve_context(resume, None).sources == list(DEFAULT_SOURCES),
)
check(
    "SearchContext defaults to a 30-day freshness window",
    SearchContext().max_age_days == 30 and _resolve_context(resume, None).max_age_days == 30,
)
check(
    "customized max_age_days is honored and clamped at 0",
    _resolve_context(resume, SearchContext(max_age_days=7)).max_age_days == 7
    and _resolve_context(resume, SearchContext(max_age_days=-3)).max_age_days == 0,
)

# Worldwide-remote opt-in (PLAN 13): extra high-earning-market locations on the
# global-reach board only; inert unless work_mode is "remote" or "any". The
# worldwide locations are always queried remote-only — with work mode "any" the
# local location keeps "any" while the worldwide pass forces "remote".
from app.core.job_search import (  # noqa: E402
    WORLDWIDE_BOARD,
    WORLDWIDE_REMOTE_LOCATIONS,
    _board_queries,
)

check(
    "SearchContext back-compat: include_worldwide defaults off",
    SearchContext().include_worldwide is False
    and _resolve_context(resume, None).include_worldwide is False,
)
_wctx = _resolve_context(
    resume,
    SearchContext(
        job_title="Dev", location="Tel Aviv", work_mode="remote", include_worldwide=True
    ),
)
check("customized include_worldwide is honored", _wctx.include_worldwide is True)
check(
    "worldwide remote: global board queried with local + worldwide locations",
    [(loc, mode) for _, loc, mode in _board_queries(WORLDWIDE_BOARD, _wctx)]
    == [("Tel Aviv", "remote")] + [(loc, "remote") for loc in WORLDWIDE_REMOTE_LOCATIONS],
    str(_board_queries(WORLDWIDE_BOARD, _wctx)),
)
check(
    "worldwide remote: local boards never see worldwide locations",
    [(loc, mode) for _, loc, mode in _board_queries("drushim", _wctx)]
    == [("Tel Aviv", "remote")],
    str(_board_queries("drushim", _wctx)),
)
_wctx_any = _resolve_context(
    resume,
    SearchContext(job_title="Dev", location="Tel Aviv", work_mode="any", include_worldwide=True),
)
check(
    "worldwide with 'any': local location stays 'any', worldwide forced remote-only",
    [(loc, mode) for _, loc, mode in _board_queries(WORLDWIDE_BOARD, _wctx_any)]
    == [("Tel Aviv", "any")] + [(loc, "remote") for loc in WORLDWIDE_REMOTE_LOCATIONS],
    str(_board_queries(WORLDWIDE_BOARD, _wctx_any)),
)
_wctx_onsite = _resolve_context(
    resume,
    SearchContext(
        job_title="Dev", location="Tel Aviv", work_mode="onsite", include_worldwide=True
    ),
)
check(
    "worldwide pass is inert for onsite work mode",
    [(loc, mode) for _, loc, mode in _board_queries(WORLDWIDE_BOARD, _wctx_onsite)]
    == [("Tel Aviv", "onsite")],
    str(_board_queries(WORLDWIDE_BOARD, _wctx_onsite)),
)
_wctx_only = _resolve_context(
    resume,
    SearchContext(
        job_title="Dev",
        location="Tel Aviv",
        work_mode="remote",
        include_worldwide=True,
        sources=["drushim"],
    ),
)
check(
    "worldwide-only pass (global board unchecked) skips the local location",
    [(loc, mode) for _, loc, mode in _board_queries(WORLDWIDE_BOARD, _wctx_only)]
    == [(loc, "remote") for loc in WORLDWIDE_REMOTE_LOCATIONS],
    str(_board_queries(WORLDWIDE_BOARD, _wctx_only)),
)
_rc = _resolve_context(
    resume,
    SearchContext(job_titles=["AI Engineer", " ai engineer ", "", "AI Automations"]),
)
check(
    "multi-keyword: titles stripped, deduped (case-insensitive), job_title mirrors first",
    _rc.job_titles == ["AI Engineer", "AI Automations"] and _rc.job_title == "AI Engineer",
    str(_rc.job_titles),
)
_rc = _resolve_context(resume, SearchContext(job_title="Solo Title"))
check(
    "multi-keyword back-compat: single job_title fills job_titles",
    _rc.job_titles == ["Solo Title"] and _rc.job_title == "Solo Title",
    str(_rc.job_titles),
)
_rc = _resolve_context(resume, None)
check(
    "multi-keyword back-compat: derived context gets a one-entry job_titles list",
    _rc.job_titles == [_rc.job_title] and _rc.job_title != "",
    str(_rc.job_titles),
)

from datetime import datetime as _dtc  # noqa: E402

_now = _dtc.fromisoformat("2026-07-05T12:00")
_fresh_hits = [
    JobHit(url="https://x/old", posted_at="2026-05-01"),  # 65 days old — dropped
    JobHit(url="https://x/undated", posted_at=""),  # unknown — kept, sorts last
    JobHit(url="https://x/week", posted_at="2026-06-28"),
    JobHit(url="https://x/today", posted_at="2026-07-05T09:30"),
]
_ff = freshest_first(_fresh_hits, 30, now=_now)
check(
    "freshest_first drops stale hits, sorts newest-first, keeps undated last",
    [h.url for h in _ff]
    == ["https://x/today", "https://x/week", "https://x/undated"],
    str([(h.url, h.posted_at) for h in _ff]),
)
check(
    "freshest_first with max_age_days=0 keeps everything (still newest-first)",
    len(freshest_first(_fresh_hits, 0, now=_now)) == 4,
)

_rr = _interleave_and_dedupe(
    {
        "linkedin": [JobHit(source="linkedin", url=f"https://li/{i}") for i in range(3)],
        "drushim": [
            JobHit(source="drushim", url="https://dr/0"),
            JobHit(source="drushim", url="https://li/0/"),  # same job, trailing slash
        ],
    },
    limit=10,
)
check(
    "fan-out interleaves sources round-robin",
    [h.url for h in _rr[:2]] == ["https://li/0", "https://dr/0"],
    str([h.url for h in _rr]),
)
check("fan-out dedupes across sources by url", len(_rr) == 4, str([h.url for h in _rr]))
_rr_q = _interleave_and_dedupe(
    {
        "jobmaster": [
            JobHit(source="jobmaster", url="https://jm/checknum.asp?key=1"),
            JobHit(source="jobmaster", url="https://jm/checknum.asp?key=2"),
        ],
    },
    limit=10,
)
check(
    "fan-out keeps urls that differ only by query (jobmaster keys)",
    len(_rr_q) == 2,
    str([h.url for h in _rr_q]),
)

# 14b-2. Cross-board duplicate detection (PLAN 15.1): same title+company on
# two boards merges into one hit carrying the other board's link; different
# titles or blank companies never merge; content_key normalization pinned.
from app.core.job_search import content_key  # noqa: E402

check(
    "content_key: legal suffixes + punctuation + case normalize away",
    content_key("Backend Engineer", "Acme Ltd") == content_key("backend engineer!", "ACME")
    and content_key("מהנדס תוכנה", 'חילן בע"מ') == content_key("מהנדס תוכנה", "חילן"),
)
check(
    "content_key: blank title or company means never-merge",
    content_key("", "Acme") == "" and content_key("Engineer", "") == "",
)
_dup = _interleave_and_dedupe(
    {
        "linkedin": [
            JobHit(source="linkedin", title="Backend Engineer", company="Acme Ltd", url="https://li/a"),
            JobHit(source="linkedin", title="Data Engineer", company="Acme", url="https://li/b"),
        ],
        "drushim": [
            JobHit(source="drushim", title="Backend Engineer!", company="ACME", url="https://dr/a"),
            JobHit(source="drushim", title="Backend Engineer", company="Other Co", url="https://dr/b"),
        ],
        "comeet": [
            JobHit(source="comeet", title="Backend Engineer", company="acme", url="https://cm/a"),
        ],
    },
    limit=10,
)
check(
    "cross-board duplicate merges into one hit with also_on links",
    len(_dup) == 3
    and _dup[0].url == "https://li/a"
    and [a["source"] for a in _dup[0].also_on] == ["drushim", "comeet"]
    and [a["url"] for a in _dup[0].also_on] == ["https://dr/a", "https://cm/a"],
    str([(h.url, h.also_on) for h in _dup]),
)
check(
    "different title/company at the same company never merge",
    {h.url for h in _dup} == {"https://li/a", "https://li/b", "https://dr/b"},
    str([h.url for h in _dup]),
)

# 14b-3. Salary intelligence v1 (PLAN 15.2): deterministic extraction of
# LITERAL salary mentions only — currency-adjacent figures, plausibility
# floor, hourly wages allowed, everything else ignored.
from app.core.salary import extract_salary as _sal  # noqa: E402

_s1 = _sal("דרוש מפתח. שכר 15,000-18,000 ₪ ברוטו לחודש. משרה מלאה.")
check(
    "salary: hebrew ILS range with month period",
    _s1 is not None and _s1.min == 15000 and _s1.max == 18000
    and _s1.currency == "ILS" and _s1.period == "month",
    str(_s1),
)
_s2 = _sal("Base compensation $120K–$150K per year plus equity.")
check(
    "salary: USD K-range with year period",
    _s2 is not None and _s2.min == 120000 and _s2.max == 150000
    and _s2.currency == "USD" and _s2.period == "year" and "$120K" in _s2.raw,
    str(_s2),
)
_s3 = _sal('שכר התחלתי 18K ש"ח')
check("salary: K suffix + gershayim shekel marker", _s3 is not None and _s3.max == 18000 and _s3.currency == "ILS", str(_s3))
_s4 = _sal("תשלום ₪60 לשעה, משמרות גמישות")
check("salary: hourly wage passes the small-figure gate", _s4 is not None and _s4.max == 60 and _s4.period == "hour", str(_s4))
check(
    "salary: numbers without currency, tiny perks, and empty text are ignored",
    _sal("Join a team of 15,000 people with 5 years experience") is None
    and _sal("You get a $5 gift card") is None
    and _sal("") is None,
)

# 14c. Drushim provider: response parser pinned against a trimmed real fixture
import json as _json  # noqa: E402
from pathlib import Path  # noqa: E402

from app.core.providers.drushim import parse_drushim_results  # noqa: E402

_DRUSHIM_FIXTURE = _json.loads(
    (Path(__file__).parent / "fixtures" / "drushim_search.json").read_text(encoding="utf-8")
)
_dr = parse_drushim_results(_DRUSHIM_FIXTURE)
check("drushim parser found all fixture jobs", len(_dr) == 3, str(len(_dr)))
check(
    "drushim fields extracted",
    _dr[0].title == "Data engineer"
    and _dr[0].company == "Mertens – Malam Team"
    and _dr[0].location == "לוד"
    and _dr[0].external_id == "37542502"
    and _dr[0].source == "drushim",
    f"{_dr[0].title} / {_dr[0].company}" if _dr else "",
)
check(
    "drushim url built from JobInfo.Link",
    _dr[0].url == "https://www.drushim.co.il/job/37542502/57157f6c/",
    _dr[0].url if _dr else "",
)
check("drushim posted_at is the ISO JobInfo.Date", _dr[0].posted_at.startswith("2026-06-28"))
check(
    "drushim description inlines Description + Requirements (html stripped)",
    "Data Engineer" in _dr[0].description
    and "ניסיון" in _dr[0].description
    and "<br" not in _dr[0].description,
)
check(
    "drushim company logo extracted; directory-stub links (trailing /) dropped",
    _dr[0].logo_url == "https://webapi.drushim.co.il/logos/2376295/page/638846445007377955.png"
    and _dr[1].logo_url == "",
    str([h.logo_url for h in _dr]),
)
check("drushim hebrew language detected", all(h.language == "he" for h in _dr))
check("drushim inline description means no detail fetch", all(h.description for h in _dr))
_expired = _json.loads(_json.dumps(_DRUSHIM_FIXTURE))
_expired["ResultList"][0]["JobInfo"]["IsExpired"] = True
check("drushim expired postings skipped", len(parse_drushim_results(_expired)) == 2)
_doubled = {"ResultList": _DRUSHIM_FIXTURE["ResultList"] * 2}
check("drushim duplicate JobCodes deduped", len(parse_drushim_results(_doubled)) == 3)
check("drushim empty response parses to empty list", parse_drushim_results({}) == [])

# 14d. Hebrew pipeline support: deterministic language detection, language-aware
# prompts (Task-tag routing intact), Hebrew keyword scoring that actually matches.
from app.core.lang import detect_language, resume_language  # noqa: E402
from app.llm import prompts as _prompts  # noqa: E402
from app.models import Contact, Experience  # noqa: E402

_he_text = _dr[0].description
_he_jd = analyze_jd(_he_text)  # stub routes on the Task tag regardless of JD language
check("hebrew jd language detected deterministically", _he_jd.language == "he", _he_jd.language)
check("english jd language stays en", analyze_jd("We need a Python engineer.").language == "en")
check(
    "detect_language handles final letters + mixed text",
    detect_language("מהנדס תוכנה ותיק") == "he" and detect_language("Senior C++ dev") == "en",
)

_he_jd.keywords = ["Python", "ניסיון ב-Spark", "AWS", "עיבוד נתונים"]
_he_score = score_resume(resume, _he_jd)
check("hebrew jd scores without crashing", 0 <= _he_score.overall <= 100, str(_he_score.overall))
check("hebrew keywords produce gap entries", len(_he_score.gaps) > 0)

# Hebrew keyword coverage must MATCH, not just not-crash: a Hebrew résumé
# containing a Hebrew JD keyword scores it covered; an absent one is missing.
_he_resume = ResumeModel(
    contact=Contact(name="דנה לוי", email="dana@example.com"),
    summary="מהנדסת נתונים עם ניסיון בעיבוד נתונים בענן.",
    skills=["Python", "עיבוד נתונים", "SQL"],
    experience=[Experience(company="חברת דוגמה", title="מהנדסת נתונים",
                           bullets=["בניית צינורות נתונים ב-Python"])],
)
_he_statuses = {
    g.keyword: g.status
    for g in score_resume(_he_resume, _he_jd).gaps
}
check(
    "hebrew keyword present in hebrew resume => covered",
    _he_statuses.get("עיבוד נתונים") == "covered" and _he_statuses.get("Python") == "covered",
    str(_he_statuses),
)
check(
    "hebrew keyword absent from resume => missing",
    _he_statuses.get("ניסיון ב-Spark") == "partial"  # "ניסיון" appears, Spark doesn't
    or _he_statuses.get("ניסיון ב-Spark") == "missing",
    str(_he_statuses.get("ניסיון ב-Spark")),
)
check("hebrew resume language detected", resume_language(_he_resume) == "he")
check("english resume language detected", resume_language(resume) == "en")

# Language notes are APPENDED — the Task tag must stay first for stub routing.
_tailored_sys = _prompts.with_resume_language(_prompts.TAILOR_SYSTEM, "he")
check(
    "language note keeps Task tag first",
    _tailored_sys.startswith(_prompts.TAILOR_SYSTEM[:40]) and "Hebrew" in _tailored_sys,
)
check(
    "english resume leaves prompts untouched",
    _prompts.with_resume_language(_prompts.TAILOR_SYSTEM, "en") == _prompts.TAILOR_SYSTEM,
)
_he_tailored = tailor_resume(_he_resume, _he_jd, ledger=None)  # stub roundtrip stays routed
check("hebrew resume tailors via stub without crashing", _he_tailored.tailored_resume is not None)

# 14e. Comeet provider: positions parser + filters + careers-page extraction,
# pinned against a trimmed real API response (pure, offline)
from app.core.providers.comeet import (  # noqa: E402
    _keyword_matches,
    _location_matches,
    extract_company_data,
    parse_careers_url,
    parse_comeet_positions,
)

_COMEET_FIXTURE = _json.loads(
    (Path(__file__).parent / "fixtures" / "comeet_positions.json").read_text(encoding="utf-8")
)
_cm = parse_comeet_positions(_COMEET_FIXTURE, company_name="Kaltura")
check("comeet parser found all fixture positions", len(_cm) == 3, str(len(_cm)))
check(
    "comeet fields extracted",
    _cm[0].title == "DevOps Engineer"
    and _cm[0].company == "Kaltura"
    and _cm[0].external_id == "1C.B6D"
    and _cm[0].location == "Bnei Brak, Israel"
    and _cm[0].source == "comeet",
    f"{_cm[0].title} / {_cm[0].company} / {_cm[0].location}" if _cm else "",
)
check(
    "comeet url is the hosted careers page",
    _cm[0].url == "https://www.comeet.com/jobs/kaltura/E2.00D/devops-engineer/1C.B6D",
    _cm[0].url if _cm else "",
)
check("comeet posted_at is the ISO time_updated", _cm[0].posted_at.startswith("2026-06-29"))
_pictured = _json.loads(_json.dumps(_COMEET_FIXTURE))
_pictured[0]["picture_url"] = "https://static.comeet.co/logos/kaltura.png"
check(
    "comeet picture_url maps to logo_url (null => empty)",
    _cm[0].logo_url == ""
    and parse_comeet_positions(_pictured)[0].logo_url == "https://static.comeet.co/logos/kaltura.png",
)
check(
    "comeet description inlines Description + Requirements (html stripped)",
    all(h.description and "<p>" not in h.description for h in _cm),
)
_internal = _json.loads(_json.dumps(_COMEET_FIXTURE))
_internal[0]["is_internal"] = True
check("comeet internal positions skipped", len(parse_comeet_positions(_internal)) == 2)
check("comeet duplicate uids deduped", len(parse_comeet_positions(_COMEET_FIXTURE * 2)) == 3)
check("comeet empty response parses to empty list", parse_comeet_positions([]) == [])

check(
    "comeet keyword filter matches on title words",
    _keyword_matches(_cm[0], "DevOps Engineer") and not _keyword_matches(_cm[0], "Underwater Welder"),
)
check(
    "comeet location filter: 'Israel' keeps IL office, drops London",
    _location_matches(_cm[0], "Israel") and not _location_matches(_cm[2], "Israel"),
)
check(
    "comeet location filter: hebrew city alias matches english office",
    _location_matches(_cm[0], "בני ברק"),
)
check(
    "comeet location filter: wrong city filtered out",
    not _location_matches(_cm[0], "Haifa"),
)

_careers_html = (
    '<script>window.COMPANY_DATA = {"name": "Kaltura", "location": "Israel", '
    '"company_uid": "E2.00D", "token": "2EDEA12ED017688C7147B1A555DA2ED"};</script>'
)
_cd = extract_company_data(_careers_html)
check(
    "comeet company data extracted from careers page html",
    _cd == {"name": "Kaltura", "uid": "E2.00D", "token": "2EDEA12ED017688C7147B1A555DA2ED"},
    str(_cd),
)
check("comeet company data tolerates missing markers", extract_company_data("<html></html>") == {"name": "", "uid": "", "token": ""})
check(
    "comeet careers url parsed to slug + uid",
    parse_careers_url("https://www.comeet.com/jobs/kaltura/E2.00D?coref=1.10") == ("kaltura", "E2.00D"),
)
try:
    parse_careers_url("https://example.com/jobs/nope")
    check("comeet bad careers url rejected", False)
except ValueError:
    check("comeet bad careers url rejected", True)

# 14e2. JobMaster provider: card + detail parsers pinned against trimmed real
# pages; Hebrew relative dates converted against a fixed clock (pure, offline)
from datetime import datetime as _dt  # noqa: E402

from app.core.providers.jobmaster import (  # noqa: E402
    _location_matches as _jm_location_matches,
    parse_hebrew_relative_date,
    parse_jobmaster_detail,
    parse_jobmaster_results,
)

_JM_HTML = (Path(__file__).parent / "fixtures" / "jobmaster_search.html").read_text(
    encoding="utf-8"
)
_JM_NOW = _dt(2026, 7, 5, 12, 0)
_jm = parse_jobmaster_results(_JM_HTML, now=_JM_NOW)
check("jobmaster parser found all fixture cards", len(_jm) == 3, str(len(_jm)))
check(
    "jobmaster fields extracted",
    _jm[1].title == "RT Embedded Engineer"
    and _jm[1].company == "B-net ייעוץ והשמה"
    and _jm[1].location == "הרצליה, תל אביב יפו"
    and _jm[1].external_id == "9801062"
    and _jm[1].source == "jobmaster",
    f"{_jm[1].title} / {_jm[1].company} / {_jm[1].location}" if len(_jm) > 1 else "",
)
check(
    "jobmaster url is the checknum detail page",
    _jm[1].url == "https://www.jobmaster.co.il/jobs/checknum.asp?key=9801062",
    _jm[1].url if len(_jm) > 1 else "",
)
check(
    "jobmaster promoted (Mekudam) card kept with its key",
    _jm[0].external_id == "9798924"
    and _jm[0].raw["promoted"] is True
    and "יאוסופט" in _jm[0].company,  # ByTitle span, not CompanyNameLink
    f"{_jm[0].external_id} / {_jm[0].company}" if _jm else "",
)
check(
    "jobmaster relative posted date converted to ISO (missing => empty)",
    _jm[1].posted_at == "2026-07-04" and _jm[0].posted_at == "",
    str([h.posted_at for h in _jm]),
)
check(
    "jobmaster cards are scrape-style: empty description + snippet in raw",
    all(h.description == "" for h in _jm)
    and "C++ Embedded Linux" in _jm[1].raw["snippet"],
)
check(
    "jobmaster language detected per card (hebrew + english mix)",
    _jm[0].language == "he" and _jm[1].language == "en" and _jm[2].language == "he",
    str([h.language for h in _jm]),
)
check("jobmaster duplicate keys deduped", len(parse_jobmaster_results(_JM_HTML * 2, now=_JM_NOW)) == 3)
check("jobmaster empty html parses to empty card list", parse_jobmaster_results("", now=_JM_NOW) == [])

check(
    "jobmaster hebrew relative dates: hours keep the time component",
    parse_hebrew_relative_date("לפני 8 שעות", _JM_NOW) == "2026-07-05T04:00",
    parse_hebrew_relative_date("לפני 8 שעות", _JM_NOW),
)
check(
    "jobmaster hebrew relative dates: days/weeks/yesterday/today",
    parse_hebrew_relative_date("לפני 3 ימים", _JM_NOW) == "2026-07-02"
    and parse_hebrew_relative_date("אתמול", _JM_NOW) == "2026-07-04"
    and parse_hebrew_relative_date("היום", _JM_NOW) == "2026-07-05"
    and parse_hebrew_relative_date("לפני שבועיים", _JM_NOW) == "2026-06-21",
)
check(
    "jobmaster hebrew relative dates: dual forms + unrecognized => empty",
    parse_hebrew_relative_date("לפני שעתיים", _JM_NOW) == "2026-07-05T10:00"
    and parse_hebrew_relative_date("garbage", _JM_NOW) == "",
)

_JM_DETAIL = (Path(__file__).parent / "fixtures" / "jobmaster_detail.html").read_text(
    encoding="utf-8"
)
_jm_text = parse_jobmaster_detail(_JM_DETAIL)
check(
    "jobmaster detail page inlines Description + Requirements (html stripped)",
    "RT Embedded Engineer" in _jm_text and "Yocto" in _jm_text and "<br" not in _jm_text,
    _jm_text[:80],
)
check("jobmaster detail without content divs parses to empty", parse_jobmaster_detail("<html></html>") == "")

check(
    "jobmaster location filter: city match + country token ignored + wrong city dropped",
    _jm_location_matches(_jm[1], "תל אביב")
    and _jm_location_matches(_jm[1], "Israel")
    and not _jm_location_matches(_jm[1], "באר שבע")
    and _jm_location_matches(JobHit(location=""), "חיפה"),  # no data => kept
)

# 14e3. Jooble provider: RETIRED from the fan-out 2026-07-05 — Jooble
# discontinued its Israeli index (il.jooble.org dead, global API is US-only).
# The module stays parser-tested so re-registering is a one-line change if
# Jooble ever brings Israel back; the parser stays pinned against the official
# docs' example response.
from app.config import get_settings as _get_settings  # noqa: E402
from app.core.providers.jooble import JoobleProvider, parse_jooble_results  # noqa: E402

_JOOBLE_FIXTURE = _json.loads(
    (Path(__file__).parent / "fixtures" / "jooble_search.json").read_text(encoding="utf-8")
)
_jb = parse_jooble_results(_JOOBLE_FIXTURE)
check("jooble parser found the docs-example job", len(_jb) == 1, str(len(_jb)))
check(
    "jooble fields extracted",
    _jb[0].title == "Sales Manager"
    and _jb[0].company == "ABC Corp"
    and _jb[0].location == "Kyiv"
    and _jb[0].external_id == "1234567890"
    and _jb[0].source == "jooble",
    f"{_jb[0].title} / {_jb[0].company}" if _jb else "",
)
check("jooble url is the posting link", _jb[0].url == "https://ua.jooble.org/jdp/12345")
check(
    "jooble updated trimmed to plain ISO seconds",
    _jb[0].posted_at == "2023-09-15T12:55:35",
    _jb[0].posted_at if _jb else "",
)
check(
    "jooble snippets stay out of description (needs fetch) but land in raw",
    _jb[0].description == ""
    and _jb[0].raw["snippet_text"].startswith("This is a great opportunity"),
)
check(
    "jooble duplicate ids deduped",
    len(parse_jooble_results({"jobs": _JOOBLE_FIXTURE["jobs"] * 2})) == 1,
)
check("jooble empty response parses to empty list", parse_jooble_results({}) == [])
_jb_he = _json.loads(_json.dumps(_JOOBLE_FIXTURE))
_jb_he["jobs"][0]["title"] = "מנהל מכירות"
check(
    "jooble language detected (hebrew title => he, docs example => en)",
    parse_jooble_results(_jb_he)[0].language == "he" and _jb[0].language == "en",
)

_jb_settings = _get_settings()
_jb_saved_key = _jb_settings.jooble_api_key
_jb_settings.jooble_api_key = ""
try:
    JoobleProvider().search(SearchContext(job_title="Engineer"))
    check("jooble missing api key raises a clear ValueError", False)
except ValueError as _e:
    check(
        "jooble missing api key raises a clear ValueError",
        "JOOBLE_API_KEY" in str(_e),
        str(_e),
    )
finally:
    _jb_settings.jooble_api_key = _jb_saved_key
check("jooble retired from the fan-out (israel index discontinued)", "jooble" not in PROVIDERS)

# 14e4. Greenhouse provider (PLAN 9.3): jobs parser + board-ref parser + filters,
# pinned against a trimmed real boards-API response (pure, offline). Lever was
# probed the same day (60+ Israeli-company slugs, API verified working via
# known-good tenants) and found ZERO Israeli tenants — so there is no Lever
# provider, by evidence rather than omission.
from app.core.providers.greenhouse import (  # noqa: E402
    _keyword_matches as _gh_kw,
    _location_matches as _gh_loc,
    parse_board_ref,
    parse_greenhouse_jobs,
)

_GH_FIXTURE = _json.loads(
    (Path(__file__).parent / "fixtures" / "greenhouse_jobs.json").read_text(encoding="utf-8")
)
_gh = parse_greenhouse_jobs(_GH_FIXTURE, company_name="Fallback Co")
check("greenhouse parser dedupes by job id (fixture has a duplicate)", len(_gh) == 3, str(len(_gh)))
check(
    "greenhouse fields extracted (title stripped, company from payload, location)",
    _gh[0].title == "Data Scientist"
    and _gh[0].company == "Melio"
    and _gh[0].location == "Tel Aviv"
    and _gh[0].source == "greenhouse"
    and _gh[0].external_id == "7748138003"
    and _gh[0].url.startswith("https://job-boards.greenhouse.io/melio/jobs/"),
    f"{_gh[0].title} / {_gh[0].company} / {_gh[0].location}" if _gh else "",
)
check(
    "greenhouse content is unescaped then tag-stripped (inline description)",
    _gh[0].description.startswith("As a Data Scientist at Melio")
    and "&lt;" not in _gh[0].description
    and "<p>" not in _gh[0].description,
    _gh[0].description[:80] if _gh else "",
)
check(
    "greenhouse posted_at from updated_at, language detected en",
    _gh[0].posted_at.startswith("2026-") and _gh[0].language == "en",
    _gh[0].posted_at if _gh else "",
)
check("greenhouse empty payload parses to empty list", parse_greenhouse_jobs({}) == [])
check(
    "greenhouse board-ref parser: slug, board URLs, and API URLs all resolve",
    parse_board_ref("WizInc") == "wizinc"
    and parse_board_ref("https://job-boards.greenhouse.io/melio/jobs/123") == "melio"
    and parse_board_ref("https://boards.greenhouse.io/jfrog") == "jfrog"
    and parse_board_ref("https://boards-api.greenhouse.io/v1/boards/via/jobs") == "via",
)
try:
    parse_board_ref("https://example.com/not-greenhouse")
    check("greenhouse board-ref parser rejects non-greenhouse urls", False)
except ValueError:
    check("greenhouse board-ref parser rejects non-greenhouse urls", True)
check(
    "greenhouse keyword filter matches title/departments/description, all-tokens",
    _gh_kw(_gh[0], "data scientist")
    and _gh_kw(_gh[0], "Engineering")  # departments
    and not _gh_kw(_gh[0], "customer success manager"),
)
check(
    "greenhouse location filter: hebrew alias + country token + miss",
    _gh_loc(_gh[0], "תל אביב")
    and _gh_loc(_gh[0], "Israel")  # via offices[].location
    and not _gh_loc(_gh[0], "New York")
    and _gh_loc(_gh[2], "New York"),
)
check("greenhouse registered in the fan-out", "greenhouse" in PROVIDERS and "greenhouse" in DEFAULT_SOURCES)

# 14f. Israeli résumé conventions (3.4) + Hebrew/RTL rendering (3.3)
import io as _io  # noqa: E402
import zipfile as _zipfile  # noqa: E402

import pdfplumber as _pdfplumber  # noqa: E402
from bidi.algorithm import get_display as _get_display  # noqa: E402

from app.models import LanguageSkill, MilitaryService  # noqa: E402


def _docx_xml(b: bytes) -> str:
    with _zipfile.ZipFile(_io.BytesIO(b)) as z:
        return z.read("word/document.xml").decode("utf-8")


def _pdf_text(b: bytes) -> str:
    with _pdfplumber.open(_io.BytesIO(b)) as pdf:
        return "\n".join(p.extract_text() or "" for p in pdf.pages)


# Structuring extracts the new sections (stub returns them; real prompt asks for them).
check(
    "structure_resume returns military_service + languages",
    len(resume.military_service) == 1
    and resume.military_service[0].unit == "8200"
    and len(resume.languages) == 2,
    f"{len(resume.military_service)} military / {len(resume.languages)} languages",
)
check("STRUCTURE prompt asks for military_service + languages",
      "military_service" in _prompts.STRUCTURE_RESUME_SYSTEM and '"languages"' in _prompts.STRUCTURE_RESUME_SYSTEM)
check("STRUCTURE prompt Task tag still first", _prompts.STRUCTURE_RESUME_SYSTEM.startswith("Task: STRUCTURE_RESUME."))

# Military unit/role/rank/dates are protected facts in the ledger...
_ml = build_facts_ledger(resume)
check(
    "ledger captures military unit/role/rank",
    {"8200", "Intelligence Analyst", "Sergeant"} <= set(_ml.military),
    str(_ml.military),
)
check("ledger captures military dates", {"2015", "2018"} <= set(_ml.dates), str(_ml.dates))

# ...and the guard flags invented military claims.
_fake_mil = result.tailored_resume.model_copy(deep=True)
_fake_mil.military_service.append(MilitaryService(unit="Sayeret Matkal", role="Team Commander", rank="Colonel"))
_mil_flags = [f.value for f in check_fabrication(_fake_mil, _ml) if f.category == "military"]
check(
    "guard flags fabricated military unit/role/rank",
    {"Sayeret Matkal", "Team Commander", "Colonel"} <= set(_mil_flags),
    str(_mil_flags),
)
check(
    "honest military service raises no flags",
    [f for f in check_fabrication(result.tailored_resume, _ml) if f.category == "military"] == [],
)

# Tailor prompt: one-page guidance + military untouchable, Task tag intact.
check("TAILOR prompt protects military service", "MILITARY SERVICE IS UNTOUCHABLE" in _prompts.TAILOR_SYSTEM)
check("TAILOR prompt has one-page guidance", "ONE PAGE" in _prompts.TAILOR_SYSTEM)
check("TAILOR prompt Task tag still first", _prompts.TAILOR_SYSTEM.startswith("Task: TAILOR."))

# Cover letter "Israeli mode": Hebrew JD => 3-5 sentence email body, not a letter.
_il_cover = _prompts.cover_letter_system("he", "he")
check("israeli cover mode asks for an email body", "EMAIL BODY" in _il_cover and "3-5" in _il_cover)
check("israeli cover mode keeps hebrew-output note", "Hebrew" in _il_cover)
check("english cover letter prompt unchanged", _prompts.cover_letter_system("en", "en") == _prompts.COVER_LETTER_SYSTEM)

# English rendering: new sections render, and NO RTL properties (pins the
# English path unchanged — bidi/rtl must never leak into English output).
_en_docx = render_docx(result.tailored_resume)
_en_xml = _docx_xml(_en_docx)
check("english docx renders military + languages sections",
      "MILITARY SERVICE" in _en_xml and "LANGUAGES" in _en_xml)
check("english docx has no RTL properties", "w:bidi" not in _en_xml and "w:rtl" not in _en_xml)
_en_pdf_text = _pdf_text(render_pdf(result.tailored_resume))
check("english pdf renders military + languages sections",
      "MILITARY SERVICE" in _en_pdf_text and "Hebrew" in _en_pdf_text and "8200" in _en_pdf_text)

# Hebrew/RTL rendering (3.3): full Hebrew resume incl. military + languages.
_he_full = _he_resume.model_copy(deep=True)
_he_full.military_service = [MilitaryService(
    unit="8200", role="מנתחת מודיעין", rank="סמלת",
    start_date="2015", end_date="2018", bullets=["ניתוח נתונים ב-Python"],
)]
_he_full.languages = [LanguageSkill(language="עברית", level="שפת אם"),
                      LanguageSkill(language="English", level="fluent")]

_he_docx = render_docx(_he_full)
check("hebrew docx renders (zip/PK header)", _he_docx[:2] == b"PK", f"{len(_he_docx)} bytes")
_he_xml = _docx_xml(_he_docx)
check("hebrew docx paragraphs carry w:bidi", "<w:bidi" in _he_xml)
check("hebrew docx runs carry w:rtl", "<w:rtl" in _he_xml)
check("hebrew docx uses hebrew section headings",
      "שירות צבאי" in _he_xml and "שפות" in _he_xml and "ניסיון תעסוקתי" in _he_xml)

_he_pdf = render_pdf(_he_full)
check("hebrew pdf renders (%PDF header)", _he_pdf[:4] == b"%PDF", f"{len(_he_pdf)} bytes")
_he_pdf_text = _pdf_text(_he_pdf)
# Extraction reads glyphs left-to-right, so correctly-rendered Hebrew comes out
# in VISUAL order (= get_display of the logical text). Logical order in the
# extract would mean the PDF displays reversed.
check(
    "hebrew pdf headings laid out in visual order (bidi applied)",
    _get_display("שפות", base_dir="R") in _he_pdf_text
    and _get_display("שירות צבאי", base_dir="R") in _he_pdf_text,
)
check("hebrew pdf keeps latin terms intact (mixed bidi)", "Python" in _he_pdf_text and "English" in _he_pdf_text)
check("hebrew pdf embeds a hebrew-capable font", b"NotoSansHebrew" in _he_pdf)

# 15. DB layer (temp SQLite): migration shim + job-search history + tracker fields
from app.db.database import SessionLocal, engine, init_db  # noqa: E402
from app.db.history import list_search_hits, record_search_hits  # noqa: E402
from app.db.models import Application  # noqa: E402

# Simulate a pre-existing DB whose applications table predates job_url/interviewed,
# so init_db()'s ADD-COLUMN shim has real work to do (create_all won't touch it).
# saved_resumes likewise predates `language` — and holds a HEBREW résumé the shim
# will mis-stamp "en", so the lazy healing in routes has real work to do too.
with engine.connect() as _conn:
    _conn.exec_driver_sql(
        "CREATE TABLE applications ("
        "id INTEGER PRIMARY KEY, job_title VARCHAR(255), company VARCHAR(255), "
        "jd_text TEXT, tailored_resume_json TEXT, cover_letter TEXT, "
        "overall_score FLOAT, status VARCHAR(50), notes TEXT, created_at DATETIME)"
    )
    _conn.exec_driver_sql(
        "CREATE TABLE saved_resumes ("
        "id INTEGER PRIMARY KEY, label VARCHAR(255), resume_json TEXT, "
        "ledger_json TEXT, updated_at DATETIME)"
    )
    _conn.exec_driver_sql(
        "INSERT INTO saved_resumes (label, resume_json, ledger_json, updated_at) "
        "VALUES (?, ?, '', '2026-01-01 00:00:00')",
        ("Legacy hebrew master", _he_resume.model_dump_json()),
    )
    _conn.commit()

init_db()
init_db()  # idempotent — create_all + shim must tolerate re-runs
check("init_db runs twice without error", True)

# PLAN 7: init_db created the admin user (invite code = APP_ACCESS_CODE) and
# backfilled the pre-multi-user rows above to it. All direct-DB checks below
# act as the admin.
from app.db.users import ensure_admin  # noqa: E402

_boot_db = SessionLocal()
_admin_user = ensure_admin(_boot_db)
_admin_id = _admin_user.id
check(
    "admin user auto-created with APP_ACCESS_CODE as invite code",
    _admin_user.is_admin is True and _admin_user.invite_code == "smoke-gate-code",
)
_legacy_sr_uid = _boot_db.execute(
    __import__("sqlalchemy").text("SELECT user_id FROM saved_resumes")
).scalar()
check("legacy rows backfilled to the admin user", _legacy_sr_uid == _admin_id, str(_legacy_sr_uid))
_boot_db.close()

with engine.connect() as _conn:
    _cols = {r[1] for r in _conn.exec_driver_sql("PRAGMA table_info(applications)").fetchall()}
    _sr_cols = {r[1] for r in _conn.exec_driver_sql("PRAGMA table_info(saved_resumes)").fetchall()}
check(
    "migration shim added job_url + interviewed + excitement",
    {"job_url", "interviewed", "excitement"} <= _cols,
    str(sorted(_cols)),
)
check("migration shim added language to saved_resumes", "language" in _sr_cols, str(sorted(_sr_cols)))

_db = SessionLocal()
_admin_user = ensure_admin(_db)  # session-bound instance for direct route calls
record_search_hits(_db, [
    JobMatch(title="Backend Engineer", company="Acme", overall=50.0, url="https://x/jobs/1", posted_at="2026-06-25"),
    JobMatch(title="Data Engineer", company="Beta", overall=60.0, url="https://x/jobs/2", source="drushim",
             logo_url="https://webapi.drushim.co.il/logos/1/page/logo.png"),
], _admin_id)
check(
    "history persists posted_at",
    {h.url: h.posted_at for h in list_search_hits(_db, _admin_id)}.get("https://x/jobs/1") == "2026-06-25",
)
check(
    "history persists logo_url (default empty)",
    {h.url: h.logo_url for h in list_search_hits(_db, _admin_id)}
    == {"https://x/jobs/1": "", "https://x/jobs/2": "https://webapi.drushim.co.il/logos/1/page/logo.png"},
    str({h.url: h.logo_url for h in list_search_hits(_db, _admin_id)}),
)
check(
    "history persists source (default + drushim)",
    {h.url: h.source for h in list_search_hits(_db, _admin_id)}
    == {"https://x/jobs/1": "linkedin", "https://x/jobs/2": "drushim"},
    str({h.url: h.source for h in list_search_hits(_db, _admin_id)}),
)
check("search history recorded 2 hits", len(list_search_hits(_db, _admin_id)) == 2, str(len(list_search_hits(_db, _admin_id))))

from app.models import AlsoOn as _AlsoOn  # noqa: E402

record_search_hits(_db, [JobMatch(title="Backend Engineer", company="Acme", overall=75.0, url="https://x/jobs/1",
                                  also_on=[_AlsoOn(source="drushim", url="https://dr/1")])], _admin_id)
_hits = list_search_hits(_db, _admin_id)
_by_url = {h.url: h for h in _hits}
check("re-record upserts by url (still 2 rows)", len(_hits) == 2, str(len(_hits)))
check("re-record refreshed the score", _by_url["https://x/jobs/1"].overall == 75.0, str(_by_url["https://x/jobs/1"].overall))
check(
    "also_on links round-trip through history (PLAN 15.1)",
    _by_url["https://x/jobs/1"].also_on_json == '[{"source": "drushim", "url": "https://dr/1"}]',
    _by_url["https://x/jobs/1"].also_on_json,
)

# Hebrew must survive the DB round-trip byte-identical (UTF-8 through SQLite).
_he_title = "מהנדס/ת נתונים — תל אביב"
_he_jd_text = "דרישות: ניסיון ב-Python ו-SQL, עבודה בענן (AWS)."
record_search_hits(_db, [JobMatch(title=_he_title, company="חברת דוגמה", overall=70.0,
                                  url="https://x/jobs/he-1", jd_text=_he_jd_text, source="drushim")], _admin_id)
_he_row = {h.url: h for h in list_search_hits(_db, _admin_id)}["https://x/jobs/he-1"]
check(
    "hebrew survives db round-trip byte-identical",
    _he_row.title == _he_title and _he_row.company == "חברת דוגמה" and _he_row.jd_text == _he_jd_text,
    _he_row.title,
)

record_search_hits(_db, [JobMatch(title=f"Role {i}", url=f"https://bulk/{i}") for i in range(105)], _admin_id)
_hits = list_search_hits(_db, _admin_id)
_urls = {h.url for h in _hits}
check("history capped at 100 rows", len(_hits) == 100, str(len(_hits)))
check(
    "earliest-inserted urls trimmed first",
    "https://x/jobs/1" not in _urls and "https://bulk/0" not in _urls and "https://bulk/104" in _urls,
)

_app_row = Application(
    user_id=_admin_id,
    job_title="Backend Engineer", company="Acme", job_url="https://x/jobs/1", interviewed=True, excitement=4
)
_db.add(_app_row)
_db.commit()
_db.refresh(_app_row)
_read = _db.get(Application, _app_row.id)
check(
    "application persists job_url + interviewed + excitement",
    _read is not None and _read.job_url == "https://x/jobs/1" and _read.interviewed is True and _read.excitement == 4,
)

# History <-> tracker status join: match by LinkedIn job id across URL shapes,
# exact URL otherwise, empty for never-applied jobs.
from app.db.history import application_statuses  # noqa: E402

_db.add(Application(user_id=_admin_id, job_title="X", status="applied", job_url="https://www.linkedin.com/jobs/view/9912345678?tracking=1"))
_db.add(Application(user_id=_admin_id, job_title="Y", status="offer", job_url="https://x/jobs/1"))
_db.commit()
_statuses = application_statuses(
    _db,
    ["https://il.linkedin.com/jobs/view/data-engineer-at-beta-9912345678", "https://x/jobs/1", "https://never/applied"],
    _admin_id,
)
check(
    "app status joined by linkedin id + exact url",
    _statuses.get("https://il.linkedin.com/jobs/view/data-engineer-at-beta-9912345678") == "applied"
    and _statuses.get("https://x/jobs/1") == "offer"
    and _statuses.get("https://never/applied") == "",
    str(_statuses),
)

# 15b. Paired he/en master résumés: one row per detected language, upsert not
# duplicate, legacy rows healed to their real language on first read (PLAN 3.4)
from app.api.routes import get_master_resume, list_master_resumes, save_master_resume  # noqa: E402
from app.models import MasterResumeIn  # noqa: E402

# The legacy row created above (pre-`language` table, Hebrew content) was
# stamped "en" by the shim — the first read must heal it to "he".
_legacy = get_master_resume(lang="he", db=_db, user=_admin_user)
check(
    "legacy master healed to its real language on read",
    _legacy is not None and _legacy.language == "he" and _legacy.label == "Legacy hebrew master",
)

_saved_en = save_master_resume(MasterResumeIn(resume=resume, label="EN master"), db=_db, user=_admin_user)
check("saving an english master lands in the en slot", _saved_en.language == "en")
_saved_he = save_master_resume(MasterResumeIn(resume=_he_resume, label="HE master"), db=_db, user=_admin_user)
_pair = list_master_resumes(db=_db, user=_admin_user).resumes
check(
    "hebrew master upserts the healed he slot — paired, not duplicated",
    _saved_he.language == "he" and len(_pair) == 2 and {m.language for m in _pair} == {"en", "he"},
    str([(m.language, m.label) for m in _pair]),
)
save_master_resume(MasterResumeIn(resume=resume, label="EN master v2"), db=_db, user=_admin_user)
_pair = list_master_resumes(db=_db, user=_admin_user).resumes
check(
    "re-saving english updates in place (still one row per language)",
    len(_pair) == 2 and any(m.label == "EN master v2" for m in _pair),
    str([(m.language, m.label) for m in _pair]),
)
_he_master = get_master_resume(lang="he", db=_db, user=_admin_user)
_en_master = get_master_resume(lang="en", db=_db, user=_admin_user)
check(
    "get by lang returns the matching master",
    _he_master is not None and _he_master.label == "HE master"
    and _en_master is not None and _en_master.label == "EN master v2",
)
check(
    "hebrew master round-trips its resume intact",
    _he_master is not None and _he_master.resume.contact.name == _he_resume.contact.name,
)
_default_master = get_master_resume(db=_db, user=_admin_user)
check(
    "default master (no lang) is the most recently updated",
    _default_master is not None and _default_master.label == "EN master v2",
    _default_master.label if _default_master else "None",
)
check("get by lang misses cleanly", get_master_resume(lang="fr", db=_db, user=_admin_user) is None)

# 15c. Job alerts (PLAN 6): settings row, history diffing, email body, and the
# full run loop with a canned search function (no network, no LLM, no SMTP)
from app.core.alerts import (  # noqa: E402
    build_alert_email,
    build_alert_email_html,
    get_alert,
    run_alert,
    split_new_matches,
    update_alert,
)
from app.models import JobSearchResult, SearchContext as _AlertCtx  # noqa: E402

_al = get_alert(_db, _admin_id)
check("alert settings row auto-creates (disabled, no email)", _al.enabled is False and _al.email == "")
update_alert(_db, _admin_id, enabled=True, email="me@example.com", context=_AlertCtx(job_title="Backend Engineer", location="Tel Aviv"))
_al = get_alert(_db, _admin_id)
check(
    "alert settings persist (single row)",
    _al.enabled is True and _al.email == "me@example.com" and "Backend Engineer" in _al.context_json,
)

# Put a known URL (back) in history — the 105-row cap test above trimmed it —
# so the diff has one seen and one unseen job to split.
record_search_hits(_db, [JobMatch(title="Backend Engineer", company="Acme", overall=75.0, url="https://x/jobs/1")], _admin_id)
_alert_matches = [
    JobMatch(title="Backend Engineer", company="Acme", overall=75.0, url="https://x/jobs/1"),
    JobMatch(title="Platform Engineer", company="Nova", overall=82.0, url="https://alerts/new-1", source="drushim"),
]
_new = split_new_matches(_db, _alert_matches, _admin_id)
check("alert diff finds only never-seen urls", [m.url for m in _new] == ["https://alerts/new-1"], str([m.url for m in _new]))

_subj, _body = build_alert_email(_new, _AlertCtx(job_title="Backend Engineer", location="Tel Aviv"))
check(
    "alert email names the search and lists the job with url + fit",
    "1 new job" in _subj and "Backend Engineer" in _subj and "Tel Aviv" in _subj
    and "Platform Engineer" in _body and "https://alerts/new-1" in _body and "82%" in _body,
    _subj,
)
_subj_he, _body_he = build_alert_email(
    [JobMatch(title="מהנדס/ת תוכנה", company="חברת דוגמה", overall=70.0, url="https://alerts/he-1")],
    _AlertCtx(job_title="מהנדס תוכנה", location="תל אביב"),
)
check("alert email is hebrew-safe", "מהנדס/ת תוכנה" in _body_he and "תל אביב" in _subj_he)

# HTML alternative: dark-theme card layout, escaped, dir="auto" for Hebrew,
# manage-link only when an app url is configured
_html = build_alert_email_html(_new, _AlertCtx(job_title="Backend Engineer", location="Tel Aviv"))
check(
    "alert html lists the job with link, fit pill, source badge",
    "Platform Engineer" in _html and 'href="https://alerts/new-1"' in _html
    and "82% fit" in _html and "Drushim" in _html and "1 new job" in _html,
)
check("alert html omits manage link without APP_BASE_URL", "Manage alerts" not in _html)
check(
    "alert html adds manage link from APP_BASE_URL",
    'href="https://app.example/jobs"' in build_alert_email_html(_new, _AlertCtx(job_title="X"), app_url="https://app.example/"),
)
_html_evil = build_alert_email_html(
    [JobMatch(title='<script>alert("x")</script>', company="A&B", overall=50.0, url="https://alerts/e-1")],
    _AlertCtx(job_title="Backend <b>Engineer</b>"),
)
check(
    "alert html escapes job fields and search context",
    "<script>" not in _html_evil and "&lt;script&gt;" in _html_evil
    and "A&amp;B" in _html_evil and "<b>Engineer</b>" not in _html_evil,
)
_html_he = build_alert_email_html(
    [JobMatch(title="מהנדס/ת תוכנה", company="חברת דוגמה", overall=70.0, url="https://alerts/he-1")],
    _AlertCtx(job_title="מהנדס תוכנה", location="תל אביב"),
)
check(
    "alert html is hebrew-safe with dir=auto",
    "מהנדס/ת תוכנה" in _html_he and 'dir="auto"' in _html_he,
)


def _canned_search(resume, ctx, cache=None):  # noqa: ANN001 - matches search_jobs' shape
    return JobSearchResult(
        context=_AlertCtx(job_title="Backend Engineer", location="Tel Aviv"),
        matches=_alert_matches,
        skipped=0,
    )


_run = run_alert(_db, _admin_id, search_fn=_canned_search)
check(
    "alert run: 2 found, 1 new, not emailed (smtp unconfigured), no error",
    _run.ran is True and _run.total == 2 and _run.new_count == 1
    and _run.emailed is False and _run.error == "",
    str(_run),
)
_al = get_alert(_db, _admin_id)
check("alert run bookkeeping persisted", _al.last_new_count == 1 and _al.last_run_at is not None and _al.last_error == "")
_run2 = run_alert(_db, _admin_id, search_fn=_canned_search)
check("alert re-run: nothing new (hits now in history)", _run2.new_count == 0, str(_run2))

# The saved customized SearchContext must be forwarded verbatim into the
# search — the alerts-card Customize panel relies on this; a cleared context
# must arrive as None ("derive from the résumé").
_seen_ctx: list = []


def _recording_search(resume, ctx, cache=None):  # noqa: ANN001 - matches search_jobs' shape
    _seen_ctx.append(ctx)
    return JobSearchResult(context=_AlertCtx(job_title="X"), matches=[], skipped=0)


run_alert(_db, _admin_id, force=True, search_fn=_recording_search)
check(
    "alert run forwards the saved customized context to the search",
    len(_seen_ctx) == 1 and _seen_ctx[0] is not None
    and _seen_ctx[0].job_title == "Backend Engineer" and _seen_ctx[0].location == "Tel Aviv",
    str(_seen_ctx[0]) if _seen_ctx else "no call",
)

update_alert(_db, _admin_id, enabled=False, email="me@example.com", context=None)
run_alert(_db, _admin_id, force=True, search_fn=_recording_search)
check(
    "alert run forwards None when the customized context is cleared",
    len(_seen_ctx) == 2 and _seen_ctx[1] is None,
)
check("alert run respects the toggle", run_alert(_db, _admin_id, search_fn=_canned_search).ran is False)
check("alert run with force ignores the toggle", run_alert(_db, _admin_id, force=True, search_fn=_canned_search).ran is True)


def _broken_search(resume, ctx, cache=None):  # noqa: ANN001
    raise ValueError("boards are down")


_run_err = run_alert(_db, _admin_id, force=True, search_fn=_broken_search)
check(
    "alert run reports search failure instead of raising",
    _run_err.ran is True and "boards are down" in _run_err.error
    and "boards are down" in get_alert(_db, _admin_id).last_error,
)

# 16. Comeet company registry: auto-seed, token persistence, careers-URL upsert
from app.core.providers.comeet_seed import SEED_COMPANIES  # noqa: E402
from app.db.comeet import list_companies, save_tokens, upsert_company  # noqa: E402

_companies = list_companies(_db)
check(
    "comeet registry auto-seeds israeli tech companies",
    len(_companies) == len(SEED_COMPANIES) >= 25,
    str(len(_companies)),
)
check(
    "comeet registry seeds carry slug/uid/careers_url but no token yet",
    all(c.slug and c.uid and c.careers_url and c.token == "" for c in _companies),
)
check("comeet registry seeding is idempotent", len(list_companies(_db)) == len(_companies))

save_tokens(_db, {"kaltura": "TESTTOKEN123"})
_by_slug = {c.slug: c for c in list_companies(_db)}
check("comeet token persisted by slug", _by_slug["kaltura"].token == "TESTTOKEN123")

_added = upsert_company(
    _db, slug="acme", name="Acme", uid="AA.001", token="T1",
    careers_url="https://www.comeet.com/jobs/acme/AA.001",
)
check("comeet add-company inserts a new row", _added.slug == "acme" and len(list_companies(_db)) == len(_companies) + 1)
_re_added = upsert_company(
    _db, slug="acme", name="Acme Corp", uid="AA.001", token="T2",
    careers_url="https://www.comeet.com/jobs/acme/AA.001",
)
check(
    "comeet re-adding a company refreshes instead of duplicating",
    _re_added.token == "T2"
    and _re_added.name == "Acme Corp"
    and len(list_companies(_db)) == len(_companies) + 1,
)
_db.close()

# 16b. Greenhouse company registry (PLAN 9.3): auto-seed on first list, upsert
# refreshes instead of duplicating. Same pattern as Comeet, no tokens at all.
from app.core.providers.greenhouse_seed import SEED_COMPANIES as _GH_SEED  # noqa: E402
from app.db.greenhouse import (  # noqa: E402
    list_companies as gh_list_companies,
    upsert_company as gh_upsert_company,
)

_db = SessionLocal()
_gh_companies = gh_list_companies(_db)
check(
    "greenhouse registry auto-seeds live-verified israeli companies",
    len(_gh_companies) == len(_GH_SEED) >= 15,
    str(len(_gh_companies)),
)
check("greenhouse registry seeding is idempotent", len(gh_list_companies(_db)) == len(_gh_companies))
gh_upsert_company(_db, slug="acme-gh", name="Acme")
_gh_re = gh_upsert_company(_db, slug="acme-gh", name="Acme Corp")
check(
    "greenhouse re-adding a company refreshes instead of duplicating",
    _gh_re.name == "Acme Corp" and len(gh_list_companies(_db)) == len(_gh_companies) + 1,
)
_db.close()

# 17. Free public CV-vs-JD scan (PLAN 6): deterministic keyword extraction,
# coverage via the scorer, Hebrew prefix rescue, rate limiter, and the
# HTTP-level gate exemption. Zero LLM calls on this path by construction.
from app.core.free_scan import (  # noqa: E402
    RateLimiter,
    extract_jd_keywords,
    free_scan,
)

_fs_en_kws = extract_jd_keywords(
    "We need a Senior Python Developer. Python, Django and REST APIs are required. "
    "Experience with Docker and Kubernetes is an advantage."
)
_fs_en_lower = [k.lower() for k in _fs_en_kws]
check(
    "free scan extracts english tech keywords, drops boilerplate",
    "python" in _fs_en_lower and "django" in _fs_en_lower and "docker" in _fs_en_lower
    and "experience" not in _fs_en_lower and "required" not in _fs_en_lower
    and "advantage" not in _fs_en_lower and "with" not in _fs_en_lower,
    str(_fs_en_kws),
)
check(
    "free scan ranks the repeated keyword first",
    _fs_en_lower and _fs_en_lower[0] == "python",
    str(_fs_en_kws[:3]),
)
_fs_he_kws = extract_jd_keywords(
    "דרוש/ה מפתח/ת פייתון. ניסיון בפייתון — חובה. ידע ב-SQL ו-Docker יתרון. עבודת צוות."
)
_fs_he_lower = [k.lower() for k in _fs_he_kws]
check(
    "free scan extracts hebrew keywords, drops hebrew boilerplate",
    "פייתון" in _fs_he_lower and "sql" in _fs_he_lower and "docker" in _fs_he_lower
    and "ניסיון" not in _fs_he_lower and "חובה" not in _fs_he_lower and "יתרון" not in _fs_he_lower,
    str(_fs_he_kws),
)
_fs_bigram_kws = extract_jd_keywords(
    "Machine learning engineer. Machine learning models in production. Python required."
)
check(
    "free scan promotes repeated bigrams over their parts",
    any(k.lower() == "machine learning" for k in _fs_bigram_kws)
    and "machine" not in [k.lower() for k in _fs_bigram_kws],
    str(_fs_bigram_kws),
)

_fs_res = free_scan(
    "רותם כהן · rotem@example.com · 054-1234567\n"
    "מהנדסת תוכנה עם ניסיון בפייתון ו-SQL. הובלתי 3 פרויקטים, שיפור של 40%.",
    "דרוש/ה מפתח/ת פייתון פייתון. ידע ב-SQL חובה. Docker יתרון.",
)
_fs_status = {g.keyword.lower(): g.status for g in _fs_res.keywords}
check(
    "free scan coverage: hebrew CV covers פייתון+sql, misses docker",
    _fs_status.get("פייתון") == "covered" and _fs_status.get("sql") == "covered"
    and _fs_status.get("docker") == "missing",
    str(_fs_status),
)
check(
    "free scan detects languages deterministically",
    _fs_res.jd_language == "he" and _fs_res.resume_language == "he",
)
check(
    "free scan raw-text checks: email+phone+numbers good on this CV",
    {c.id: c.severity for c in _fs_res.checks}.get("email") == "good"
    and {c.id: c.severity for c in _fs_res.checks}.get("phone") == "good"
    and {c.id: c.severity for c in _fs_res.checks}.get("numbers") == "good",
    str([(c.id, c.severity) for c in _fs_res.checks]),
)

# Prefix rescue: JD only has the glued form "בפייתון"; CV has bare "פייתון".
_fs_rescue = free_scan("שולטת פייתון ברמה גבוהה", "נדרשת שליטה בפייתון. בפייתון נעשה הכל.")
_fs_rescue_status = {g.keyword: g.status for g in _fs_rescue.keywords}
check(
    "free scan rescues prefix-glued hebrew keyword as partial (not covered)",
    _fs_rescue_status.get("בפייתון") == "partial",
    str(_fs_rescue_status),
)

_rl = RateLimiter(max_requests=3, window_seconds=60)
check(
    "rate limiter allows up to the cap then blocks",
    all(_rl.allow("1.2.3.4", now=t) for t in (0.0, 1.0, 2.0))
    and not _rl.allow("1.2.3.4", now=3.0)
    and _rl.allow("5.6.7.8", now=3.0),  # other keys unaffected
)
check("rate limiter window slides", _rl.allow("1.2.3.4", now=61.0))

# HTTP: with APP_ACCESS_CODE set (top of file), /public/scan must work with
# no X-App-Key while a gated route 401s.
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app as _fastapi_app  # noqa: E402

with TestClient(_fastapi_app) as _tc:
    _scan_resp = _tc.post(
        "/public/scan",
        files={"file": ("resume.txt", "Dana Levi\ndana@example.com\nPython, SQL".encode("utf-8"), "text/plain")},
        data={"jd_text": "Python developer. Python and SQL required. Docker an advantage."},
    )
    check(
        "public scan endpoint bypasses the access gate and scores",
        _scan_resp.status_code == 200 and 0 < _scan_resp.json()["coverage"] <= 100,
        f"{_scan_resp.status_code} {_scan_resp.text[:120]}",
    )
    check(
        "public scan rejects an empty JD",
        _tc.post(
            "/public/scan",
            files={"file": ("resume.txt", b"text", "text/plain")},
            data={"jd_text": " "},
        ).status_code == 400,
    )
    _gated = _tc.post("/jd/analyze", json={"jd_text": "Python developer"})
    check("gated routes still 401 without the access code", _gated.status_code == 401, str(_gated.status_code))

# 18. Résumé templates (PLAN 6): every template × format × language renders,
# stays ATS-safe (no tables/text-boxes/images/headers/footers in the DOCX
# XML), and the content survives re-extraction — which is what an ATS
# actually does. This is the executable proof behind "every template passes
# our own ATS scan".
from app.render.templates import DEFAULT_TEMPLATE, TEMPLATES, get_template  # noqa: E402

check(
    "template registry: 3 templates, default present",
    len(TEMPLATES) == 3 and DEFAULT_TEMPLATE in TEMPLATES,
    str(list(TEMPLATES)),
)
check(
    "unknown/empty template names fall back to the default (old clients unaffected)",
    get_template("no-such-template").id == DEFAULT_TEMPLATE and get_template(None).id == DEFAULT_TEMPLATE,
)

_ATS_FORBIDDEN = ("<w:tbl", "<w:pict", "graphicData", "headerReference", "footerReference", "txbxContent")
for _tpl in TEMPLATES:
    # English DOCX: ATS-safe XML + facts survive our own extractor.
    _tpl_docx = render_docx(resume, template=_tpl)
    _tpl_xml = _docx_xml(_tpl_docx)
    check(
        f"docx[{_tpl}] en: renders, single column, no tables/images/headers",
        _tpl_docx[:2] == b"PK" and not any(tok in _tpl_xml for tok in _ATS_FORBIDDEN),
    )
    _tpl_txt = _li_extract_text("resume.docx", _tpl_docx)
    check(
        f"docx[{_tpl}] en: name/company/bullet/skill survive extraction",
        resume.contact.name in _tpl_txt
        and resume.experience[0].company in _tpl_txt
        and resume.experience[0].bullets[0] in _tpl_txt
        and resume.skills[0] in _tpl_txt,
    )

    # English PDF: real selectable text.
    _tpl_pdf = render_pdf(resume, template=_tpl)
    _tpl_pdf_txt = _pdf_text(_tpl_pdf)
    check(
        f"pdf[{_tpl}] en: renders and text extracts",
        _tpl_pdf[:4] == b"%PDF"
        and resume.contact.name in _tpl_pdf_txt
        and resume.experience[0].company in _tpl_pdf_txt
        and resume.skills[0] in _tpl_pdf_txt,
    )

    # Hebrew DOCX: RTL props + Hebrew headings + text intact in every template.
    _tpl_he_docx = render_docx(_he_full, template=_tpl)
    _tpl_he_xml = _docx_xml(_tpl_he_docx)
    check(
        f"docx[{_tpl}] he: RTL props + hebrew headings + ATS-safe",
        "<w:bidi" in _tpl_he_xml
        and "<w:rtl" in _tpl_he_xml
        and "שירות צבאי" in _tpl_he_xml
        and not any(tok in _tpl_he_xml for tok in _ATS_FORBIDDEN),
    )
    check(
        f"docx[{_tpl}] he: hebrew content survives extraction",
        _he_full.contact.name in _li_extract_text("resume.docx", _tpl_he_docx),
    )

    # Hebrew PDF: bidi-correct (extraction reads VISUAL order), Latin intact.
    _tpl_he_pdf = render_pdf(_he_full, template=_tpl)
    _tpl_he_pdf_txt = _pdf_text(_tpl_he_pdf)
    check(
        f"pdf[{_tpl}] he: renders, visual-order hebrew + latin intact",
        _tpl_he_pdf[:4] == b"%PDF"
        and _get_display(_he_full.contact.name, base_dir="R") in _tpl_he_pdf_txt
        and "Python" in _tpl_he_pdf_txt,
    )

# 19. Friends beta (PLAN 7): invite-code auth, per-user isolation, admin
# mint/revoke, daily caps, feedback, delete-my-data — all through the HTTP
# stack (gate middleware included), then per-user alerts at the function level.
_ADMIN_H = {"X-App-Key": "smoke-gate-code"}
with TestClient(_fastapi_app) as _tc:
    # Gate → user resolution
    check(
        "admin invite code (APP_ACCESS_CODE) still opens the gate",
        _tc.get("/applications", headers=_ADMIN_H).status_code == 200,
    )
    check(
        "unknown invite code 401s",
        _tc.get("/applications", headers={"X-App-Key": "not-a-code"}).status_code == 401,
    )

    # Cron endpoint with nothing enabled: 0 users, no network touched.
    _cron = _tc.get("/jobs/alerts/cron")
    check(
        "cron endpoint iterates enabled alerts (none yet)",
        _cron.status_code == 200 and _cron.json() == {"users": 0, "results": []},
        _cron.text[:100],
    )

    # Mint a friend
    _mint = _tc.post(
        "/admin/users", json={"name": "Noa", "email": "noa@example.com"}, headers=_ADMIN_H
    )
    check(
        "admin mints a friend invite code",
        _mint.status_code == 200 and len(_mint.json()["invite_code"]) >= 8,
        _mint.text[:120],
    )
    _friend_id = _mint.json()["id"]
    _FRIEND_H = {"X-App-Key": _mint.json()["invite_code"]}
    _admin_row_id = next(
        u["id"] for u in _tc.get("/admin/users", headers=_ADMIN_H).json()["users"] if u["is_admin"]
    )
    check("friend code opens the gate", _tc.get("/applications", headers=_FRIEND_H).status_code == 200)
    check(
        "friend can't reach admin endpoints (403)",
        _tc.get("/admin/users", headers=_FRIEND_H).status_code == 403
        and _tc.post("/admin/users", json={"name": "Eve"}, headers=_FRIEND_H).status_code == 403,
    )

    # Isolation: admin has masters/applications/history from section 15;
    # the friend must see none of it.
    check("friend sees no master résumé", _tc.get("/profile/resume", headers=_FRIEND_H).json() is None)
    check("friend tracker is empty", _tc.get("/applications", headers=_FRIEND_H).json() == [])
    check("friend history is empty", _tc.get("/jobs/history", headers=_FRIEND_H).json()["hits"] == [])
    _admin_apps = _tc.get("/applications", headers=_ADMIN_H).json()
    check("admin still sees own tracker rows", len(_admin_apps) >= 3, str(len(_admin_apps)))

    # Friend writes their own data; the admin's view is unchanged.
    _resume_json = resume.model_dump()
    check(
        "friend saves their own master résumé",
        _tc.put(
            "/profile/resume", json={"resume": _resume_json, "label": "Noa CV"}, headers=_FRIEND_H
        ).status_code == 200,
    )
    check(
        "friend saves their own application",
        _tc.post(
            "/applications", json={"job_title": "QA", "company": "FriendCo"}, headers=_FRIEND_H
        ).status_code == 200,
    )
    check(
        "cross-user isolation: admin can't see the friend's rows",
        all(a["company"] != "FriendCo" for a in _tc.get("/applications", headers=_ADMIN_H).json())
        and all(
            m["label"] != "Noa CV"
            for m in _tc.get("/profile/resumes", headers=_ADMIN_H).json()["resumes"]
        ),
    )
    check(
        "friend can't read the admin's application by id (404)",
        _tc.get(f"/applications/{_admin_apps[0]['id']}", headers=_FRIEND_H).status_code == 404,
    )

    # Stale-application nudges (Home reminder): an "applied" app with no status
    # change for STALE_APPLICATION_DAYS (7) days surfaces; a fresh one does not.
    from datetime import datetime as _dt, timedelta as _td, timezone as _tz  # noqa: E402

    _fresh_app = _tc.post(
        "/applications",
        json={"job_title": "Fresh", "company": "FreshCo", "status": "applied"},
        headers=_ADMIN_H,
    ).json()
    _stale_app = _tc.post(
        "/applications",
        json={"job_title": "Stale", "company": "StaleCo", "status": "applied"},
        headers=_ADMIN_H,
    ).json()
    _nudge_db = SessionLocal()
    _stale_row = _nudge_db.get(Application, _stale_app["id"])
    _stale_row.status_changed_at = _dt.now(_tz.utc) - _td(days=10)
    _nudge_db.commit()
    _nudge_db.close()
    _nudges = _tc.get("/applications/nudges", headers=_ADMIN_H).json()["items"]
    check(
        "stale applied app surfaces as a nudge with days_stale >= 7",
        any(n["id"] == _stale_app["id"] and n["days_stale"] >= 7 for n in _nudges),
        str(_nudges)[:200],
    )
    check(
        "fresh applied app is not a nudge",
        all(n["id"] != _fresh_app["id"] for n in _nudges),
    )

    # Daily caps (DAILY_TAILOR_CAP=2 at the top of this file; stub LLM = offline).
    _tailor_body = {"resume": _resume_json, "jd": {"job_title": "Backend Engineer"}}
    _t1 = _tc.post("/tailor", json=_tailor_body, headers=_FRIEND_H)
    _t2 = _tc.post("/tailor", json=_tailor_body, headers=_FRIEND_H)
    _t3 = _tc.post("/tailor", json=_tailor_body, headers=_FRIEND_H)
    check("friend can tailor up to the daily cap", _t1.status_code == 200 and _t2.status_code == 200)
    check(
        "over the cap → 429 with structured daily_limit detail",
        _t3.status_code == 429
        and _t3.json()["detail"] == {"code": "daily_limit", "action": "tailor", "cap": 2},
        _t3.text[:120],
    )
    check(
        "admin is exempt from daily caps",
        all(
            _tc.post("/tailor", json=_tailor_body, headers=_ADMIN_H).status_code == 200
            for _ in range(3)
        ),
    )

    # Feedback (PLAN 7.0)
    check(
        "feedback rejects empty text",
        _tc.post("/feedback", json={"page": "/jobs", "text": "  "}, headers=_FRIEND_H).status_code == 400,
    )
    check(
        "friend sends feedback (hebrew-safe)",
        _tc.post(
            "/feedback", json={"page": "/jobs", "text": "האתר מעולה אבל החיפוש איטי"}, headers=_FRIEND_H
        ).status_code == 200,
    )
    _fb = _tc.get("/admin/feedback", headers=_ADMIN_H)
    check(
        "admin reads feedback with the sender's name",
        _fb.status_code == 200
        and any(
            f["text"] == "האתר מעולה אבל החיפוש איטי" and f["user_name"] == "Noa" and f["page"] == "/jobs"
            for f in _fb.json()["feedback"]
        ),
        _fb.text[:150],
    )
    check("feedback list is admin-only", _tc.get("/admin/feedback", headers=_FRIEND_H).status_code == 403)

    # Delete-my-data (PLAN 7.5): friend leaves cleanly, admin data untouched.
    _del = _tc.request("DELETE", "/profile/data", headers=_FRIEND_H)
    check(
        "delete-my-data wipes the friend's rows (résumé, app, usage, feedback)",
        _del.status_code == 200
        and _del.json()["resumes"] == 1
        and _del.json()["applications"] == 1
        and _del.json()["usage"] == 1
        and _del.json()["feedback"] == 1,
        _del.text[:200],
    )
    check(
        "after wipe: friend empty, admin intact",
        _tc.get("/profile/resume", headers=_FRIEND_H).json() is None
        and _tc.get("/applications", headers=_FRIEND_H).json() == []
        and len(_tc.get("/applications", headers=_ADMIN_H).json()) >= 3,
    )

    # Revoke (deactivate): the code stops working; admins can't be deactivated.
    check(
        "admin account can't be deactivated",
        _tc.patch(
            f"/admin/users/{_admin_row_id}", json={"is_active": False}, headers=_ADMIN_H
        ).status_code == 400,
    )
    check(
        "deactivating the friend revokes their code",
        _tc.patch(
            f"/admin/users/{_friend_id}", json={"is_active": False}, headers=_ADMIN_H
        ).status_code == 200
        and _tc.get("/applications", headers=_FRIEND_H).status_code == 401,
    )

# 19b. Per-user alerts (PLAN 7.3): the cron loop runs every enabled user's
# alert against their OWN master résumé and history.
from app.core.alerts import run_all_alerts  # noqa: E402
from app.db.models import SavedResume as _SR  # noqa: E402
from app.db.users import mint_user  # noqa: E402

_db3 = SessionLocal()
_dana = mint_user(_db3, "Dana")
_db3.add(_SR(user_id=_dana.id, language="en", resume_json=resume.model_dump_json()))
_db3.commit()
update_alert(_db3, _admin_id, enabled=True, email="admin@example.com",
             context=_AlertCtx(job_title="Backend Engineer"))
update_alert(_db3, _dana.id, enabled=True, email="dana@example.com",
             context=_AlertCtx(job_title="Backend Engineer"))
_cron_results = run_all_alerts(_db3, search_fn=_canned_search)
check("cron loop runs every enabled user's alert", len(_cron_results) == 2, str(len(_cron_results)))
check(
    "per-user diff: admin saw these urls before, dana never did",
    _cron_results[0].new_count == 0 and _cron_results[1].new_count == 2,
    str([(r.new_count, r.error) for r in _cron_results]),
)
check(
    "dana's run recorded into dana's own history",
    len(list_search_hits(_db3, _dana.id)) == 2
    and all(h.user_id == _dana.id for h in list_search_hits(_db3, _dana.id)),
)
update_alert(_db3, _admin_id, enabled=False, email="admin@example.com", context=None)
update_alert(_db3, _dana.id, enabled=False, email="dana@example.com", context=None)
_db3.close()

# 19c. Stale-nudge emails (PLAN 11.4): opt-in filter, once-per-stale-period
# watermark, re-arm after a status change, retry after a send failure — all
# offline via injected send_fn + fixed clock, then the cron endpoint's shape.
from datetime import timedelta as _td, timezone as _tz  # noqa: E402

from app.core.nudges import build_nudge_email, build_nudge_email_html, run_all_nudges  # noqa: E402
from app.models import StaleApplication as _StaleApp  # noqa: E402

_db4 = SessionLocal()
_noga = mint_user(_db4, "Noga")
_omer = mint_user(_db4, "Omer")
# Noga + Omer opt in (alerts toggle stays OFF — nudges are independent);
# Dana/admin keep nudge_emails False, so the loop must skip them.
update_alert(_db4, _noga.id, enabled=False, email="noga@example.com", context=None, nudge_emails=True)
update_alert(_db4, _omer.id, enabled=False, email="omer@example.com", context=None, nudge_emails=True)
_T0 = _dt.now(_tz.utc)
_noga_app = Application(
    user_id=_noga.id, job_title="Backend Dev", company="Acme", jd_text="x",
    status="applied", status_changed_at=_T0 - _td(days=10),
)
_omer_app = Application(
    user_id=_omer.id, job_title="Data Eng", company="מפעל", jd_text="x",
    status="applied", status_changed_at=_T0 - _td(days=10),
)
_db4.add_all([_noga_app, _omer_app])
_db4.commit()

_sent: list[tuple] = []
def _capture_send(to, subject, body, html=""):  # noqa: ANN001
    _sent.append((to, subject, body, html))
def _boom_send(to, subject, body, html=""):  # noqa: ANN001
    raise RuntimeError("smtp down")

_run1 = run_all_nudges(_db4, send_fn=_capture_send, now=_T0 - _td(days=2))
check(
    "nudges: only opted-in users run; each stale app emailed",
    len(_run1) == 2 and all(r.emailed and r.new_stale == 1 for r in _run1) and len(_sent) == 2,
    str([(r.new_stale, r.emailed, r.error) for r in _run1]),
)
check(
    "nudge email: subject + hebrew company + tracker link, all present",
    "waiting on a follow-up" in _sent[0][1]
    and "מפעל" in _sent[1][2]
    and "Acme" in _sent[0][3] and 'dir="auto"' in _sent[0][3],
)
_run2 = run_all_nudges(_db4, send_fn=_capture_send, now=_T0 - _td(days=2) + _td(hours=1))
check(
    "nudges: second run doesn't re-nag (still stale, nothing newly stale)",
    all(r.stale == 1 and r.new_stale == 0 and not r.emailed for r in _run2) and len(_sent) == 2,
    str([(r.stale, r.new_stale) for r in _run2]),
)
# Re-arm: Noga's app changes status, then goes quiet again — new stale period.
_noga_app.status = "interview"
_db4.commit()
_noga_app.status = "applied"
_noga_app.status_changed_at = _T0 - _td(days=8)  # crossed the 7d line at T0-1d > last nudge
_db4.commit()
_run3 = run_all_nudges(_db4, send_fn=_capture_send, now=_T0)
check(
    "nudges: a later quiet period re-arms the email",
    _run3[0].emailed and _run3[0].new_stale == 1 and not _run3[1].emailed and len(_sent) == 3,
    str([(r.new_stale, r.emailed) for r in _run3]),
)
# Failure keeps the watermark: Omer's app re-arms, the send blows up, the next
# run (working SMTP) retries it. Failures never raise out of the loop.
_omer_app.status = "rejected"
_db4.commit()
_omer_app.status = "applied"
# Crosses the 7d line at T0+30min — after Omer's watermark (T0, stamped by
# run3's quiet advance) and before run4's clock (T0+1h).
_omer_app.status_changed_at = _T0 - _td(days=7) + _td(minutes=30)
_db4.commit()
_run4 = run_all_nudges(_db4, send_fn=_boom_send, now=_T0 + _td(hours=1))
check(
    "nudges: send failure is captured, not raised",
    _run4[1].new_stale == 1 and not _run4[1].emailed and "smtp down" in _run4[1].error,
    str([(r.new_stale, r.error) for r in _run4]),
)
_run5 = run_all_nudges(_db4, send_fn=_capture_send, now=_T0 + _td(hours=2))
check(
    "nudges: failed send is retried on the next run (watermark not advanced)",
    _run5[1].emailed and _run5[1].new_stale == 1 and len(_sent) == 4,
    str([(r.new_stale, r.emailed) for r in _run5]),
)
# Pure builders: escaping + no-app-url fallback.
_nudge_items = [
    _StaleApp(id=1, job_title="Eng <b>Lead</b>", company="A&B", days_stale=9, job_url="")
]
check(
    "nudge html escapes + text falls back without app url",
    "Eng &lt;b&gt;Lead&lt;/b&gt;" in build_nudge_email_html(_nudge_items)
    and "Tracker page" in build_nudge_email(_nudge_items)[1],
)
update_alert(_db4, _noga.id, enabled=False, email="noga@example.com", context=None, nudge_emails=False)
update_alert(_db4, _omer.id, enabled=False, email="omer@example.com", context=None, nudge_emails=False)
_db4.close()

with TestClient(_fastapi_app) as _tc:
    _ncron = _tc.get("/jobs/nudges/cron")
    check(
        "nudge cron endpoint is gate-exempt and reports opted-in users",
        _ncron.status_code == 200 and _ncron.json()["users"] == 0,
        _ncron.text[:100],
    )
    # Mock interview endpoints (PLAN 11.3) through the real HTTP stack.
    _mi_resp = _tc.post(
        "/interview/chat",
        json={"resume": resume.model_dump(), "jd_text": "", "transcript": []},
        headers=_ADMIN_H,
    )
    check(
        "POST /interview/chat opens the interview with a message",
        _mi_resp.status_code == 200 and len(_mi_resp.json()["message"]) > 0,
        _mi_resp.text[:80],
    )
    _sc_400 = _tc.post(
        "/interview/scorecard",
        json={"resume": resume.model_dump(), "jd_text": "", "transcript": []},
        headers=_ADMIN_H,
    )
    check(
        "scorecard without a single candidate answer 400s",
        _sc_400.status_code == 400,
        _sc_400.text[:80],
    )

# 20. SSE search stream (PLAN 9.2): progress events then one terminal result/
# error frame, Hebrew-safe payloads, history recorded with top_matched (9.1).
# The search itself is monkeypatched — providers are network; the endpoint's
# streaming/queue/persistence plumbing is what's under test here.
import json as _json  # noqa: E402

import app.api.routes as _routes_mod  # noqa: E402

_STREAM_MATCH = JobMatch(
    title="מהנדס/ת תוכנה",
    company="StreamCo",
    overall=88.0,
    top_matched=["Python", "SQL"],
    top_gaps=["Kubernetes"],
    jd_text="JD",
    url="https://stream.test/job-1",
    source="linkedin",
)


def _fake_stream_search(resume, customize, progress=None, cache=None):  # noqa: ANN001 - matches search_jobs' shape
    progress({"stage": "boards", "source": "linkedin", "index": 1, "total": 1})
    progress({"stage": "scoring", "index": 1, "total": 1, "title": _STREAM_MATCH.title, "company": "StreamCo"})
    progress({"stage": "match", "index": 1, "total": 1, "match": _STREAM_MATCH.model_dump()})
    return JobSearchResult(context=_AlertCtx(job_title="Backend Engineer"), matches=[_STREAM_MATCH])


def _sse_events(text: str) -> list[tuple[str, dict]]:
    events = []
    for block in text.split("\n\n"):
        lines = [ln for ln in block.strip().splitlines() if ln and not ln.startswith(":")]
        if not lines:
            continue
        name = next((ln[len("event: "):] for ln in lines if ln.startswith("event: ")), "")
        data = next((ln[len("data: "):] for ln in lines if ln.startswith("data: ")), "")
        events.append((name, _json.loads(data) if data else {}))
    return events


_orig_search_jobs = _routes_mod.search_jobs
try:
    _routes_mod.search_jobs = _fake_stream_search
    with TestClient(_fastapi_app) as _tc:
        _sresp = _tc.post(
            "/jobs/search/stream",
            json={"resume": resume.model_dump(), "customize": None},
            headers=_ADMIN_H,
        )
        check(
            "search stream: 200 event-stream",
            _sresp.status_code == 200 and "text/event-stream" in _sresp.headers["content-type"],
            f"{_sresp.status_code} {_sresp.headers.get('content-type')}",
        )
        _frames = _sse_events(_sresp.text)
        _progress = [d for n, d in _frames if n == "progress"]
        _results = [d for n, d in _frames if n == "result"]
        check(
            "search stream: progress frames arrive in order, then one result",
            len(_progress) == 2
            and _progress[0]["stage"] == "boards"
            and _progress[1] == {"stage": "scoring", "index": 1, "total": 1, "title": _STREAM_MATCH.title, "company": "StreamCo"}
            and len(_results) == 1
            and _frames[-1][0] == "result",
            str(_frames)[:300],
        )
        check(
            "search stream: result is a full JobSearchResult with 9.1 fields, hebrew intact",
            _results and _results[0]["matches"][0]["top_matched"] == ["Python", "SQL"]
            and _results[0]["matches"][0]["title"] == "מהנדס/ת תוכנה"
            and "מהנדס/ת תוכנה" in _sresp.text,  # ensure_ascii=False — no \uXXXX escaping on the wire
        )
        # PLAN 12.2: the "match" progress stage rides its OWN event name, and
        # its data is the JobMatch object itself (not the progress envelope).
        _match_frames = [d for n, d in _frames if n == "match"]
        check(
            "search stream: `match` frame carries the JobMatch itself, before the result",
            len(_match_frames) == 1
            and _match_frames[0]["url"] == _STREAM_MATCH.url
            and _match_frames[0]["title"] == _STREAM_MATCH.title
            and "index" not in _match_frames[0]
            and [n for n, _ in _frames].index("match") < [n for n, _ in _frames].index("result"),
            str(_match_frames)[:200],
        )
        _hist_hits = _tc.get("/jobs/history", headers=_ADMIN_H).json()["hits"]
        _stream_hit = next((h for h in _hist_hits if h["url"] == _STREAM_MATCH.url), None)
        check(
            "search stream: hit persisted to history with top_matched",
            _stream_hit is not None
            and _stream_hit["top_matched"] == ["Python", "SQL"]
            and _stream_hit["top_gaps"] == ["Kubernetes"],
            str(_stream_hit)[:200],
        )

        def _broken_stream_search(resume, customize, progress=None, cache=None):  # noqa: ANN001
            raise ValueError("boards are down")

        _routes_mod.search_jobs = _broken_stream_search
        _eresp = _tc.post(
            "/jobs/search/stream",
            json={"resume": resume.model_dump(), "customize": None},
            headers=_ADMIN_H,
        )
        _eframes = _sse_events(_eresp.text)
        check(
            "search stream: user-facing failure rides the stream as an error frame",
            _eresp.status_code == 200
            and _eframes == [("error", {"detail": "boards are down", "status": 400})],
            str(_eframes)[:200],
        )
finally:
    _routes_mod.search_jobs = _orig_search_jobs

# 21. Fan-out failure classification: a board that answered fine with zero
# matches (NoResultsError) must land in source_empty, NOT source_errors — the
# "Some sources were unavailable" banner was showing empty queries as outages
# when every board was actually up.
from app.core.job_search import search_jobs as _fan_search  # noqa: E402
from app.core.providers import PROVIDERS as _PROV  # noqa: E402
from app.core.providers.base import JobHit as _FanHit, NoResultsError as _NoRes  # noqa: E402


class _FakeBoard:
    def __init__(self, name: str, mode: str):
        self.name = name
        self._mode = mode

    def search(self, ctx):  # noqa: ANN001
        if self._mode == "ok":
            return [
                _FanHit(
                    source=self.name, title="Py Dev", company="OkCo",
                    description="Python and SQL work", url="https://fake.ok/1",
                )
            ]
        if self._mode == "empty":
            raise _NoRes(f"No {self.name} jobs found for '{ctx.job_title}'.")
        if self._mode == "down":
            raise ValueError(f"Couldn't reach {self.name}.")
        if self._mode == "nodesc":  # inline description missing AND unfetchable → skipped
            return [
                _FanHit(source=self.name, title="No Desc", company="NoDescCo", url="https://fake.nodesc/1")
            ]
        raise RuntimeError("boom")

    def fetch_description(self, hit):  # noqa: ANN001
        return hit.description


_fakes = {
    name: _FakeBoard(name, mode)
    for name, mode in (
        ("fake_ok", "ok"), ("fake_empty", "empty"), ("fake_down", "down"),
        ("fake_buggy", "buggy"), ("fake_nodesc", "nodesc"),
    )
}
_PROV.update(_fakes)
try:
    _fan_events: list[dict] = []
    _fan = _fan_search(
        resume,
        _AlertCtx(job_title="Python", sources=list(_fakes), max_age_days=0),
        progress=_fan_events.append,  # called from worker threads; list.append is thread-safe
    )
    check(
        "fan-out: empty boards land in source_empty, failed boards in source_errors",
        [m.url for m in _fan.matches] == ["https://fake.ok/1"]
        and list(_fan.source_empty) == ["fake_empty"]
        and "No fake_empty jobs" in _fan.source_empty["fake_empty"]
        and set(_fan.source_errors) == {"fake_down", "fake_buggy"},
        f"empty={_fan.source_empty} errors={_fan.source_errors}",
    )
    check(
        "parallel fan-out: undescribable hit skipped (not fatal), matches sorted by overall",
        _fan.skipped == 1
        and [m.overall for m in _fan.matches]
        == sorted((m.overall for m in _fan.matches), reverse=True),
        f"skipped={_fan.skipped}",
    )
    # Boards/jobs run in parallel now: progress events are completion-ordered,
    # so pin sets/counts (one event per board/job, indexes 1..n) — not sequence.
    _b_ev = [e for e in _fan_events if e["stage"] == "boards"]
    _s_ev = [e for e in _fan_events if e["stage"] == "scoring"]
    _m_ev = [e for e in _fan_events if e["stage"] == "match"]
    check(
        "parallel boards: one completion event per board, indexes 1..n, any order",
        {e["source"] for e in _b_ev} == set(_fakes)
        and sorted(e["index"] for e in _b_ev) == list(range(1, len(_fakes) + 1))
        and all(e["total"] == len(_fakes) for e in _b_ev),
        str(_b_ev)[:300],
    )
    check(
        "parallel scoring: one event per hit; `match` events only for scored hits",
        sorted(e["index"] for e in _s_ev) == [1, 2]
        and all(e["total"] == 2 for e in _s_ev)
        and len(_m_ev) == 1
        and _m_ev[0]["match"]["url"] == "https://fake.ok/1"
        and _m_ev[0]["match"]["overall"] == _fan.matches[0].overall,
        f"scoring={_s_ev} match={str(_m_ev)[:200]}",
    )
    try:
        _fan_search(resume, _AlertCtx(job_title="Python", sources=["fake_empty"], max_age_days=0))
        check("all-empty search raises NoResultsError", False, "did not raise")
    except _NoRes as e:
        check(
            "all-empty search raises NoResultsError, not 'all boards failed'",
            "No jobs found on any board" in str(e),
            str(e),
        )
    try:
        _fan_search(resume, _AlertCtx(job_title="Python", sources=["fake_empty", "fake_down"], max_age_days=0))
        check("no hits + a real failure still raises 'all boards failed'", False, "did not raise")
    except _NoRes as e:
        check("no hits + a real failure still raises 'all boards failed'", False, f"NoResultsError: {e}")
    except ValueError as e:
        check(
            "no hits + a real failure still raises 'all boards failed'",
            "All job boards failed" in str(e) and "fake_down" in str(e),
            str(e),
        )
finally:
    for _k in _fakes:
        _PROV.pop(_k, None)

# 21b. Two-tier score cache (PLAN 12.4): a fresh history row scored against
# the SAME résumé rebuilds the match with ZERO LLM calls and ZERO fetches
# (tier 1); a fresh row for a DIFFERENT résumé still spares the description
# fetch but rescores with exactly one LLM call (tier 2); a stale (>TTL) row is
# ignored entirely (full path). resume_hash round-trips through the DB.
from datetime import datetime as _c_dt, timedelta as _c_td, timezone as _c_tz  # noqa: E402

from app.core.job_search import resume_hash as _resume_hash  # noqa: E402
from app.db.history import CACHE_TTL_DAYS as _CACHE_TTL, load_score_cache as _load_cache  # noqa: E402
from app.llm.client import get_llm_client as _get_llm  # noqa: E402

_C_URL = "https://fake.cache/1"
_c_hash = _resume_hash(resume)
check(
    "resume_hash is a stable sha256 hex of the résumé",
    len(_c_hash) == 64 and _c_hash == _resume_hash(resume) and _c_hash != _resume_hash(_he_resume),
    _c_hash[:16],
)

_cache_db = SessionLocal()


class _CacheBoard:
    """One posting whose card omits company/logo (the cached row must fill
    them) but carries a FRESH title/posted_at (which must win over the row)."""

    def __init__(self):
        self.fetches = 0

    def search(self, ctx):  # noqa: ANN001
        return [_FanHit(source="fake_cache", title="Py Dev (fresh card)",
                        url=_C_URL, posted_at="2026-07-10")]

    def fetch_description(self, hit):  # noqa: ANN001
        self.fetches += 1
        return "Fetched: Python and SQL work."


_c_board = _CacheBoard()
_PROV["fake_cache"] = _c_board
_c_stub = _get_llm()
_c_orig_cjson = _c_stub.complete_json
_c_llm_tasks: list[str] = []


def _c_counting_cjson(system, user):  # noqa: ANN001
    _c_llm_tasks.append(system[:40].upper())
    return _c_orig_cjson(system, user)


try:
    record_search_hits(_cache_db, [JobMatch(
        title="Cached Py Dev", company="CacheCo", location="Tel Aviv",
        overall=64.5, keyword_coverage=57.0, fit_score=72.0,
        top_matched=["Python"], top_gaps=["Kubernetes"],
        jd_text="Python and SQL work (cached)", url=_C_URL,
        posted_at="2026-06-01", source="fake_cache", logo_url="https://logo/cached.png",
    )], _admin_id, resume_hash=_c_hash)
    _c_row = {h.url: h for h in list_search_hits(_cache_db, _admin_id)}[_C_URL]
    check("record_search_hits stores resume_hash on the row", _c_row.resume_hash == _c_hash, _c_row.resume_hash[:16])

    _c_cache = _load_cache(_cache_db, _admin_id, _c_hash)
    check(
        "load_score_cache round-trips the row as a full match (key = url.rstrip('/'))",
        _C_URL in _c_cache and _c_cache[_C_URL].is_full_match is True
        and _c_cache[_C_URL].jd_text == "Python and SQL work (cached)"
        and list(_c_cache[_C_URL].top_matched) == ["Python"]
        and list(_c_cache[_C_URL].top_gaps) == ["Kubernetes"],
        str(_c_cache.get(_C_URL))[:200],
    )
    check("rows without jd_text never enter the cache", "https://bulk/104" not in _c_cache)
    _c_other = _load_cache(_cache_db, _admin_id, "some-other-resume-hash")
    check(
        "different résumé hash → text-reuse entry, not a full match",
        _C_URL in _c_other and _c_other[_C_URL].is_full_match is False,
    )

    # The customize context names a title, so no SEARCH_CONTEXT LLM call runs —
    # every counted JD_FIT call below is a scoring call.
    _c_ctx = _AlertCtx(job_title="Python", sources=["fake_cache"], max_age_days=0)
    _c_stub.complete_json = _c_counting_cjson

    # Tier 1: same résumé → zero LLM, zero fetch; scores come from the row;
    # the fresh card's title/posted_at win; company/logo fall back to the row.
    _c_events: list[dict] = []
    _t1 = _fan_search(resume, _c_ctx, progress=_c_events.append, cache=_c_cache)
    _t1_m = _t1.matches[0]
    check(
        "tier 1: zero scoring LLM calls and zero description fetches",
        _c_board.fetches == 0 and not [t for t in _c_llm_tasks if "JD_FIT" in t],
        f"fetches={_c_board.fetches} llm={_c_llm_tasks}",
    )
    check(
        "tier 1: match rebuilt from the seeded row's scores + keywords + jd_text",
        _t1_m.overall == 64.5 and _t1_m.keyword_coverage == 57.0 and _t1_m.fit_score == 72.0
        and _t1_m.top_matched == ["Python"] and _t1_m.top_gaps == ["Kubernetes"]
        and _t1_m.jd_text == "Python and SQL work (cached)" and _t1.skipped == 0,
        f"overall={_t1_m.overall} cov={_t1_m.keyword_coverage} fit={_t1_m.fit_score}",
    )
    check(
        "tier 1: fresh card fields win, cached row fills the card's blanks",
        _t1_m.title == "Py Dev (fresh card)" and _t1_m.posted_at == "2026-07-10"
        and _t1_m.company == "CacheCo" and _t1_m.location == "Tel Aviv"
        and _t1_m.logo_url == "https://logo/cached.png",
        f"title={_t1_m.title} posted={_t1_m.posted_at} company={_t1_m.company}",
    )
    check(
        "tier 1: scoring + match progress events still fire (streaming looks identical)",
        [e["stage"] for e in _c_events if e["stage"] != "boards"] == ["scoring", "match"]
        and next(e for e in _c_events if e["stage"] == "match")["match"]["url"] == _C_URL,
        str(_c_events)[:200],
    )

    # Tier 2: different résumé hash → jd_text reused (no fetch), ONE LLM call.
    _c_llm_tasks.clear()
    _t2 = _fan_search(resume, _c_ctx, cache=_c_other)
    check(
        "tier 2: no fetch, exactly one scoring LLM call, cached jd_text reused",
        _c_board.fetches == 0 and len([t for t in _c_llm_tasks if "JD_FIT" in t]) == 1
        and _t2.matches[0].jd_text == "Python and SQL work (cached)",
        f"fetches={_c_board.fetches} llm={_c_llm_tasks}",
    )

    # Stale row: force searched_at past the TTL → excluded → full path again.
    _c_row.searched_at = _c_dt.now(_c_tz.utc).replace(tzinfo=None) - _c_td(days=_CACHE_TTL + 1)
    _cache_db.commit()
    _c_stale = _load_cache(_cache_db, _admin_id, _c_hash)
    check("stale row (past the TTL) is excluded from the cache", _C_URL not in _c_stale)
    _c_llm_tasks.clear()
    _t3 = _fan_search(resume, _c_ctx, cache=_c_stale)
    check(
        "stale row → full path: description fetched and one scoring LLM call",
        _c_board.fetches == 1 and len([t for t in _c_llm_tasks if "JD_FIT" in t]) == 1
        and _t3.matches[0].jd_text == "Fetched: Python and SQL work.",
        f"fetches={_c_board.fetches} llm={_c_llm_tasks}",
    )
finally:
    _c_stub.complete_json = _c_orig_cjson
    _PROV.pop("fake_cache", None)
    _cache_db.close()

# 22. Batch auto-tailor kits (PLAN 8.1): enqueue high-fit jobs, drain the
# queue one tailor per request (the serverless-safe loop), guard flags mark
# kits never-auto-approvable, caps charged upfront, per-user isolation.
from datetime import datetime as _dt, timedelta as _td  # noqa: E402

from sqlalchemy import select as _ksel  # noqa: E402

from app.core.kits import enqueue_kits as _enqueue_kits, process_next_kit as _process_next  # noqa: E402
from app.db.models import TailorKit as _TKit, User as _KUser  # noqa: E402
from app.models import FabricationFlag as _KFlag, KitJobIn as _KitJob, TailorResult as _KTR  # noqa: E402

_KIT_JD = "Python developer. Python and SQL required. Docker an advantage."


def _kit_job(i: int, overall: float = 85.0) -> dict:
    return {
        "title": f"Backend Dev {i}",
        "company": "KitCo",
        "location": "Tel Aviv",
        "url": f"https://kit.test/job-{i}",
        "source": "linkedin",
        "jd_text": _KIT_JD,
        "overall": overall,
    }


with TestClient(_fastapi_app) as _tc:
    _kim = _tc.post("/admin/users", json={"name": "Kim"}, headers=_ADMIN_H).json()
    _KIM_H = {"X-App-Key": _kim["invite_code"]}
    _tc.put(
        "/profile/resume",
        json={"resume": resume.model_dump(), "label": "Kim CV"},
        headers=_KIM_H,
    )

    # Enqueue 2 (== DAILY_TAILOR_CAP), then dedupe, then the cap says no more.
    _b1 = _tc.post("/kits/batch", json={"jobs": [_kit_job(1), _kit_job(2)]}, headers=_KIM_H)
    check(
        "kit batch queues jobs and charges the tailor cap upfront",
        _b1.status_code == 200
        and len(_b1.json()["queued"]) == 2
        and _b1.json()["skipped_existing"] == 0
        and all(k["status"] == "queued" for k in _b1.json()["queued"]),
        _b1.text[:200],
    )
    _b2 = _tc.post("/kits/batch", json={"jobs": [_kit_job(1), _kit_job(2)]}, headers=_KIM_H)
    check(
        "re-batching the same URLs skips them (and charges nothing)",
        _b2.status_code == 200
        and _b2.json()["queued"] == []
        and _b2.json()["skipped_existing"] == 2,
        _b2.text[:200],
    )
    _b3 = _tc.post("/kits/batch", json={"jobs": [_kit_job(3)]}, headers=_KIM_H)
    check(
        "over-cap batch → 429 daily_limit and queues nothing",
        _b3.status_code == 429
        and _b3.json()["detail"] == {"code": "daily_limit", "action": "tailor", "cap": 2}
        and len(_tc.get("/kits", headers=_KIM_H).json()["kits"]) == 2,
        _b3.text[:150],
    )
    check(
        "kit batch rejects jobs without URL/JD",
        _tc.post(
            "/kits/batch",
            json={"jobs": [{"title": "no jd", "url": "https://kit.test/x"}]},
            headers=_KIM_H,
        ).status_code == 400,
    )

    # Drain the queue: one stub tailor pipeline run per request.
    _p1 = _tc.post("/kits/process-next", headers=_KIM_H).json()
    _p2 = _tc.post("/kits/process-next", headers=_KIM_H).json()
    _p3 = _tc.post("/kits/process-next", headers=_KIM_H).json()
    check(
        "process-next drains the queue one kit per call",
        _p1["kit"] is not None and _p1["remaining"] == 1
        and _p2["kit"] is not None and _p2["remaining"] == 0
        and _p3["kit"] is None and _p3["remaining"] == 0,
        f"{_p1.get('remaining')}/{_p2.get('remaining')}/{_p3.get('remaining')}",
    )
    check(
        "processed kit: done, guard-clean, tailored against the en master",
        _p1["kit"]["status"] == "done"
        and _p1["kit"]["flag_count"] == 0
        and _p1["kit"]["base_language"] == "en"
        and _p1["kit"]["error"] == "",
        str(_p1["kit"])[:200],
    )
    _kd = _tc.get(f"/kits/{_p1['kit']['id']}", headers=_KIM_H).json()
    check(
        "kit detail carries the full review payload (jd, base résumé, TailorResult)",
        _kd["jd"] is not None
        and _kd["base_resume"] is not None
        and _kd["result"] is not None
        and _kd["result"]["tailored_resume"]["contact"] is not None
        and _kd["base_resume"] == resume.model_dump(),
        str(_kd)[:200],
    )

    # Isolation: the admin sees none of Kim's kits and can't fetch/delete them.
    _admin_kits = _tc.get("/kits", headers=_ADMIN_H).json()["kits"]
    check(
        "kits are per-user: admin sees none of Kim's",
        all(not k["url"].startswith("https://kit.test/") for k in _admin_kits)
        and _tc.get(f"/kits/{_p1['kit']['id']}", headers=_ADMIN_H).status_code == 404
        and _tc.delete(f"/kits/{_p1['kit']['id']}", headers=_ADMIN_H).status_code == 404,
    )
    check(
        "owner deletes their kit",
        _tc.delete(f"/kits/{_p1['kit']['id']}", headers=_KIM_H).json() == {"deleted": True},
    )

    # Review (PLAN 8.2): approve lands in the tracker as ready-to-send with the
    # reviewer's effective résumé; reject records why. Kim's kit 2 is "done".
    _kit2 = _p2["kit"]
    check(
        "approving someone else's kit 404s",
        _tc.post(f"/kits/{_kit2['id']}/approve", json={}, headers=_ADMIN_H).status_code == 404,
    )
    _effective = resume.model_dump()
    _effective["summary"] = "Reviewed effective summary"
    _apr = _tc.post(
        f"/kits/{_kit2['id']}/approve",
        json={"resume": _effective, "cover_letter": "Dear KitCo"},
        headers=_KIM_H,
    )
    check(
        "approve: kit → approved, tracker application linked",
        _apr.status_code == 200
        and _apr.json()["status"] == "approved"
        and _apr.json()["application_id"],
        _apr.text[:200],
    )
    _kit_app = _tc.get(f"/applications/{_apr.json()['application_id']}", headers=_KIM_H).json()
    check(
        "approved application: ready-to-send with effective résumé + cover letter",
        _kit_app["status"] == "saved"
        and _kit_app["company"] == "KitCo"
        and _kit_app["cover_letter"] == "Dear KitCo"
        and _kit_app["tailored_resume"]["summary"] == "Reviewed effective summary"
        and _kit_app["job_url"] == _kit2["url"],
        str(_kit_app)[:200],
    )
    check(
        "approved kit can't be re-approved or rejected (400)",
        _tc.post(f"/kits/{_kit2['id']}/approve", json={}, headers=_KIM_H).status_code == 400
        and _tc.post(f"/kits/{_kit2['id']}/reject", json={"reason": "x"}, headers=_KIM_H).status_code == 400,
    )

    # Reject flow on a fresh admin kit (admins are cap-exempt).
    _tc.post("/kits/batch", json={"jobs": [_kit_job(20)]}, headers=_ADMIN_H)
    _admin_kit = _tc.post("/kits/process-next", headers=_ADMIN_H).json()["kit"]
    _rej = _tc.post(
        f"/kits/{_admin_kit['id']}/reject",
        json={"reason": "wrong seniority"},
        headers=_ADMIN_H,
    )
    check(
        "reject records the reason (feeds threshold tuning)",
        _rej.status_code == 200
        and _rej.json()["status"] == "rejected"
        and _rej.json()["reject_reason"] == "wrong seniority",
        _rej.text[:150],
    )
    check(
        "rejected kit can't be approved",
        _tc.post(f"/kits/{_admin_kit['id']}/approve", json={}, headers=_ADMIN_H).status_code == 400,
    )

    # No master résumé → the kit fails with a clear error, the loop keeps 200ing.
    _noam = _tc.post("/admin/users", json={"name": "Noam"}, headers=_ADMIN_H).json()
    _NOAM_H = {"X-App-Key": _noam["invite_code"]}
    _tc.post("/kits/batch", json={"jobs": [_kit_job(9)]}, headers=_NOAM_H)
    _np = _tc.post("/kits/process-next", headers=_NOAM_H).json()
    check(
        "kit without a master résumé fails softly (status=failed, loop continues)",
        _np["kit"] is not None
        and _np["kit"]["status"] == "failed"
        and "master résumé" in _np["kit"]["error"]
        and _np["remaining"] == 0,
        str(_np)[:200],
    )
    # Re-batching a failed kit requeues it (still 1 kit, back to queued).
    _rb = _tc.post("/kits/batch", json={"jobs": [_kit_job(9)]}, headers=_NOAM_H)
    check(
        "re-batching a failed kit requeues it instead of skipping",
        _rb.status_code == 200 and len(_rb.json()["queued"]) == 1
        and _rb.json()["queued"][0]["status"] == "queued",
        _rb.text[:150],
    )
    check(
        "unprocessed (queued) kit can't be reviewed",
        _tc.post(
            f"/kits/{_rb.json()['queued'][0]['id']}/reject", json={}, headers=_NOAM_H
        ).status_code == 400,
    )

# Function level: a tailor that invents facts marks the kit flagged (never
# auto-approvable), and a crashed "running" kit is requeued after the timeout.
_dbk = SessionLocal()
_kim_row = _dbk.execute(_ksel(_KUser).where(_KUser.name == "Kim")).scalars().first()
_flag_rows, _ = _enqueue_kits(
    _dbk, _kim_row, [_KitJob(title="Flagged", url="https://kit.test/flagged", jd_text=_KIT_JD)]
)


def _flagging_tailor(resume, jd, ledger=None):  # noqa: ANN001 - matches tailor_resume's shape
    return _KTR(
        tailored_resume=resume,
        fabrication_flags=[_KFlag(category="employer", value="FakeCo", detail="invented")],
    )


_flag_kit, _ = _process_next(_dbk, _kim_row, tailor_fn=_flagging_tailor)
check(
    "guard-flagged tailor marks the kit (flag_count > 0 ⇒ never auto-approvable)",
    _flag_kit is not None and _flag_kit.status == "done" and _flag_kit.flag_count == 1,
    f"{_flag_kit.status if _flag_kit else None}/{_flag_kit.flag_count if _flag_kit else None}",
)

# Simulate a serverless invocation that died mid-run: stuck "running" past the
# timeout is requeued and picked up by the next process-next call.
_flag_kit.status = "running"
_flag_kit.started_at = _dt.utcnow() - _td(minutes=30)
_dbk.commit()
_stuck_kit, _ = _process_next(_dbk, _kim_row, tailor_fn=_flagging_tailor)
check(
    "stuck running kit is requeued and reprocessed after the timeout",
    _stuck_kit is not None and _stuck_kit.id == _flag_kit.id and _stuck_kit.status == "done",
    f"{_stuck_kit.id if _stuck_kit else None} vs {_flag_kit.id}",
)
_dbk.close()

# 22b. True auto-submit (PLAN 8.4): Comeet-only channel. Pure helpers pinned,
# then the whole submit path through the HTTP stack with the transport mocked —
# guardrails, cap, audit trail, and the exact multipart the wire would carry.
# Nothing leaves the box.
from app.core import auto_submit as _asub  # noqa: E402

_ref = _asub.parse_comeet_position_url(
    "https://www.comeet.com/jobs/kaltura/E2.00D/senior-dev/C5.D69?utm=x"
)
check(
    "comeet position url parsed (slug, company uid, position uid)",
    _ref == ("kaltura", "E2.00D", "C5.D69"),
    str(_ref),
)
try:
    _asub.parse_comeet_position_url("https://www.linkedin.com/jobs/view/123")
    check("non-comeet url rejected by the position parser", False)
except ValueError:
    check("non-comeet url rejected by the position parser", True)
check(
    "candidate name splitting (single names repeat, comeet wants both)",
    _asub.split_name("Ada Lovelace King") == ("Ada", "Lovelace King")
    and _asub.split_name("Madonna") == ("Madonna", "Madonna")
    and _asub.split_name("") == ("", ""),
)
_mp_body, _mp_ct = _asub.build_multipart(
    {"first_name": "דנה", "email": "d@x.com", "empty": ""},
    "cv", "resume.pdf", b"%PDF-fake", boundary="BBB",
)
check(
    "multipart builder: utf-8 fields, empties skipped, pdf file part, closed boundary",
    b'name="first_name"' in _mp_body
    and "דנה".encode("utf-8") in _mp_body
    and b'name="empty"' not in _mp_body
    and b'name="cv"; filename="resume.pdf"' in _mp_body
    and b"Content-Type: application/pdf" in _mp_body
    and _mp_body.endswith(b"--BBB--\r\n")
    and _mp_ct == "multipart/form-data; boundary=BBB",
)

_sent_apps: list[tuple[str, bytes, str]] = []


def _fake_apply_post(url: str, body: bytes, content_type: str) -> str:
    _sent_apps.append((url, body, content_type))
    return _json.dumps({"post_submit_questionnaires": "https://apply.example/q/1"})


_real_post, _real_token = _asub._default_post, _asub._resolve_token
_asub._default_post = _fake_apply_post
_asub._resolve_token = lambda db, ref: "TOK123"
try:
    with TestClient(_fastapi_app) as _tc:
        _sub = _tc.post("/admin/users", json={"name": "Sub"}, headers=_ADMIN_H).json()
        _SUB_H = {"X-App-Key": _sub["invite_code"]}
        _tc.put(
            "/profile/resume",
            json={"resume": resume.model_dump(), "label": "Sub CV"},
            headers=_SUB_H,
        )

        def _comeet_job(i: int) -> dict:
            return {
                "title": f"Backend Dev {i}",
                "company": f"SubCo{i}",
                "location": "Tel Aviv",
                "url": f"https://www.comeet.com/jobs/subco{i}/A{i}.00{i}/backend-dev/B{i}.0{i}0",
                "source": "comeet",
                "jd_text": _KIT_JD,
                "overall": 90.0,
            }

        _tc.post("/kits/batch", json={"jobs": [_comeet_job(1), _comeet_job(2)]}, headers=_SUB_H)
        _sk1 = _tc.post("/kits/process-next", headers=_SUB_H).json()["kit"]
        _sk2 = _tc.post("/kits/process-next", headers=_SUB_H).json()["kit"]

        _r = _tc.post(f"/kits/{_sk1['id']}/submit", headers=_SUB_H)
        check(
            "submit refuses a kit that was never approved in review",
            _r.status_code == 400 and "approved" in _r.json()["detail"],
            _r.text[:150],
        )
        _r = _tc.post(f"/kits/{_kit2['id']}/submit", headers=_KIM_H)
        check(
            "submit refuses non-comeet kits (linkedin is never automated)",
            _r.status_code == 400 and "Comeet" in _r.json()["detail"],
            _r.text[:150],
        )

        _tc.post(f"/kits/{_sk1['id']}/approve", json={"cover_letter": "Cover A"}, headers=_SUB_H)
        _tc.post(f"/kits/{_sk2['id']}/approve", json={"cover_letter": "Cover B"}, headers=_SUB_H)

        _r = _tc.post(f"/kits/{_sk1['id']}/submit", headers=_SUB_H)
        check(
            "approved guard-clean comeet kit submits: status + timestamps + questionnaire",
            _r.status_code == 200
            and _r.json()["status"] == "submitted"
            and _r.json()["submitted_at"] != ""
            and _r.json()["submit_note"] == "https://apply.example/q/1",
            _r.text[:200],
        )
        _url, _body, _ct = _sent_apps[-1]
        check(
            "the wire call hits the position's apply endpoint with the page token",
            _url == "https://www.comeet.co/careers-api/1.0/company/A1.001/positions/B1.010/apply?token=TOK123",
            _url,
        )
        check(
            "the multipart carries candidate fields, the cover letter, and a real PDF",
            b'name="first_name"' in _body
            and b"Sample" in _body
            and b"sample@example.com" in _body
            and b"Cover A" in _body
            and b"%PDF" in _body
            and _ct.startswith("multipart/form-data"),
            _ct,
        )
        _sub_app = _tc.get(f"/applications/{_r.json()['application_id']}", headers=_SUB_H).json()
        check(
            "audit trail: tracker application flips to applied with an auto-apply note",
            _sub_app["status"] == "applied"
            and "[auto-apply" in _sub_app["notes"]
            and "https://apply.example/q/1" in _sub_app["notes"],
            str(_sub_app.get("notes"))[:200],
        )
        _r = _tc.post(f"/kits/{_sk1['id']}/submit", headers=_SUB_H)
        check(
            "a submitted kit can't be sent twice",
            _r.status_code == 400 and "already" in _r.json()["detail"].lower(),
            _r.text[:150],
        )
        _r = _tc.post(f"/kits/{_sk2['id']}/submit", headers=_SUB_H)
        check(
            "daily submit cap: the second real send of the day 429s (cap=1)",
            _r.status_code == 429
            and _r.json()["detail"] == {"code": "daily_limit", "action": "submit", "cap": 1},
            _r.text[:150],
        )
        check(
            "refused submits never reached the network (exactly one real send)",
            len(_sent_apps) == 1,
            str(len(_sent_apps)),
        )

    # Function-level guardrails that the HTTP flow above can't reach: flagged
    # kits and the per-company dedupe both refuse BEFORE any network call.
    _dbs = SessionLocal()
    _sub_row = _dbs.execute(_ksel(_KUser).where(_KUser.name == "Sub")).scalars().first()
    _flagged = _TKit(
        user_id=_sub_row.id, status="approved", source="comeet", flag_count=1,
        company="FlagCo", url="https://www.comeet.com/jobs/flagco/AA.001/dev/BB.002",
    )
    _same_co = _TKit(
        user_id=_sub_row.id, status="approved", source="comeet", flag_count=0,
        company="subco1",  # case-insensitive match against the submitted SubCo1
        url="https://www.comeet.com/jobs/subco1/A1.001/other-role/C9.00C",
    )
    _dbs.add_all([_flagged, _same_co])
    _dbs.commit()
    try:
        _asub.submit_kit(_dbs, _sub_row, _flagged)
        check("flagged kits are never auto-submitted, even after approval", False)
    except ValueError as _e:
        check("flagged kits are never auto-submitted, even after approval", "flag" in str(_e).lower(), str(_e))
    try:
        _asub.submit_kit(_dbs, _sub_row, _same_co)
        check("per-company dedupe: one auto-application per company", False)
    except ValueError as _e:
        check("per-company dedupe: one auto-application per company", "already auto-applied" in str(_e), str(_e))
    check(
        "guardrail refusals left no extra network sends",
        len(_sent_apps) == 1,
        str(len(_sent_apps)),
    )
    _dbs.close()
finally:
    _asub._default_post = _real_post
    _asub._resolve_token = _real_token

print("\n" + ("ALL PASSED" if not failures else f"FAILURES: {failures}"))
raise SystemExit(1 if failures else 0)
