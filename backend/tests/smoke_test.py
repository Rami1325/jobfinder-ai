"""Offline end-to-end smoke test using the stub LLM (no API key needed).

DB checks run against a throwaway temp SQLite file (DATABASE_URL override below),
so the repo's jobfinder.db is never touched.

Run from the backend dir:
    .venv\\Scripts\\python.exe -m tests.smoke_test
"""
from __future__ import annotations

import os
import tempfile

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
check("work mode 'any' omits f_WT", "f_WT" not in _build_search_url("X", "Y", "any", 0))

_fb = _fallback_context(resume)  # stub resume: Engineer at Acme Corp
check("fallback context uses most recent title", _fb.job_title == "Engineer", _fb.job_title)
_ctx = derive_search_context(resume)  # routes through the SEARCH_CONTEXT stub branch
check("stub search context derived", _ctx.job_title != "", str(_ctx))
check("JobMatch back-compat: url defaults empty", JobMatch().url == "")

# 15. DB layer (temp SQLite): migration shim + job-search history + tracker fields
from app.db.database import SessionLocal, engine, init_db  # noqa: E402
from app.db.history import list_search_hits, record_search_hits  # noqa: E402
from app.db.models import Application  # noqa: E402

# Simulate a pre-existing DB whose applications table predates job_url/interviewed,
# so init_db()'s ADD-COLUMN shim has real work to do (create_all won't touch it).
with engine.connect() as _conn:
    _conn.exec_driver_sql(
        "CREATE TABLE applications ("
        "id INTEGER PRIMARY KEY, job_title VARCHAR(255), company VARCHAR(255), "
        "jd_text TEXT, tailored_resume_json TEXT, cover_letter TEXT, "
        "overall_score FLOAT, status VARCHAR(50), notes TEXT, created_at DATETIME)"
    )
    _conn.commit()

init_db()
init_db()  # idempotent — create_all + shim must tolerate re-runs
check("init_db runs twice without error", True)

with engine.connect() as _conn:
    _cols = {r[1] for r in _conn.exec_driver_sql("PRAGMA table_info(applications)").fetchall()}
check(
    "migration shim added job_url + interviewed",
    {"job_url", "interviewed"} <= _cols,
    str(sorted(_cols)),
)

_db = SessionLocal()
record_search_hits(_db, [
    JobMatch(title="Backend Engineer", company="Acme", overall=50.0, url="https://x/jobs/1"),
    JobMatch(title="Data Engineer", company="Beta", overall=60.0, url="https://x/jobs/2"),
])
check("search history recorded 2 hits", len(list_search_hits(_db)) == 2, str(len(list_search_hits(_db))))

record_search_hits(_db, [JobMatch(title="Backend Engineer", company="Acme", overall=75.0, url="https://x/jobs/1")])
_hits = list_search_hits(_db)
_by_url = {h.url: h for h in _hits}
check("re-record upserts by url (still 2 rows)", len(_hits) == 2, str(len(_hits)))
check("re-record refreshed the score", _by_url["https://x/jobs/1"].overall == 75.0, str(_by_url["https://x/jobs/1"].overall))

record_search_hits(_db, [JobMatch(title=f"Role {i}", url=f"https://bulk/{i}") for i in range(105)])
_hits = list_search_hits(_db)
_urls = {h.url for h in _hits}
check("history capped at 100 rows", len(_hits) == 100, str(len(_hits)))
check(
    "earliest-inserted urls trimmed first",
    "https://x/jobs/1" not in _urls and "https://bulk/0" not in _urls and "https://bulk/104" in _urls,
)

_app_row = Application(job_title="Backend Engineer", company="Acme", job_url="https://x/jobs/1", interviewed=True)
_db.add(_app_row)
_db.commit()
_db.refresh(_app_row)
_read = _db.get(Application, _app_row.id)
check(
    "application persists job_url + interviewed",
    _read is not None and _read.job_url == "https://x/jobs/1" and _read.interviewed is True,
)
_db.close()

print("\n" + ("ALL PASSED" if not failures else f"FAILURES: {failures}"))
raise SystemExit(1 if failures else 0)
