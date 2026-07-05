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

# 10. ATS scanner (deterministic checks + optional coverage)
ats = scan_resume(resume, "Python, SQL, REST APIs required.")
check("ats scan produced issues + score", len(ats.issues) > 0 and 0 <= ats.score <= 100, str(ats.score))

# 11. LinkedIn optimizer
li = optimize_linkedin(resume)
check("linkedin headline non-empty", len(li.headline) > 0)

# 12. Follow-up email
fu = write_follow_up("Acme", "Software Engineer", "after applying", "strong Python fit")
check("follow-up email has subject + body", len(fu.subject) > 0 and len(fu.body) > 0)

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

_fb = _fallback_context(resume)  # stub resume: Engineer at Acme Corp
check("fallback context uses most recent title", _fb.job_title == "Engineer", _fb.job_title)
_ctx = derive_search_context(resume)  # routes through the SEARCH_CONTEXT stub branch
check("stub search context derived", _ctx.job_title != "", str(_ctx))
check(
    "JobMatch back-compat: url + posted_at default empty",
    JobMatch().url == "" and JobMatch().posted_at == "",
)
check("JobMatch back-compat: source defaults to linkedin", JobMatch().source == "linkedin")

# 14b. Provider registry + multi-source context resolution (pure, offline)
from app.core.job_search import _interleave_and_dedupe, _resolve_context  # noqa: E402
from app.core.providers import DEFAULT_SOURCES, PROVIDERS, JobHit  # noqa: E402
from app.core.scorer import score_resume  # noqa: E402
from app.models import SearchContext  # noqa: E402

check(
    "provider registry has linkedin + drushim + comeet + jobmaster (jooble retired)",
    {"linkedin", "drushim", "comeet", "jobmaster"} <= set(PROVIDERS)
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
record_search_hits(_db, [
    JobMatch(title="Backend Engineer", company="Acme", overall=50.0, url="https://x/jobs/1", posted_at="2026-06-25"),
    JobMatch(title="Data Engineer", company="Beta", overall=60.0, url="https://x/jobs/2", source="drushim"),
])
check(
    "history persists posted_at",
    {h.url: h.posted_at for h in list_search_hits(_db)}.get("https://x/jobs/1") == "2026-06-25",
)
check(
    "history persists source (default + drushim)",
    {h.url: h.source for h in list_search_hits(_db)}
    == {"https://x/jobs/1": "linkedin", "https://x/jobs/2": "drushim"},
    str({h.url: h.source for h in list_search_hits(_db)}),
)
check("search history recorded 2 hits", len(list_search_hits(_db)) == 2, str(len(list_search_hits(_db))))

record_search_hits(_db, [JobMatch(title="Backend Engineer", company="Acme", overall=75.0, url="https://x/jobs/1")])
_hits = list_search_hits(_db)
_by_url = {h.url: h for h in _hits}
check("re-record upserts by url (still 2 rows)", len(_hits) == 2, str(len(_hits)))
check("re-record refreshed the score", _by_url["https://x/jobs/1"].overall == 75.0, str(_by_url["https://x/jobs/1"].overall))

# Hebrew must survive the DB round-trip byte-identical (UTF-8 through SQLite).
_he_title = "מהנדס/ת נתונים — תל אביב"
_he_jd_text = "דרישות: ניסיון ב-Python ו-SQL, עבודה בענן (AWS)."
record_search_hits(_db, [JobMatch(title=_he_title, company="חברת דוגמה", overall=70.0,
                                  url="https://x/jobs/he-1", jd_text=_he_jd_text, source="drushim")])
_he_row = {h.url: h for h in list_search_hits(_db)}["https://x/jobs/he-1"]
check(
    "hebrew survives db round-trip byte-identical",
    _he_row.title == _he_title and _he_row.company == "חברת דוגמה" and _he_row.jd_text == _he_jd_text,
    _he_row.title,
)

record_search_hits(_db, [JobMatch(title=f"Role {i}", url=f"https://bulk/{i}") for i in range(105)])
_hits = list_search_hits(_db)
_urls = {h.url for h in _hits}
check("history capped at 100 rows", len(_hits) == 100, str(len(_hits)))
check(
    "earliest-inserted urls trimmed first",
    "https://x/jobs/1" not in _urls and "https://bulk/0" not in _urls and "https://bulk/104" in _urls,
)

_app_row = Application(
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

_db.add(Application(job_title="X", status="applied", job_url="https://www.linkedin.com/jobs/view/9912345678?tracking=1"))
_db.add(Application(job_title="Y", status="offer", job_url="https://x/jobs/1"))
_db.commit()
_statuses = application_statuses(
    _db,
    ["https://il.linkedin.com/jobs/view/data-engineer-at-beta-9912345678", "https://x/jobs/1", "https://never/applied"],
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
_legacy = get_master_resume(lang="he", db=_db)
check(
    "legacy master healed to its real language on read",
    _legacy is not None and _legacy.language == "he" and _legacy.label == "Legacy hebrew master",
)

_saved_en = save_master_resume(MasterResumeIn(resume=resume, label="EN master"), db=_db)
check("saving an english master lands in the en slot", _saved_en.language == "en")
_saved_he = save_master_resume(MasterResumeIn(resume=_he_resume, label="HE master"), db=_db)
_pair = list_master_resumes(db=_db).resumes
check(
    "hebrew master upserts the healed he slot — paired, not duplicated",
    _saved_he.language == "he" and len(_pair) == 2 and {m.language for m in _pair} == {"en", "he"},
    str([(m.language, m.label) for m in _pair]),
)
save_master_resume(MasterResumeIn(resume=resume, label="EN master v2"), db=_db)
_pair = list_master_resumes(db=_db).resumes
check(
    "re-saving english updates in place (still one row per language)",
    len(_pair) == 2 and any(m.label == "EN master v2" for m in _pair),
    str([(m.language, m.label) for m in _pair]),
)
_he_master = get_master_resume(lang="he", db=_db)
_en_master = get_master_resume(lang="en", db=_db)
check(
    "get by lang returns the matching master",
    _he_master is not None and _he_master.label == "HE master"
    and _en_master is not None and _en_master.label == "EN master v2",
)
check(
    "hebrew master round-trips its resume intact",
    _he_master is not None and _he_master.resume.contact.name == _he_resume.contact.name,
)
_default_master = get_master_resume(db=_db)
check(
    "default master (no lang) is the most recently updated",
    _default_master is not None and _default_master.label == "EN master v2",
    _default_master.label if _default_master else "None",
)
check("get by lang misses cleanly", get_master_resume(lang="fr", db=_db) is None)

# 15c. Job alerts (PLAN 6): settings row, history diffing, email body, and the
# full run loop with a canned search function (no network, no LLM, no SMTP)
from app.core.alerts import (  # noqa: E402
    build_alert_email,
    get_alert,
    run_alert,
    split_new_matches,
    update_alert,
)
from app.models import JobSearchResult, SearchContext as _AlertCtx  # noqa: E402

_al = get_alert(_db)
check("alert settings row auto-creates (disabled, no email)", _al.enabled is False and _al.email == "")
update_alert(_db, enabled=True, email="me@example.com", context=_AlertCtx(job_title="Backend Engineer", location="Tel Aviv"))
_al = get_alert(_db)
check(
    "alert settings persist (single row)",
    _al.enabled is True and _al.email == "me@example.com" and "Backend Engineer" in _al.context_json,
)

# Put a known URL (back) in history — the 105-row cap test above trimmed it —
# so the diff has one seen and one unseen job to split.
record_search_hits(_db, [JobMatch(title="Backend Engineer", company="Acme", overall=75.0, url="https://x/jobs/1")])
_alert_matches = [
    JobMatch(title="Backend Engineer", company="Acme", overall=75.0, url="https://x/jobs/1"),
    JobMatch(title="Platform Engineer", company="Nova", overall=82.0, url="https://alerts/new-1", source="drushim"),
]
_new = split_new_matches(_db, _alert_matches)
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


def _canned_search(resume, ctx):  # noqa: ANN001 - matches search_jobs' shape
    return JobSearchResult(
        context=_AlertCtx(job_title="Backend Engineer", location="Tel Aviv"),
        matches=_alert_matches,
        skipped=0,
    )


_run = run_alert(_db, search_fn=_canned_search)
check(
    "alert run: 2 found, 1 new, not emailed (smtp unconfigured), no error",
    _run.ran is True and _run.total == 2 and _run.new_count == 1
    and _run.emailed is False and _run.error == "",
    str(_run),
)
_al = get_alert(_db)
check("alert run bookkeeping persisted", _al.last_new_count == 1 and _al.last_run_at is not None and _al.last_error == "")
_run2 = run_alert(_db, search_fn=_canned_search)
check("alert re-run: nothing new (hits now in history)", _run2.new_count == 0, str(_run2))
update_alert(_db, enabled=False, email="me@example.com", context=None)
check("alert run respects the toggle", run_alert(_db, search_fn=_canned_search).ran is False)
check("alert run with force ignores the toggle", run_alert(_db, force=True, search_fn=_canned_search).ran is True)


def _broken_search(resume, ctx):  # noqa: ANN001
    raise ValueError("boards are down")


_run_err = run_alert(_db, force=True, search_fn=_broken_search)
check(
    "alert run reports search failure instead of raising",
    _run_err.ran is True and "boards are down" in _run_err.error
    and "boards are down" in get_alert(_db).last_error,
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

print("\n" + ("ALL PASSED" if not failures else f"FAILURES: {failures}"))
raise SystemExit(1 if failures else 0)
