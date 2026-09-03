"""Offline end-to-end smoke test using the stub LLM (no API key needed).

DB checks run against a throwaway temp SQLite file (DATABASE_URL override below),
so the repo's jobfinder.db is never touched.

Run from the backend dir:
    .venv\\Scripts\\python.exe -m tests.smoke_test
"""
from __future__ import annotations

import atexit
import os
import sys
import tempfile

# Hebrew shows up in check output (Israeli boards, Hebrew-pipeline checks);
# Windows consoles default to cp1252 which can't print it. Never let printing
# be the thing that fails the suite.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]

os.environ["USE_STUB_LLM"] = "true"
# Never report smoke-test failures to Sentry. This suite drives failure paths on
# purpose — 401/403/429, malformed payloads, a search stream that used to raise —
# and with a real SENTRY_DSN in backend/.env every one of them landed in the live
# Sentry project. Tagged `development`, but indistinguishable at a glance from a
# production incident: PYTHON-FASTAPI-6 was a local test run that read as an
# outage. Must be set before any app.* import — main.py inits Sentry at import.
os.environ["SENTRY_DSN"] = ""
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
# 1 MB upload cap so section 25 can prove the limit without building a 10 MB
# body. Only the two HTTP upload routes read it; the direct extract_text() calls
# elsewhere in this suite are unaffected.
os.environ["MAX_UPLOAD_MB"] = "1"
# Small llm cap so section 26 can prove PLAN 20.6/S2 with three calls. Section
# 26 mints its own user for it, so no earlier section can spend the budget first.
os.environ["DAILY_LLM_CAP"] = "3"
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
from app.models import Contact, Education, Experience, FactsLedger, Project, ResumeModel  # noqa: E402
from app.parsers.structurer import build_facts_ledger, structure_resume  # noqa: E402
from app.render.docx_renderer import render_docx  # noqa: E402
from app.render.pdf_renderer import render_pdf  # noqa: E402

failures: list[str] = []
_ran = 0
_reached_end = False


def check(name: str, cond: bool, extra: str = "") -> None:
    global _ran
    _ran += 1
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" — {extra}" if extra else ""))
    if not cond:
        failures.append(name)


@atexit.register
def _report_abort() -> None:
    """Say how much of the suite actually ran when it dies mid-file.

    This file is straight-line top-level code with no top-level try, so an
    exception at check N aborts the process and every check after it silently
    never runs — a traceback is the only output, and it says nothing about the
    ~865 checks that were skipped, which makes a crash read as a small local
    failure. CI used to paper over exactly that with `smoke_test || smoke_test`
    (removed — see .github/workflows/ci.yml), so an intermittent crash could
    land as a GREEN build. The retry is gone; this line makes what remains
    legible instead of merely red.
    """
    if not _reached_end:
        print(f"\nABORTED after {_ran} checks — the rest of the suite never ran.")


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

# 4a. A CURATED SHORTLIST SURVIVES THE UNION VALIDATOR.
# `ResumeModel` keeps `skills` as the flat union of `skill_groups` and only ever
# ADDS — right for a master, where the taxonomy is the document. But a TAILOR
# response that returns a curated flat list AND echoes the master's groups has
# its curation silently reversed at parse time: measured on the real master,
# 20 flat entries + the real groups validates to 66 skills, and nothing reports
# it. That would defeat every other mechanism that shortens this section, so
# `tailor_resume` strips the groups before validating.
#
# DRIVEN, not called: a check that invoked the flattening directly would still
# pass with the call site deleted. This swaps a fake client into the real
# function so the assertion is about the shipped path.
import app.core.tailor as _flat_mod  # noqa: E402


class _GroupEchoClient:
    """Answers TAILOR with a curated flat list AND the master's groups; every
    other task falls through to the stub so the rest of the pipeline is real."""

    def __init__(self, inner):
        self._inner = inner

    def complete_json(self, system: str, user: str):
        if not system.startswith("Task: TAILOR."):
            return self._inner.complete_json(system, user)
        body = resume.model_dump()
        body["skills"] = ["Python", "SQL"]
        body["skill_groups"] = [
            {"label": "Backend", "items": ["Python", "SQL"]},
            {"label": "Other", "items": ["Fortran", "COBOL", "Pascal", "Delphi"]},
        ]
        return {"tailored_resume": body, "changelog": [], "covered_keywords": []}

    def complete_text(self, system: str, user: str):
        return self._inner.complete_text(system, user)


_real_factory = _flat_mod.get_llm_client
_flat_mod.get_llm_client = lambda: _GroupEchoClient(_real_factory())
try:
    _flat = tailor_resume(resume, jd, ledger)
finally:
    _flat_mod.get_llm_client = _real_factory
check(
    "a tailored CV is flat: echoed skill_groups do not resurrect the curated-away skills",
    _flat.tailored_resume.skill_groups == []
    and "Fortran" not in _flat.tailored_resume.skills,
    f"{len(_flat.tailored_resume.skills)} skills, "
    f"{len(_flat.tailored_resume.skill_groups)} groups",
)
# The false-positive half: groups with NO flat list are the only content there
# is, so stripping them there would delete the section outright. Asserted on the
# validator, which is where that case is decided.
check(
    "groups with no flat list still populate skills (stripping there would delete the section)",
    ResumeModel.model_validate(
        {"skill_groups": [{"label": "A", "items": ["Rust", "Zig"]}]}
    ).skills == ["Rust", "Zig"],
)

# 4b. THE SKILLS CEILING (`core/skills_shortlist.py`), the mirror of the keyword
# guard's floor. Measured on the real key over 12 job-pairs across two
# independent runs: the shipped CV carried a median of 63.5 skills against a
# 66-skill master — more than it started with — at 18.6% precision, and every
# prompt-only fix that cut the count paid for it in keyword coverage.
from app.config import get_settings as _cap_settings  # noqa: E402
from app.core.skills_shortlist import (  # noqa: E402
    relevance as _rel,
    shortlist_skills,
)
import app.core.skills_shortlist as _order_mod  # noqa: E402
import app.core.skills as _skills_mod  # noqa: E402
from app.models import JDModel as _AtsJD, SkillGroup  # noqa: E402

_big = ResumeModel(
    skills=["Python", "PostgreSQL"] + [f"Noise{i}" for i in range(40)],
    skill_groups=[
        SkillGroup(label="Backend", items=["Python", "PostgreSQL"]),
        SkillGroup(label="Other", items=[f"Noise{i}" for i in range(40)]),
    ],
)
_capjd = _AtsJD(hard_skills=["Python"], keywords=["PostgreSQL"])
_cut, _dropped = shortlist_skills(_big, _capjd, 10)
check(
    "skills shortlist: 42 entries cut to the cap",
    len(_cut.skills) == 10 and len(_dropped) == 32,
    f"{len(_cut.skills)} kept, {len(_dropped)} dropped",
)
check(
    "skills shortlist: a skill THIS JOB NAMES is never dropped, cap or no cap",
    # cap of 1 against two named skills: both survive. This is the whole reason
    # the ceiling cannot re-open the defect the keyword floor exists to fix.
    set(shortlist_skills(_big, _capjd, 1)[0].skills) >= {"Python", "PostgreSQL"},
    str(shortlist_skills(_big, _capjd, 1)[0].skills),
)
check(
    "skills shortlist: a restored carrier is protected from the cap",
    "Noise7" in shortlist_skills(_big, _capjd, 3, protected=frozenset(["Noise7"]))[0].skills,
)
check(
    "skills shortlist: the model's own order survives the cut",
    _cut.skills == [s for s in _big.skills if s in set(_cut.skills)],
)
check(
    "skills shortlist: the two-field write — a dropped skill leaves its GROUP too",
    all(i in set(_cut.skills) for g in _cut.skill_groups for i in g.items),
    str([(g.label, len(g.items)) for g in _cut.skill_groups]),
)
# THE FALSE-POSITIVE HALF, in three directions. "Cut the skills list" is
# trivially satisfied by cutting always, so each of these is a case where firing
# would be the defect.
check(
    "skills shortlist: a list already under the cap is returned UNTOUCHED, same object",
    shortlist_skills(_big, _capjd, 99)[0] is _big
    and shortlist_skills(_big, _capjd, 0)[0] is _big,
)
check(
    "skills shortlist: a JD naming nothing cannot cut anything",
    shortlist_skills(_big, _AtsJD(), 5)[0] is _big,
)
check(
    "skills shortlist: relevance uses the scorer's matcher, so a Hebrew prefix still matches",
    # The Python twin of check-mirrors 10: ב/ל/ה/ו/מ/ש are word characters, so
    # only the verbatim-substring branch matches פייתון inside בפייתון. A
    # shortlist with its own matcher would drop the carrier as irrelevant — in
    # the primary market.
    _rel("פיתוח בפייתון", ["פייתון"]) == "covered" and _rel("Java", ["JavaScript"]) == "missing",
    f'{_rel("פיתוח בפייתון", ["פייתון"])=} {_rel("Java", ["JavaScript"])=}',
)
# DRIVEN through the shipped pipeline, not called — and the stub has to be made
# to OVERSHOOT first. The first version of this check drove `tailor_resume` with
# the plain stub, which returns a 4-skill résumé: the cap never fired, so it
# passed green and would have gone on passing with the call site in `tailor.py`
# deleted. That is the 21.7 failure mode, caught here only because the PASS line
# printed the count.
_cap_prev = _cap_settings().resume_max_skills
_wide_jd = _AtsJD(hard_skills=["Python", "SQL"], keywords=["REST APIs"])
_bloat_master = ResumeModel(
    contact=Contact(name="A", email="a@b.com"),
    skills=["Python", "SQL", "REST APIs"] + [f"Filler{i}" for i in range(50)],
    experience=[Experience(company="Acme", title="Eng", start_date="2020", end_date="2023",
                           bullets=["Built the API in Python."])],
)


class _BloatClient:
    """Answers TAILOR with the whole 53-entry list — the measured real-model
    behaviour (63.5 shipped against a 66-skill master) — and falls through to
    the stub for every other task."""

    def __init__(self, inner):
        self._inner = inner

    def complete_json(self, system: str, user: str):
        if not system.startswith("Task: TAILOR."):
            return self._inner.complete_json(system, user)
        body = _bloat_master.model_dump()
        body["skill_groups"] = []
        return {"tailored_resume": body, "changelog": [], "covered_keywords": []}

    def complete_text(self, system: str, user: str):
        return self._inner.complete_text(system, user)


_cap_real = _flat_mod.get_llm_client
_flat_mod.get_llm_client = lambda: _BloatClient(_cap_real())
try:
    _capped = tailor_resume(_bloat_master, _wide_jd)
finally:
    _flat_mod.get_llm_client = _cap_real
check(
    "tailor: the shipped pipeline applies the ceiling to a 53-skill response",
    len(_capped.tailored_resume.skills) == _cap_prev,
    f"{len(_capped.tailored_resume.skills)} skills, cap {_cap_prev}",
)
check(
    "tailor: nothing the job named was cut, and the cut is REPORTED, never silent",
    {"Python", "SQL", "REST APIs"} <= set(_capped.tailored_resume.skills)
    and any(c.section == "skills" and "Cut the skills list" in c.change
            for c in _capped.changelog),
    str([c.change for c in _capped.changelog if c.section == "skills"]),
)
# THE CHANGELOG MAY NOT DESCRIBE A DOCUMENT THAT DOES NOT EXIST. Two sentences
# in this entry were false on a rendered CV: it announced the cut as "to the 30
# this job asks for" while the app's OWN `ats_scan` said 19 of those 30 are not
# mentioned by the posting, and it opened "Your master résumé lists 75 skills"
# with a number that is what the MODEL returned (it over-produces on purpose)
# against a 66-entry master. Pinned on the two claims, not on the wording:
# the count named must be the pre-cut list, and the entries named as still being
# in the master must actually BE in it.
_cap_entry = next(c for c in _capped.changelog
                  if c.section == "skills" and c.change.startswith("Cut the skills list"))
check(
    "tailor: the skills changelog counts the DRAFT it cut, not the master",
    f"{len(_bloat_master.skills)} to {len(_capped.tailored_resume.skills)}" in _cap_entry.change
    and "master résumé lists" not in _cap_entry.reason,
    _cap_entry.change,
)
# THE SECOND CLAIM NEEDS ITS OWN FIXTURE, and finding that out is the reason
# this comment is here. Written against `_bloat_master` the check passed by
# never firing: `_BloatClient` answers TAILOR with the master ITSELF, so every
# dropped entry is a master entry by construction and no sample could ever be
# wrong. Probed by making the code name model-invented entries — the defect it
# exists for — and it stayed green.
#
# The real case is a model that writes entries of its own ("orchestration
# patterns", "tool use") and has SOME of them fall outside the cap alongside
# some of the candidate's. The tail is alternated deliberately: a response that
# ends in a solid run of minted entries drops only those, leaves the sample
# empty, and the check passes vacuously again.
_mint_master = ResumeModel(
    contact=Contact(name="A", email="a@b.com"),
    skills=["Python", "SQL", "REST APIs"] + [f"Real{i}" for i in range(20)],
    experience=[Experience(company="Acme", title="Eng", start_date="2020", end_date="2023",
                           bullets=["Built the API in Python."])],
)
_mint_response = (
    ["Python", "SQL", "REST APIs"]
    + [f"Real{i}" for i in range(5)]
    + [x for i in range(15) for x in (f"Minted{i}", f"Real{5 + i}")]
)


class _MintClient(_BloatClient):
    def complete_json(self, system: str, user: str):
        if not system.startswith("Task: TAILOR."):
            return self._inner.complete_json(system, user)
        body = _mint_master.model_dump()
        body["skills"], body["skill_groups"] = list(_mint_response), []
        return {"tailored_resume": body, "changelog": [], "covered_keywords": []}


_flat_mod.get_llm_client = lambda: _MintClient(_cap_real())
try:
    _minted = tailor_resume(_mint_master, _wide_jd)
finally:
    _flat_mod.get_llm_client = _cap_real
_mint_entry = next(c for c in _minted.changelog
                   if c.section == "skills" and c.change.startswith("Cut the skills list"))
_mint_named = [
    n.strip()
    for n in _mint_entry.reason.split("was dropped.")[-1]
    .replace(" and others", "").replace(" stay in your master résumé.", "").split(",")
    if n.strip()
]
check(
    "tailor: the changelog's 'stay in your master résumé' sample names ONLY master entries",
    _mint_named and all(n in {s.strip() for s in _mint_master.skills} for n in _mint_named),
    f"named {_mint_named}",
)
check(
    "tailor: …and the fixture can actually catch it — the cut DID drop minted entries too",
    any(s.startswith("Minted") for s in _mint_response
        if s not in set(_minted.tailored_resume.skills)),
    str([s for s in _mint_response if s not in set(_minted.tailored_resume.skills)]),
)

# 4b-iii. THE CANDIDATE'S OWN WORDS LEAD; THE AD'S FOLLOW.
# `shortlist_skills` ranks by whether the JD names an entry, so a phrase COPIED
# FROM THE AD scores `covered` by construction and outranks the candidate's real
# tools. Measured on a real "AI Engineer, Agentic Workflows" tailor: the first
# twelve chips were `workflow automation`, `LLM systems`, `retrieval`, `tool
# use`, `orchestration patterns`... while OpenAI, RAG, pgvector, MCP, FastAPI
# and SQLAlchemy sat in the tail. `order_skills` is a stable PARTITION of that
# same list -- which is the whole safety argument, since coverage, lost
# keywords, the fabrication flags and the page count are all functions of the
# SET and therefore cannot move.
_ordered = _minted.tailored_resume.skills
_own_at = [i for i, s in enumerate(_ordered) if not s.startswith("Minted")]
_mint_at = [i for i, s in enumerate(_ordered) if s.startswith("Minted")]
check(
    "tailor: the candidate's own skills all precede the wording the model introduced",
    not _own_at or not _mint_at or max(_own_at) < min(_mint_at),
    str(_ordered[:8]) + " ... " + str(_ordered[-4:]),
)
check(
    "tailor: …and BOTH groups are actually present, so the check can fail",
    bool(_own_at) and bool(_mint_at),
    f"{len(_own_at)} own, {len(_mint_at)} introduced",
)
check(
    "tailor: ordering is a PARTITION — the set is byte-identical, so no metric can move",
    sorted(_ordered) == sorted(
        [s for s in _mint_response if s in set(_ordered)][: len(_ordered)]
    ) or sorted(_ordered) == sorted(set(_ordered)) and set(_ordered) <= set(_mint_response),
    f"{len(_ordered)} entries, all from the response: {set(_ordered) <= set(_mint_response)}",
)
check(
    "tailor: the model's relative ranking survives INSIDE each group (stable, not re-sorted)",
    [s for s in _ordered if s.startswith("Minted")]
    == [s for s in _mint_response if s.startswith("Minted") and s in set(_ordered)]
    and [s for s in _ordered if not s.startswith("Minted")]
    == [s for s in _mint_response if not s.startswith("Minted") and s in set(_ordered)],
    str([s for s in _ordered if s.startswith("Minted")][:5]),
)
# THE FALSE-POSITIVE HALF: a guard with nothing to say returns what it was given,
# the identity convention `shortlist_skills` and `preserve_keywords` share.
# Without this, "own words lead" is trivially satisfied by rewriting every list.
_all_own = ResumeModel(contact=Contact(name="A", email="a@b.com"), skills=["Go", "Rust", "C"])
_all_foreign = ResumeModel(contact=Contact(name="A", email="a@b.com"), skills=["X1", "X2"])
check(
    "tailor: the reorder is REPORTED — the model's own changelog claims the opposite order",
    any(c.section == "skills" and "Put your own wording first" in c.change
        for c in _minted.changelog),
    str([c.change for c in _minted.changelog if c.section == "skills"]),
)
# THE FALSE-POSITIVE HALF. `_BloatClient` answers TAILOR with the master itself,
# so every entry is the candidate's own and `order_skills` moves NOTHING —
# claiming a reorder there is a changelog describing a document that does not
# exist, which is the defect the entry above this one was written to answer.
check(
    "tailor: …and NOT claimed when nothing moved (every entry is already the candidate's)",
    not any(c.section == "skills" and "Put your own wording first" in c.change
            for c in _capped.changelog),
    str([c.change for c in _capped.changelog if c.section == "skills"]),
)
# 4b-iv. THE SECOND DOOR. `humanizer.py` validates its OWN raw LLM résumé and
# `tailor_resume` accepts it AFTER the dedupe has already run, so a repeat the
# polish pass introduces sails past a guard that finished earlier. The humanizer
# is pointed straight at this list — `voice_audit` scans the joined skills for
# banned phrases — so it rewords entries routinely, and two rewordings colliding
# on one string IS the duplicate. Found by review, after the first fix shipped.
#
# PATCHED ON `app.core.humanizer`, not on `tailor`: humanizer.py does its own
# `from app.llm.client import get_llm_client`, so the name is already bound in
# ITS namespace and patching the caller's is a no-op that reads as a pass.
import app.core.humanizer as _hum_mod  # noqa: E402

_dup_hum_master = ResumeModel(
    contact=Contact(name="A", email="a@b.com"),
    skills=["Python", "SQL", "Go"],
    # A banned word is what makes the humanizer FIRE at all; without an issue to
    # fix, `tailor_resume` never calls it and this check passes by never firing.
    experience=[Experience(company="Acme", title="Eng", start_date="2020", end_date="2023",
                           bullets=["Leveraged Python to build the API."])],
)


class _HumDupClient(_BloatClient):
    """Answers TAILOR clean and HUMANIZE with repeats — the measured shape."""

    def complete_json(self, system: str, user: str):
        if system.startswith("Task: HUMANIZE."):
            body = _dup_hum_master.model_dump()
            body["skills"] = ["Python", "SQL", "python", "Go", "  Python  ", "Go"]
            body["skill_groups"] = []
            body["experience"][0]["bullets"] = ["Built the API in Python."]
            return {"revised_resume": body}
        if not system.startswith("Task: TAILOR."):
            return self._inner.complete_json(system, user)
        body = _dup_hum_master.model_dump()
        body["skill_groups"] = []
        return {"tailored_resume": body, "changelog": [], "covered_keywords": []}


_hum_real = _hum_mod.get_llm_client
_flat_mod.get_llm_client = lambda: _HumDupClient(_cap_real())
_hum_mod.get_llm_client = lambda: _HumDupClient(_cap_real())
try:
    _humdup = tailor_resume(_dup_hum_master, _wide_jd)
finally:
    _flat_mod.get_llm_client, _hum_mod.get_llm_client = _cap_real, _hum_real
_hs = _humdup.tailored_resume.skills
check(
    "tailor: a duplicate the HUMANIZER introduced does not ship either (the second door)",
    len(_hs) == len({s.strip().casefold() for s in _hs}),
    str(_hs),
)
check(
    "tailor: …and the humanizer fixture really did run, or the check above proves nothing",
    _humdup.voice_report.revised,
    f"revised={_humdup.voice_report.revised} issues={len(_humdup.voice_report.issues)}",
)

# 4b-v. THE ORDER IS APPLIED ONLY IF IT COSTS NOTHING, and this is the check that
# stops a Hebrew regression. `scorer._resume_text` joins skills with a SPACE and
# `_keyword_present` tries the verbatim phrase FIRST, so a multi-word JD keyword
# can match ACROSS the join between two adjacent entries — and Hebrew's ב/ל/ה/ו/מ/ש
# prefixes mean the token fallback does not rescue it. Measured: the same set,
# reordered, scores 100.0 then 50.0. So `tailor_resume` measures coverage and the
# page count either side of the reorder and keeps the old order when the new one
# is worse.
_he_jd = _AtsJD(hard_skills=["פייתון מתקדם"], keywords=[])
_he_master = ResumeModel(
    contact=Contact(name="A", email="a@b.com"),
    skills=["מתקדם"],
    experience=[Experience(company="Acme", title="Eng", start_date="2020", end_date="2023",
                           bullets=["בניתי מערכת."])],
)


class _HeClient(_BloatClient):
    def complete_json(self, system: str, user: str):
        if not system.startswith("Task: TAILOR."):
            return self._inner.complete_json(system, user)
        body = _he_master.model_dump()
        # 'בפייתון' is NOT in the master, so `order_skills` wants to move it last
        # -- which breaks the cross-join match and halves coverage.
        body["skills"], body["skill_groups"] = ["בפייתון", "מתקדם"], []
        return {"tailored_resume": body, "changelog": [], "covered_keywords": []}


_flat_mod.get_llm_client = lambda: _HeClient(_cap_real())
try:
    _he = tailor_resume(_he_master, _he_jd)
finally:
    _flat_mod.get_llm_client = _cap_real
check(
    "tailor: a reorder that would COST keyword coverage is refused — Hebrew, the primary market",
    _he.tailored_resume.skills == ["בפייתון", "מתקדם"],
    str(_he.tailored_resume.skills),
)
check(
    "tailor: …and the refusal is silent — no reorder is claimed in the changelog",
    not any(c.section == "skills" and "Put your own wording first" in c.change
            for c in _he.changelog),
    str([c.change for c in _he.changelog if c.section == "skills"]),
)

check(
    "skills order: a list with nothing to move is returned UNTOUCHED, same object",
    _order_mod.order_skills(_all_own, _all_own) is _all_own
    and _order_mod.order_skills(_all_foreign, _all_own) is _all_foreign
    and _order_mod.order_skills(_all_own, ResumeModel(contact=Contact(name="A"))) is _all_own,
)

# 4b-ii. A SKILL MAY NOT BE DRAWN TWICE, AND A DUPLICATE MAY NOT BUY A CAP SLOT.
# Measured on the shipped config: 3 of 12 real-key runs returned the same entry
# twice and every one shipped it — `skill_blocks` hands the flat list straight to
# both renderers, so it is a chip drawn twice on the page the user sends.
# `ResumeModel`'s union validator cannot see it (it seeds `seen` FROM the flat
# list), and `shortlist_skills` counts the cap against a SET while emitting a
# LIST, so cap 30 shipped 31 and 32.
#
# DRIVEN, for the `_BloatClient` reason above: a check that called
# `_dedupe_skills` directly would still pass with the call site deleted.
_dup_master = ResumeModel(
    contact=Contact(name="A", email="a@b.com"),
    # `python` and `  Python  ` are the same chip on the page; the cap counts
    # them as three. Interleaved, so first-wins ORDER is pinned too.
    skills=["Python", "SQL", "python", "REST APIs", "  Python  ", "Go"],
    experience=[Experience(company="Acme", title="Eng", start_date="2020", end_date="2023",
                           bullets=["Built the API in Python."])],
)


class _DupClient(_BloatClient):
    def complete_json(self, system: str, user: str):
        if not system.startswith("Task: TAILOR."):
            return self._inner.complete_json(system, user)
        body = _dup_master.model_dump()
        body["skill_groups"] = []
        return {"tailored_resume": body, "changelog": [], "covered_keywords": []}


_flat_mod.get_llm_client = lambda: _DupClient(_cap_real())
try:
    _deduped = tailor_resume(_dup_master, _wide_jd)
finally:
    _flat_mod.get_llm_client = _cap_real
_dshipped = _deduped.tailored_resume.skills
check(
    "tailor: a duplicated skill is drawn once — case and padding included",
    len(_dshipped) == len({s.strip().casefold() for s in _dshipped}),
    str(_dshipped),
)
check(
    "tailor: the dedupe only ever REMOVES — first occurrence keeps its place and spelling",
    _dshipped == ["Python", "SQL", "REST APIs", "Go"],
    str(_dshipped),
)
# THE FALSE-POSITIVE HALF is the check above this block, and it is load-bearing:
# "no duplicates" is trivially satisfied by mangling every list. `_bloat_master`
# has 53 DISTINCT entries, so the changelog's pre-cut count must still read 53 —
# if the dedupe ever removed from a clean list, that number would fall and the
# "counts the DRAFT it cut" check goes red. Nothing else needs to run for it.
check(
    "tailor: a skills payload that is not a list of strings still fails VALIDATION, not the dedupe",
    _skills_mod.dedupe_skills("Python, SQL") == "Python, SQL"
    and _skills_mod.dedupe_skills(["Python", 7]) == ["Python", 7]
    and _skills_mod.dedupe_skills(None) is None,
)

# 4c. THE POOLED CALLS STILL REPORT THEIR TOKENS.
# `tailor_resume` runs two pairs of LLM calls concurrently (score_before ∥
# plan_cv). The second pair was credibility ∥ score_after; CREDIBILITY was
# REMOVED, so `score_after` is inline now and this pins the surviving pair.
# A ThreadPoolExecutor worker starts from an EMPTY context, so a bare
# `pool.submit(fn, ...)` instead of `pool.submit(copy_context().run, fn, ...)`
# makes four of the five calls invisible to `metering` and their tokens vanish
# from `usage_log` -- silently, with the tailor still returning a perfect result.
# Nothing else in the app would notice; the bill would just be wrong.
#
# Driven through the real function inside a real meter, because that is the only
# thing that can tell the two spellings apart.
# BEHAVIOUR CANNOT PIN THIS, and finding that out is half the check. Driving
# `tailor_resume` inside a real `metering.meter()` reports 0 calls and 0 tokens
# whether the submits are right or wrong -- because this suite runs on
# `StubClient`, and only `OpenAIClient` calls `metering.record()`. A behavioural
# assertion here would have been red on correct code, then "fixed" by weakening
# it into something that never fires. So the SOURCE is parsed instead, the same
# answer the keyword-guard and geo-restriction pins reached for the same reason.
import ast as _pool_ast  # noqa: E402
import inspect as _pool_inspect  # noqa: E402

import app.core.tailor as _pool_mod  # noqa: E402

_POOL_SUBMITS = [
    n for n in _pool_ast.walk(_pool_ast.parse(_pool_inspect.getsource(_pool_mod)))
    if isinstance(n, _pool_ast.Call)
    and isinstance(n.func, _pool_ast.Attribute)
    and n.func.attr == "submit"
]


def _is_copy_context_run(call: _pool_ast.Call) -> bool:
    """First argument must be `copy_context().run` — anything else is a bare
    submit, and a bare submit loses the tokens."""
    if not call.args:
        return False
    a = call.args[0]
    return (
        isinstance(a, _pool_ast.Attribute)
        and a.attr == "run"
        and isinstance(a.value, _pool_ast.Call)
        and isinstance(a.value.func, _pool_ast.Name)
        and a.value.func.id == "copy_context"
    )


check(
    "tailor: every pooled LLM call is submitted through copy_context().run — a bare "
    "submit starts the worker from an EMPTY context and its tokens vanish from usage_log",
    # EXACT COUNT, never `>= 1` and never `all(...)` alone: `all()` over an
    # empty list is True, so a count-free pin passes vacuously on a file with
    # no submits at all.
    len(_POOL_SUBMITS) == 2 and all(_is_copy_context_run(c) for c in _POOL_SUBMITS),
    f"{len(_POOL_SUBMITS)} submits, "
    f"{sum(1 for c in _POOL_SUBMITS if _is_copy_context_run(c))} context-copied",
)

# 5. Fabrication guard catches an injected fake employer
fake = result.tailored_resume.model_copy(deep=True)
fake.experience.append(Experience(company="FAKE Industries Ltd", title="CEO", start_date="2010", end_date="2019"))
flags = check_fabrication(fake, ledger)
flagged_employers = [f.value for f in flags if f.category == "employer"]
check("guard flags fabricated employer", "FAKE Industries Ltd" in flagged_employers, str(flagged_employers))

# 5a. Numbers inside PROJECTS are guarded too (PLAN 20.5 / C1). The ledger read
# experience, education, certifications, military and the summary but never
# projects, so a metric invented into a project bullet passed silently — and
# because the omission was symmetric (the guard rebuilds the ledger the same way
# from the tailored résumé) nothing ever went red to reveal it. The false-
# positive cases are pinned alongside the catch: this must not start firing on
# the rewording and re-homing the tailor is explicitly allowed to do.
_pj_orig = ResumeModel(
    experience=[
        Experience(company="Acme", title="Engineer", start_date="2020", end_date="2023",
                   bullets=["Cut latency 30%."])
    ],
    projects=[
        Project(name="Ziko", description="Delivery app serving 12 restaurants.",
                bullets=["Handled 500 orders/week."])
    ],
)
_pj_ledger = build_facts_ledger(_pj_orig)
check(
    "ledger records numbers from project text",
    {"12", "500"} <= set(_pj_ledger.numbers),
    str(_pj_ledger.numbers),
)


def _pj_numbers(mutate) -> list[str]:  # noqa: ANN001
    r = _pj_orig.model_copy(deep=True)
    mutate(r)
    return [f.value for f in check_fabrication(r, _pj_ledger) if f.category == "number"]


def _set_project_bullet(text: str):  # noqa: ANN001
    return lambda r: r.projects[0].bullets.__setitem__(0, text)


check(
    "guard flags a metric invented into a project bullet",
    _pj_numbers(_set_project_bullet("Handled 50,000 orders/week.")) == ["50,000"],
    str(_pj_numbers(_set_project_bullet("Handled 50,000 orders/week."))),
)
check(
    "rewording a real project metric is NOT flagged",
    _pj_numbers(_set_project_bullet("Processed 500 orders every week for the client.")) == [],
)
check(
    "a metric moved from experience into a project is NOT flagged",
    _pj_numbers(_set_project_bullet("Cut latency 30% on the ordering path.")) == [],
)
check("an untouched résumé stays clean under the project guard", _pj_numbers(lambda r: None) == [])

# 5b. Target-title headline (PLAN 17.2). The headline is a CLAIM, so the guard
# reads it — but only for rank. Restating the same work in the target role's
# words is the entire point of the line; awarding yourself a promotion is not.
check(
    "ledger keeps the headline apart from employment titles",
    ledger.headlines == [resume.headline] if resume.headline else ledger.headlines == [],
    f"headlines={ledger.headlines} titles={ledger.titles}",
)


def _headline_flags(headline: str, base=None, led=None) -> list[str]:
    r = (base or result.tailored_resume).model_copy(deep=True)
    r.headline = headline
    return [f.value for f in check_fabrication(r, led or ledger) if f.category == "headline"]


check("guard: repositioned headline is clean", _headline_flags("Backend Engineer") == [])
check("guard: empty headline is clean", _headline_flags("") == [])
check(
    "guard: headline that awards a promotion is flagged",
    _headline_flags("Senior Backend Engineer") == ["Senior Backend Engineer"],
    str(_headline_flags("Senior Backend Engineer")),
)
check(
    "guard: rank words only match whole words ('Leading' is not 'Lead')",
    _headline_flags("Leading Contributor") == [],
)
check(
    "guard: hebrew rank inflation is caught too",
    _headline_flags("מהנדס תוכנה בכיר") == ["מהנדס תוכנה בכיר"],
)
_senior = result.tailored_resume.model_copy(deep=True)
_senior.experience[0].title = "Senior Engineer"
check(
    "guard: a candidate who really is senior keeps the rank",
    _headline_flags("Senior Backend Engineer", _senior, build_facts_ledger(_senior)) == [],
)
check(
    "tailor stub sets a headline and it survives the guard",
    result.tailored_resume.headline != ""
    and [f for f in result.fabrication_flags if f.category == "headline"] == [],
    result.tailored_resume.headline,
)
check(
    "TAILOR prompt forbids promoting the headline; STRUCTURE prompt copies it verbatim",
    "NEVER promote" in _li_prompts.TAILOR_SYSTEM
    and "headline" in _li_prompts.STRUCTURE_RESUME_SYSTEM,
)

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
# It takes an ANALYSED JDModel and never job-ad text: /tools/ats-scan is
# uncapped because nothing in it reaches the model, and accepting text would
# force it to (see ATSScanRequest).
from app.models import JDModel as _AtsJD  # noqa: E402

ats = scan_resume(resume, _AtsJD(hard_skills=["Python", "SQL", "REST APIs"], keywords=["Python", "SQL"]))
check("ats scan produced issues + score", len(ats.issues) > 0 and 0 <= ats.score <= 100, str(ats.score))

# 10a. The skills-count verdict is TWO-SIDED, and only when there is a job to be
# two-sided about. The version this replaced returned severity="good" for any
# count at or above five with no upper bound, so a measured 79-skill tailored CV
# — against a 66-skill master — was told "79 skills listed: good", while the
# owner's actual complaint was that the section was overstuffed and the TAILOR
# prompt thirty lines away asked for 15-25.
#
# THE FALSE-POSITIVE PIN IS THE FIRST ONE AND IT IS THE POINT. A master résumé
# listing 66 skills is an inventory, which is what a master is FOR; warning on it
# would be a guard firing on legitimate input. So the bound exists only when a JD
# does, and "make the long list warn" is NOT trivially satisfiable by warning on
# length.
_inventory = ResumeModel(
    contact=Contact(name="A", email="a@b.com", phone="050"),
    skills=[f"Skill{i}" for i in range(60)] + ["Python", "SQL"],
)
_narrow_jd = _AtsJD(hard_skills=["Python"], keywords=["SQL"])
_skill_verdict = lambda r, j=None: next(  # noqa: E731
    i for i in scan_resume(r, j).issues if "skill" in i.label.lower() and "sentence" not in i.label
)
check(
    "ats scan: a 62-skill master with NO job is an inventory, not a defect",
    _skill_verdict(_inventory).severity == "good",
    _skill_verdict(_inventory).label,
)
check(
    "ats scan: the SAME résumé against a job it mostly does not match warns",
    _skill_verdict(_inventory, _narrow_jd).severity == "warn"
    and "60" in _skill_verdict(_inventory, _narrow_jd).detail,
    _skill_verdict(_inventory, _narrow_jd).label,
)
_focused = ResumeModel(
    contact=Contact(name="A", email="a@b.com", phone="050"),
    skills=["Python", "SQL", "REST APIs", "PostgreSQL", "Docker"],
)
check(
    "ats scan: a focused list is not punished for being short",
    _skill_verdict(_focused, _AtsJD(hard_skills=["Python", "SQL", "PostgreSQL"])).severity == "good",
    _skill_verdict(_focused, _AtsJD(hard_skills=["Python", "SQL", "PostgreSQL"])).label,
)
check(
    "ats scan: fewer than five skills still reads as too few, JD or not",
    _skill_verdict(ResumeModel(skills=["Python", "SQL"]), _narrow_jd).severity == "warn"
    and _skill_verdict(ResumeModel(skills=["Python", "SQL"])).severity == "warn",
)
# The verdict is REPLACED, never appended: `format_health` is good/len(issues),
# so a JD-only issue would give the same document a different FORMAT health
# depending on which job it was aimed at — and whether the paper parses has
# nothing to do with that.
check(
    "ats scan: supplying a JD does not change how many issues there are",
    len(scan_resume(_inventory).issues) == len(scan_resume(_inventory, _narrow_jd).issues),
    f"{len(scan_resume(_inventory).issues)} vs {len(scan_resume(_inventory, _narrow_jd).issues)}",
)

# 10b. Deeper ATS checks (PLAN 17.4) — all deterministic, all explainable, and
# all reporting rather than rewriting. Each is pinned on a résumé that trips it
# AND one that does not, so a check that silently always fires can't hide.
from app.core.dates import ats_form, is_current, parse_date, years_of_experience  # noqa: E402

check(
    "dates: the ATS-safe form is derived, and a bare year is never given an invented month",
    ats_form("03/2020") == "Mar 2020"
    and ats_form("March 2020") == "Mar 2020"
    and ats_form("מרץ 2020") == "Mar 2020"
    and ats_form("2020") == "2020"
    and ats_form("summer of 2019") == "2019"
    and ats_form("sometime") == ""
    and ats_form("היום") == "Present",
    f'{ats_form("summer of 2019")=} {ats_form("2020")=}',
)
check(
    "dates: hebrew and english 'still there' words both read as current",
    is_current("Present") and is_current("היום") and not is_current("2020"),
)
check(
    "dates: concurrent roles are unioned, not summed",
    years_of_experience(
        ResumeModel(experience=[
            Experience(company="A", start_date="2020", end_date="2024"),
            Experience(company="B", start_date="2021", end_date="2023"),
        ])
    ) == 4.0,
    str(years_of_experience(ResumeModel(experience=[
        Experience(company="A", start_date="2020", end_date="2024"),
        Experience(company="B", start_date="2021", end_date="2023"),
    ]))),
)


def _ats_labels(r: ResumeModel, severity: str | None = None) -> set[str]:
    return {i.label for i in scan_resume(r).issues if severity is None or i.severity == severity}


_messy = ResumeModel(
    contact=Contact(name="A", email="a@b.com", phone="050"),
    summary="I lead ML work and my focus is CI/CD.",
    skills=["Python", "SQL", "Docker", "Git", "Linux"],
    experience=[Experience(
        company="Acme", title="Eng", start_date="summer of 2019", end_date="sometime",
        bullets=["Did.", "Shipped a thing."],
    )],
)
_messy_warn = _ats_labels(_messy)
check(
    "ats 17.4: unreadable dates, unpaired acronyms, pronouns and stub bullets all surface",
    "Unreadable employment dates" in _messy_warn
    and "Pair each acronym with its long form once" in _messy_warn
    and "Drop the first-person pronouns" in _messy_warn
    and "Some bullets are the wrong length" in _messy_warn,
    str(sorted(_messy_warn)),
)
_tidy = ResumeModel(
    contact=Contact(name="A", email="a@b.com", phone="050"),
    summary="Backend engineer building payment services.",
    skills=["Python", "SQL", "FastAPI", "Docker", "Git"],
    experience=[Experience(
        company="Acme", title="Eng", start_date="Mar 2019", end_date="Present",
        bullets=["Cut checkout latency from 840ms to 210ms across 1.2M monthly transactions.",
                 "Reduced failed charges by 38% with an idempotent retry pipeline."],
    )],
)
_tidy_good = _ats_labels(_tidy, "good")
check(
    "ats 17.4: a clean résumé passes every new check (no always-on warnings)",
    {"Dates are in an ATS-readable format", "Acronyms are spelled out",
     "No first-person pronouns", "Bullet lengths are well judged",
     "Length suits the experience"} <= _tidy_good,
    str(sorted(_ats_labels(_tidy) - _tidy_good)),
)
check(
    "ats 17.4: 'I' is matched as a word, not inside other words",
    "Drop the first-person pronouns" not in _ats_labels(
        _tidy.model_copy(update={"summary": "Migrated it, improved it, integrated it."})
    ),
)
# 10b-bis (PLAN 07/9). A SKILL WRITTEN AS A SENTENCE. `structure_resume` splits
# the entries a CV PUNCTUATED as a list (see the normalisation checks in 18e); a
# sentence carries no separator, so nothing may split it and nothing may shorten
# it — that would be truncating the user's own document. This is where that case
# belongs instead: the route is uncapped and this module reaches no model, so it
# can report what it cannot fix. The false-positive half matters most — the
# user's own longest real entries run to FOUR words and their CV must stay green,
# or a warning that always fires teaches them to ignore the panel.
_sentence_skill_cv = _tidy.model_copy(update={"skills": [
    "Designing and operating distributed backend systems at scale", *_tidy.skills,
]})
_real_skill_cv = _tidy.model_copy(update={"skills": [
    "CI/CD", "prompt and system design", "evaluation and fallback handling",
    "RTL and i18n", "Python",
]})
_sentence_skills_before = list(_sentence_skill_cv.skills)
_sentence_labels = _ats_labels(_sentence_skill_cv)
check(
    "ats: a skill written as a sentence is REPORTED and left untouched, while "
    "four-word entries from a real résumé stay green",
    "Some skills are written as sentences" in _sentence_labels
    and "Skills read as terms, not sentences" in _ats_labels(_real_skill_cv, "good")
    and "Some skills are written as sentences" not in _ats_labels(_real_skill_cv)
    # The scanner reports; it never rewrites. Pinned because "fix the sentence"
    # is the tempting next step and it is data loss in the user's own words.
    and _sentence_skill_cv.skills == _sentence_skills_before,
    str(sorted(_sentence_labels)),
)

# 10c. Section order by profile (PLAN 17.5): education outranks experience for
# an early-career résumé, and both renderers follow the same rule.
from app.core.section_order import EARLY_CAREER_ORDER, EXPERIENCED_ORDER, is_early_career, section_order  # noqa: E402

_senior = ResumeModel(
    contact=Contact(name="S"), summary="x", skills=["Python"],
    experience=[Experience(company="A", title="Eng", start_date="2015", end_date="2024", bullets=["Did work."])],
    education=[Education(institution="TAU", degree="BSc", start_date="2011", end_date="2014")],
)
_student = _senior.model_copy(deep=True)
_student.experience = [Experience(company="A", title="Intern", start_date="2025", end_date="2026", bullets=["Did work."])]
_student.education = [Education(institution="TAU", degree="BSc", start_date="2023", end_date="")]
_no_jobs = _senior.model_copy(deep=True)
_no_jobs.experience = []
_no_school = _senior.model_copy(deep=True)
_no_school.education = []
_no_school.experience = [Experience(company="A", title="Eng", start_date="2025", end_date="2026", bullets=["Did work."])]
check(
    "17.5: early-career = still studying, no jobs yet, or under 3 years",
    is_early_career(_student) and is_early_career(_no_jobs)
    and not is_early_career(_senior) and not is_early_career(_no_school),
    f"student={is_early_career(_student)} nojobs={is_early_career(_no_jobs)} "
    f"senior={is_early_career(_senior)} noschool={is_early_career(_no_school)}",
)
check(
    "17.5: the two orders differ only in where education sits",
    section_order(_senior) == EXPERIENCED_ORDER
    and section_order(_student) == EARLY_CAREER_ORDER
    and set(EARLY_CAREER_ORDER) == set(EXPERIENCED_ORDER),
)
_old_blank = _senior.model_copy(deep=True)
_old_blank.education = [Education(institution="TAU", degree="BSc", start_date="2005", end_date="")]
check(
    "17.5: a blank end date on an OLD degree means unfilled, not 'still studying'",
    not is_early_career(_old_blank),
    str(section_order(_old_blank)[:4]),
)
_no_dates = _senior.model_copy(deep=True)
_no_dates.education = [Education(institution="TAU", degree="BSc")]
check(
    "17.5: a degree with no dates at all makes no claim either way",
    not is_early_career(_no_dates),
)


# The rendered proof of 17.5 lives with the other render checks (section 18b),
# where the PDF text extractor is in scope.

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
    [(loc, mode) for _, loc, mode, _o in _board_queries(WORLDWIDE_BOARD, _wctx)]
    == [("Tel Aviv", "remote")] + [(loc, "remote") for loc in WORLDWIDE_REMOTE_LOCATIONS],
    str(_board_queries(WORLDWIDE_BOARD, _wctx)),
)
check(
    "worldwide remote: local boards never see worldwide locations",
    [(loc, mode) for _, loc, mode, _o in _board_queries("drushim", _wctx)]
    == [("Tel Aviv", "remote")],
    str(_board_queries("drushim", _wctx)),
)
_wctx_any = _resolve_context(
    resume,
    SearchContext(job_title="Dev", location="Tel Aviv", work_mode="any", include_worldwide=True),
)
check(
    "worldwide with 'any': local location stays 'any', worldwide forced remote-only",
    [(loc, mode) for _, loc, mode, _o in _board_queries(WORLDWIDE_BOARD, _wctx_any)]
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
    [(loc, mode) for _, loc, mode, _o in _board_queries(WORLDWIDE_BOARD, _wctx_onsite)]
    == [("Tel Aviv", "onsite")],
    str(_board_queries(WORLDWIDE_BOARD, _wctx_onsite)),
)
# The origin stamp (the geo-restriction gate's input): "" for the user's own
# location, the market name for each worldwide query. Carried by _board_queries
# rather than inferred downstream, because with several keywords the local
# location recurs at index 0, len(locations), 2*len(locations)…
check(
    "worldwide queries stamp their origin market; the local query stamps nothing",
    [o for _t, _l, _m, o in _board_queries(WORLDWIDE_BOARD, _wctx)]
    == [""] + WORLDWIDE_REMOTE_LOCATIONS,
    str([o for _t, _l, _m, o in _board_queries(WORLDWIDE_BOARD, _wctx)]),
)
check(
    "a local board's every query stamps an empty origin market",
    [o for _t, _l, _m, o in _board_queries("drushim", _wctx)] == [""],
    str([o for _t, _l, _m, o in _board_queries("drushim", _wctx)]),
)
check(
    "include_worldwide off: every stamp is empty, so the geo classifier is unreachable",
    {o for _t, _l, _m, o in _board_queries(WORLDWIDE_BOARD, _resolve_context(resume, None))}
    == {""},
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
    "unchecked global board is never queried — worldwide pass included (PLAN 15.9)",
    _board_queries(WORLDWIDE_BOARD, _wctx_only) == [],
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

# 14b-4. Relevance-first selection (PLAN 15.6): title_relevance is a pure
# Hebrew-aware query↔title match; the fan-out fills the limit fresh+relevant
# → stale+relevant (marked stale) → fresh+loose, dropping stale+irrelevant.
from app.core.job_search import select_hits, tiered_by_source  # noqa: E402
from app.core.relevance import RELEVANT_MIN, title_relevance  # noqa: E402

check(
    "relevance: exact and reordered title matches score 1.0",
    title_relevance("Senior Software Engineer", ["Software Engineer"]) == 1.0
    and title_relevance("Engineer, Software (TLV)", ["Software Engineer"]) == 1.0,
)
check(
    "relevance: english query matches hebrew title via aliases (and reverse)",
    title_relevance("מהנדס/ת תוכנה", ["Software Engineer"]) == 1.0
    and title_relevance("Software Engineer", ["מהנדס תוכנה"]) == 1.0,
)
check(
    "relevance: suffix-tolerant (engineering/מהנדסת) but java≠javascript",
    title_relevance("Software Engineering Lead", ["Software Engineer"]) == 1.0
    and title_relevance("מהנדסת תוכנה", ["מהנדס תוכנה"]) == 1.0
    and title_relevance("JavaScript Developer", ["Java Developer"]) < 1.0,
)
check(
    "relevance: unrelated title scores below the relevance floor",
    title_relevance("Product Manager", ["Software Engineer"]) < RELEVANT_MIN
    and title_relevance("Sales Representative", ["Backend Developer"]) < RELEVANT_MIN,
)
check(
    "relevance: best keyword wins in multi-keyword searches",
    title_relevance("Data Engineer", ["Product Manager", "Data Engineer"]) == 1.0,
)

_rel_now = _dtc.fromisoformat("2026-07-21T12:00")
_rel_hits = {
    "boardA": [
        JobHit(source="boardA", title="Backend Engineer", company="FreshCo",
               url="https://a/fresh-rel", posted_at="2026-07-20"),
        JobHit(source="boardA", title="Office Manager", company="NoiseCo",
               url="https://a/fresh-noise", posted_at="2026-07-21"),
        JobHit(source="boardA", title="Backend Engineer", company="OldCo",
               url="https://a/old-rel", posted_at="2026-05-10"),
        JobHit(source="boardA", title="Accountant", company="OldNoiseCo",
               url="https://a/old-noise", posted_at="2026-05-11"),
    ],
}
_tiers = tiered_by_source(_rel_hits, ["Backend Engineer"], 30, now=_rel_now)
check(
    "tiering: fresh-relevant / stale-relevant / fresh-loose split, stale-irrelevant dropped",
    [h.url for h in _tiers[0]["boardA"]] == ["https://a/fresh-rel"]
    and [h.url for h in _tiers[1]["boardA"]] == ["https://a/old-rel"]
    and [h.url for h in _tiers[2]["boardA"]] == ["https://a/fresh-noise"],
    str([{k: [h.url for h in v] for k, v in t.items()} for t in _tiers]),
)
check(
    "tiering: stale-relevant hits carry the stale flag, fresh ones don't",
    _tiers[1]["boardA"][0].stale is True
    and _tiers[0]["boardA"][0].stale is False
    and _tiers[2]["boardA"][0].stale is False,
)
_sel = select_hits(_tiers, 3)
check(
    "selection: old-but-relevant outranks fresh-but-irrelevant",
    [h.url for h in _sel]
    == ["https://a/fresh-rel", "https://a/old-rel", "https://a/fresh-noise"],
    str([h.url for h in _sel]),
)
check(
    "selection: limit filled by relevance tier first",
    [h.url for h in select_hits(_tiers, 2)]
    == ["https://a/fresh-rel", "https://a/old-rel"],
)
check(
    "tiering: max_age_days=0 means nothing is stale",
    tiered_by_source(_rel_hits, ["Backend Engineer"], 0, now=_rel_now)[1] == {},
)
_dup_tiers = tiered_by_source(
    {
        "boardA": [JobHit(source="boardA", title="Backend Engineer", company="Acme",
                          url="https://a/dup", posted_at="2026-07-20")],
        "boardB": [JobHit(source="boardB", title="Backend Engineer", company="Acme Ltd",
                          url="https://b/dup", posted_at="2026-05-01")],
    },
    ["Backend Engineer"],
    30,
    now=_rel_now,
)
_dup_sel = select_hits(_dup_tiers, 10)
check(
    "selection: cross-tier duplicate becomes an also_on link, not a second row",
    len(_dup_sel) == 1
    and _dup_sel[0].url == "https://a/dup"
    and [a["url"] for a in _dup_sel[0].also_on] == ["https://b/dup"],
    str([(h.url, h.also_on) for h in _dup_sel]),
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

# 14b-4. Geographic hiring restrictions (the worldwide-remote fix): a posting
# that STATES it hires only in a country an Israeli cannot work is caught
# deterministically, before the scoring LLM call. High precision, low recall by
# design — under-flagging is the safe direction, and every catch is pinned next
# to the legitimate input that must NOT trip it. See app/core/geo_restriction.py.
import inspect as _geo_inspect  # noqa: E402

from app.core import geo_restriction as _geo_mod  # noqa: E402
from app.core.geo_restriction import (  # noqa: E402
    BLOCKING_KINDS as _GEO_BLOCKING,
    detect_geo_restriction as _geo,
)
from app.models import GeoRestriction as _GeoR  # noqa: E402

_F = _GeoR()  # the "nothing stated" sentinel, so `(verdict or _F).kind` reads cleanly

check(
    "geo: US work-authorization requirement is caught, scoped and blocking",
    (_g := _geo("Applicants must be legally authorized to work in the United States.")) is not None
    and _g.kind == "work_auth" and _g.scope == "us" and _g.blocking is True,
    str(_g),
)
check(
    "geo: a refused UK visa route is scoped from the regime, not the document",
    (_g := _geo("We are unable to offer Skilled Worker sponsorship for this role.")) is not None
    and _g.kind == "work_auth" and _g.scope == "uk" and _g.blocking is True,
    str(_g),
)
check(
    "geo: citizenship, export control and in-country residency each caught",
    (_geo("U.S. citizens only due to federal contract requirements.") or _F).kind == "citizenship"
    and (_geo("Must qualify as a U.S. Person under ITAR.") or _F).kind == "clearance"
    and (_geo("Candidates must reside in the United States.") or _F).kind == "residency"
    and (_geo("This role is remote within Canada.") or _F).kind == "residency",
)
check(
    "geo: a (Remote - UK) title tag is caught from the title alone",
    (_g := _geo("", title="Backend Engineer (Remote - UK)")) is not None
    and _g.kind == "title_tag" and _g.scope == "uk" and _g.blocking is True,
    str(_g),
)
# ONE check, deliberately: split across several, "make the US case pass" is
# trivially satisfied by over-matching. Every string here is legitimate input a
# naive matcher fires on, and each one hides real jobs when it does.
check(
    "geo: business prose, common words, offered sponsorship and tautologies never fire",
    _geo("Our customers are in the US and our team is US-based.") is None
    and _geo("Please contact us - we would love to hear from you.") is None
    and _geo("Compensation is paid in USD.") is None
    and _geo("We are happy to sponsor visas for the right candidate.") is None
    and _geo("Visa sponsorship is available for exceptional candidates.") is None
    and _geo("Applicants must be authorized to work in the country where the role is based.") is None
    and _geo("Relocation package offered.") is None
    and _geo("Headquartered in the United States, with an office in New York.") is None
    and _geo("", title="US Sales Manager") is None
    and _geo("", location="Chicago, IL") is None
    and _geo("", location="New York, NY") is None
    and _geo("", location="London, England, United Kingdom") is None
    and _geo("") is None,
)
# The polarity trap: "No visa sponsorship IS AVAILABLE" contains the allow
# phrase verbatim. A suppressor that matches it reads the sentence backwards
# and silently clears the commonest US-only phrasing there is.
check(
    "geo: a negated allow-phrase still fires; the un-negated one still suppresses",
    (_geo("No visa sponsorship is available for this position.") or _F).blocking is True
    and (_geo("Sponsorship is not available for this role.") or _F).blocking is True
    and _geo("Sponsorship is available for this role.") is None,
)
# The trailing qualifier arrives AFTER the phrase, so a matcher that stops at
# the phrase boundary inverts the highest-confidence positive in the catalogue.
check(
    "geo: 'work from anywhere' clears, 'work from anywhere in the US' blocks",
    _geo("You can work from anywhere.") is None
    and (_geo("You can work from anywhere in the US.") or _F).blocking is True,
)
# Israel-openness, incl. the Hebrew prefix defect (frontend check 10, in
# Python): re.search(r"\bישראל\b", "…בישראל…") is False because ב/ל/ה/ו/מ/ש are
# word characters, so the token test must be a bare SUBSTRING. The Latin half
# sits in the same check on purpose — "make the Hebrew case pass" is otherwise
# trivially satisfied by deleting every boundary guard.
check(
    "geo: Israel signals clear the posting; short Latin tokens keep their boundaries",
    _geo("אזרחות ישראלית - חובה. סיווג ביטחוני נדרש.") is None
    and _geo("מותר לעבוד בישראל בלבד") is None
    and _geo("שכר 15,000-18,000 ₪ לחודש") is None
    and _geo("Write to careers@acme.co.il. U.S. citizens only.") is None
    and _geo("Offices: New York, London, Tel Aviv. Must reside in the United States.") is None
    and _geo("Full remote. We hire globally - work from anywhere.") is None
    and _geo("Please contact us.") is None
    and (_geo("Must reside in the United States.") or _F).blocking is True,
)
# Both spellings of the gershayim are mutually invisible ('ארה"ב' != 'ארה״ב'),
# so this is trivially satisfied by R1 matching any Hebrew — which is exactly
# why it is pinned: it fails loudly if R1 is ever narrowed to a token list.
check(
    "geo: a Hebrew posting clears in either gershayim spelling",
    _geo("משרה מרחוק עבור ארה\"ב") is None
    and _geo("משרה מרחוק עבור ארה״ב") is None,
)
# Israel named inside an exclusion clause is the ONE case where naming Israel
# blocks. The sanctions preamble never lists Israel, so it must not match.
check(
    "geo: 'excluding Israel' blocks; a sanctions country list does not",
    (_g := _geo("We hire across EMEA, excluding Israel and Turkey.")) is not None
    and _g.scope == "il_excluded" and _g.blocking is True
    and _geo("We cannot hire in the following countries: Russia, Belarus, Iran, North Korea.") is None,
    str(_g),
)
_GEO_EEO = (
    "Equal Opportunity Employer. We do not discriminate on the basis of race, color, "
    "religion, sex, national origin, citizenship status, veteran status, or disability."
)
_GEO_US = "Applicants must be authorized to work in the United States."
# Both directions in one check: pinning only the suppression is satisfied by
# truncating everything, pinning only the catch by never truncating at all.
check(
    "geo: the EEO block is cut, and the same sentence above it still fires",
    _geo(_GEO_EEO) is None
    and _geo(_GEO_EEO + "\n\n" + _GEO_US) is None
    and (_geo(_GEO_US + "\n\n" + _GEO_EEO) or _F).blocking is True,
)
check(
    "geo: pay-transparency states never fire; an actual state exclusion does",
    _geo("The base salary range is $150,000 - $190,000. For Colorado-based roles it differs.") is None
    and (_geo("This role is not available in Colorado.") or _F).kind == "residency_state",
)
# The same acronym means opposite things: only HIRING verbs bind it.
check(
    "geo: region words bind to hiring verbs only, and never to regions holding Israel",
    (_g := _geo("We are hiring across APAC.")) is not None
    and _g.kind == "region" and _g.blocking is False
    and _geo("You will own the APAC market and support our APAC customers.") is None
    and _geo("We are hiring across EMEA.") is None
    and _geo("We are hiring across the Middle East.") is None
    and _geo("We are hiring across MENA.") is None
    and _geo("Open to applicants in the EU or an associated country.") is None
    and _geo("We are hiring for ANZ Bank.") is None
    and _geo("Firmware on Nordic Semiconductor nRF52.") is None
    and _geo("Operations in the Gulf of Mexico.") is None,
    str(_g),
)
check(
    "geo: every Tier-1 kind blocks and every Tier-2 kind does not",
    all(
        (_geo(txt) or _F).blocking is (kind in _GEO_BLOCKING) and (_geo(txt) or _F).kind == kind
        for kind, txt in (
            ("work_auth", "Must be authorized to work in the United States."),
            ("citizenship", "U.S. citizens only."),
            ("residency", "Candidates must reside in the United States."),
            ("region", "We are hiring across APAC."),
            ("onsite", "Relocation is required for this position."),
        )
    ),
)
# A Tier-2 phrase must never mask a Tier-1 one — order is the algorithm.
check(
    "geo: a posting stating both a region and an authorization rule returns the blocking one",
    (_g := _geo("We are hiring across APAC. Applicants must be authorized to work in the US.")) is not None
    and _g.blocking is True and _g.kind == "work_auth",
    str(_g),
)
_GEO_LONG = ("Lorem ipsum. " * 300) + _GEO_US
check(
    "geo: raw is the posting's own sentence, normalised and capped at 240 chars",
    (_g := _geo(_GEO_LONG)) is not None
    and _g.raw in " ".join(_GEO_LONG.split())
    and len(_g.raw) <= 240 and "\n" not in _g.raw,
    f"{len(_g.raw if _g else '')} chars",
)
# The 22.10 shape: behaviour alone cannot pin "this never reaches the model" —
# an LLM-backed classifier also returns a verdict. The floor makes an
# unreadable module go red instead of silently passing.
_GEO_SRC = _geo_inspect.getsource(_geo_mod)
check(
    "geo: the classifier is source-pinned to no LLM and no network",
    len(_GEO_SRC) > 2000
    and "get_llm_client" not in _GEO_SRC
    and "complete_json" not in _GEO_SRC
    and "analyze_jd" not in _GEO_SRC
    and "urllib" not in _GEO_SRC
    and "requests" not in _GEO_SRC,
    f"{len(_GEO_SRC)} chars scanned",
)

# 14b-5. The false-positive round. Every check below is a posting a NAIVE rule
# hid, found by adversarial review after the first cut shipped green — the first
# fixture set passed because each case was narrow enough to never fire. A guard
# that deletes a real job is the worst failure this module has, so the positive
# it must still catch sits in the SAME check as the prose it must not.
check(
    "geo: an Israel-ONLY posting is never read as excluding Israel",
    _geo("We are unable to employ candidates outside of Israel.") is None
    and _geo("We do not hire outside Israel at this time.") is None
    and _geo("We cannot employ anyone who is not physically located in Israel.") is None
    and _geo("Israel-based candidates only.") is None
    # …while the genuine exclusion still blocks. R0 runs before R1, so R1 cannot
    # rescue this one — the inversion had to be fixed inside R0 itself.
    and (_geo("We hire across EMEA, excluding Israel and Turkey.") or _F).scope == "il_excluded",
)
check(
    "geo: a NEGATED clearance requirement welcomes you, and must not block",
    _geo("No security clearance is required for this role.") is None
    and _geo("A security clearance is not required, and we welcome applicants from anywhere.") is None
    and _geo("Top secret clearance preferred but not required.") is None
    and _geo("This position does not require a security clearance.") is None
    # …and a real one still blocks, in both word orders.
    and (_geo("An active security clearance is required.") or _F).kind == "clearance"
    and (_geo("You must hold a DoD clearance.") or _F).kind == "clearance"
    and (_geo("Must qualify as a U.S. Person under ITAR.") or _F).kind == "clearance",
)
check(
    "geo: clearance vocabulary that is also ordinary English never fires alone",
    _geo("Our mission is to strengthen public trust in the financial system.") is None
    and _geo("Federal contract experience preferred.") is None
    and _geo("You will help our customers protect their top secret sauce.") is None,
)
check(
    "geo: a US-benefits clause proves global hiring and must not be read as a restriction",
    _geo(
        "Acme is remote-first with teammates in 24 countries. US-based employees are "
        "eligible for our 401(k) with a 4 percent match; employees elsewhere receive an "
        "equivalent local pension contribution."
    ) is None
    and _geo("Our UK-based employees enjoy private medical cover.") is None
    # …while the same shape aimed at the READER still blocks.
    and (_geo("This position is open to US-based candidates.") or _F).blocking is True
    and (_geo("We are considering UK-based applicants for this role.") or _F).blocking is True,
)
check(
    "geo: an employer-of-record reach statement is openness, not a restriction",
    _geo(
        "Fully remote. Through our employer-of-record we are registered to employ in "
        "more than 60 countries, so tell us where you are."
    ) is None
    and (_geo("You must reside in one of the following states: CA, NY, TX.") or _F).blocking is True,
)
check(
    "geo: relocation assistance cannot cancel a sponsorship refusal",
    (_geo("Relocation assistance is provided for the right person. Note: no visa sponsorship.")
     or _F).blocking is True
    # The negation can sit further left than a tight window sees.
    and (_geo("There is no employment-based visa sponsorship available for this role.")
         or _F).blocking is True
    # …and an actual offer to sponsor still suppresses.
    and _geo("We are happy to sponsor visas for the right candidate.") is None,
)
# `lod` (Lod, from HE_CITY_ALIASES) is a substring of ordinary English words, and
# an Israel token clears the posting outright — so a US-only ad whose benefits
# mention lodging was silently unclassifiable. Latin aliases need a boundary;
# Hebrew must NOT have one (see the prefix pin above). Both halves in one check.
check(
    "geo: Latin city aliases need word boundaries, Hebrew ones must not have them",
    (_geo("We cover travel and lodging. Applicants must be authorized to work in the "
          "United States.") or _F).blocking is True
    and (_geo("Our user base exploded last year. Applicants must be authorized to work "
              "in the United States.") or _F).blocking is True
    and _geo("Our office is in Haifa. Applicants must be authorized to work in the "
             "United States.") is None
    and _geo("מותר לעבוד בישראל בלבד") is None,
)
check(
    "geo: region acronyms bind only to hiring verbs, and GCC is a compiler",
    _geo("Build systems based on GCC, CMake and Bazel.") is None
    and _geo("Embedded C firmware based on GCC and newlib for ARM targets.") is None
    and _geo("The team is based in the Americas and works async.") is None
    and (_geo("We are hiring across APAC.") or _F).kind == "region",
)
check(
    "geo: scope comes from the matched SENTENCE, never a neighbouring one",
    (_geo("We are a London fintech. Our biggest customers are in the United States and "
          "Canada. Unfortunately we cannot offer visa sponsorship.") or _F).scope != "us",
)
# raw is what the card shows under "Quoted from the posting". A head slice drops
# the evidence whenever the match sits past RAW_MAX inside its own sentence.
_GEO_RUNON = (
    "We are a fast growing team building developer tooling for large enterprises across "
    "many industries and we care deeply about craft, ownership and shipping quickly with "
    "a small senior team that values written communication over meetings, and applicants "
    "must reside in the United States"
)
check(
    "geo: the quote always contains the phrase that fired, even in a long sentence",
    (_g := _geo(_GEO_RUNON)) is not None
    and "United States" in _g.raw
    and len(_g.raw) <= 240,
    f"{len(_g.raw if _g else '')} chars: {(_g.raw if _g else '')[-60:]}",
)
# The fast path returns None when no rule's vocabulary is present. It is what
# keeps the per-posting cost off the search hot path; if it ever drops a stem a
# rule needs, that rule's own check above goes red.
check(
    "geo: a posting with none of the rule vocabulary is answered without scanning",
    _geo("We build developer tools in Python and Go. Great team, strong craft culture.")
    is None,
)

# 14c. Ghost postings — the deterministic classifier (PLAN 28.1). A talent pool
# wearing a job title, a listing that has been up since spring, a role the board
# relisted under a new id, an application form that closed weeks ago: each costs
# the user a tailor, a cover letter and a week of waiting. `ghost_signals` reads
# the posting plus what our own searches remember about it and returns the
# EVIDENCE, never a score.
#
# Same shape as the geo block above, for the same reason: every positive sits in
# the SAME check() as the legitimate posting it must not fire on, because "make
# the talent-pool case pass" is trivially satisfied by matching anything that
# says "talent". Two differences from geo worth knowing before reading on:
#
#   - recall here is FAR worse. A ghost posting that says nothing unusual, whose
#     board states no publish date and that none of our searches has seen before
#     is indistinguishable from a live one. So `None` never means "the posting is
#     real", and no check below may be written as if it did.
#   - the classifier is UNGATED. Geo is gated on `origin_market` because its
#     rules are meaningless against a Tel Aviv listing; ghosts are a
#     PRIMARY-MARKET problem, so the Israeli cases here are positives, not
#     escapes. Pinned end to end in section 21e.
from datetime import datetime as _gh_dt, timedelta as _gh_td  # noqa: E402

from app.core import ghost_signals as _ghost_mod  # noqa: E402
from app.core.ghost_signals import (  # noqa: E402
    LONG_OPEN_STRONG_DAYS as _GH_STRONG_DAYS,
    LONG_OPEN_WEAK_DAYS as _GH_WEAK_DAYS,
    Sighting as _GhSighting,
    detect_ghost_signals as _gh_detect,
    parse_board_date as _gh_parse_date,
)
from app.models import GhostReport as _GhostReport, GhostSignal as _GhostSignal  # noqa: E402

# ONE instant for this whole block. `detect_ghost_signals` takes `now` as a
# parameter (the `jobmaster.parse_hebrew_relative_date` precedent) precisely so
# these checks are dates and not dice: a suite reading the wall clock would
# drift across the 30/60-day thresholds depending on the hour CI happened to run,
# and the failure would look like a flake rather than a rule.
_GH_NOW = _gh_dt(2026, 9, 3, 12, 0, 0)


def _gh(title: str = "", jd: str = "", **kw):  # noqa: ANN201
    """`detect_ghost_signals` with the two text arguments up front, so each check
    below reads as the posting it describes rather than as a keyword soup."""
    kw.setdefault("now", _GH_NOW)
    return _gh_detect(title=title, jd_text=jd, **kw)


def _gh_kinds(report) -> dict:  # noqa: ANN001
    """{kind: strength}. Safe as a dict because each kind is emitted at most
    once; comparing the WHOLE mapping (rather than asserting one kind is
    present) is what makes a rule that fires twice, or fires on the wrong
    posting, go red instead of hiding behind a truthy membership test."""
    return {s.kind: s.strength for s in (report.signals if report else [])}


def _gh_rep(report):  # noqa: ANN001
    """The report, or an EMPTY one when nothing fired. Same reason as
    `_gh_sig0` below: a check must go RED, never abort the suite, on a rule
    that used to fire and stopped."""
    return report if report is not None else _GhostReport()


def _gh_sig0(report):  # noqa: ANN001
    """The strongest signal, or a blank one when the report is None/empty.

    Never `report.signals[0]` at a check site. A regression that makes a rule
    stop firing would raise AttributeError/IndexError there, and this file is
    straight-line top-level code with no top-level try — so ONE broken rule would
    abort the process and every later check in the suite would silently never
    run, reported only as `ABORTED after N checks`. A blank signal keeps the
    failure local and red. (Learned here while probing `long_open`.)"""
    return report.signals[0] if report is not None and report.signals else _GhostSignal()


def _gh_sight(days_ago=None, first_url="", seen_count=0, relist_count=0) -> _GhSighting:  # noqa: ANN001
    return _GhSighting(
        first_seen_at=None if days_ago is None else _GH_NOW - _gh_td(days=days_ago),
        first_url=first_url,
        seen_count=seen_count,
        relist_count=relist_count,
    )


# The four kinds, each with the strength ITS OWN rule claims. Asserting the
# whole {kind: strength} mapping rather than "a signal fired" is deliberate: a
# `long_open` that shipped as `strong` at 31 days, or an `evergreen` weak family
# promoted to strong, would filter and badge postings the derivation rule below
# says it must not — and a membership test cannot see either.
check(
    "ghost: all four kinds fire, each carrying the strength its own rule claims",
    _gh_kinds(_gh("Backend Engineer", "Python.", closed="No longer accepting applications"))
    == {"closed": "certain"}
    and _gh_kinds(_gh("Talent Pool - Engineering", "Python.")) == {"evergreen": "strong"}
    and _gh_kinds(_gh("Backend Engineer", "We are always looking for talented engineers."))
    == {"evergreen": "weak"}
    and _gh_kinds(_gh(raw={"first_published": "2026-06-02"})) == {"long_open": "strong"}
    and _gh_kinds(_gh(sighting=_gh_sight(35, "https://b/1"), url="https://b/1"))
    == {"long_open": "weak"}
    and _gh_kinds(_gh(sighting=_gh_sight(2, "https://b/1"), url="https://b/2"))
    == {"reposted": "weak"},
)
# THE DERIVATION RULE, which is the only arithmetic in the module and therefore
# the only thing a future edit can silently retune. `likely` is >= 1 strong OR
# >= 2 weak, and `closed` is any CERTAIN signal. The two flags describe
# DIFFERENT facts and do not nest: a closed-only report is `likely=False`
# because "likely a ghost" is a suspicion and closure is past it, while a
# posting that is both closed AND a talent pool carries both — so a UI reading
# `likely` as "is this suspicious at all" would call a dead posting clean.
#
# Every report is bound BEFORE the check rather than by a walrus inside it. This
# file is straight-line top-level code with no top-level try, so a name the
# and-chain short-circuits past would make the `extra` f-string raise NameError
# and abort the whole suite at the first regression — turning one red check into
# "ABORTED after 234 checks". Found the hard way while probing this very check.
_gh1 = _gh_rep(_gh("Talent Pool", "x"))
_gh2 = _gh_rep(_gh("Backend Engineer", "We are always looking for talented people.",
                   sighting=_gh_sight(31, "https://b/1"), url="https://b/1"))
_gh3 = _gh_rep(_gh("Backend Engineer", "We are always looking for talented people."))
_gh4 = _gh_rep(_gh(closed="HTTP 404"))
_gh5 = _gh_rep(_gh("Talent Pool", "x", closed="HTTP 410"))
check(
    "ghost: 1 strong ⇒ likely, 2 weak ⇒ likely, 1 weak ⇒ NOT likely, certain ⇒ closed",
    _gh1.likely is True and _gh1.closed is False
    and _gh2.likely is True and len(_gh2.signals) == 2
    and _gh3.likely is False and _gh3.closed is False and len(_gh3.signals) == 1
    and _gh4.closed is True and _gh4.likely is False
    # …and the two flags are independent, not nested.
    and _gh5.closed is True and _gh5.likely is True
    and _gh_sig0(_gh5).kind == "closed",
    f"strong={_gh1.likely} 2weak={_gh2.likely} 1weak={_gh3.likely} "
    f"certain={_gh4.closed}/{_gh4.likely} both={_gh5.closed}/{_gh5.likely}",
)
# FALSE POSITIVE (a): PRIVACY BOILERPLATE. `קורות החיים יישמרו במאגר החברה`
# ships on a large share of Israeli agency ads for perfectly live vacancies, and
# the English "kept on file / retained for future opportunities" is its twin.
# This is why the evergreen markers are TITLE-ONLY: a privacy paragraph lives in
# the body and the body matcher does not know those phrases, so the protection is
# structural rather than a veto that can be out-argued. The true positive sits in
# the same check because "never fire on privacy text" is trivially satisfied by
# deleting the evergreen family outright.
check(
    "ghost: privacy boilerplate never fires — in Hebrew or English — and the title marker still does",
    _gh("מפתח Full Stack", "דרוש מפתח. קורות החיים יישמרו במאגר החברה לצורך משרות עתידיות.") is None
    and _gh("מפתחת Backend", "המידע יישמר לצורך משרות עתידיות במאגר מועמדים של החברה.") is None
    and _gh("Backend Engineer", "Your CV will be kept on file and retained for future opportunities.")
    is None
    and _gh(
        "Backend Engineer",
        "Privacy notice: your data is retained for future opportunities in our talent pool.",
    ) is None
    # …while the same words IN THE TITLE are the posting describing itself.
    and _gh_kinds(_gh("מאגר מועמדים - מפתחים", "פייתון.")) == {"evergreen": "strong"}
    and _gh_kinds(_gh("Future Opportunities - Engineering", "x")) == {"evergreen": "strong"},
)
# FALSE POSITIVE (b): A RECRUITER'S OWN JOB names the vocabulary as a DUTY.
# `רכזת גיוס - ניהול מאגר מועמדים` is a real Drushim title carrying the marker
# verbatim. The body half is structural (title-only markers); the title half
# needs `_RECRUITER_DUTY`, scoped to the "ownable" markers only — a pool, a
# community, a network, a pipeline are things a recruiter can be PAID to run,
# while "General Application" is not a duty in any phrasing, so vetoing it could
# only ever lose a true positive. Both halves are pinned here.
check(
    "ghost: a recruiter's own pipeline job never fires, and an un-ownable marker is never vetoed",
    _gh(
        "Talent Acquisition Partner",
        "You will build and grow our talent pipeline and maintain the talent pool.",
    ) is None
    and _gh("רכזת גיוס - ניהול מאגר מועמדים", "עבודה מול מנהלים.") is None
    and _gh("אחראי מאגר מועמדים", "x") is None
    and _gh("Recruiter - Building our Talent Pipeline", "x") is None
    # …the veto is GERUNDS only, so a talent pool naming its AUDIENCE still fires…
    and _gh_kinds(_gh("Talent Pool - Engineering Manager", "x")) == {"evergreen": "strong"}
    # …and the un-ownable markers fire even wearing the duty vocabulary.
    and _gh_kinds(_gh("General Application - Managing Director", "x")) == {"evergreen": "strong"}
    and _gh_kinds(_gh("מועמדות כללית - ניהול מוצר", "x")) == {"evergreen": "strong"},
)
# FALSE POSITIVE (c): `מאגר` is the ordinary Hebrew word for a database.
# `ניהול מאגר לקוחות` is a CRM job and `מאגר מידע` / `מאגר נתונים` are what every
# Israeli data role calls its warehouse. Structural again — the marker is the
# two-word phrase `מאגר מועמדים`, never a bare `מאגר` — and the true positive is
# in the same check because "never fire on מאגר" is trivially satisfied by
# deleting the Hebrew half, which would disable the feature in the primary market.
check(
    "ghost: מאגר as 'database' never fires; מאגר מועמדים still does",
    _gh("מפתח - ניהול מאגר לקוחות", "בניית מאגר מידע ומאגר נתונים.") is None
    and _gh("Data Engineer", "בניית מאגר מידע גדול לניתוח.") is None
    and _gh("מנהל מאגר נתונים", "x") is None
    and _gh_kinds(_gh("מאגר מועמדים כללי", "x")) == {"evergreen": "strong"},
)
# The weak family's PERSON OBJECT is mandatory, and it is the guard. "We are
# always looking for ways to improve our platform" is a sentence about work, not
# about candidates, and it sits in the about-us blurb of thousands of real
# postings — a bare `always looking for` fires on every one of them. Two weak
# signals make a posting `likely`, so this family firing loosely is a badge on
# the whole market.
check(
    "ghost: 'always looking for' needs a PERSON object — ways/technologies never fire",
    _gh("Backend Engineer", "We are always looking for ways to improve our platform.") is None
    and _gh("Backend Engineer", "We are always on the lookout for new technologies.") is None
    and _gh("מפתח", "אנחנו תמיד מחפשים דרכים לשפר את המוצר.") is None
    # …and the candidate-facing form still fires, in both languages.
    and _gh_kinds(_gh("Backend Engineer", "We are always looking for talented engineers."))
    == {"evergreen": "weak"}
    and _gh_kinds(_gh("מפתח", "אנחנו תמיד מחפשים אנשים מוכשרים.")) == {"evergreen": "weak"},
)
# long_open answers TWO DIFFERENT QUESTIONS and must say which, because the UI
# prints a different sentence for each: `first_published` is the BOARD's own
# publish date ("posted N days ago"), while `first_seen` is only a LOWER bound —
# the day one of OUR searches first ran over it, which says nothing about the
# days before that. When both exist the EARLIER wins and reports ITS basis. When
# NEITHER exists the signal is absent: unknown is never zero, the `last_above_min`
# rule arriving again.
_gl1 = _gh_sig0(_gh(raw={"first_published": "2026-05-01"}, sighting=_gh_sight(35, "https://b/1"),
                    url="https://b/1"))
# the sighting is the earlier of the two here, so it wins and says so
_gl2 = _gh_sig0(_gh(raw={"first_published": "2026-08-20"}, sighting=_gh_sight(90, "https://b/1"),
                    url="https://b/1"))
check(
    "ghost: long_open prefers the earlier date, names its basis, and abstains when it has neither",
    _gl1.basis == "first_published" and _gl1.days == 125 and _gl1.since == "2026-05-01"
    and _gl2.basis == "first_seen" and _gl2.days == 90 and _gl2.since == "2026-06-05"
    # neither: a posting whose board never said and that we have never seen
    and _gh("Backend Engineer", "Talent pipeline work in Python.") is None
    # a board clock ahead of ours yields a negative age and must abstain, never
    # report a 0-day "ghost"
    and _gh(raw={"first_published": "2027-01-01"}) is None
    # nothing in the posting SAYS this — we computed it — so there is no quote,
    # and inventing one would be the module claiming the posting said something
    # it did not.
    and _gl1.raw == "",
    f"{_gl1.basis}/{_gl1.days} then {_gl2.basis}/{_gl2.days}",
)
# `posted_at` is ACCEPTED and deliberately UNUSED by the age. Comeet's
# `time_updated` and Greenhouse's `updated_at` land in it, so an evergreen
# posting touched weekly reads as permanently fresh — which is precisely the
# ghost failure mode this signal exists to catch, i.e. wiring it in would make
# the signal agree with the ghost instead of with the market. Driven with a
# FRESH posted_at beside an OLD first_published: a classifier that read the
# former would abstain, and this check would go red.
_gp = _gh(posted_at="2026-09-02", raw={"first_published": "2026-01-01"})
_gp_sig = _gh_sig0(_gp)
_gp_only = _gh(posted_at="2026-01-01")
check(
    "ghost: long_open never reads posted_at — a board that touches the row weekly cannot hide",
    _gp_sig.days == 245 and _gp_sig.basis == "first_published"
    # …and posted_at ALONE, however old, produces nothing at all.
    and _gp_only is None,
    f"{_gh_kinds(_gp)} then posted_at-only={_gp_only}",
)
# `reposted` is about a NEW LISTING ID for the same role, never about having been
# seen twice — a posting we saw yesterday and see again today is a posting that
# is still up, which is the normal case and the whole market. It also abstains on
# an EMPTY url: without that guard `"" != first_url` is true for every posting
# whose url the caller did not pass, and a guard that fires on everything is
# worse than no guard.
check(
    "ghost: reposted needs a DIFFERENT url — a second sighting at the same one is not a relist",
    _gh_kinds(_gh(sighting=_gh_sight(2, "https://b/1", seen_count=9), url="https://b/2"))
    == {"reposted": "weak"}
    and _gh(sighting=_gh_sight(2, "https://b/1", seen_count=9), url="https://b/1") is None
    # a trailing slash is the same URL — the key `_interleave_and_dedupe` and the
    # score cache already agree on
    and _gh(sighting=_gh_sight(2, "https://b/1/", seen_count=9), url="https://b/1") is None
    # no url on our side, and no first_url on the row: abstain, both directions
    and _gh(sighting=_gh_sight(2, "https://b/1", seen_count=9), url="") is None
    and _gh(sighting=_gh_sight(2, "", seen_count=9), url="https://b/2") is None,
)


class _GhTripwire:
    """Stands in for the evergreen title pattern and COUNTS being consulted.

    The fast path's whole job is not scanning, and "returns None" cannot tell a
    bail-out from a full scan that matched nothing — a check that passes by never
    firing is the 21.7 failure mode. Both directions ride in one check below: the
    clean posting must not consult it, and a posting carrying one marker must."""

    def __init__(self) -> None:
        self.consulted = 0

    def finditer(self, text: str):  # noqa: ANN202
        self.consulted += 1
        return iter(())


_gh_trip = _GhTripwire()
_gh_real_title_re = _ghost_mod._EVERGREEN_TITLE_RE
try:
    _ghost_mod._EVERGREEN_TITLE_RE = _gh_trip
    _gh_quiet = _gh("Backend Engineer", "We build developer tools in Python and Go.")
    _gh_quiet_scans = _gh_trip.consulted
    _gh("Talent Pool - Engineering", "Python.")
    _gh_marker_scans = _gh_trip.consulted
finally:
    _ghost_mod._EVERGREEN_TITLE_RE = _gh_real_title_re
check(
    "ghost: a posting with no rule vocabulary and no sighting is answered without scanning",
    _gh_quiet is None and _gh_quiet_scans == 0 and _gh_marker_scans == 1,
    f"clean consulted the tables {_gh_quiet_scans}×, a marker posting {_gh_marker_scans}×",
)
# `raw` is what the card prints under "Quoted from the posting". A head slice
# drops the evidence whenever the match sits past RAW_MAX inside its own
# sentence — a run-on, or a scraped body with no terminator — and the UI then
# shows a quote that does not contain the phrase we fired on. Same contract as
# `GeoRestriction.raw` and `SalaryInfo.raw`: proof, not promise.
_GH_RUNON = (
    "We are a fast growing team building developer tooling for large enterprises across "
    "many industries and we care deeply about craft, ownership and shipping quickly with "
    "a small senior team that values written communication over meetings, and right now "
    "there are no specific openings for this discipline"
)
_gq_raw = _gh_sig0(_gh("Backend Engineer", _GH_RUNON)).raw
# a long TITLE is capped the same way, and the marker survives the cap
_gq2_raw = _gh_sig0(_gh("Talent Pool " + "x" * 300, "")).raw
check(
    "ghost: the quote always contains the phrase that fired, and stays within the card's cap",
    "no specific openings" in _gq_raw and len(_gq_raw) <= 240 and "\n" not in _gq_raw
    and _gq2_raw.startswith("Talent Pool") and len(_gq2_raw) == 240,
    f"{len(_gq_raw)} chars: …{_gq_raw[-52:]}",
)
# `now` IS A PARAMETER, and this is what that buys. The identical posting, aged
# against three different instants, gives three different answers — strong,
# weak, and nothing at all. A `datetime.now()` inside the module would make
# every one of the checks above depend on the day CI ran, and the 30/60-day
# thresholds unpinnable by construction.
_GH_PUB = {"first_published": "2026-06-02"}
_gn1 = _gh_sig0(_gh_detect(title="", jd_text="", raw=_GH_PUB, now=_gh_dt(2026, 9, 3)))
_gn2 = _gh_sig0(_gh_detect(title="", jd_text="", raw=_GH_PUB, now=_gh_dt(2026, 7, 7)))
_gn3 = _gh_detect(title="", jd_text="", raw=_GH_PUB, now=_gh_dt(2026, 6, 20))
check(
    "ghost: `now` is injected — the same posting is strong, weak or silent purely by the clock",
    _gn1.days == 93 and _gn1.strength == "strong"
    and _gn2.days == 35 and _gn2.strength == "weak"
    and _gn3 is None
    # …and the two thresholds are the module's own constants, not restated here
    and _gn1.days >= _GH_STRONG_DAYS > _gn2.days >= _GH_WEAK_DAYS,
    f"{_gn1.days}d {_gn1.strength} / {_gn2.days}d {_gn2.strength} / 18d {_gn3}",
)

# 14c-2. The closure marker. `linkedin_closed_marker` is the only place in the
# app where a BOARD tells us a posting is dead, and the false-positive half is
# the one that matters: a false "closed" DELETES A LIVE JOB, which is the worst
# failure this feature has. `tests/fixtures/linkedin_job_open.html` exists for
# exactly that — "make the closed case pass" is trivially satisfied by returning
# the marker always.
#
# The four decoys planted in the open fixture are asserted PRESENT first. Without
# that, a fixture someone trimmed would make this check pass by never firing —
# the same failure the x-ray's true-positive pin was written to avoid.
from pathlib import Path as _gh_Path  # noqa: E402

from app.core.providers.linkedin import linkedin_closed_marker as _gh_closed  # noqa: E402

_GH_FIXTURES = _gh_Path(__file__).resolve().parent / "fixtures"
_GH_CLOSED_HTML = (_GH_FIXTURES / "linkedin_job_closed.html").read_text(encoding="utf-8")
_GH_OPEN_HTML = (_GH_FIXTURES / "linkedin_job_open.html").read_text(encoding="utf-8")
# Anchored on the DECOYS' OWN MARKUP, never on a word that also appears in the
# fixture's provenance comment. The first draft asserted `"undisclosed" in html`
# — and the header comment that DOCUMENTS the trap contains that word, so
# deleting the decoy from the body left this check green. Probed with exactly
# that edit. The commented banner is pinned through the provider's own comment
# regex rather than a "<!--" substring, so "the banner is invisible to a reader"
# is asserted rather than assumed.
from app.core.providers.linkedin import _COMMENT_RE as _GH_COMMENT_RE  # noqa: E402

_GH_OPEN_UNCOMMENTED = _GH_COMMENT_RE.sub("", _GH_OPEN_HTML)
check(
    "ghost: the OPEN fixture still carries all four decoys a naive matcher fires on",
    # 1. ordinary ad copy that says the phrase, inside the description container
    "We are no longer accepting applications by email" in _GH_OPEN_HTML
    # 2. the real banner, present but COMMENTED OUT — a reader sees nothing
    and "closed-job__flavor--closed" in _GH_OPEN_HTML
    and "closed-job__flavor--closed" not in _GH_OPEN_UNCOMMENTED
    # 3. the neighbouring figcaption a tag-anchored scan would return instead
    and 'class="num-applicants__caption"' in _GH_OPEN_UNCOMMENTED
    # 4. the bare-"closed" bait, in the body
    and "undisclosed at this stage" in _GH_OPEN_HTML
    and "closed-loop monitoring" in _GH_OPEN_HTML
    # …and the closed fixture really does carry the banner, uncommented
    and "closed-job__flavor--closed" in _GH_COMMENT_RE.sub("", _GH_CLOSED_HTML),
)
check(
    "ghost: linkedin_closed_marker fires on the closed page and NEVER on the open one",
    _gh_closed(_GH_CLOSED_HTML) == "No longer accepting applications"
    and _gh_closed(_GH_OPEN_HTML) == ""
    # "" means NOT OBSERVED, never "open" — an unfetchable page abstains
    and _gh_closed("") == ""
    and _gh_closed("<html><body>Sign in to continue</body></html>") == "",
    f"closed={_gh_closed(_GH_CLOSED_HTML)!r} open={_gh_closed(_GH_OPEN_HTML)!r}",
)

# 14c-3. Source pins. Behaviour alone cannot pin "this never reaches the model"
# — an LLM-backed classifier also returns a verdict — so the shape is pinned too.
#
# PARSED, NEVER GREPPED, and this module is the case that proves why: its
# docstring says in so many words "Never the LLM and never the network", and it
# imports from `geo_restriction`, which is itself one hop from the client
# factory. A substring scan for "get_llm_client" therefore fails in BOTH
# directions here — green when a module merely imports something that imports
# the client, red the moment a comment names the hazard. Reading Name/Attribute/
# import nodes answers the question the check is actually asking. (This is the
# same correction `skills_shortlist`'s pin records, arriving before the defect
# rather than after it.)
import ast as _gh_ast  # noqa: E402
import inspect as _gh_inspect  # noqa: E402

_GH_SRC = _gh_inspect.getsource(_ghost_mod)
_GH_TREE = _gh_ast.parse(_GH_SRC)
_GH_USED = (
    {n.id for n in _gh_ast.walk(_GH_TREE) if isinstance(n, _gh_ast.Name)}
    | {n.attr for n in _gh_ast.walk(_GH_TREE) if isinstance(n, _gh_ast.Attribute)}
    | {
        part
        for n in _gh_ast.walk(_GH_TREE)
        if isinstance(n, (_gh_ast.Import, _gh_ast.ImportFrom))
        for a in n.names
        # BOTH the bound name and every DOTTED SEGMENT of the module path. The
        # first draft collected `a.asname or a.name` only, so `import
        # urllib.request` contributed the single string "urllib.request" and the
        # forbidden-set intersection against "urllib" missed it entirely — the
        # check went GREEN with the network imported. Found by probing exactly
        # that defect in, per the rule at the top of check-mirrors.
        for part in {a.asname or a.name, *(a.name.split("."))}
    }
    | {
        part
        for n in _gh_ast.walk(_GH_TREE)
        if isinstance(n, _gh_ast.ImportFrom) and n.module
        for part in {n.module, *n.module.split(".")}
    }
)
check(
    "ghost: the classifier is source-pinned to no LLM, no network and no clock",
    len(_GH_SRC) > 2000
    and not _GH_USED & {
        "get_llm_client", "complete_json", "complete_text", "analyze_jd",
        "openai", "urllib", "requests", "httpx", "socket",
    }
    # `now` is a parameter — a `datetime.now()` here would make every check in
    # 14c depend on the hour it ran, and the thresholds unpinnable.
    and "datetime.now" not in _GH_SRC
    and "utcnow" not in _GH_SRC,
    f"{len(_GH_SRC)} chars, {len(_GH_USED)} identifiers",
)
# This is NOT an LLM task, so CLAUDE.md's "any new LLM task must add a stub
# branch and a smoke-test check" rule deliberately does not apply — and a future
# reader must not add one, because a stub branch here would mean the classifier
# had grown a model call the geo section's own rule forbids. Pinned the way the
# keyword-guard and skills-shortlist pins do it: by the absence of a routing token.
import app.llm.client as _gh_client_mod  # noqa: E402

_GH_CLIENT_SRC = _gh_inspect.getsource(_gh_client_mod)
check(
    "ghost: app/llm/client.py gained no stub branch for it — this is not an LLM task",
    "GHOST" not in _GH_CLIENT_SRC and "GHOST_SIGNAL" not in _GH_CLIENT_SRC,
)
# ONE parser for board dates, one answer. `job_search._posted_datetime` delegates
# here, so the ghost's age and the freshness tier can never disagree about the
# same string — the "one matcher, one answer" rule applied to a date. A second
# `fromisoformat` in `job_search` would let a posting be 93 days old to the badge
# and unparseable to the tier, on the same row.
import app.core.job_search as _gh_js_mod  # noqa: E402

_GH_JS_SRC = _gh_inspect.getsource(_gh_js_mod)
check(
    "ghost: parse_board_date is THE board-date parser, and job_search delegates to it",
    _gh_parse_date("2026-06-02T03:17:15-04:00") == _gh_dt(2026, 6, 2, 3, 17, 15)
    and _gh_parse_date("") is None and _gh_parse_date("junk") is None
    and _gh_parse_date(None) is None  # type: ignore[arg-type]
    and _gh_js_mod._posted_datetime("2026-06-02T03:17:15-04:00")
    == _gh_parse_date("2026-06-02T03:17:15-04:00")
    and "fromisoformat" not in _GH_JS_SRC,
)
# THE IMPORTER CENSUS. A second call site would classify on a DIFFERENT gate and
# contradict the first about the same posting — the geo-restriction correction
# CLAUDE.md records as the one that mattered most (`kits.enqueue_kits` and
# `GET /jobs/history` each re-derived a verdict the search had already answered,
# and each disagreed with it). `kits.py`, `job_match.py`, `db/history.py` and
# `alerts.py` are where that would go today; the set is COMPUTED by walking every
# module the app ships, so it finds tomorrow's too.
#
# TWO tiers, because the module exports two different kinds of thing and only one
# of them is a gate. `db/sightings.py` legitimately imports the `Sighting`
# dataclass — it is the RETURN TYPE of `load_sightings`, a frozen value object
# that classifies nothing — while `detect_ghost_signals` is the classifier and
# must have exactly one importer. Folding the two would either forbid a type
# import the contract requires, or permit a second call site.
_GH_APP_DIR = _gh_Path(_ghost_mod.__file__).parents[1]  # …/app, never cwd
_GH_MOD_IMPORTERS: list[str] = []
_GH_FN_IMPORTERS: list[str] = []
_GH_SCANNED = 0
for _gh_py in sorted(_GH_APP_DIR.rglob("*.py")):
    _GH_SCANNED += 1
    _gh_rel = str(_gh_py.relative_to(_GH_APP_DIR)).replace("\\", "/")
    if _gh_rel == "core/ghost_signals.py":
        continue
    _gh_mod_hit = _gh_fn_hit = False
    for _gh_n in _gh_ast.walk(_gh_ast.parse(_gh_py.read_text(encoding="utf-8"))):
        if isinstance(_gh_n, _gh_ast.ImportFrom):
            if (_gh_n.module or "").split(".")[-1] == "ghost_signals":
                _gh_mod_hit = True
                _gh_fn_hit |= any(a.name == "detect_ghost_signals" for a in _gh_n.names)
            elif any(a.name == "ghost_signals" for a in _gh_n.names):
                _gh_mod_hit = True
        elif isinstance(_gh_n, _gh_ast.Import):
            _gh_mod_hit |= any(a.name.split(".")[-1] == "ghost_signals" for a in _gh_n.names)
    if _gh_mod_hit:
        _GH_MOD_IMPORTERS.append(_gh_rel)
    if _gh_fn_hit:
        _GH_FN_IMPORTERS.append(_gh_rel)
check(
    "ghost: exactly one CLASSIFIER call site in the whole app — core/job_search.py",
    _GH_FN_IMPORTERS == ["core/job_search.py"]
    and _GH_MOD_IMPORTERS == ["core/job_search.py", "db/sightings.py"]
    and _GH_SCANNED > 40,
    f"classifier={_GH_FN_IMPORTERS} module={_GH_MOD_IMPORTERS} ({_GH_SCANNED} modules scanned)",
)

# 14b-6. Prompt input bounds, output cap, and honest size errors.
# A production Sentry issue was a token-limit failure on a large master résumé.
# Nothing in the backend bounded prompt input: the only ceiling was a 10 MB FILE
# cap, and a 10 MB PDF extracts to megabytes that went into the prompt whole.
import inspect as _lim_inspect  # noqa: E402

from app.core import jd_analyzer as _jd_analyzer_mod  # noqa: E402
from app.llm import client as _lim_client_mod  # noqa: E402
from app.parsers import structurer as _structure_resume_mod  # noqa: E402
from app.llm.limits import (  # noqa: E402
    ContextWindowExceeded,
    InputTooLarge,
    OutputTruncated,
    clip_utf8,
    require_within,
    utf8_bytes,
)

# BYTES, NOT CHARACTERS. Hebrew costs ~1.9 bytes/char, so a character cap
# silently grants the primary market roughly twice the tokens for the same
# number. Both halves in one check: the ratio must be real AND the cap must
# actually charge for it.
_HE = "ניהול מערכות"
check(
    "limits: sized in UTF-8 bytes, so Hebrew is not granted a bigger budget",
    utf8_bytes(_HE) > len(_HE) and utf8_bytes("systems management") == 18,
    f"he {len(_HE)} chars / {utf8_bytes(_HE)} bytes",
)

# A cap is a GUARD RAIL, not a budget: it must fire on the pathological input
# and never on a real CV. The false-positive half is the point — CLAUDE.md's
# rule is that a guard which also fires on legitimate input is worse than none.
_lim_real_cv = "Senior Engineer\n" + ("Built and shipped backend services. " * 1200)
check(
    "limits: a realistic long CV passes the cap, a pathological one does not",
    (require_within(_lim_real_cv, 256, "resume") is None)
    and utf8_bytes(_lim_real_cv) < 256 * 1024,
)
try:
    require_within("x" * (300 * 1024), 256, "resume")
    check("limits: an oversize résumé raises InputTooLarge", False, "did not raise")
except InputTooLarge as _e:
    check(
        "limits: an oversize résumé raises InputTooLarge carrying both numbers",
        _e.kind == "resume" and _e.size_kb == 300 and _e.cap_kb == 256,
        f"{_e.kind} {_e.size_kb}/{_e.cap_kb}",
    )

# clip_utf8 is for SCRAPED text only. It must cut on a character boundary (a raw
# byte slice mid-character yields U+FFFD) and back off to whitespace, because a
# shortened Hebrew word can BE a different real word (בנק -> נק) — a term the
# candidate never wrote, in the section the fabrication guard does not cover.
_lim_long_he = (_HE + " ") * 200
_lim_cut, _lim_flag = clip_utf8(_lim_long_he, 1)
check(
    "limits: clip cuts on a character boundary and never mid-word",
    _lim_flag is True
    and "�" not in _lim_cut
    and _lim_long_he.startswith(_lim_cut)
    and _lim_long_he[len(_lim_cut) : len(_lim_cut) + 1].isspace()
    and _lim_cut.split()[-1] in _HE.split(),
    f"{utf8_bytes(_lim_cut)} bytes, last word {_lim_cut.split()[-1]!r}",
)
check(
    "limits: text under the cap is returned untouched, and a word-less blob is not emptied",
    clip_utf8("short text", 256) == ("short text", False)
    and len(clip_utf8("A" * 5000, 1)[0]) == 1024,
)

# The classifier for a context overflow keys on `code`, never on the exception
# type: every malformed-parameter bug is also a BadRequestError, and reporting
# those as "your résumé is too long" is a guard firing on legitimate input.
import httpx as _lim_httpx  # noqa: E402
from openai import BadRequestError as _LimBadRequest  # noqa: E402


def _lim_err(msg: str, code: str) -> _LimBadRequest:
    return _LimBadRequest(
        msg,
        response=_lim_httpx.Response(400, request=_lim_httpx.Request("POST", "http://x")),
        body={"code": code},
    )


check(
    "limits: only a context_length_exceeded 400 is treated as a size problem",
    _lim_client_mod._is_context_overflow(
        _lim_err("maximum context length is 128000 tokens", "context_length_exceeded")
    )
    is True
    and _lim_client_mod._is_context_overflow(
        _lim_err("Unsupported parameter: 'foo'", "unsupported_parameter")
    )
    is False,
)

# THE JSON TRUNCATION TRAP. chat.completions.create NEVER raises on
# finish_reason == "length" — it returns partial content, which json.loads then
# fails on, and the user is shown a parse error that reads as our bug. The
# SDK's own LengthFinishReasonError is reachable only via .parse()/.stream().
from types import SimpleNamespace as _LimNS  # noqa: E402

check(
    "limits: a truncated completion raises OutputTruncated instead of a parse error",
    _lim_client_mod._guard_finish_reason(
        _LimNS(choices=[_LimNS(finish_reason="stop")])
    )
    is None,
)
try:
    _lim_client_mod._guard_finish_reason(_LimNS(choices=[_LimNS(finish_reason="length")]))
    check("limits: finish_reason=length is detected", False, "did not raise")
except OutputTruncated:
    check("limits: finish_reason=length is detected", True)

# ...and it must be WIRED IN, not merely defined. Driving the real
# complete_json/complete_text is the only thing that catches the guard being
# deleted from the call path: a check that calls _guard_finish_reason directly
# still passes with the call site gone. Both entry points, because complete_text
# (the cover letter) has no parse step to fail loudly on its own — the letter
# would simply stop mid-sentence.
def _lim_truncating_metered(kwargs):
    return _LimNS(
        choices=[_LimNS(finish_reason="length", message=_LimNS(content='{"partial":'))]
    )


_lim_c_json = _lim_client_mod.OpenAIClient.__new__(_lim_client_mod.OpenAIClient)
_lim_c_json._model, _lim_c_json._unsupported, _lim_c_json._cap_param = "m", set(), "max_completion_tokens"
_lim_c_json._metered = _lim_truncating_metered
_lim_json_raised = ""
try:
    _lim_c_json.complete_json("sys", "user")
except OutputTruncated:
    _lim_json_raised = "typed"
except Exception as _e:  # noqa: BLE001 - a JSONDecodeError here is the defect
    _lim_json_raised = type(_e).__name__

_lim_c_text = _lim_client_mod.OpenAIClient.__new__(_lim_client_mod.OpenAIClient)
_lim_c_text._model, _lim_c_text._unsupported, _lim_c_text._cap_param = "m", set(), "max_completion_tokens"
_lim_c_text._metered = _lim_truncating_metered
_lim_text_raised = ""
try:
    _lim_c_text.complete_text("sys", "user")
except OutputTruncated:
    _lim_text_raised = "typed"
except Exception as _e:  # noqa: BLE001
    _lim_text_raised = type(_e).__name__

check(
    "limits: a truncated response raises through complete_json AND complete_text",
    _lim_json_raised == "typed" and _lim_text_raised == "typed",
    f"json={_lim_json_raised or 'no raise (JSONDecodeError would reach the user)'} "
    f"text={_lim_text_raised or 'no raise (letter silently cut short)'}",
)

# The output cap must actually reach the wire, and the capability probe must
# survive a model that rejects BOTH temperature and the modern cap name. The
# previous single-shot retry stripped exactly ONE kwarg, so such a call died on
# the second — which is what adding a second probe to it would have caused.
_lim_sent: list[dict] = []


def _lim_fake_metered(reject: tuple[str, ...]):
    def _run(kwargs):
        _lim_sent.append(dict(kwargs))
        for name in reject:
            if name in kwargs:
                raise _lim_err(f"Unsupported parameter: '{name}'", "unsupported_parameter")
        return _LimNS(
            choices=[_LimNS(finish_reason="stop", message=_LimNS(content='{"ok":1}'))]
        )

    return _run


_lim_c = _lim_client_mod.OpenAIClient.__new__(_lim_client_mod.OpenAIClient)
_lim_c._model, _lim_c._unsupported, _lim_c._cap_param = "m", set(), "max_completion_tokens"
_lim_c._metered = _lim_fake_metered(())
_lim_c.complete_json("sys", "user")
check(
    "limits: an explicit output cap is sent on every call",
    _lim_sent[-1].get("max_completion_tokens") == get_settings().llm_max_output_tokens,
    str(_lim_sent[-1].get("max_completion_tokens")),
)

_lim_sent.clear()
_lim_c2 = _lim_client_mod.OpenAIClient.__new__(_lim_client_mod.OpenAIClient)
_lim_c2._model, _lim_c2._unsupported, _lim_c2._cap_param = "m", set(), "max_completion_tokens"
_lim_c2._metered = _lim_fake_metered(("temperature", "max_completion_tokens"))
check(
    "limits: the probe survives a model rejecting temperature AND the cap name",
    _lim_c2.complete_json("sys", "user") == {"ok": 1}
    and _lim_c2._cap_param == "max_tokens"
    and "max_tokens" in _lim_sent[-1],
    f"attempts={len(_lim_sent)} final={sorted(k for k in _lim_sent[-1] if k not in ('model','messages','response_format'))}",
)

# A context overflow must NOT be mistaken for a capability problem and retried
# away — it has to surface as the typed error the route maps to 413.
_lim_c3 = _lim_client_mod.OpenAIClient.__new__(_lim_client_mod.OpenAIClient)
_lim_c3._model, _lim_c3._unsupported, _lim_c3._cap_param = "m", set(), "max_completion_tokens"


def _lim_ctx_metered(kwargs):
    raise _lim_err("maximum context length is 128000 tokens", "context_length_exceeded")


_lim_c3._metered = _lim_ctx_metered
try:
    _lim_c3.complete_json("sys", "user")
    check("limits: a context overflow surfaces as ContextWindowExceeded", False, "no raise")
except ContextWindowExceeded:
    check("limits: a context overflow surfaces as ContextWindowExceeded", True)

# The call sites that must refuse rather than truncate — the résumé is the
# user's own document, and a silently shortened one is data loss they would
# discover from a recruiter.
# THE BOUNDARY PIN. Guarding the stored master résumé is NOT enough: 25 request
# models take a `resume: ResumeModel` straight from the client body, so the
# stored row is one of twenty-six doors. Every model call builds its user
# message with a prompts.*_user builder, so that is where the bound lives — and
# every builder taking a guarded argument must actually carry the decorator, or
# it is a door standing open.
from app.llm import prompts as _lim_prompts  # noqa: E402

import re as _lim_re  # noqa: E402

_lim_src = _lim_inspect.getsource(_lim_prompts)
_lim_decorator = "@_bounded" + chr(10) + "def "
_lim_undecorated = [
    name
    for name, params in _lim_re.findall(r"^def (\w+_user)\(([^)]*)\)", _lim_src, _lim_re.M)
    if any(a in params for a in ("resume_json", "raw_text", "jd_text"))
    and (_lim_decorator + name + "(") not in _lim_src
]
check(
    "limits: every prompt builder taking a résumé or JD argument is bounded",
    len(_lim_src) > 2000 and not _lim_undecorated,
    f"unbounded: {_lim_undecorated}" if _lim_undecorated else "all bounded",
)

_lim_big_resume = '{"x":"' + "y" * (300 * 1024) + '"}'
_lim_fired = []
for _lim_name, _lim_call in (
    ("cover_letter", lambda: _lim_prompts.cover_letter_user(_lim_big_resume, "{}", "warm")),
    ("jd_fit", lambda: _lim_prompts.jd_fit_user(_lim_big_resume, "jd")),
    ("interview_chat", lambda: _lim_prompts.interview_chat_user(_lim_big_resume, "jd", [])),
    ("linkedin", lambda: _lim_prompts.linkedin_user(_lim_big_resume)),
):
    try:
        _lim_call()
    except InputTooLarge:
        _lim_fired.append(_lim_name)
check(
    "limits: the bound reaches the routes that bypass the stored résumé entirely",
    _lim_fired == ["cover_letter", "jd_fit", "interview_chat", "linkedin"],
    str(_lim_fired),
)
# The false-positive half, in the same block: an ordinary résumé and job ad must
# sail through every one of them, or the guard is worse than no guard.
check(
    "limits: ordinary inputs are untouched by the bound",
    bool(_lim_prompts.jd_fit_user('{"name":"Jane"}', "We need a Python developer."))
    and bool(_lim_prompts.structure_resume_user("Jane Doe\nEngineer at Acme")),
)

check(
    "limits: structure_resume and analyze_jd guard their input before the model",
    "require_within" in _lim_inspect.getsource(_structure_resume_mod)
    and "require_within" in _lim_inspect.getsource(_jd_analyzer_mod),
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

import re as _re  # noqa: E402
import pdfplumber as _pdfplumber  # noqa: E402
from bidi.algorithm import get_display as _get_display  # noqa: E402

from app.models import LanguageSkill, MilitaryService  # noqa: E402


def _docx_xml(b: bytes) -> str:
    with _zipfile.ZipFile(_io.BytesIO(b)) as z:
        return z.read("word/document.xml").decode("utf-8")


def _docx_parts(b: bytes) -> dict[str, bytes]:
    """Every part of the .docx, keyed by name — the file's CONTENT with the zip
    container's clock left out.

    `render_docx(a) == render_docx(b)` looked like the strongest possible
    "same document" assertion and was in fact a wall-clock race: python-docx
    hands `writestr` a plain name, so each entry is stamped with the current
    time at 2-second DOS granularity, and two renders either side of that
    boundary differ in bytes while being the same file. Observed red on a clean
    tree with identical lengths (36951 == 36951). Comparing parts keeps the
    byte-for-byte claim over everything the renderer actually writes and drops
    only the timestamp it does not control.
    """
    with _zipfile.ZipFile(_io.BytesIO(b)) as z:
        return {name: z.read(name) for name in sorted(z.namelist())}


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

# Tailor prompt: page budget + military untouchable, Task tag intact.
check("TAILOR prompt protects military service", "MILITARY SERVICE IS UNTOUCHABLE" in _prompts.TAILOR_SYSTEM)
check("TAILOR prompt has page-length guidance", "TWO PAGES" in _prompts.TAILOR_SYSTEM)
check(
    "TAILOR prompt tells the model projects are curated, not preserved",
    "PROJECTS ARE CURATED, NOT PRESERVED" in _prompts.TAILOR_SYSTEM,
)
check(
    "TAILOR prompt still protects roles/degrees/certs from the trim",
    "PROTECTED ENTRIES" in _prompts.TAILOR_SYSTEM,
)
check("TAILOR prompt Task tag still first", _prompts.TAILOR_SYSTEM.startswith("Task: TAILOR."))
check(
    "PLAN_CV prompt asks for a project shortlist",
    "select_projects" in _prompts.PLAN_CV_SYSTEM and "drop_projects" in _prompts.PLAN_CV_SYSTEM,
)
check(
    "TAILOR prompt caps the skills list and unpacks master-CV category blocks",
    "KEEP IT SHORT AND FLAT" in _prompts.TAILOR_SYSTEM
    and "15-25 INDIVIDUAL skills" in _prompts.TAILOR_SYSTEM,
)
# The budget must reach the model as concrete numbers — a vague "keep it short"
# against a 20-project master résumé is exactly what produced 5 pages.
_budget_user = _prompts.tailor_user("{}", "{}", max_pages=2, source_pages=5, source_projects=21)
check(
    "tailor_user states the real page/project numbers when the source is long",
    "5 pages" in _budget_user and "21 projects" in _budget_user and "2 pages" in _budget_user,
)
check(
    "tailor_user stays quiet about cutting when the source already fits",
    "NEEDS REAL CUTTING" not in _prompts.tailor_user("{}", "{}", max_pages=2, source_pages=1),
)

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
check(
    "migration shim added the 17.3 outcome columns to a pre-existing applications table",
    {"template", "voice_score", "fabrication_flag_count"} <= _cols,
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

# Already-applied marking on search results: the point is to stop re-reading a
# job you have handled. Matching by URL alone is not enough — the tracker's URL
# and the search card's URL differ in shape for the same LinkedIn posting, and
# the same job appears on two boards under two URLs.
from app.db.history import applied_status_map, stamp_applied  # noqa: E402

_applied_app = Application(
    user_id=_admin_id, job_title="Tracked Role", company="TrackedCo", overall_score=70.0,
    status="applied", job_url="https://www.linkedin.com/jobs/view/4012345678/",
)
_saved_app = Application(
    user_id=_admin_id, job_title="Saved Role", company="SavedCo", overall_score=60.0,
    status="saved", job_url="https://boards.example/jobs/77",
)
_db.add_all([_applied_app, _saved_app])
_db.commit()

_stamp_map = applied_status_map(_db, _admin_id)
_to_stamp = [
    # Same LinkedIn posting, different slug + tracking params than the tracker's.
    JobMatch(title="Tracked Role", company="TrackedCo",
             url="https://il.linkedin.com/jobs/view/backend-engineer-at-trackedco-4012345678?refId=abc"),
    # Saved (not applied) — still badged, but must NOT count as "done".
    JobMatch(title="Saved Role", company="SavedCo", url="https://boards.example/jobs/77"),
    # Applied via a different board; this card is the LinkedIn twin.
    JobMatch(title="Cross Board", company="XCo", url="https://linkedin.com/jobs/view/999",
             also_on=[_AlsoOn(source="comeet", url="https://boards.example/jobs/77")]),
    JobMatch(title="Brand New", company="NewCo", url="https://boards.example/jobs/never-seen"),
]
stamp_applied(_to_stamp, _stamp_map)
check(
    "applied marking survives a different LinkedIn slug + tracking params",
    _to_stamp[0].application_status == "applied",
    _to_stamp[0].application_status,
)
check(
    "a saved job is marked saved, not applied",
    _to_stamp[1].application_status == "saved",
    _to_stamp[1].application_status,
)
check(
    "a job handled on another board is marked via also_on",
    _to_stamp[2].application_status == "saved",
    _to_stamp[2].application_status,
)
check(
    "an untouched job stays unmarked",
    _to_stamp[3].application_status == "",
    _to_stamp[3].application_status,
)
_untouched = [JobMatch(title="X", url="https://boards.example/jobs/77")]
stamp_applied(_untouched, {})
check("empty tracker marks nothing", _untouched[0].application_status == "")

# The SSE search stamps DICTS: its incremental `match` frames are already
# model_dump()ed by the time they reach the endpoint, and those frames are the
# list the user reads while the search runs.
_frame = JobMatch(
    title="Tracked Role", company="TrackedCo",
    url="https://il.linkedin.com/jobs/view/backend-engineer-4012345678?refId=x",
).model_dump()
_frame_cross = JobMatch(title="Cross", url="https://other/1",
                        also_on=[_AlsoOn(source="comeet", url="https://boards.example/jobs/77")]).model_dump()
stamp_applied([_frame, _frame_cross], _stamp_map)
check("SSE match frames (dicts) get stamped too", _frame["application_status"] == "applied",
      _frame["application_status"])
check("dict frames follow also_on as well", _frame_cross["application_status"] == "saved",
      _frame_cross["application_status"])

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

# 15b-2. PLAN 15.3 (résumé builder): a ledger-less save derives the facts
# ledger from the résumé itself — the user typed those facts, so the résumé IS
# the guard's source of truth and a built master never has an empty ledger.
check(
    "ledger-less master save derives the ledger from the résumé",
    _saved_en.ledger is not None
    and _saved_en.ledger.model_dump() == build_facts_ledger(resume).model_dump()
    and any(_saved_en.ledger.model_dump().values()),
)
# An explicitly passed ledger must be stored verbatim, never rebuilt.
_explicit_ledger = build_facts_ledger(resume)
_explicit_ledger.employers.append("Ledger-Pin Co")
_saved_explicit = save_master_resume(
    MasterResumeIn(resume=resume, ledger=_explicit_ledger, label="EN master v2"),
    db=_db,
    user=_admin_user,
)
check(
    "explicitly passed ledger is stored verbatim, not rebuilt",
    _saved_explicit.ledger is not None
    and "Ledger-Pin Co" in _saved_explicit.ledger.employers,
)
# Restore the derived ledger so downstream master-résumé checks see clean state.
save_master_resume(MasterResumeIn(resume=resume, label="EN master v2"), db=_db, user=_admin_user)
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
# ...AND THE ANSWER IS NOT A COIN FLIP WHEN THE CLOCK CANNOT SEPARATE TWO SAVES.
# `datetime.now()` ticks about every 15.6 ms on Windows, so two saves inside one
# tick used to land on the identical `updated_at`, and `_master_rows`' sort had
# nothing left to order them by — `GET /profile/resume` with no `lang` then
# answered with whichever row SQLite happened to return. It surfaced as the
# check above failing on one run and passing on the next.
#
# Driven by FORCING the tie rather than by hoping for one: both rows are stamped
# with the same instant, then a save must still come back on top. A check that
# waited for the real 15 ms collision would pass by never firing.
from datetime import datetime as _tie_dt, timezone as _tie_tz  # noqa: E402
from app.api.routes import _master_rows  # noqa: E402

_tie_at = _tie_dt(2030, 1, 1, tzinfo=_tie_tz.utc)
for _tie_row in _master_rows(_db, _admin_user.id):
    _tie_row.updated_at = _tie_at
_db.commit()
save_master_resume(MasterResumeIn(resume=resume, label="EN master v3"), db=_db, user=_admin_user)
_tied_default = get_master_resume(db=_db, user=_admin_user)
check(
    "default master: a save wins even when the clock cannot separate it from the other slot",
    _tied_default is not None and _tied_default.label == "EN master v3",
    _tied_default.label if _tied_default else "None",
)
check(
    "...and the other language slot is untouched by that tiebreak",
    (_he_after := get_master_resume(lang="he", db=_db, user=_admin_user)) is not None
    and _he_after.label == "HE master",
    _he_after.label if _he_after else "None",
)

# 15c. Job alerts (PLAN 6): settings row, history diffing, email body, and the
# full run loop with a canned search function (no network, no LLM, no SMTP)
from app.core.alerts import (  # noqa: E402
    DEFAULT_MIN_SCORE,
    above_min,
    alert_min_score,
    build_alert_email,
    build_alert_email_html,
    displayed_score as _displayed_score,
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
# Old-but-relevant backfill (PLAN 15.6): stale matches are marked with their
# post date in both email bodies; fresh matches never get the chip.
_stale_match = JobMatch(
    title="Backend Engineer", company="OldCo", overall=80.0,
    url="https://alerts/stale-1", posted_at="2026-05-10", stale=True,
)
check(
    "alert html marks stale jobs with an 'Older posting' chip + date",
    "Older posting" in build_alert_email_html([_stale_match], _AlertCtx(job_title="X"))
    and "2026-05-10" in build_alert_email_html([_stale_match], _AlertCtx(job_title="X"))
    and "Older posting" not in _html,
)
check(
    "alert plain text marks stale jobs with the post date",
    "older posting — 2026-05-10" in build_alert_email([_stale_match], _AlertCtx(job_title="X"))[1]
    and "older posting" not in _body,
)
check(
    "alert html is hebrew-safe with dir=auto",
    "מהנדס/ת תוכנה" in _html_he and 'dir="auto"' in _html_he,
)

# PLAN 28.5 — the ghost chip, in BOTH bodies, off ONE threshold.
#
# The email and the Jobs card must never describe the same posting differently,
# and they did: `_ghost_label` gated on `signals` being non-empty while
# `cards.tsx::strongestGhostSignal` gates on `closed || likely`. A posting with
# ONE WEAK signal has signals and is not likely, so it was chipped "Relisted" in
# the inbox and showed nothing on the card it linked to. Both halves are pinned
# here, in one check, because "make the chip appear" is trivially satisfied by
# chipping every posting that carries any signal at all — which is the defect.
#
# `closed` is deliberately absent: a certain signal filters the posting before a
# JobMatch exists, so it is unreachable from an email by construction. That is
# asserted one section down, where the search itself is driven.
def _ghost_match(url: str, ghost) -> JobMatch:  # noqa: ANN001, ANN202
    return JobMatch(title="Backend Engineer", company="GhostCo", overall=80.0, url=url, ghost=ghost)


_gh_strong = _GhostReport(
    likely=True,
    signals=[_GhostSignal(kind="evergreen", strength="strong", raw="This is not a specific role.")],
)
_gh_one_weak = _GhostReport(  # has a signal, is NOT likely — the case that broke
    likely=False,
    signals=[_GhostSignal(kind="reposted", strength="weak")],
)
_gh_two_weak = _GhostReport(
    likely=True,
    signals=[
        _GhostSignal(kind="long_open", strength="weak", days=35, basis="first_seen"),
        _GhostSignal(kind="reposted", strength="weak"),
    ],
)
_gh_html_strong = build_alert_email_html([_ghost_match("https://a/g1", _gh_strong)], _AlertCtx(job_title="X"))
_gh_text_strong = build_alert_email([_ghost_match("https://a/g1", _gh_strong)], _AlertCtx(job_title="X"))[1]
_gh_html_weak = build_alert_email_html([_ghost_match("https://a/g2", _gh_one_weak)], _AlertCtx(job_title="X"))
_gh_text_weak = build_alert_email([_ghost_match("https://a/g2", _gh_one_weak)], _AlertCtx(job_title="X"))[1]
_gh_html_two = build_alert_email_html([_ghost_match("https://a/g3", _gh_two_weak)], _AlertCtx(job_title="X"))
_gh_text_two = build_alert_email([_ghost_match("https://a/g3", _gh_two_weak)], _AlertCtx(job_title="X"))[1]
check(
    "alert ghost chip rides BOTH bodies on `closed or likely`, and one weak "
    "signal — which the card would not badge — chips neither",
    # The HTML chip is title-case; the plain-text twin lower-cases the FIRST
    # CHARACTER ONLY, so it reads as a fragment beside "(states a location
    # requirement)" without flattening an acronym a future label may carry.
    # Both casings are pinned: one body drifting is the same defect as one body
    # gating differently, which is what this check exists for.
    "General application" in _gh_html_strong
    and "(general application)" in _gh_text_strong
    and "Relisted" not in _gh_html_weak
    and "relisted" not in _gh_text_weak.lower()
    # 2 weak IS likely, and long_open outranks reposted, so the STRONGEST
    # signal's label is the one that ships — not merely any label.
    and "Seen for 35 days" in _gh_html_two
    and "(seen for 35 days)" in _gh_text_two
    and "General application" not in _html,  # a plain match never grows the chip
    f"strong_html={'General application' in _gh_html_strong} "
    f"strong_text={'(general application)' in _gh_text_strong} "
    f"weak_html={'Relisted' in _gh_html_weak} two={'Seen for 35 days' in _gh_html_two}",
)


# `sightings_fn` is NAMED on every fake below rather than swallowed by a `**_`.
# `run_alert` documents its call shape as
# `search_fn(resume, context, cache=..., sightings_fn=...)`, and a `**_` would
# absorb a RENAMED kwarg silently — the fake would keep passing while the real
# `search_jobs` stopped receiving the market memory and `long_open`/`reposted`
# went permanently quiet. Spelled out, a rename goes red here first.
_alert_sfn: list = []  # what the cron actually handed the search, per call


def _canned_search(resume, ctx, cache=None, sightings_fn=None):  # noqa: ANN001 - matches search_jobs' shape
    _alert_sfn.append(sightings_fn)
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


def _recording_search(resume, ctx, cache=None, sightings_fn=None):  # noqa: ANN001 - matches search_jobs' shape
    _seen_ctx.append(ctx)
    _alert_sfn.append(sightings_fn)
    return JobSearchResult(context=_AlertCtx(job_title="X"), matches=[], skipped=0)


run_alert(_db, _admin_id, force=True, search_fn=_recording_search)
check(
    "alert run forwards the saved customized context to the search",
    len(_seen_ctx) == 1 and _seen_ctx[0] is not None
    and _seen_ctx[0].job_title == "Backend Engineer" and _seen_ctx[0].location == "Tel Aviv",
    str(_seen_ctx[0]) if _seen_ctx else "no call",
)

# …and the market memory travels with it (PLAN 28.3). A daily cron that read no
# sightings would leave `long_open` and `reposted` permanently dark in the one
# place they matter most — the email is the surface that tells the user not to
# bother — and nothing on the page would say so, because the classifier abstains
# silently when the sighting is None. Pinned by CALLING what was handed over:
# a `partial(load_sightings, db)` answers {} for an empty key list, while a None
# or a sentinel does not answer at all.
check(
    "alerts cron: the search is handed a live market-memory reader, not None",
    _alert_sfn and callable(_alert_sfn[-1]) and _alert_sfn[-1]([]) == {},
    f"{len(_alert_sfn)} calls, last={_alert_sfn[-1] if _alert_sfn else None}",
)

update_alert(_db, _admin_id, enabled=False, email="me@example.com", context=None)
run_alert(_db, _admin_id, force=True, search_fn=_recording_search)
check(
    "alert run forwards None when the customized context is cleared",
    len(_seen_ctx) == 2 and _seen_ctx[1] is None,
)
check("alert run respects the toggle", run_alert(_db, _admin_id, search_fn=_canned_search).ran is False)
check("alert run with force ignores the toggle", run_alert(_db, _admin_id, force=True, search_fn=_canned_search).ran is True)


def _broken_search(resume, ctx, cache=None, sightings_fn=None):  # noqa: ANN001
    raise ValueError("boards are down")


_run_err = run_alert(_db, _admin_id, force=True, search_fn=_broken_search)
check(
    "alert run reports search failure instead of raising",
    _run_err.ran is True and "boards are down" in _run_err.error
    and "boards are down" in get_alert(_db, _admin_id).last_error,
)

# 15c-bis. The alert fit bar: the daily email carries only high-fit jobs.
# Before this, every unseen posting the search returned was emailed — a good
# morning arrived as ~20 jobs of which two were worth opening.
_bar_pool = [
    JobMatch(title="Way above", company="A", overall=91.0, url="https://bar/91"),
    JobMatch(title="At the bar", company="B", overall=75.0, url="https://bar/75"),
    JobMatch(title="Rounds up to the bar", company="C", overall=74.6, url="https://bar/74.6"),
    JobMatch(title="Rounds below", company="D", overall=74.4, url="https://bar/74.4"),
    JobMatch(title="Well below", company="E", overall=41.0, url="https://bar/41"),
]
check(
    "alert bar keeps jobs at/above it and drops the rest",
    [m.url for m in above_min(_bar_pool, 75)] == ["https://bar/91", "https://bar/75", "https://bar/74.6"],
    str([m.url for m in above_min(_bar_pool, 75)]),
)
# The rounded value is the one the email prints ("75% fit") and the one the fit
# ring shows, so the bar must be read off THAT and not the raw float — otherwise
# the History tab shows "75% fit" on a job the 75% email footer says it excluded.
check(
    "alert bar compares the DISPLAYED (rounded) fit, not the raw float",
    any(m.url == "https://bar/74.6" for m in above_min(_bar_pool, 75))
    and not any(m.url == "https://bar/74.4" for m in above_min(_bar_pool, 75)),
)
# EXACTLY x.5 IS THE CASE THAT MATTERS, and the two probes above straddle it
# without ever landing on it — which is why this shipped. Python's `round()` is
# half-to-EVEN, so `round(74.5)` is 74 while `Math.round(74.5)` (ProgressRing,
# the job card, the kits queue) is 75. `overall` is stored to one decimal —
# `round(0.5*cov + 0.5*fit, 1)`, reachable at coverage 80.0 / fit 69.0 — so x.5
# is a real value, not a hypothetical. The app painted "75% fit" on a job the
# 75%-bar email had silently dropped.
_bar_half = [JobMatch(title="Exactly half", company="F", overall=74.5, url="https://bar/74.5")]
check(
    "alert bar rounds HALF-UP like the fit ring — 74.5 displays as 75 and must "
    "clear a 75 bar (python's round() is half-to-even and would drop it)",
    [m.url for m in above_min(_bar_half, 75)] == ["https://bar/74.5"],
    f"displayed_score(74.5)={_displayed_score(74.5)} "
    f"round(74.5)={round(74.5)}",
)
# The false-positive half: half-up must not become "round everything up".
check(
    "alert bar half-up still drops 74.49 — the rounding is half-up, not ceiling",
    above_min([JobMatch(title="x", company="G", overall=74.49, url="https://bar/74.49")], 75) == []
    and _displayed_score(75.5) == 76
    and _displayed_score(75.0) == 75,
)
# The false-positive half: "only email high-match jobs" is trivially satisfied by
# emailing nothing, and 0 must still mean the pre-bar behaviour.
check(
    "alert bar of 0 emails every new job (the pre-bar behaviour is reachable)",
    [m.url for m in above_min(_bar_pool, 0)] == [m.url for m in _bar_pool]
    and len(above_min(_bar_pool, 60)) == 4
    and len(above_min(_bar_pool, 90)) == 1,
)
check("alert bar defaults to 75", DEFAULT_MIN_SCORE == 75)

update_alert(_db, _admin_id, enabled=True, email="me@example.com", context=None, min_score=60)
check("alert bar persists on the settings row", alert_min_score(get_alert(_db, _admin_id)) == 60)
update_alert(_db, _admin_id, enabled=True, email="me@example.com", context=None)
check(
    "alert update with min_score=None leaves the bar alone (a stale client can't reset it)",
    alert_min_score(get_alert(_db, _admin_id)) == 60,
)
update_alert(_db, _admin_id, enabled=True, email="me@example.com", context=None, min_score=150)
check("alert bar clamps above 100", alert_min_score(get_alert(_db, _admin_id)) == 100)
update_alert(_db, _admin_id, enabled=True, email="me@example.com", context=None, min_score=-5)
check("alert bar clamps below 0", alert_min_score(get_alert(_db, _admin_id)) == 0)

# The footer names the RULE, never a held-back count (a number you cannot tap to
# reveal is a dead end in an inbox — the same call the geo filter made).
_bar_subj, _bar_body = build_alert_email(_bar_pool[:1], _AlertCtx(job_title="X"), 75)
_bar_html = build_alert_email_html(_bar_pool[:1], _AlertCtx(job_title="X"), min_score=75)
check(
    "alert email states the bar in both bodies",
    "75% fit or above" in _bar_body and "75% fit or above" in _bar_html,
)
check(
    "alert email says nothing about a bar when there is none",
    "fit or above" not in build_alert_email(_bar_pool[:1], _AlertCtx(job_title="X"), 0)[1]
    and "fit or above" not in build_alert_email_html(_bar_pool[:1], _AlertCtx(job_title="X")),
)
check(
    "alert email footer names no held-back count",
    "below your bar" not in _bar_body and "below your bar" not in _bar_html
    and "4 more" not in _bar_body,
)

# End to end: the bar filters the EMAIL, never the history. Every match is still
# recorded — that is what the History tab shows and what load_score_cache reuses,
# so dropping below-bar rows would make the cron re-score them every morning.
def _bar_search(resume, ctx, cache=None, sightings_fn=None):  # noqa: ANN001 - matches search_jobs' shape
    return JobSearchResult(context=_AlertCtx(job_title="X"), matches=_bar_pool, skipped=0)


update_alert(_db, _admin_id, enabled=True, email="me@example.com", context=None, min_score=75)
_bar_run = run_alert(_db, _admin_id, search_fn=_bar_search)
check(
    "alert run reports all new jobs AND the subset that cleared the bar",
    _bar_run.total == 5 and _bar_run.new_count == 5 and _bar_run.above_min == 3,
    str(_bar_run),
)
_bar_row = get_alert(_db, _admin_id)
check(
    "alert run persists both counts (12 new / 3 emailed must not read as a broken run)",
    _bar_row.last_new_count == 5 and _bar_row.last_above_min == 3,
    f"{_bar_row.last_new_count}/{_bar_row.last_above_min}",
)
# A run from BEFORE the bar never measured this, and the card renders a
# different sentence for unknown than for zero — so the column must not default
# to 0. Caught on the real page, which said "6 new jobs, 0 above your 75% bar"
# about a morning that had no bar. 0 stays a legitimate stored value.
from app.db.models import JobAlert as _JobAlert  # noqa: E402

_virgin = _JobAlert(user_id=987654)
_db.add(_virgin)
_db.commit()
_db.refresh(_virgin)
check(
    "a never-run alert reports its cleared-the-bar count as UNKNOWN, not 0",
    _virgin.last_above_min is None and _virgin.last_new_count == 0,
    str(_virgin.last_above_min),
)

check(
    "below-bar jobs are still recorded in history (cache stays warm, never re-emailed)",
    split_new_matches(_db, _bar_pool, _admin_id) == [],
    str([m.url for m in split_new_matches(_db, _bar_pool, _admin_id)]),
)

# A run where nothing clears the bar sends no email at all — and still records.
_low = [JobMatch(title="Low", company="F", overall=30.0, url="https://bar/low-1")]


def _low_search(resume, ctx, cache=None, sightings_fn=None):  # noqa: ANN001
    return JobSearchResult(context=_AlertCtx(job_title="X"), matches=_low, skipped=0)


_low_run = run_alert(_db, _admin_id, search_fn=_low_search)
check(
    "alert run with nothing above the bar: new but nothing to email",
    _low_run.new_count == 1 and _low_run.above_min == 0 and _low_run.emailed is False,
    str(_low_run),
)
check(
    "and a measured 0 is STORED as 0, not left unknown — the other half of the split",
    get_alert(_db, _admin_id).last_above_min == 0,
    str(get_alert(_db, _admin_id).last_above_min),
)
update_alert(_db, _admin_id, enabled=False, email="me@example.com", context=None, min_score=DEFAULT_MIN_SCORE)

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

# ---------------------------------------------------------------------------
# THE DOCX DECOMPRESSION CAP. `max_upload_mb` bounds COMPRESSED bytes, and a
# .docx is a zip that python-docx expands into an lxml tree in full before a
# word of text exists. Measured: 0.298 MB of zip is 102.0 MB of `document.xml`
# (343:1), so the 10 MB upload cap admitted ~3.4 GB of XML from unremarkable
# content. That matters because `POST /public/scan` takes NO access code — it
# is the one door a stranger who has never seen an invite code can reach.
#
# Driven through `extract_text`, never by calling the guard directly: a direct
# call still passes with the `_assert_docx_expansion(data)` line deleted from
# `_extract_docx`, which is the 22.10 failure mode — a check that cannot fail.
import inspect as _docx_inspect  # noqa: E402
import io as _docx_io  # noqa: E402
import random as _docx_random  # noqa: E402
import zipfile as _zf_mod  # noqa: E402

from app.llm.limits import InputTooLarge as _DocxTooLarge  # noqa: E402
from app.parsers.resume_parser import extract_text as _docx_extract  # noqa: E402


def _make_docx(document_xml: bytes, extra: dict[str, bytes] | None = None) -> bytes:
    """A minimal but VALID .docx, so the guard is what refuses it — not a parse error."""
    buf = _docx_io.BytesIO()
    with _zf_mod.ZipFile(buf, "w", _zf_mod.ZIP_DEFLATED) as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Default Extension="jpeg" ContentType="image/jpeg"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument'
            '.wordprocessingml.document.main+xml"/></Types>',
        )
        z.writestr(
            "_rels/.rels",
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships'
            '/officeDocument" Target="word/document.xml"/></Relationships>',
        )
        z.writestr("word/document.xml", document_xml)
        for name, blob in (extra or {}).items():
            z.writestr(name, blob)
    return buf.getvalue()


_DOCX_HEAD = (
    b'<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/'
    b'wordprocessingml/2006/main"><w:body>'
)
_DOCX_TAIL = b"</w:body></w:document>"
_DOCX_PARA = b"<w:p><w:r><w:t>x</w:t></w:r></w:p>"

# ~40 MB of XML from ~0.1 MB of zip: past the 32 MB cap, nowhere near the 10 MB
# upload cap, so only the expansion guard can refuse it.
_docx_bomb = _make_docx(_DOCX_HEAD + _DOCX_PARA * 1_200_000 + _DOCX_TAIL)

# THE FALSE-POSITIVE HALF, IN THE SAME CHECK. "Make the bomb fail" is trivially
# satisfied by capping at 1 MB, and the case that would break first is not a
# text CV (a 30-page master is 1.0 MB of XML) but an image-heavy one: images are
# already compressed, so a photo-laden .docx expands ~1:1 and its ceiling is
# `max_upload_mb` ITSELF. Incompressible bytes, deliberately — a run of zeros
# would compress away and pin nothing.
_docx_real = _make_docx(
    _DOCX_HEAD + b"<w:p><w:r><w:t>Dana Levi builds Kubernetes tooling</w:t></w:r></w:p>" + _DOCX_TAIL,
    {"word/media/image1.jpeg": _docx_random.Random(7).randbytes(6 * 1024 * 1024)},
)
_docx_bomb_err: object = None
try:
    _docx_extract("bomb.docx", _docx_bomb)
except Exception as _e:  # noqa: BLE001 - the TYPE is the assertion
    _docx_bomb_err = _e
_docx_real_text = _docx_extract("real.docx", _docx_real)
check(
    "a .docx that expands past the cap is refused (413), while a 6 MB "
    "image-heavy CV — which expands ~1:1 and is the worst legitimate case — "
    "still parses",
    isinstance(_docx_bomb_err, _DocxTooLarge)
    and getattr(_docx_bomb_err, "kind", "") == "resume"
    and "Kubernetes" in _docx_real_text,
    f"bomb={type(_docx_bomb_err).__name__} zip={len(_docx_bomb)}B "
    f"real_zip={len(_docx_real)}B text={_docx_real_text[:40]!r}",
)

# Our OWN render must survive it: `ats_xray` feeds `render_docx` output straight
# back through `extract_text`, so a guard that fires here breaks /tools/ats-xray
# rather than only uploads.
_docx_ours_err: object = None
_docx_ours = ""
try:
    _docx_ours = _docx_extract("ours.docx", render_docx(resume))
except Exception as _e:  # noqa: BLE001
    _docx_ours_err = _e
check(
    "the cap never fires on our own render_docx output — the x-ray reads it back "
    "through this same path, so a guard that fires here breaks /tools/ats-xray",
    _docx_ours_err is None and len(_docx_ours.strip()) > 0,
    f"err={_docx_ours_err} len={len(_docx_ours)}",
)

# THE CAP'S FLOOR IS DERIVED FROM THE UPLOAD CAP, so raising `max_upload_mb`
# cannot silently turn this into a guard that refuses a CV the upload cap admits.
from app.parsers import resume_parser as _rp_mod  # noqa: E402

check(
    "the expansion cap is floored at 3x max_upload_mb — the two numbers cannot drift",
    "max(cap_mb, 3 * settings.max_upload_mb)" in _docx_inspect.getsource(_rp_mod._assert_docx_expansion),
)

# FAILS CLOSED, NOT OPEN. "The central directory can lie" is the obvious
# evasion, and it does not work: `ZipExtFile._read1` clamps each member to the
# declared `file_size` and the CRC then fails at EOF, so an under-declaring zip
# inflates nothing. It must land on the 400 path, not 500 and not 413.
_docx_lie = bytearray(_docx_bomb)
_docx_i = _docx_lie.find(b"PK\x01\x02")
while _docx_i != -1:
    _docx_lie[_docx_i + 24 : _docx_i + 28] = (1).to_bytes(4, "little")
    _docx_i = _docx_lie.find(b"PK\x01\x02", _docx_i + 4)
_docx_lie_err: object = None
try:
    _docx_extract("lie.docx", bytes(_docx_lie))
except Exception as _e:  # noqa: BLE001
    _docx_lie_err = _e
check(
    "a zip whose central directory UNDER-declares its sizes fails closed — the "
    "member's CRC breaks and it lands on 400, never inflating past the cap",
    isinstance(_docx_lie_err, ValueError) and not isinstance(_docx_lie_err, _DocxTooLarge),
    f"{type(_docx_lie_err).__name__}: {_docx_lie_err}",
)

# Malformed input is user error, not our bug. Both of these were 500s before the
# guard landed: a PDF renamed .docx raised PackageNotFoundError, and a plain zip
# renamed .docx died on a bare KeyError inside ZipFile.read.
_docx_bad = []
for _name, _blob in (
    ("pdf-renamed.docx", b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\ntrailer"),
    ("plain-zip.docx", b""),
):
    if not _blob:
        _z = _docx_io.BytesIO()
        with _zf_mod.ZipFile(_z, "w") as _zw:
            _zw.writestr("hello.txt", "not a word document")
        _blob = _z.getvalue()
    try:
        _docx_extract(_name, _blob)
        _docx_bad.append(f"{_name}: no raise")
    except ValueError:
        pass
    except Exception as _e:  # noqa: BLE001
        _docx_bad.append(f"{_name}: {type(_e).__name__}")
check(
    "a corrupt or non-Word .docx is a 400, never a 500 — a PDF and a plain zip "
    "renamed .docx both raise ValueError",
    _docx_bad == [],
    str(_docx_bad),
)

# WHY COVERAGE LIVES ON THE SERVER, pinned so nobody "optimises" it into the
# frontend. `_keyword_present` tries the VERBATIM phrase first, and a JD keyword
# has to find itself inside a prefixed Hebrew word, because Hebrew attaches
# ב/ל/ה/ו/מ/ש directly onto the noun.
#
# This comment used to say the frontend's `lib/keywords.ts` made exactly this
# case MISS, and that the resulting disagreement was the reason status stays on
# the server. That is no longer true and the correction matters: the two
# matchers now agree here, because `_keyword_present`'s boundary was given the
# SAME asymmetry the TS side already had — a Latin-only lookbehind, a
# full-class lookahead (see the boundary block below). They disagreed for a long
# time and "one matcher, one answer" says they may not.
#
# The rule still stands, on its real reason: `countOccurrences` answers "how
# many times does this phrase appear", while STATUS additionally carries the
# token fallback and the `partial` tier, which the TS side does not implement
# and must not start to. check-mirrors check 4 fails the build if any lib/*.ts
# begins returning covered/partial/missing.
from app.core.scorer import keyword_analysis as _kw_analysis  # noqa: E402
from app.models import JDModel as _JD_glue  # noqa: E402

_glue_jd = _JD_glue(keywords=["פייתון"], hard_skills=[])
_glue_cv = ResumeModel(contact=Contact(name="דנה"), summary="עובדת בפייתון כבר חמש שנים")
_glue_pct, _glue_gaps = _kw_analysis(_glue_cv, _glue_jd)
check(
    "coverage: a hebrew keyword matches inside its prefixed form — the reason this "
    "is not reimplemented in TypeScript, where the boundary guard makes it miss",
    _glue_gaps and _glue_gaps[0].status == "covered" and _glue_pct == 100.0,
    f"pct={_glue_pct} statuses={[(g.keyword, g.status) for g in _glue_gaps]}",
)

# ---------------------------------------------------------------------------
# COVERAGE READS EVERY PRINTED SECTION, AND ONLY MATCHES AT TOKEN BOUNDARIES.
#
# Two defects, one function pair, both moving the app's flagship deterministic
# number — in opposite directions at once.
#
# (a) `scorer._resume_text` omitted `headline`, `military_service` and
#     `languages` while BOTH renderers draw all three. An Israeli CV whose
#     Kubernetes/Terraform evidence lived in a unit bullet scored those
#     `missing`, and /tools/coverage advised "surface real experience using the
#     term 'Terraform'" about a page that printed it twice. Coverage is half of
#     `overall`, so it moved search ranking, History, the fit ring and the 75%
#     alert bar — and `keyword_guard` reads the same text, so the keyword floor
#     was structurally unable to see the tailor delete a military-only keyword.
#
# (b) the verbatim branch was a bare `kw in resume_text` with NO boundary, so
#     `Go` matched inside "django", `ORM` inside "terraform", and `R`/`C`
#     matched almost anything. Every one is an ordinary `jd.hard_skills` value.
#
# Both halves are pinned WITH their false-positive case, because "read the
# military section" is trivially satisfied by reading everything, and "add a
# boundary" is trivially satisfied by a symmetric one that deletes Hebrew.
from app.core import ats_scan as _cov_ats  # noqa: E402
from app.core.scorer import _keyword_present as _cov_kp  # noqa: E402
from app.core.scorer import _resume_text as _cov_text  # noqa: E402
from app.core.scorer import _tokens as _cov_tok  # noqa: E402
from app.models import LanguageSkill as _CovLang  # noqa: E402
from app.models import MilitaryService as _CovMil  # noqa: E402

# Every printed section carries a unique sentinel, so the assertion is "this
# section is READ", not "this particular string appears".
_cov_cv = ResumeModel(
    contact=Contact(name="Dana Levi"),
    headline="Senior sentinelheadline Engineer",
    summary="Backend engineer, sentinelsummary.",
    skills=["sentinelskill"],
    certifications=["sentinelcert"],
    experience=[Experience(title="sentineltitle", company="sentinelcompany", bullets=["sentinelbullet"])],
    education=[Education(degree="sentineldegree", field="sentinelfield", institution="sentinelinstitution")],
    projects=[Project(name="sentinelproject", description="sentineldesc", bullets=["sentinelprojbullet"])],
    military_service=[_CovMil(unit="sentinelunit", role="sentinelrole", bullets=["sentinelmilbullet"])],
    languages=[_CovLang(language="sentinellanguage", level="sentinellevel")],
)
_cov_txt = _cov_text(_cov_cv)
_cov_missed = [
    s
    for s in (
        "sentinelheadline", "sentinelsummary", "sentinelskill", "sentinelcert",
        "sentineltitle", "sentinelcompany", "sentinelbullet",
        "sentineldegree", "sentinelfield", "sentinelinstitution",
        "sentinelproject", "sentineldesc", "sentinelprojbullet",
        "sentinelunit", "sentinelrole", "sentinelmilbullet",
        "sentinellanguage",
    )
    if s not in _cov_txt
]
check(
    "coverage corpus reads EVERY printed section — headline, military service and "
    "languages included (the three it silently skipped)",
    _cov_missed == [],
    f"not read: {_cov_missed}",
)
# The false-positive half: a proficiency word is not a skill claim, so `level`
# stays out. Including it would let a JD keyword hit on a word no claim holds.
check(
    "coverage corpus reads a language's NAME but not its proficiency level",
    "sentinellanguage" in _cov_txt and "sentinellevel" not in _cov_txt,
)

# Adding a printed section to the model must force a decision here rather than
# silently shipping a section nothing scores — check-mirrors 1's rule, in Python.
_COV_UNREAD = {"contact", "skill_groups"}  # Contact is not a claim; groups are presentation
_COV_READ = {
    "headline", "summary", "skills", "certifications", "experience",
    "education", "projects", "military_service", "languages",
}
_cov_new = set(ResumeModel.model_fields) - _COV_UNREAD - _COV_READ
check(
    "a new ResumeModel section cannot ship unread by the coverage corpus",
    _cov_new == set(),
    f"unaccounted for: {sorted(_cov_new)}",
)

# `ats_scan._resume_text` is a DELIBERATE second corpus (", " skill join, " \n"
# part join, case preserved) because it feeds prose checks — `_has_term`, the
# one-page word count — not keyword matching. It may differ in punctuation; it
# may NOT read a different set of sections. Nothing pinned that, which is how
# the two disagreed about military service for as long as they did.
_cov_ats_txt = _cov_ats._resume_text(_cov_cv).lower()
_cov_div = [
    s
    for s in (
        "sentinelheadline", "sentinelsummary", "sentinelskill", "sentinelcert",
        "sentineltitle", "sentinelproject", "sentineldegree",
        "sentinelunit", "sentinelmilbullet",
    )
    if (s in _cov_txt) != (s in _cov_ats_txt)
]
check(
    "scorer and ats_scan read the SAME sections — two corpora, never two answers "
    "about which parts of the résumé count",
    _cov_div == [],
    f"divergent: {_cov_div}",
)

# (b) the boundary — catch and false positive in one table.
_cov_lat = "built microservices in django with mongodb, terraform and react; strong grpc background"
_cov_lat_t = _cov_tok(_cov_lat)
_cov_fp = [k for k in ("Go", "R", "C", "ORM", "Java", "Script") if _cov_kp(k, _cov_lat, _cov_lat_t) == "covered"]
_cov_tp = [
    k
    for k in ("django", "MongoDB", "Terraform", "React", "gRPC", "microservices")
    if _cov_kp(k, _cov_lat, _cov_lat_t) != "covered"
]
check(
    "coverage: a keyword buried mid-word is NOT covered — 'Go' in django, 'ORM' "
    "in terraform, 'Java' in JavaScript",
    _cov_fp == [],
    f"falsely covered: {_cov_fp}",
)
check(
    "coverage: the terms the résumé really holds are still covered — the false-"
    "positive half, since a boundary is trivially satisfied by matching nothing",
    _cov_tp == [],
    f"wrongly missing: {_cov_tp}",
)

# `+#.` are word characters in `_WORD_RE`, so C++/C#/.NET survive the boundary
# while a bare `C` does not.
_cov_pp = "experienced in c++, c# and .net core"
_cov_pp_t = _cov_tok(_cov_pp)
check(
    "coverage: C++ / C# / .NET match while a bare 'C' does not",
    all(_cov_kp(k, _cov_pp, _cov_pp_t) == "covered" for k in ("C++", "C#", ".NET"))
    and _cov_kp("C", _cov_pp, _cov_pp_t) != "covered",
    str([(k, _cov_kp(k, _cov_pp, _cov_pp_t)) for k in ("C++", "C#", ".NET", "C")]),
)

# THE LOOKBEHIND IS LATIN-ONLY AND THAT ASYMMETRY IS THE WHOLE FIX. A symmetric
# boundary passes every Latin check above and silently deletes Hebrew coverage
# in the primary market, because ב/ל/ה/ו/מ/ש glue straight onto the noun.
_cov_he = "ניסיון רב בפייתון ובניהול צוותים"
_cov_he_t = _cov_tok(_cov_he)
check(
    "coverage: a Hebrew keyword still matches behind its inseparable prefix — "
    "פייתון inside בפייתון, ניהול inside ובניהול",
    _cov_kp("פייתון", _cov_he, _cov_he_t) == "covered"
    and _cov_kp("ניהול", _cov_he, _cov_he_t) == "covered",
)
# ...while the LOOKAHEAD keeps the Hebrew block, so a longer Hebrew word that
# merely STARTS with the keyword is not a match.
check(
    "coverage: a longer Hebrew word that only STARTS with the keyword is not covered",
    _cov_kp("ניהו", _cov_he, _cov_he_t) != "covered",
    _cov_kp("ניהו", _cov_he, _cov_he_t),
)

# The multi-word cross-join match that `order_skills`' acceptance gate was
# calibrated on: skills join with a SPACE, so a two-word JD phrase can span two
# adjacent entries. The boundary must not break it, or that gate silently
# changes meaning.
_cov_join = _cov_text(ResumeModel(contact=Contact(name="דנה"), skills=["פייתון", "מתקדם"]))
check(
    "coverage: a multi-word keyword still matches ACROSS the skills space-join — "
    "the behaviour order_skills' gate measures",
    _cov_kp("פייתון מתקדם", _cov_join, _cov_tok(_cov_join)) == "covered",
)

# A LONGER TERM THAT STARTS WITH THE KEYWORD IS `partial`, NEVER `covered`.
# `PostgreSQL` is evidence for `Postgres`, not the term — which is exactly what
# `partial` means here. Dropping it outright was the first attempt and it broke
# a pinned invariant one file over: `length_budget._drop_unmatched_skill`
# protects any entry the scorer reads as not-`missing` and removes the LONGEST
# unmatched one, so a strict boundary would have deleted "PostgreSQL
# administration and replication tuning at scale" from a CV applying to a job
# that says Postgres.
#
# `SQL` inside `PostgreSQL` stays missing, and that asymmetry is the point: it
# is a SUFFIX, the same shape as `ORM` inside terraform.
_cov_pg = "postgresql administration and replication tuning"
_cov_pg_t = _cov_tok(_cov_pg)
check(
    "coverage: a longer term that STARTS with the keyword is partial, not covered "
    "— PostgreSQL is evidence for Postgres, not the term",
    _cov_kp("Postgres", _cov_pg, _cov_pg_t) == "partial"
    and _cov_kp("PostgreSQL", _cov_pg, _cov_pg_t) == "covered"
    and _cov_kp("SQL", _cov_pg, _cov_pg_t) == "missing",
    str([(k, _cov_kp(k, _cov_pg, _cov_pg_t)) for k in ("Postgres", "PostgreSQL", "SQL")]),
)
# The false-positive half, and the reason the floor exists: below it a shared
# prefix is coincidence, not a shared root. `R` inside "react" and `C` inside
# "clusters" are how single-letter JD hard skills used to score 100%, and `Java`
# must never reach `JavaScript` — the case lib/keywords.ts names in its own
# comment. The floor is TUNED, not measured; it sits between Java(4) and
# Postgres(8).
_cov_sp = "react clusters, rust and javascript"
_cov_sp_t = _cov_tok(_cov_sp)
check(
    "coverage: a short keyword never rides the prefix rule — R/C/Go stay missing "
    "and Java never reaches JavaScript",
    all(_cov_kp(k, _cov_sp, _cov_sp_t) == "missing" for k in ("R", "C", "Go", "Java")),
    str([(k, _cov_kp(k, _cov_sp, _cov_sp_t)) for k in ("R", "C", "Go", "Java")]),
)

# A KEYWORD AT THE END OF A SENTENCE. `.` is a word character only so `.NET` and
# `node.js` hold together, and a flat trailing class therefore made `SQL`
# invisible inside "…ו-SQL." — which is how this change first came back red.
_cov_dot = "מהנדסת תוכנה עם ניסיון בפייתון ו-sql. גם python. built with node.js"
_cov_dot_t = _cov_tok(_cov_dot)
check(
    "coverage: a sentence-final full stop is a boundary, while a dot INSIDE a "
    "name is not — 'SQL.'/'Python.' match, 'node' ⊄ 'node.js'",
    _cov_kp("SQL", _cov_dot, _cov_dot_t) == "covered"
    and _cov_kp("Python", _cov_dot, _cov_dot_t) == "covered"
    and _cov_kp("node.js", _cov_dot, _cov_dot_t) == "covered"
    and _cov_kp("node", _cov_dot, _cov_dot_t) == "missing",
    str([(k, _cov_kp(k, _cov_dot, _cov_dot_t)) for k in ("SQL", "Python", "node.js", "node")]),
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

    # THE ZIP BOMB, OVER HTTP, ON THE ONE ROUTE THAT TAKES NO ACCESS CODE. The
    # unit check above proves the guard raises; this proves the raise is WIRED —
    # gate exemption, the `InputTooLarge` exception handler and the structured
    # 413 body all in one request. Without it the guard could regress to a 500
    # (a limit the user can act on turning into a Sentry issue) with the unit
    # check still green.
    _bomb_resp = _tc.post(
        "/public/scan",
        files={"file": ("bomb.docx", _docx_bomb,
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
        data={"jd_text": "Python developer."},
    )
    check(
        "the unauthenticated /public/scan refuses a decompression bomb with a 413, "
        "not a 500 — the door a stranger with no invite code can reach",
        _bomb_resp.status_code == 413
        and _bomb_resp.json().get("detail", {}).get("code") == "input_too_large",
        f"{_bomb_resp.status_code} {_bomb_resp.text[:160]}",
    )
    # The false-positive half over HTTP too: an ordinary .docx still scores.
    # A SMALL one — this suite sets MAX_UPLOAD_MB=1 (top of file), so the 6 MB
    # image-heavy fixture the unit check uses is refused by the *upload* cap
    # before the expansion guard is reached. That case belongs to the unit
    # check, which does not cross an HTTP boundary; what this one has to prove
    # is that a normal CV still gets a 200 through the same route.
    _ok_resp = _tc.post(
        "/public/scan",
        files={"file": ("small.docx", _make_docx(
            _DOCX_HEAD + b"<w:p><w:r><w:t>Dana Levi builds Kubernetes tooling</w:t></w:r></w:p>" + _DOCX_TAIL),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
        data={"jd_text": "Kubernetes engineer. Kubernetes required."},
    )
    check(
        "…while a real .docx upload still scans normally through the same route",
        _ok_resp.status_code == 200 and 0 < _ok_resp.json()["coverage"] <= 100,
        f"{_ok_resp.status_code} {_ok_resp.text[:160]}",
    )

# 18. Résumé templates (PLAN 6): every template × format × language renders,
# stays ATS-safe (no tables/text-boxes/images/headers/footers in the DOCX
# XML), and the content survives re-extraction — which is what an ATS
# actually does. This is the executable proof behind "every template passes
# our own ATS scan".
from app.render.templates import DEFAULT_TEMPLATE, TEMPLATES, get_template  # noqa: E402

check(
    "template registry: 11 templates, default present",
    len(TEMPLATES) == 11 and DEFAULT_TEMPLATE in TEMPLATES,
    str(list(TEMPLATES)),
)
check(
    "every template differs from every other in SHAPE, not just hue — a set that "
    "varies only by accent colour is what made the downloads read as undesigned",
    len({(t.header, t.heading, t.entry, t.skills, t.layout, t.rail, t.pdf_family,
          t.heading_case, t.bullet_glyph, bool(t.page_bg)) for t in TEMPLATES.values()}) >= 9,
    str(sorted((t.id, t.header, t.heading, t.entry, t.layout) for t in TEMPLATES.values())),
)
check(
    "a section heading is never SMALLER than the body it governs (the old set "
    "shipped 9.5pt headings over 10.2pt body — a live hierarchy inversion)",
    all(t.heading_size + t.heading_bump >= t.body_size for t in TEMPLATES.values()),
    str([(t.id, t.heading_size + t.heading_bump, t.body_size) for t in TEMPLATES.values()
         if t.heading_size + t.heading_bump < t.body_size]),
)
check(
    "two-column templates are PDF-only and every one names a single-column "
    "DOCX fallback that itself renders in one column",
    all(t.docx_fallback and not TEMPLATES[t.docx_fallback].pdf_only
        for t in TEMPLATES.values() if t.pdf_only),
    str([(t.id, t.docx_fallback) for t in TEMPLATES.values() if t.pdf_only]),
)
check(
    "unknown/empty template names fall back to the default (old clients unaffected)",
    get_template("no-such-template").id == DEFAULT_TEMPLATE and get_template(None).id == DEFAULT_TEMPLATE,
)
# Three BOOLEANS used to stand beside the enums that already said the same
# thing, and they are how the renderers drifted from the declaration:
# `header_rule` / `heading_rule` are what the hairlines actually keyed off while
# `header="plain"` and `heading="plain"` sat there meaning nothing, and
# `accent_name` was a live branch in BOTH renderers that no spec ever reached.
# Source-pinned as well as behaviour-pinned, the shape the geo-restriction work
# settled on: behaviour alone cannot catch a re-added flag that happens to
# default to today's look. The word boundary is load-bearing — `header_rule_pt`
# and `heading_rule_color` are real, live fields and must not match.
import ast as _tspec_ast  # noqa: E402
import inspect as _tspec_inspect  # noqa: E402

from app.render import docx_renderer as _docx_mod  # noqa: E402
from app.render import pdf_renderer as _pdf_mod  # noqa: E402
from app.render import templates as _tpl_mod  # noqa: E402

_DEAD_FLAGS = ("accent_name", "header_rule", "heading_rule")
_LIVE_FLAGS = ("header_rule_pt", "header_rule_accent", "heading_rule_pt", "heading_rule_color")


def _spec_refs(mod, names: tuple[str, ...]) -> set[str]:
    """Which of `names` the module actually REFERENCES — an attribute read, a
    dataclass field declaration, or a constructor keyword. Walked as an AST
    rather than grepped, so a comment recording what the flag used to do (this
    file's own habit, and the reason the deletions are understandable a year
    from now) is not mistaken for a live reference."""
    found: set[str] = set()
    for node in _tspec_ast.walk(_tspec_ast.parse(_tspec_inspect.getsource(mod))):
        if isinstance(node, _tspec_ast.Attribute) and node.attr in names:
            found.add(node.attr)
        elif (isinstance(node, _tspec_ast.AnnAssign)
              and isinstance(node.target, _tspec_ast.Name) and node.target.id in names):
            found.add(node.target.id)
        elif isinstance(node, _tspec_ast.keyword) and node.arg in names:
            found.add(node.arg)
    return found


_render_mods = (_tpl_mod, _pdf_mod, _docx_mod)
_dead_src = {m.__name__.rsplit(".", 1)[-1]: sorted(_spec_refs(m, _DEAD_FLAGS)) for m in _render_mods}
# The positive control: the same walker must find the live fields that share
# those prefixes, or "no references anywhere" is satisfied by a walker that
# never matches anything.
_live_src = set().union(*(_spec_refs(m, _LIVE_FLAGS) for m in _render_mods))
check(
    "a presentation flag no template sets, standing beside the enum that already "
    "says the same thing, is DELETED rather than left for the next reader to "
    "believe — and the live *_pt / *_accent / *_color fields that share its "
    "prefix are all still read",
    not any(_dead_src.values())
    and not any(hasattr(t, n) for t in TEMPLATES.values() for n in _DEAD_FLAGS)
    and _live_src == set(_LIVE_FLAGS),
    f"dead={ {k: v for k, v in _dead_src.items() if v} } live_found={sorted(_live_src)}",
)

# 18a. A run taller than one frame must SPLIT, not raise. reportlab cannot place
# a bare Flowable that does not implement split(), so before this a résumé with a
# long summary (or one very long bullet) made POST /render raise LayoutError and
# return a 500. It is a crash, not a layout nicety — pinned per template because
# the page geometry that triggers it differs per template.
_huge = ResumeModel(
    contact=Contact(name="Overflow Candidate", email="of@example.com"),
    summary=("Backend engineer with deep experience across payments, data and platform. " * 90),
    experience=[Experience(company="X", title="Engineer",
                           bullets=[("Shipped a thing that mattered a great deal. " * 120)])],
)
_huge_want = _re.sub(r"\s+", " ", _huge.summary).strip()
for _tpl in TEMPLATES:
    try:
        _huge_pdf = render_pdf(_huge, template=_tpl)
        _huge_txt = _re.sub(r"\s+", " ", _pdf_text(_huge_pdf))
        _ok = _huge_pdf[:4] == b"%PDF" and _huge_want in _huge_txt
    except Exception as _e:  # LayoutError or anything else = the 500 is back
        _huge_pdf, _ok = b"", False
        _huge_txt = f"{type(_e).__name__}: {_e}"
    check(
        f"pdf[{_tpl}]: an over-long run splits across pages instead of raising, "
        f"and no word is lost or duplicated",
        _ok, _huge_txt[:180],
    )

# 18a-2. A split bullet must not grow a SECOND glyph on its continuation.
check(
    "pdf: a bullet that splits across a page keeps exactly one glyph",
    _pdf_text(render_pdf(_huge)).count("•") == 1,
    str(_pdf_text(render_pdf(_huge)).count("•")),
)

# 18a-3. Two-column templates are PDF-only for a MEASURED reason: text
# extraction y-sorts across the full page width, so sidebar text is glued to the
# front of the main-column line at the same height. Individual bullets survive
# intact (keyword matching is fine) but title/employer attribution is polluted.
# This pins the behaviour we shipped knowingly, so nobody later "fixes" the
# fallback away believing a two-column DOCX would be equivalent.
_2col = render_pdf(resume, template="split")
_2col_txt = _pdf_text(_2col)
check(
    "pdf[split]: every bullet still survives extraction as one contiguous string",
    resume.experience[0].bullets[0].split(",")[0] in _re.sub(r"\s+", " ", _2col_txt),
    _2col_txt[:200],
)
_split_docx_xml = _docx_xml(render_docx(resume, template="split"))
# python-docx always writes a single-column <w:cols w:space="..."/> in the
# sectPr, so the real invariant is "never a MULTI-column section and never a
# table" — not the absence of the element.
check(
    "docx[split]: falls back to a single-column sibling — no table, no snaking columns",
    "<w:tbl" not in _split_docx_xml
    and not _re.search(r'<w:cols[^>]*w:num="(?!1")', _split_docx_xml)
    and resume.contact.name in _li_extract_text("resume.docx", render_docx(resume, template="split")),
    str(_re.findall(r"<w:cols[^>]*>", _split_docx_xml)),
)
from app.render.labels import labels_for as _labels_for  # noqa: E402
from app.render.pdf_renderer import (  # noqa: E402
    _Chips, _Cols, _Segments, _Sheet, _adv, _band_metrics, _column_widths, _flow,
)
from reportlab.lib.colors import HexColor as _HexColor  # noqa: E402


def _below_header(res, spec, rtl: bool) -> float:
    """Distance from the page top to the first row of body content.

    Shared by 18f and 18h. Both need to ignore the HEADER, which spans the full
    text width by design — the name and the headline are drawn across both
    columns, so a word from either legitimately sits left of the rail edge and
    legitimately straddles the sidebar gutter. Computed with the renderer's own
    `_band_metrics`, so if the band's geometry changes the cut follows it
    instead of going stale.
    """
    _hdr, _m, _s = _flow(res, _Sheet(spec, rtl), _labels_for("he" if rtl else "en"))
    _hh, _pt, _pb = _band_metrics(_hdr, spec)
    _band = (_hh + _pt + _pb) if _hh else 0.0
    return (_band + 4.0) if _band else spec.margin_tb_pt


# 18f. A dense résumé must not push main-column content into the rail. The
# sidebar frame is 660pt and a 138-skill résumé's rail content measured 2,453pt;
# reportlab reacts to a full frame by advancing to the NEXT one -- the main
# column -- so the overflow landed there and the FrameBreak then pushed the real
# main content onto page 2, INTO page 2's side frame. Summary and Experience
# rendered inside a 30%-wide rail. Shipped, and found by the owner's first real
# tailor. Page 1 is the only page that has a rail, so that is where to look.
#
# TWO CARVE-OUTS, both of which this check went RED without on a CORRECT render
# — a guard that fires on legitimate input is worse than no guard.
#   * The HEADER band spans the full text width, so a probe word appearing in
#     the name or the headline is drawn left of the rail edge by design. The
#     scan therefore starts below the header (`_below_header`, computed with the
#     renderer's own `_band_metrics` so it follows the band rather than going
#     stale), and any word the header could also contain is dropped from the
#     probe set outright — belt and braces, since a headline is one line and the
#     band's height is measured, not assumed.
#   * The probe words have to be unique to the MAIN column. A word that also
#     appears in a sidebar section would be "found" in the rail on a perfectly
#     demoted render.
_dense = resume.model_copy(deep=True)
_dense.skills = [f"Skill {chr(65 + i % 26)}{i} platform" for i in range(140)]
_dense_header_words = set((_dense.contact.name or "").split()) | set(
    (_dense.headline or "").split())
_dense_side_words = {w for s in _dense.skills for w in s.split()}
for _tpl in (t for t, sp in TEMPLATES.items() if sp.layout == "sidebar"):
    _sp = get_template(_tpl)
    _rail_right = _sp.margin_lr_pt + _column_widths(_sp)[0]
    _probe = [w for w in _dense.summary.split()
              if w not in _dense_header_words and w not in _dense_side_words][:6]
    _cut = _below_header(_dense, _sp, False)
    with _pdfplumber.open(_io.BytesIO(render_pdf(_dense, template=_tpl))) as _pdf:
        _p1 = _pdf.pages[0]
        _intruders = [(w["text"], round(w["x0"], 1)) for w in _p1.extract_words()
                      if w["text"] in _probe and w["top"] >= _cut and w["x0"] < _rail_right]
    check(
        f"pdf[{_tpl}]: a dense résumé keeps main-column content OUT of the rail "
        f"on page 1 (the sidebar demotes what will not fit instead of spilling)",
        # `_probe` is asserted non-empty: with every summary word filtered out
        # the scan would have nothing to look for and pass by never firing.
        bool(_probe) and not _intruders, f"probe={_probe} intruders={_intruders}",
    )
check(
    "pdf: a page-sized chip run splits instead of jumping whole to the next "
    "frame -- neither KeepTogether nor keepWithNext may wrap it, both refuse to "
    "split and leave the column it came from empty",
    _Chips(["a really quite long skill name " + str(i) for i in range(200)],
           font="Helvetica", size=9, ink=_HexColor("#000000"),
           border=_HexColor("#cccccc")).split(300.0, 200.0).__len__() == 2,
)

# 18a-4. `_Cols` and `_Segments` were the two bare Flowables still missing the
# `split()` the invariant requires, and it was a LIVE 500: `POST /render` raised
# LayoutError at 107 certifications on classic/minimal, 109 on executive, 113 on
# timeline and 133 on compact (every list_cols>1 template, which is nine of the
# eleven), and at 160 languages on minimal, 163 on executive and 169 on
# timeline. Template-dependent, which is the worst shape this bug takes: the
# same résumé rendered on `classic` and 500'd on `executive`, because chips route
# through `_Chips` and it already had one.
#
# The existing per-template split check (18a) could not see any of this — its
# `_huge` fixture is a long summary and a long bullet, i.e. only `_Text`, the one
# flowable that already split. It is the shape of check that passes by never
# firing, so this one drives the other two DIRECTLY as well as through a render.
#
# The `KeepTogether` around both is not a fix and must not be reached for:
# reportlab answers one it cannot place by RELEASING its children into the flow,
# so the bare flowable is asked to split anyway — the traceback named `_Cols`,
# not the wrapper.
_ov_certs = [f"Certificate{i:03d}" for i in range(150)]
_ov_langs = [LanguageSkill(language=f"Language{i:03d}", level="Fluent") for i in range(250)]
# Short items on purpose. A certification long enough to WRAP inside its column
# is legitimately interleaved by two-column extraction ("…number 100 from a •
# …number 101 from a recognised body recognised body"), which is the documented
# property of `list_cols` and would make this check red on a correct render.
_ov_bad: list = []
for _tpl in TEMPLATES:
    for _label, _mutate, _want in (
        ("certifications", lambda r: setattr(r, "certifications", _ov_certs), _ov_certs),
        ("languages", lambda r: setattr(r, "languages", _ov_langs),
         [f"Language{i:03d}" for i in range(250)]),
    ):
        _r = resume.model_copy(deep=True)
        _mutate(_r)
        try:
            _txt = _re.sub(r"\s+", " ", _pdf_text(render_pdf(_r, template=_tpl)))
            _lost = [v for v in _want if v not in _txt]
        except Exception as _e:  # LayoutError or anything else = the 500 is back
            _lost = [f"{type(_e).__name__}: {_e}"]
        if _lost:
            _ov_bad.append((_tpl, _label, len(_lost), _lost[:1]))
check(
    "pdf: 150 certifications and 250 languages render on EVERY template instead "
    "of raising LayoutError, and not one item is lost in the split",
    not _ov_bad, str(_ov_bad[:3]),
)
# …and the same shape as the `_Chips.split` probe above, for the same reason it
# exists: a wrapper can make `split` never be called at all, so the method is
# also driven on its own — two parts for a block taller than the frame, and an
# empty list (move me whole) for one that fits.
_ov_sheet = _Sheet(get_template("classic"), False)
_ov_cols = _Cols(_ov_certs, font=_ov_sheet.reg, size=10, color=_HexColor("#000000"),
                 glyph_color=_HexColor("#000000"), leading=13, cols=2)
_ov_segs = [(f"Language{i:03d} – Fluent", _ov_sheet.reg, 10, _HexColor("#000000"), "")
            for i in range(250)]
_ov_seg = _Segments(_ov_segs, sep=" · ", sep_color=_HexColor("#cccccc"), leading=13)
_ov_seg_halves = _ov_seg.split(400.0, 200.0)
_ov_rtl_halves = _Segments(_ov_segs, sep=" · ", sep_color=_HexColor("#cccccc"),
                           leading=13, rtl=True).split(400.0, 200.0)
check(
    "pdf: _Cols.split and _Segments.split return exactly two parts for a block "
    "taller than the frame and none for one that fits, and neither half loses or "
    "duplicates an item — in both directions",
    len(_ov_cols.split(400.0, 200.0)) == 2
    and _ov_cols.split(400.0, 200.0)[0].items + _ov_cols.split(400.0, 200.0)[1].items == _ov_certs
    and _Cols(_ov_certs[:2], font=_ov_sheet.reg, size=10, color=_HexColor("#000000"),
              glyph_color=_HexColor("#000000"), leading=13, cols=2).split(400.0, 500.0) == []
    and len(_ov_seg_halves) == 2
    and sorted(s[0] for h in _ov_seg_halves for s in h.segments) == sorted(s[0] for s in _ov_segs)
    and _Segments(_ov_segs[:2], sep=" · ", sep_color=_HexColor("#cccccc"),
                  leading=13).split(400.0, 500.0) == []
    and len(_ov_rtl_halves) == 2
    and sorted(s[0] for h in _ov_rtl_halves for s in h.segments) == sorted(s[0] for s in _ov_segs),
    f"cols={len(_ov_cols.split(400.0, 200.0))} segs={len(_ov_seg_halves)} rtl={len(_ov_rtl_halves)}",
)

# --------------------------------------------------------------------------- #
# 18g. A CHIP MAY NOT BE WIDER THAN ITS COLUMN.
#
# 18f above aims INWARD (main-column content must stay out of the rail). This
# aims the other way, at the axis nobody guarded: `_Chips._pack` broke to a new
# row only when the current one already held something (`if cur and cw + gap + w
# > avail_w`), so a single item wider than the whole column was appended to an
# EMPTY row unconditionally. `wrap()` then reported `avail_w` regardless of what
# it had packed, so reportlab believed the flowable fitted, and nothing clips.
#
# Measured on `split` before the fix: one 60-character skill packed a 253.00pt
# row into the 148.58pt rail and was DRAWN from x=48.0 to x=301.0, straight
# across the main column (which starts at 216.6). The 147-character sentence
# below packed 616.13pt into the same rail. And the damage is not cosmetic: the
# chip overprints the main column at the same y, pdfminer y-sorts, and the
# extracted text came back as "Designing and operating distributed backeEnXd
# PsyEstRemIEs NatC scEale" -- the chip interleaved character-by-character with
# the EXPERIENCE heading, which stopped being extractable at all (18j below pins
# exactly that).
#
# Direction-blind, per template, at BOTH the rail width and the full text width:
# a sidebar template's skills block can be DEMOTED into the main column by the
# height pass in `_flow`, so it has to be safe in either place.
_LONG_SKILL = ("Designing and operating distributed backend systems at massive scale across "
               "many regions, many teams and many time zones worldwide every single day")
# An unbreakable token is the case only `_wrap_lines`' hard-break loop can
# place. It is why every `inline`-skills template stayed clean through all of
# this: `_Text` already goes through that loop, and `_Chips` simply did not.
_LONG_TOKEN = "A" * 80
_HE_LONG_SKILL = ("תכנון והפעלה של מערכות מבוזרות בקנה מידה גדול מאוד באזורים רבים "
                  "ובצוותים רבים ובאזורי זמן רבים בכל יום ויום")
_HE_LONG_TOKEN = "א" * 80
# The false-positive fixture: ordinary short skills, the shape 99% of résumés
# have. Nothing here may move.
_NORMAL_SKILLS = ["Python", "SQL", "Go", "Machine Learning", "Distributed Systems", "CI/CD"]

_chip_over: list = []
_chip_drift: list = []
_chip_probed = 0
# Derived from TEMPLATES rather than hard-coded, so the check fails loudly if
# the loop ever stops running (a check that passes by never firing is the 21.7
# failure mode). Two directions x four over-long inputs x one column, or two
# columns when the template has a rail.
_chip_expected = sum(2 * 4 * (2 if _sp.layout == "sidebar" else 1)
                     for _sp in TEMPLATES.values() if _sp.skills == "chips")
for _tpl, _sp in TEMPLATES.items():
    if _sp.skills != "chips":
        continue
    _size = _sp.meta_size + 0.4          # what build_skills() passes to _Chips
    _cols = [_sp.page_w_pt - 2 * _sp.margin_lr_pt]
    if _sp.layout == "sidebar":
        _cols.append(_column_widths(_sp)[0])
    for _rtl in (False, True):
        _sh = _Sheet(_sp, _rtl)

        def _chips(items, rtl=_rtl, sheet=_sh, size=_size):
            return _Chips(items, font=sheet.reg, size=size, ink=_HexColor("#000000"),
                          border=_HexColor("#cccccc"), rtl=rtl)

        for _item in (_LONG_SKILL, _LONG_TOKEN, _HE_LONG_SKILL, _HE_LONG_TOKEN):
            for _w in _cols:
                _c = _chips([_item])
                _rows = _c._pack(_w)
                _chip_probed += 1
                _widest_row = max(sum(_e[1] for _e in _ents) + _c.gap * (len(_ents) - 1)
                                  for _ents, _h in _rows)
                _widest_line = max(_adv(_ln, _sh.reg, _size) + 2 * _c.pad
                                   for _ents, _h in _rows for _e in _ents for _ln in _e[2])
                if _widest_row > _w + 1e-6 or _widest_line > _w + 1e-6:
                    _chip_over.append((_tpl, _rtl, round(_w, 2),
                                       round(_widest_row, 2), round(_widest_line, 2)))
        # THE FALSE-POSITIVE HALF, in the same check on purpose: "make the long
        # skill fit" is trivially satisfied by wrapping EVERY chip, which would
        # re-lay-out every résumé that never had a problem. A normal skills list
        # must still pack exactly what it packed before -- one line per chip,
        # every row exactly `chip_h`, every box `_adv(label) + 2*pad` wide, and
        # `wrap()` returning the pre-fix `n*(chip_h+gap) - gap`. Measured
        # separately: with this true, all 11 templates x 2 languages render
        # byte-identically before and after the fix (modulo reportlab's
        # per-render /ID digest, the only non-deterministic bytes in the file).
        for _w in _cols:
            _c = _chips(_NORMAL_SKILLS)
            _rows = _c._pack(_w)
            _pre_fix_h = len(_rows) * (_c.chip_h + _c.gap) - _c.gap
            if (not _rows
                    or any(_h != _c.chip_h for _ents, _h in _rows)
                    or any(_lines != [_lbl] for _ents, _h in _rows for _lbl, _bw, _lines in _ents)
                    or any(abs(_bw - (_adv(_lbl, _sh.reg, _size) + 2 * _c.pad)) > 1e-9
                           for _ents, _h in _rows for _lbl, _bw, _lines in _ents)
                    or abs(_c.wrap(_w, 10_000.0)[1] - _pre_fix_h) > 1e-9):
                _chip_drift.append((_tpl, _rtl, round(_w, 2),
                                    [(len(_e), round(_h, 2)) for _e, _h in _rows]))
check(
    "pdf: no chip row and no wrapped chip line may exceed its column, at the "
    "rail width AND the full text width, in both directions -- and a NORMAL "
    "skills list still packs at the pre-fix geometry (without that half, "
    "'make the long skill fit' is satisfied by wrapping every chip)",
    _chip_probed == _chip_expected and not _chip_over and not _chip_drift,
    f"probed={_chip_probed}/{_chip_expected} over={_chip_over[:3]} drift={_chip_drift[:3]}",
)


# 18h. The same invariant at RENDER level, where the user meets it.
#
# ASSERT ON GEOMETRY, NOT ON TEXT. pdfplumber returns Hebrew already
# bidi-reordered, so a check matching `w["text"]` against `resume.skills` finds
# nothing in RTL and passes by never firing -- probed: the text form catches 2
# escaping words on split/panel in LTR and 0 in RTL, while the geometry form
# fires on the chip rectangle in both.
#
# The header is excluded because it LEGITIMATELY spans both columns (the name is
# drawn across the full text width, so "Candidate" straddles the gutter on every
# two-column render). Same carve-out `ats_xray._collision` makes, for the same
# reason. `body_top` is computed with the renderer's own `_band_metrics`, so if
# the band's geometry changes the cut follows it instead of going stale.
# (`_below_header` is defined above 18f, which needs the same cut for the same
# reason — a probe word inside the full-width band is not an intruder.)
def _chip_escapes(res, tpl: str, rtl: bool) -> tuple[list, list]:
    """(straddles the sidebar gutter, leaves the text column) for everything
    drawn below the header on page 1 -- extracted words UNION drawn curves, the
    latter being where a chip's own rounded rectangle shows up."""
    _spec = get_template(tpl)
    _cut = _below_header(res, _spec, rtl)
    _lo, _hi = _spec.margin_lr_pt, _spec.page_w_pt - _spec.margin_lr_pt
    _g0 = _g1 = None
    if _spec.layout == "sidebar":
        _side_w, _main_w = _column_widths(_spec)
        # In RTL the rail is on the RIGHT, so the gutter sits between the main
        # column's right edge and the rail's left edge.
        _g0 = (_lo + _main_w) if rtl else (_lo + _side_w)
        _g1 = _g0 + _spec.sidebar_gutter
    _straddle: list = []
    _escape: list = []
    with _pdfplumber.open(_io.BytesIO(render_pdf(res, template=tpl))) as _pdf:
        _pg = _pdf.pages[0]
        _boxes = [(w["text"], w["x0"], w["x1"], w["top"]) for w in _pg.extract_words()]
        _boxes += [("<chip>", c["x0"], c["x1"], c["top"]) for c in _pg.curves]
    for _t, _a, _b, _top in _boxes:
        if _top < _cut:
            continue
        if _g0 is not None and _a < _g0 - 0.05 and _b > _g1 + 0.05:
            _straddle.append((_t[:24], round(_a, 1), round(_b, 1)))
        if _a < _lo - 0.05 or _b > _hi + 0.05:
            _escape.append((_t[:24], round(_a, 1), round(_b, 1)))
    return _straddle, _escape


_esc_long: list = []
_esc_clean: list = []
_esc_seen: list = []
for _tpl, _sp in TEMPLATES.items():
    if _sp.skills != "chips":
        continue
    for _base, _item, _rtl in ((resume, _LONG_SKILL, False), (_he_full, _HE_LONG_SKILL, True),
                               (resume, _LONG_TOKEN, False), (_he_full, _HE_LONG_TOKEN, True)):
        _r = _base.model_copy(deep=True)
        _r.skills = ["Python", "SQL", _item]
        _r.skill_groups = []
        _s1, _e1 = _chip_escapes(_r, _tpl, _rtl)
        _esc_seen.append((_tpl, _rtl))
        if _s1 or _e1:
            _esc_long.append((_tpl, _rtl, _s1[:2], _e1[:2]))
    # The clean control: an ordinary résumé must be clean too, or the check is
    # passing because extraction broke rather than because the chip stayed home.
    for _base, _rtl in ((resume, False), (_he_full, True)):
        _s2, _e2 = _chip_escapes(_base, _tpl, _rtl)
        if _s2 or _e2:
            _esc_clean.append((_tpl, _rtl, _s2[:2], _e2[:2]))
check(
    "pdf: with one over-long skill, nothing drawn below the header straddles "
    "the sidebar gutter or leaves the text column -- every chips template, both "
    "directions, sentence and unbreakable token (geometry, not text: pdfplumber "
    "hands back Hebrew already reordered, so a text match never fires in RTL)",
    len(_esc_seen) == 4 * sum(1 for _sp in TEMPLATES.values() if _sp.skills == "chips")
    and not _esc_long and not _esc_clean,
    f"seen={len(_esc_seen)} long={_esc_long[:2]} clean={_esc_clean[:2]}",
)


# 18i. …and the wrap must happen ONLY to the chip that needs it.
#
# 18g pins that at `_pack` level; this pins it on the rendered file, which is
# the artefact the user sends. Every chip is one drawn rounded rectangle, and
# the only other curves in the document are the contact/date icons, which are
# 1.6-4.4pt tall against a 15.5-15.8pt chip -- so "the tallest curve on the page
# equals chip_h" is a language-blind way to say "no chip was wrapped into extra
# lines". That alone is not enough, and the probe proved it: routing EVERY chip
# through the over-wide branch gives each one a full-width row of a SINGLE line,
# so every box is still exactly chip_h and the height test stays green while the
# section has been completely re-laid-out. So the second half asserts that
# ordinary chips still SHARE rows -- more chip rectangles than distinct row
# tops. The positive half is in the same check: with a skill too wide for the
# column, one rectangle MUST be taller, or nothing wrapped and 18g is passing on
# an input the renderer never sees.
def _over_wide_skill(word: str, spec, rtl: bool) -> str:
    """A skill guaranteed wider than this template's FULL text column, grown
    from real font metrics rather than guessed at a character count -- 27
    lowercase Latin characters fit the `split` rail but only 16 capital Ms, and
    28 Hebrew characters, so any fixed length is wrong for someone."""
    _sh = _Sheet(spec, rtl)
    _size = spec.meta_size + 0.4
    _pad = _Chips([], font=_sh.reg, size=_size, ink=None, border=None).pad
    _col = spec.page_w_pt - 2 * spec.margin_lr_pt
    _text = word
    while _adv(_text, _sh.reg, _size) + 2 * _pad <= _col and len(_text) < 600:
        _text += " " + word
    return _text


def _chip_boxes(res, tpl: str) -> list:
    """(height, top) of every drawn rounded rectangle on the rendered file."""
    with _pdfplumber.open(_io.BytesIO(render_pdf(res, template=tpl))) as _pdf:
        return [(c["bottom"] - c["top"], round(c["top"], 1)) for p in _pdf.pages for c in p.curves]


_tall_normal: list = []
_lonely_normal: list = []
_tall_missing: list = []
for _tpl, _sp in TEMPLATES.items():
    if _sp.skills != "chips":
        continue
    _chip_h = (_sp.meta_size + 0.4) * 1.72
    for _base, _word, _rtl in ((resume, "distributed", False), (_he_full, "מבוזרות", True)):
        _boxes = _chip_boxes(_base, _tpl)
        if not _boxes or max(_h for _h, _t in _boxes) > _chip_h + 0.5:
            _tall_normal.append((_tpl, _rtl, round(max(_h for _h, _t in _boxes), 2) if _boxes else None,
                                 round(_chip_h, 2)))
        # Chips of chip_h height only — the icons are 1.6-4.4pt and would
        # otherwise each contribute a row top of their own.
        _chips_only = [_t for _h, _t in _boxes if abs(_h - _chip_h) <= 0.5]
        if len(_chips_only) <= len(set(_chips_only)):
            _lonely_normal.append((_tpl, _rtl, len(_chips_only), len(set(_chips_only))))
        _wide = _base.model_copy(deep=True)
        _wide.skills = list(_base.skills) + [_over_wide_skill(_word, _sp, _rtl)]
        _wide.skill_groups = []
        _boxes2 = _chip_boxes(_wide, _tpl)
        if not _boxes2 or max(_h for _h, _t in _boxes2) <= _chip_h + 0.5:
            _tall_missing.append((_tpl, _rtl, round(max(_h for _h, _t in _boxes2), 2) if _boxes2 else None,
                                  round(_chip_h, 2)))
check(
    "pdf: an ordinary skills list draws every chip exactly chip_h tall AND still "
    "packs several of them per row (nothing wrapped or exiled to its own row "
    "that did not have to be), while an over-wide skill draws a taller box -- "
    "both halves, every chips template, both directions",
    not _tall_normal and not _lonely_normal and not _tall_missing,
    f"grew_taller={_tall_normal[:3]} one_per_row={_lonely_normal[:3]} did_not_wrap={_tall_missing[:3]}",
)


# 18j. The honest assertion: one long skill used to DELETE a standard section
# name from the file we tell the user is ATS-safe.
#
# The fixture is tuned so the over-wide chip lands at the EXPERIENCE heading's y
# (a two-line summary and five short skills ahead of the long one); the guard
# below asserts it STILL lands there, so the check cannot quietly stop
# exercising the collision if the vertical rhythm ever shifts. Before the fix
# `"EXPERIENCE" in extract_text(...)` was False on both split and panel and the
# extracted line read "…backeEnXd PsyEstRemIEs NatC scEale". The clean twin is
# pinned beside it so the check cannot be satisfied by breaking extraction
# generally.
def _exp_fixture(skill: str):
    _r = resume.model_copy(deep=True)
    _r.summary = " ".join(["Experienced backend professional building reliable services."] * 2)
    _r.skills = [f"Skill{i}" for i in range(5)] + [skill]
    _r.skill_groups = []
    return _r


_exp_bad: list = []
for _tpl in ("split", "panel"):
    _long_pdf = render_pdf(_exp_fixture("Designing and operating distributed backend systems at scale"),
                           template=_tpl)
    _clean_pdf = render_pdf(_exp_fixture("Distributed systems"), template=_tpl)
    with _pdfplumber.open(_io.BytesIO(_long_pdf)) as _pdf:
        _chip_tops = [w["top"] for w in _pdf.pages[0].extract_words() if w["text"].startswith("Design")]
    with _pdfplumber.open(_io.BytesIO(_clean_pdf)) as _pdf:
        _head_tops = [w["top"] for w in _pdf.pages[0].extract_words() if w["text"] == "EXPERIENCE"]
    _aligned = bool(_chip_tops) and bool(_head_tops) and abs(_chip_tops[0] - _head_tops[0]) < 6.0
    if not (_aligned
            and "EXPERIENCE" in _li_extract_text("resume.pdf", _long_pdf)
            and "EXPERIENCE" in _li_extract_text("resume.pdf", _clean_pdf)):
        _exp_bad.append((_tpl, _aligned, [round(t, 1) for t in _chip_tops[:1]],
                         [round(t, 1) for t in _head_tops[:1]]))
check(
    "pdf[split,panel]: a long skill no longer deletes the EXPERIENCE heading -- "
    "and the fixture still puts the chip at the heading's y, so the check "
    "cannot pass by no longer exercising the collision",
    not _exp_bad, str(_exp_bad),
)


# 18k. LANGUAGES, not just skills. `build_languages` builds a `_Chips` too, so a
# `LanguageSkill` level string like "Native / full professional working
# proficiency, written and spoken" hit exactly the same defect -- it overran the
# `split` rail by 158.3pt with no skill involved at all.
_lang_bad: list = []
for _tpl in ("split", "panel"):
    _lr = resume.model_copy(deep=True)
    _lr.languages = [LanguageSkill(
        language="English",
        level="Native / full professional working proficiency, written and spoken")]
    _ls, _le = _chip_escapes(_lr, _tpl, False)
    if _ls or _le:
        _lang_bad.append((_tpl, _ls[:2], _le[:2]))
check(
    "pdf[split,panel]: a long LANGUAGES proficiency string stays in its column "
    "too -- `_Chips` draws both sections, so the fix cannot be skills-only",
    not _lang_bad, str(_lang_bad),
)


# 18l. `split()` now ACCUMULATES per-row heights instead of dividing the room by
# a fixed `chip_h + gap` step, because rows are no longer all one line tall. For
# a block of uniform rows the two agree exactly -- which is why the 200-item pin
# above still returns 2 -- so the arithmetic needs its own case: a block mixing
# normal rows with one wrapped chip, at a height where the old formula counted
# the two-line row as one line and would hand the frame a head TALLER than the
# room it was given. Measured: at avail_h=80 the old formula takes 4 rows for
# 87.42pt of content; the accumulator takes 3 for 67.34pt.
_mix_items = ([f"Skill{i}" for i in range(8)]
              + ["a single skill written out as a whole long sentence that cannot fit"]
              + [f"More{i}" for i in range(8)])
_mix = _Chips(_mix_items, font="Helvetica", size=9, ink=_HexColor("#000000"),
              border=_HexColor("#cccccc"))
_mix_rows = _mix._pack(160.0)
_mix_halves = _mix.split(160.0, 80.0)
_mix_head_h = _mix_halves[0].wrap(160.0, 80.0)[1] if len(_mix_halves) == 2 else None
check(
    "pdf: a chip block mixing normal rows with a WRAPPED chip splits at a row "
    "boundary, never inside a chip, and its head actually fits the room it was "
    "offered (the fixture must really contain a multi-line row, or this passes "
    "by never firing)",
    any(_h > _mix.chip_h + 1e-9 for _ents, _h in _mix_rows)      # the fixture is real
    and len(_mix_halves) == 2
    and _mix_halves[0].items + _mix_halves[1].items == _mix_items  # nothing lost or duplicated
    and _mix_head_h is not None and _mix_head_h <= 80.0,
    f"rows={[round(_h, 2) for _e, _h in _mix_rows]} head_h={_mix_head_h}",
)

check(
    "docx[split] renders the SAME document as its declared fallback, part for part "
    "— one code path, so the Word file can never silently drift from the sibling "
    "the UI names",
    # PARTS, not raw bytes, for the reason `_docx_parts` documents: python-docx
    # stamps every zip entry with the current time at 2-second DOS granularity,
    # so two renders either side of that boundary differ in bytes while being the
    # same file. This is the check behind the "one smoke test flakes, just re-run
    # it" folklore — it was never same-second ORDERING, it was the clock inside
    # the container, and the fix is to compare what the renderer actually writes.
    _docx_parts(render_docx(resume, template="split"))
    == _docx_parts(render_docx(resume, template=get_template("split").docx_fallback)),
)

# 18c. ATS X-ray (21.7). We render the file and read it back with our OWN parser
# — the closest proxy we have to an ATS — and report what survived. The point is
# to stop asserting that templates are ATS-safe and start showing it.
from app.core.ats_xray import xray  # noqa: E402


def _xray_bad() -> bool:
    try:
        xray(resume, "classic", "rtf")
    except ValueError:
        return True
    return False

_xr = xray(resume, "classic", "pdf")
check(
    "x-ray: every protected fact is recovered from the default template — nothing missing",
    _xr.missing == 0 and _xr.clean > 0 and _xr.polluted == 0,
    f"clean={_xr.clean} split={_xr.split} polluted={_xr.polluted} missing={_xr.missing}",
)
check(
    "x-ray returns the parser's ACTUAL text, not a summary of it",
    resume.contact.name in _xr.text and resume.experience[0].company in _xr.text,
)
# THE FALSE-POSITIVE PIN. A guard that fires correctly AND fires on clean input
# is worse than no guard: it teaches users to ignore it. A single-column layout
# has no second column to interleave with, so it must NEVER report pollution —
# including the header, whose headline legitimately contains skill words.
_fp = {t: xray(resume, t, "pdf").polluted
       for t, spec in TEMPLATES.items() if spec.layout == "single"}
check(
    "x-ray: NO single-column template reports column pollution (false-positive pin)",
    all(v == 0 for v in _fp.values()),
    str({k: v for k, v in _fp.items() if v}),
)
# ...and the true-positive half, so the check can never be satisfied by a guard
# that simply never fires.
#
# Interleaving is CONTENT-dependent, not automatic: it only happens where the
# sidebar still has content at the same height as a main-column entry. The
# shared `resume` fixture has a short sidebar and produces none, which is a real
# and useful fact — so the true-positive case gets a résumé built to trigger it
# (a full sidebar running down beside three roles).
_xr_deep = ResumeModel(
    contact=Contact(name="Column Collider", email="cc@example.com", phone="+972 50-000-0000",
                    location="Tel Aviv", linkedin="linkedin.com/in/collider"),
    headline="Platform Engineer",
    summary="Platform engineer with a long sidebar and a long career.",
    skills=["Python", "Go", "Rust", "PostgreSQL", "Kafka", "Kubernetes", "AWS",
            "Terraform", "gRPC", "Redis", "Airflow", "Docker"],
    experience=[
        Experience(company="Alpha Systems", title="Staff Engineer", location="Tel Aviv",
                   start_date="2022", end_date="Present",
                   bullets=["Ran the platform team and shipped the migration."]),
        Experience(company="Beta Labs", title="Senior Engineer", location="Haifa",
                   start_date="2019", end_date="2022",
                   bullets=["Built the ingestion pipeline end to end."]),
        Experience(company="Gamma Works", title="Engineer", location="Herzliya",
                   start_date="2017", end_date="2019",
                   bullets=["Owned the billing service."]),
    ],
    education=[Education(institution="Technion", degree="B.Sc.", field="Computer Science",
                         start_date="2013", end_date="2017")],
    certifications=["AWS Certified Solutions Architect", "Certified Kubernetes Administrator"],
    languages=[LanguageSkill(language="Hebrew", level="Native"),
               LanguageSkill(language="English", level="Fluent"),
               LanguageSkill(language="Russian", level="Conversational")],
)
_xr2 = xray(_xr_deep, "panel", "pdf")
check(
    "x-ray: a two-column PDF DOES report the interleaving we measured, naming the "
    "main-column fact and the sidebar value glued to it",
    _xr2.two_column and _xr2.polluted > 0
    and all(f.collided_with for f in _xr2.facts if f.status == "polluted"),
    f"polluted={_xr2.polluted} "
    + str([(f.kind, f.collided_with) for f in _xr2.facts if f.status == "polluted"]),
)
_xrd = xray(_xr_deep, "panel", "docx")
check(
    "x-ray[docx] of a two-column template reports the single-column sibling the "
    "user actually receives, and finds nothing polluted in it",
    (not _xrd.two_column) and _xrd.docx_fallback == get_template("panel").docx_fallback
    and _xrd.polluted == 0 and _xrd.missing == 0,
    f"fallback={_xrd.docx_fallback} polluted={_xrd.polluted} missing={_xrd.missing}",
)
# The old pin here was `clean > 0` in both formats. A Hebrew résumé carries two
# Latin facts (email, phone), so it passed while the OTHER 14 read `missing` —
# a check that passed by never firing, on the honesty feature, in the primary
# market. PDF extraction returns VISUAL (bidi-reordered) text while a fact from
# the model is LOGICAL, so nothing Hebrew ever matched. Pin the whole set.
_he_xr_pdf = xray(_he_full, "classic", "pdf")
_he_xr_docx = xray(_he_full, "classic", "docx")
check(
    f"x-ray[he/pdf]: a correctly rendered Hebrew CV loses NOTHING — {_he_xr_pdf.clean}/{len(_he_xr_pdf.facts)} clean",
    _he_xr_pdf.missing == 0 and _he_xr_pdf.clean == len(_he_xr_pdf.facts) and len(_he_xr_pdf.facts) > 5,
    f"clean={_he_xr_pdf.clean} split={_he_xr_pdf.split} missing={_he_xr_pdf.missing} n={len(_he_xr_pdf.facts)}",
)
check(
    "x-ray[he/docx] agrees — docx extraction is logical, so it is the control",
    _he_xr_docx.missing == 0 and _he_xr_docx.clean == len(_he_xr_docx.facts),
    f"clean={_he_xr_docx.clean}/{len(_he_xr_docx.facts)} missing={_he_xr_docx.missing}",
)
# Its own fixture, deliberately: a wrapped Hebrew bullet is the case the visual
# lookup has to reach through the SPLIT fallback rather than a whole-line hit,
# and `_he_full`'s bullets are short enough to never wrap — so a check written
# against them would pass without ever exercising it (the 21.7 lesson).
_he_wrap = _he_full.model_copy(deep=True)
_he_wrap.experience[0].bullets = [
    "הובלתי את הפיתוח של מערכת ניתוח הנתונים המרכזית של החברה מקצה לקצה, כולל תכנון הסכימה, "
    "בניית צינורות העיבוד, אופטימיזציה של השאילתות והדרכת ארבעה מפתחים חדשים לאורך הדרך"
]
_he_wrap_xr = xray(_he_wrap, "classic", "pdf")
_wrapped = [f for f in _he_wrap_xr.facts if f.kind == "bullet"]
check(
    "x-ray[he/pdf]: a Hebrew bullet long enough to WRAP reads as split, never as lost",
    bool(_wrapped) and all(f.status == "split" for f in _wrapped) and _he_wrap_xr.missing == 0,
    f"bullet statuses={[f.status for f in _wrapped]} missing={_he_wrap_xr.missing}",
)
check(
    "x-ray rejects an unknown format instead of guessing",
    (lambda: [False for _ in [0]] and _xray_bad())(),
)

# "<w:drawing" joined the list with the vector icons (21.8): the PDF draws small
# marks on the contact row and the Word file must never answer that by embedding
# a drawing object — it is exactly what an ATS parser cannot un-pick.
_ATS_FORBIDDEN = ("<w:tbl", "<w:pict", "<w:drawing", "graphicData", "headerReference",
                  "footerReference", "txbxContent")
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

# 18b. Design pass on the rendered CV. Letter-spacing, hairlines and flush-right
# dates are what make the download look designed rather than typed — each one is
# also a way to break an ATS, so each is pinned here.
_dsg_pdf_txt = _pdf_text(render_pdf(resume))
check(
    "pdf: letter-spaced headings still extract as whole words (Tc must not inject spaces)",
    "SUMMARY" in _dsg_pdf_txt and "EXPERIENCE" in _dsg_pdf_txt,
    _dsg_pdf_txt[:160],
)
_dsg_docx_xml = _docx_xml(render_docx(resume))
check(
    "docx: hairlines/bars are paragraph borders — no table anywhere",
    "<w:pBdr" in _dsg_docx_xml and "<w:tbl" not in _dsg_docx_xml,
)
# The flush-right date is a right TAB STOP, never a table. `classic` moved to the
# stacked entry (title, then "Employer · Location · Dates") to kill the ~300pt
# white river that flush-right dates leave beside a short title — so the tab-stop
# guarantee is now pinned on a template that still uses the split entry.
_dsg_split_xml = _docx_xml(render_docx(resume, template="executive"))
check(
    "docx: a flush-right date is a right tab stop, not a table",
    "<w:tabs" in _dsg_split_xml and "<w:tbl" not in _dsg_split_xml,
)
# The band, the accent bar and the chips are the three moves that carry most of
# the visual upgrade, and all three had to be reproducible in DOCX without a
# table — paragraph shading, a left paragraph border, and a bordered run.
_dsg_band_xml = _docx_xml(render_docx(resume, template="modern"))
check(
    "docx: filled header band is paragraph shading and chips are bordered runs — "
    "still no table, text box, image, header or footer",
    "<w:shd" in _dsg_band_xml and "<w:bdr" in _dsg_band_xml
    and not any(tok in _dsg_band_xml for tok in _ATS_FORBIDDEN),
)
_dsg_bar_xml = _docx_xml(render_docx(resume, template="compact"))
# The literal this used to assert ('w:sz="18"') was the RENDERER's hard-coded
# 2.25pt, not compact's declared 2.4 — so it pinned the bug rather than the
# spec, and honouring `heading_bar_w` turned it red. Derived from the
# declaration now, which is the repair the rule asks for: fix the assertion, do
# not weaken it.
_dsg_bar_sz = int(round(get_template("compact").heading_bar_w * 8))
check(
    "docx: the accent bar beside a heading is a left paragraph border, at the "
    "WIDTH the template declares",
    f'<w:left w:val="single" w:sz="{_dsg_bar_sz}"' in _dsg_bar_xml
    and "<w:tbl" not in _dsg_bar_xml,
    f"want sz={_dsg_bar_sz}, found {sorted(set(_re.findall(r'<w:left [^>]*>', _dsg_bar_xml)))[:2]}",
)
_dsg_he_xml = _docx_xml(render_docx(_he_full))
check(
    "docx he: bold/size mirrored onto the complex-script twins (Word ignores w:b for Hebrew)",
    "<w:bCs" in _dsg_he_xml and "<w:szCs" in _dsg_he_xml,
)

# --------------------------------------------------------------------------- #
# 18m. THE SPEC IS THE CONTRACT, AND BOTH RENDERERS HAVE TO KEEP IT.
#
# "A template must differ from the others in SHAPE, not in hue... every option
# in it is reproducible in BOTH renderers, so the two downloads can never
# disagree about what the document SAYS."  The PDF honoured essentially the
# whole presentation vocabulary; the DOCX read a subset and hard-coded the rest.
# Fifteen spec fields with a visible consequence were never referenced by
# `docx_renderer` at all — `heading_case`, the heading rule's predicate, weight,
# colour, short width and hang, `heading_bar_w`, `header_rule_pt`,
# `header_rule_accent`, `bullet_glyph`, `bullet_scale`, `bullet_accent`,
# `page_bg`, `rail`, `list_cols` — so per template the Word file contradicted
# its own PDF: Title Case in the PDF and UPPERCASE in Word, a 26-32pt accent
# underline in the PDF and a full-width grey hairline in Word, `minimal` drawing
# nine heading rules in Word and none at all in its PDF.
#
# NONE of that was catchable by the checks that existed, and the reason is worth
# stating: they rendered every template in every format and language and then
# asserted only that the file opened and the words came back. Nothing looked at
# what either file CONTAINED. That is the same gap CLAUDE.md records for the
# sidebar overflow ("the old checks rendered every template but never asserted
# WHERE content landed"), so the checks below are positional and derived from
# the spec wherever a number is involved — never restated literals, which is how
# the `w:sz="18"` assertion above came to pin the renderer's hard-coded value
# against the template's declared one.
from docx import Document as _Document  # noqa: E402
from docx.enum.text import WD_ALIGN_PARAGRAPH as _WD_ALIGN  # noqa: E402

# One fixture with all eight sections populated, a project DESCRIPTION (the
# timeline rail broke across exactly that line and no existing fixture had one)
# and three certifications with unique leading tokens, so `list_cols` can be
# read positionally out of the PDF.
_tf = ResumeModel(
    contact=Contact(name="Tamar Fidelity", email="tamar@example.com", phone="+972-52-000-0000",
                    location="Tel Aviv", linkedin="linkedin.com/in/tamar"),
    headline="Platform Engineer",
    summary="Platform engineer with nine years across payments and data infrastructure.",
    skills=["Python", "Go", "PostgreSQL", "Kubernetes"],
    experience=[Experience(company="Acme Systems", title="Staff Engineer", location="Tel Aviv",
                           start_date="2016", end_date="Present",
                           bullets=["Ran the platform team.", "Shipped the payments migration."])],
    projects=[Project(name="Ziko", bullets=["Built the dispatch service."],
                      # Every word here is unique in this résumé on purpose: the
                      # rail check below locates the description POSITIONALLY by
                      # its words, and a token that also appears in the summary
                      # would be looked for in a section that has no rail.
                      description="Guides couriers through Jaffa alleyways nightly.")],
    education=[Education(institution="Technion", degree="B.Sc.", field="Computer Science",
                         start_date="2010", end_date="2014")],
    military_service=[MilitaryService(unit="8200", role="Analyst",
                                      start_date="2006", end_date="2009")],
    certifications=["Certalpha Solutions Architect", "Certbravo Kubernetes Admin",
                    "Certcharlie Terraform Associate"],
    languages=[LanguageSkill(language="Hebrew", level="Native"),
               LanguageSkill(language="English", level="Fluent")],
)
_TF_LABELS = _labels_for("en")


def _eff(tpl: str):
    """The spec the DOCX actually renders. A two-column template has no Word
    file of its own — it falls back to the single-column sibling — so every
    DOCX assertion below has to be made against the sibling's declaration, not
    against the one the user picked."""
    _s = get_template(tpl)
    return get_template(_s.docx_fallback) if _s.docx_fallback else _s


def _cased(label: str, spec) -> str:
    """pdf_renderer's own expression for a section heading's case."""
    return label.title() if spec.heading_case == "title" else label.upper()


def _heading_words(spec) -> set[str]:
    return {_cased(v, spec) for v in _TF_LABELS.values()}


# 18m-1. THE STRUCTURAL-DISTINCTNESS PIN — the one that would have caught this
# whole class at once.
#
# The existing diversity check (18, above) reads the SPEC tuple, so all fifteen
# ignored fields stayed green: eleven declarations that differ, rendering into
# far fewer documents. This reads the RENDERED file instead. Every colour and
# every type size / weight / spacing value is blinded, so what is left is the
# document's SHAPE — which paragraphs carry a border and on which edge, which
# carry an indent, an alignment, a tab stop, a numbering reference, and what the
# bullet level actually says.
#
# The section properties are deliberately NOT blinded: the page size and the
# margins are the text column's geometry, which is layout rather than hue —
# `minimal`'s 84pt side margin is documented as load-bearing, being the gutter
# its hung headings live in.
#
# The bar is DERIVED, not a number: two templates may render the same Word
# document only when one names the other as its `docx_fallback`, which is the
# one collapse the design intends. Measured before this work: 8 groups, with
# classic == modern == split == panel — i.e. `classic == modern` on top of the
# two declared pairs, the exact "one document in N colours" failure Phase 21
# existed to kill. After: 9, each group exactly one fallback class.
_STRUCT_ATTR = _re.compile(r'(w:[A-Za-z]+)="([^"]*)"')
_STRUCT_BLIND = _re.compile(r"^(-?\d+|[0-9A-Fa-f]{6}|auto)$")


def _blind(xml: str) -> str:
    return _STRUCT_ATTR.sub(
        lambda m: f'{m.group(1)}="#"' if _STRUCT_BLIND.match(m.group(2)) else m.group(0), xml)


def _docx_structure(blob: bytes) -> str:
    with _zipfile.ZipFile(_io.BytesIO(blob)) as z:
        doc = z.read("word/document.xml").decode("utf-8")
        # numbering.xml carries the bullet LEVEL, so the glyph is part of the
        # structure rather than something only the eye can see.
        num = z.read("word/numbering.xml").decode("utf-8")
    head, sep, tail = doc.partition("<w:sectPr")
    if not sep:  # fail loudly: a document with no section properties means the
        raise AssertionError("no <w:sectPr> in word/document.xml")  # partition silently kept everything
    return _blind(head) + sep + tail + "\n@@\n" + _blind(num)


_struct: dict[str, list[str]] = {}
for _tpl in TEMPLATES:
    _struct.setdefault(_docx_structure(render_docx(_tf, template=_tpl)), []).append(_tpl)
_struct_want = len({(t.docx_fallback or t.id) for t in TEMPLATES.values()})
# The blinding has to actually blind, or every template is "distinct" because
# its accent colour is still in the signature — a check that passes by never
# firing, which is the failure mode this suite exists to prevent.
_struct_raw = _docx_xml(render_docx(_tf))
check(
    "docx: eleven templates render as many DISTINCT DOCUMENTS as the design "
    "declares — with every colour and every size/spacing value blinded, two "
    "templates may share a structure ONLY when one names the other as its "
    "docx_fallback (8 before this work: classic == modern == split == panel)",
    bool(_re.search(r'w:val="[0-9A-F]{6}"', _struct_raw)) and 'w:val="#"' in _blind(_struct_raw)
    and len(_struct) == _struct_want
    and all(len({get_template(t).docx_fallback or t for t in g}) == 1 for g in _struct.values()),
    f"groups={len(_struct)}/{_struct_want} " + str(sorted(_struct.values(), key=len, reverse=True)[:3]),
)

# 18m-2. The heading TEXT is the same in both downloads, derived from
# `heading_case`. The wrong case must be ABSENT as well as the right one
# present, or "upper() is always applied" satisfies half the check.
_hc_bad: list = []
for _tpl in TEMPLATES:
    for _fmt, _spec, _txt in (
        ("pdf", get_template(_tpl), _pdf_text(render_pdf(_tf, template=_tpl))),
        ("docx", _eff(_tpl), _li_extract_text("resume.docx", render_docx(_tf, template=_tpl))),
    ):
        _raw = _TF_LABELS["experience"]
        _want = _cased(_raw, _spec)
        _other = _raw.upper() if _spec.heading_case == "title" else _raw.title()
        if _want not in _txt or _other in _txt:
            _hc_bad.append((_tpl, _fmt, _spec.heading_case, _want in _txt, _other in _txt))
check(
    "heading_case reaches BOTH renderers: executive and ivy print Title Case and "
    "the other nine print CAPS, in the PDF and in the Word file alike (the DOCX "
    "never read the field — both printed SUMMARY/EXPERIENCE in Word)",
    not _hc_bad and any(t.heading_case == "title" for t in TEMPLATES.values()),
    str(_hc_bad[:4]),
)

# 18m-3. The NUMBER of heading rules in the Word file is `pdf_renderer`'s own
# predicate applied to the same headings — never a count and never a literal.
# `minimal` drew nine bottom borders in Word (one header + eight headings) where
# its PDF draws none at all, because the two used different predicates.
_hr_bad: list = []
for _tpl in TEMPLATES:
    _spec = _eff(_tpl)
    _blob = render_docx(_tf, template=_tpl)
    _heads = [p for p in _Document(_io.BytesIO(_blob)).paragraphs
              if p.text.strip() in _heading_words(_spec)]
    _want = (len(_heads) * (1 if _spec.heading in ("rule", "short", "centered") else 0)
             + (1 if _spec.header == "rule" else 0))
    _got = _docx_xml(_blob).count('<w:bottom w:val="single"')
    # A fixture that stopped producing headings would make every count 0 == 0.
    if len(_heads) != len(_TF_LABELS) or _got != _want:
        _hr_bad.append((_tpl, f"heads={len(_heads)}", f"got={_got}", f"want={_want}"))
check(
    "docx: a section heading carries a rule exactly when pdf_renderer draws one "
    "— heading in (rule, short, centered) — plus one for a header='rule' "
    "template, and the fixture really has all eight sections",
    not _hr_bad, str(_hr_bad[:4]),
)

# 18m-4. …and every one of those rules has the WEIGHT and COLOUR its template
# declares. Asserted as a SET over the whole document so the header rule and the
# heading rule are both covered and neither can borrow the other's value:
# `ledger` must show 2.0pt rust for its header and 2.0pt near-black for its
# headings, where both used to print as a 0.5pt D8D8D8 hairline.
_BORDER_RE = _re.compile(
    r'<w:bottom w:val="single" w:sz="(\d+)" w:space="\d+" w:color="([0-9A-Fa-f]{6})"/>')
_rw_bad: list = []
_rw_expected = 0
for _tpl in TEMPLATES:
    _spec = _eff(_tpl)
    _want = set()
    if _spec.header == "rule":
        _want.add((str(int(round(_spec.header_rule_pt * 8))),
                   _spec.accent if _spec.header_rule_accent else _spec.rule))
    if _spec.heading in ("rule", "short", "centered"):
        _want.add((str(int(round(_spec.heading_rule_pt * 8))), _spec.head_rule_fill))
    _rw_expected += len(_want)
    _got = set(_BORDER_RE.findall(_docx_xml(render_docx(_tf, template=_tpl))))
    if _got != _want:
        _rw_bad.append((_tpl, sorted(_got), sorted(_want)))
check(
    "docx: every hairline is drawn at the weight and in the colour its template "
    "declares — header_rule_pt / header_rule_accent for the header, "
    "heading_rule_pt / head_rule_fill for the headings (this file hard-coded "
    "0.5pt grey for all of them)",
    not _rw_bad and _rw_expected >= len(TEMPLATES),
    f"expected_pairs={_rw_expected} " + str(_rw_bad[:3]),
)

# 18m-5. A "short" underline is `heading_short_pt` WIDE — assert the twips, not
# merely that an indent exists. It cannot be a border on the heading paragraph
# itself: a paragraph border spans its paragraph, so a 32pt rule would mean a
# 32pt-wide paragraph and "EXPERIENCE" at 11pt bold measures ~70pt, wrapping the
# heading to about one character per line. So it is an empty paragraph indented
# to leave exactly that width, carrying the border on its bottom.
_su_bad: list = []
_su_seen = 0
for _tpl in TEMPLATES:
    _spec = _eff(_tpl)
    if _spec.heading != "short":
        continue
    _su_seen += 1
    _want = int(round((_spec.page_w_pt - 2 * _spec.margin_lr_pt - _spec.heading_short_pt) * 20))
    _xml = _docx_xml(render_docx(_tf, template=_tpl))
    if f'<w:ind w:right="{_want}"/>' not in _xml:
        _su_bad.append((_tpl, _want, sorted(set(_re.findall(r'<w:ind [^>]*>', _xml)))[:3]))
check(
    "docx: a heading='short' template's accent underline is exactly "
    "heading_short_pt wide — asserted in twips, on every template that declares "
    "one",
    not _su_bad and _su_seen == sum(1 for t in TEMPLATES if _eff(t).heading == "short"),
    f"seen={_su_seen} " + str(_su_bad[:3]),
)

# 18m-6. The heading WORD is the same colour in both downloads. pdf_renderer
# colours it `ink` for the treatments that carry their own accent mark (a bar, a
# coloured underline, a hang) and `accent` where the word is the only colour on
# the line; the DOCX used `ink if bar else accent`, a different predicate, and
# wrote 0E7A5F / 15476B / 2E6B4F / 374151 where the PDF drew 14181F / 111827 /
# 121A16 / 111827. Read out of the RENDERED PDF, not out of the spec, so it is
# the drawn colour that is compared.
def _pdf_word_color(blob: bytes, word: str):
    with _pdfplumber.open(_io.BytesIO(blob)) as pdf:
        for page in pdf.pages:
            for w in page.extract_words():
                if w["text"] != word:
                    continue
                for ch in page.chars:
                    if (w["x0"] - 0.5 <= ch["x0"] and ch["x1"] <= w["x1"] + 0.5
                            and abs(ch["top"] - w["top"]) < 1.5):
                        return ch.get("non_stroking_color")
    return None


def _hex_rgb(value: str) -> tuple:
    return tuple(int(value[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


_col_bad: list = []
for _tpl, _sp in TEMPLATES.items():
    # A fallback template's Word file IS the sibling's, so comparing its PDF
    # with it would be comparing two different templates on purpose.
    if _sp.docx_fallback:
        continue
    _word = _cased(_TF_LABELS["experience"], _sp)
    _drawn = _pdf_word_color(render_pdf(_tf, template=_tpl), _word)
    _want = _sp.ink if _sp.heading in ("bar", "short", "hung") else _sp.accent
    _para = next((p for p in _Document(_io.BytesIO(render_docx(_tf, template=_tpl))).paragraphs
                  if p.text.strip() == _word), None)
    _in_docx = str(_para.runs[0].font.color.rgb) if (_para and _para.runs) else None
    if (_drawn is None or _in_docx is None
            or _in_docx != _want
            or max(abs(a - b) for a, b in zip(tuple(_drawn), _hex_rgb(_want))) > 1 / 255.0):
        _col_bad.append((_tpl, _sp.heading, _drawn, _in_docx, _want))
check(
    "the section heading is the same colour in the PDF and in the Word file — "
    "ink where the treatment carries its own accent mark, accent otherwise, one "
    "predicate for both renderers (they used different ones on four templates)",
    not _col_bad, str(_col_bad[:3]),
)

# 18m-7. POSITIONAL, both directions in one check: where the heading actually
# LANDS. This is the class of assertion the old template checks lacked — they
# rendered every template and never asserted where content went.
#   centered -> the PDF word's midpoint is on the page centre AND the Word
#               paragraph carries <w:jc w:val="center"/>
#   hung     -> the PDF word ends LEFT of the text column AND the Word paragraph
#               carries a negative left indent
# The other nine templates must satisfy NEITHER, or "centre everything" and
# "hang everything" pass.
_pos_bad: list = []
for _tpl, _sp in TEMPLATES.items():
    if _sp.docx_fallback:
        continue
    _word = _cased(_TF_LABELS["experience"], _sp)
    with _pdfplumber.open(_io.BytesIO(render_pdf(_tf, template=_tpl))) as _pdf:
        _hits = [w for p in _pdf.pages for w in p.extract_words() if w["text"] == _word]
    _para = next((p for p in _Document(_io.BytesIO(render_docx(_tf, template=_tpl))).paragraphs
                  if p.text.strip() == _word), None)
    if not _hits or _para is None:
        _pos_bad.append((_tpl, "heading not found", bool(_hits), _para is not None))
        continue
    _mid = (_hits[0]["x0"] + _hits[0]["x1"]) / 2
    _pdf_centered = abs(_mid - _sp.page_w_pt / 2) <= 2.0
    _pdf_hung = _hits[0]["x1"] < _sp.margin_lr_pt - 0.5
    _ind = _para.paragraph_format.left_indent
    _docx_centered = _para.alignment == _WD_ALIGN.CENTER
    _docx_hung = _ind is not None and _ind.pt < 0
    if ((_pdf_centered, _docx_centered) != (_sp.heading == "centered",) * 2
            or (_pdf_hung, _docx_hung) != (_sp.heading == "hung",) * 2):
        _pos_bad.append((_tpl, _sp.heading, f"pdf_c={_pdf_centered} docx_c={_docx_centered}",
                         f"pdf_h={_pdf_hung} docx_h={_docx_hung}"))
check(
    "heading POSITION agrees between the two renderers and with the spec: ivy's "
    "centred headings land on the page centre and carry w:jc center; minimal's "
    "hung ones sit out in the start margin and carry a negative w:ind; the other "
    "seven do neither",
    not _pos_bad
    and any(t.heading == "centered" for t in TEMPLATES.values())
    and any(t.heading == "hung" for t in TEMPLATES.values()),
    str(_pos_bad[:3]),
)

# 18m-8. THE HEADER HAIRLINE, and the deliberate visual change. `header` is now
# authoritative in both renderers, so `header="plain"` finally means what
# templates.py has always said it means: ivy and minimal stop drawing a rule
# they never declared (measured before: ivy 0.8pt C9CED6, minimal 0.8pt E4E7EB,
# in BOTH formats, while both picker thumbnails correctly drew none).
#
# Pinned in BOTH directions inside one check, because "suppress the rule" is
# trivially satisfied by suppressing every rule: the four header="rule"
# templates must still draw exactly one, and the band templates — whose header
# is a painted rectangle, not a line — must draw none either.
_hdr_bad: list = []
for _tpl, _sp in TEMPLATES.items():
    _spec_d = _eff(_tpl)
    _word_p = _cased(_TF_LABELS["summary"], _sp)
    _text_w = _sp.page_w_pt - 2 * _sp.margin_lr_pt
    with _pdfplumber.open(_io.BytesIO(render_pdf(_tf, template=_tpl))) as _pdf:
        _page = _pdf.pages[0]
        _tops = [w["top"] for w in _page.extract_words() if w["text"] == _word_p]
        _cut = min(_tops) if _tops else _page.height
        # Only a rule spanning most of the column counts; the heading rules all
        # sit BELOW the first heading's top, and a short accent underline is
        # under it too.
        _rules = [ln for ln in _page.lines
                  if ln["top"] < _cut - 0.5 and (ln["x1"] - ln["x0"]) > _text_w / 2]
    _paras = _Document(_io.BytesIO(render_docx(_tf, template=_tpl))).paragraphs
    _first_head = next((i for i, p in enumerate(_paras)
                        if p.text.strip() in _heading_words(_spec_d)), len(_paras))
    _hdr_borders = sum(1 for p in _paras[:_first_head] if "<w:bottom " in p._p.xml)
    _want_rule = 1 if _sp.header == "rule" else 0
    _want_docx = 1 if _spec_d.header == "rule" else 0
    if not _tops or len(_rules) != _want_rule or _hdr_borders != _want_docx:
        _hdr_bad.append((_tpl, _sp.header, f"pdf={len(_rules)}/{_want_rule}",
                         f"docx={_hdr_borders}/{_want_docx}", f"heading_found={bool(_tops)}"))
check(
    "header='plain' means NO hairline in either renderer (ivy, minimal), "
    "header='band' paints a rectangle instead of one, and the four header='rule' "
    "templates still draw exactly one — the bool the hairline used to key off "
    "was never set False by anybody",
    not _hdr_bad
    and {t.header for t in TEMPLATES.values()} == {"rule", "plain", "band"},
    str(_hdr_bad[:3]),
)

# 18m-9. THE BULLET IS THE TEMPLATE'S OWN GLYPH, and it is still a REAL WORD
# LIST. `doc.add_paragraph(item, style="List Bullet")` borrowed python-docx's
# stock numId 1, whose level text is a Symbol-font private-use codepoint — so
# `bullet_glyph`, `bullet_scale` and `bullet_accent` were all unreachable and
# executive's em dash and minimal's en dash, both drawn correctly in the PDF,
# printed as Word's generic dot. Resolved the way Word resolves it: paragraph
# numPr -> w:num -> w:abstractNum -> the level.
_NUMPR_RE = _re.compile(r"<w:numPr>.*?<w:numId w:val=\"(\d+)\"/>.*?</w:numPr>", _re.S)


def _bullet_level(blob: bytes) -> tuple:
    """(lvlText, sz, szCs, colour, w:cs font) of the level the bullets point at."""
    with _zipfile.ZipFile(_io.BytesIO(blob)) as z:
        doc = z.read("word/document.xml").decode("utf-8")
        num = z.read("word/numbering.xml").decode("utf-8")
    used = set(_NUMPR_RE.findall(doc))
    if len(used) != 1:
        return ("<%d numIds>" % len(used), "", "", "", "")
    abstract = _re.search(rf'<w:num w:numId="{used.pop()}">\s*<w:abstractNumId w:val="(\d+)"/>', num)
    if not abstract:
        return ("<no w:num>", "", "", "", "")
    block = _re.search(rf'<w:abstractNum w:abstractNumId="{abstract.group(1)}">.*?</w:abstractNum>',
                       num, _re.S)
    if not block:
        return ("<no w:abstractNum>", "", "", "", "")
    body = block.group(0)

    def _one(pattern: str) -> str:
        m = _re.search(pattern, body)
        return m.group(1) if m else ""

    return (_one(r'<w:lvlText w:val="([^"]*)"'), _one(r'<w:sz w:val="(\d+)"'),
            _one(r'<w:szCs w:val="(\d+)"'), _one(r'<w:color w:val="([0-9A-Fa-f]{6})"'),
            _one(r'<w:rFonts[^>]*w:cs="([^"]*)"'))


_bl_bad: list = []
for _tpl in TEMPLATES:
    _spec = _eff(_tpl)
    _half_pt = str(int(round(_spec.body_size * _spec.bullet_scale * 2)))
    _want = (_spec.bullet_glyph, _half_pt, _half_pt,
             _spec.accent if _spec.bullet_accent else _spec.muted, _spec.docx_font_he)
    _got = _bullet_level(render_docx(_tf, template=_tpl))
    if _got != _want:
        _bl_bad.append((_tpl, _got, _want))
check(
    "docx: the bullet paragraphs point at THIS template's numbering level — its "
    "own glyph, its own scaled size (with the w:szCs twin _set_rtl's sweep can "
    "never reach, because a numbering level is not a paragraph), its own colour, "
    "and w:cs on docx_font_he so Word does not substitute a face for Hebrew",
    not _bl_bad
    # …and the eleven really do declare more than one glyph, or "always the dot"
    # satisfies this by accident.
    and len({_eff(t).bullet_glyph for t in TEMPLATES}) >= 2,
    str(_bl_bad[:3]),
)

# 18m-10. `list_cols` reaches both renderers. Nine templates declare 2 and the
# DOCX rendered 1, wasting the right half of the page on a handful of short
# items. Positional on the PDF side (the SET of x0 values the certifications are
# placed at) and structural on the Word side (ceil(n/2) rows, each carrying a
# left tab stop and a real tab in its text — never a table and never w:cols,
# which is the snaking layout that made split and panel PDF-only).
#
# `split` and `panel` declare list_cols=1, so they are the PDF's own
# false-positive control: their certifications must sit at ONE x. Nothing
# declares 1 on the DOCX side, so that half borrows the icons check's technique
# and registers a one-column twin of classic for the length of the check.
import dataclasses as _tf_dc  # noqa: E402

_CERT_HEADS = [c.split()[0] for c in _tf.certifications]
TEMPLATES["_cols1"] = _tf_dc.replace(TEMPLATES["classic"], id="_cols1", list_cols=1)
try:
    _lc_bad: list = []
    for _tpl in list(TEMPLATES):
        _spec = _eff(_tpl)
        _cols = min(2, _spec.list_cols)
        # PDF: read where the certifications landed.
        _pspec = get_template(_tpl)
        _pcols = min(2, _pspec.list_cols)
        with _pdfplumber.open(_io.BytesIO(render_pdf(_tf, template=_tpl))) as _pdf:
            _xs = {round(w["x0"], 1) for p in _pdf.pages for w in p.extract_words()
                   if w["text"] in _CERT_HEADS}
        # DOCX: the rows between the certifications heading and the next heading.
        _paras = [p for p in _Document(_io.BytesIO(render_docx(_tf, template=_tpl))).paragraphs
                  if p.text.strip()]
        _hw = _heading_words(_spec)
        _start = next((i for i, p in enumerate(_paras)
                       if p.text.strip() == _cased(_TF_LABELS["certifications"], _spec)), -1)
        _rows = []
        for _p in _paras[_start + 1:] if _start >= 0 else []:
            if _p.text.strip() in _hw:
                break
            _rows.append(_p)
        _want_rows = -(-len(_tf.certifications) // _cols)
        _tabbed = sum(1 for _p in _rows
                      if any(t.alignment == _WD_ALIGN.LEFT for t in _p.paragraph_format.tab_stops))
        if (len(_xs) != _pcols or len(_rows) != _want_rows
                or _tabbed != (len(_rows) if _cols > 1 else 0)
                or sum(1 for _p in _rows if "\t" in _p.text) != (_cols > 1)):
            _lc_bad.append((_tpl, f"pdf_x={sorted(_xs)}/{_pcols}",
                            f"rows={len(_rows)}/{_want_rows}", f"tabbed={_tabbed}"))
    check(
        "list_cols reaches both renderers: the PDF places certifications at "
        "exactly that many x positions and the Word file emits ceil(n/cols) rows "
        "delimited by a TAB STOP — with split/panel (declared 1) and a "
        "one-column twin of classic as the false-positive halves",
        not _lc_bad and any(get_template(t).list_cols == 1 for t in TEMPLATES),
        str(_lc_bad[:3]),
    )
finally:
    del TEMPLATES["_cols1"]

# 18m-11. THE TIMELINE RAIL, and the hole nothing was looking at. The rail is
# drawn per FLOWABLE over that flowable's own height, so consecutive flowables
# tile into one line and a flowable that does not draw it leaves a gap —
# `build_projects` built the description `_Text` without `rail=`, so the rail
# broke across every project description (measured: a 15.2pt hole containing the
# description text) on the one template whose picker copy promises "one
# continuous line". No existing fixture even had a project description.
#
# Both directions in the same check: the description must be covered, and the
# section HEADING must NOT be — the rail belongs to the entries, so "draw a rail
# down the whole page" has to fail too.
_rail_sp = get_template("timeline")
_rail_x = _rail_sp.margin_lr_pt - 13.0  # `_Sheet.rail`'s gutter offset
_rail_desc = _tf.projects[0].description.split()
with _pdfplumber.open(_io.BytesIO(render_pdf(_tf, template="timeline"))) as _pdf:
    _page1 = _pdf.pages[0]
    _segs = [(ln["top"], ln["bottom"]) for ln in _page1.lines
             if abs(ln["x0"] - _rail_x) < 0.6 and abs(ln["x1"] - _rail_x) < 0.6]
    _dw = [w for w in _page1.extract_words() if w["text"] in _rail_desc]
    _hw_words = [w for w in _page1.extract_words()
                 if w["text"] == _cased(_TF_LABELS["projects"], _rail_sp)]
# Fail loudly if a probe word stopped being unique to the description: it would
# then be located in a section that legitimately has no rail, and the check
# would go red on a correct render — a guard firing on legitimate input.
_rail_unique = len(_dw) == len(_rail_desc)


def _covered(word) -> bool:
    return any(t <= word["top"] + 0.5 and b >= word["bottom"] - 0.5 for t, b in _segs)


_rail_gap = [w["text"] for w in _dw if not _covered(w)]
check(
    "pdf[timeline]: the rail runs unbroken THROUGH a project description — the "
    "line is per-flowable, so a flowable built without rail= punches a hole in "
    "it — while a section heading, which sits between entries, is still outside "
    "the rail",
    bool(_segs) and _rail_unique and bool(_hw_words)
    and not _rail_gap and not any(_covered(w) for w in _hw_words),
    f"segments={len(_segs)} desc_words={len(_dw)}/{len(_rail_desc)} uncovered={_rail_gap[:4]}",
)

_rail_docx_bad: list = []
for _tpl in TEMPLATES:
    _spec = _eff(_tpl)
    _paras = _Document(_io.BytesIO(render_docx(_tf, template=_tpl))).paragraphs
    _hw = _heading_words(_spec)
    # A heading's own left border is the accent BAR (compact, panel->modern), a
    # different device; the rail is what runs down the entry's paragraphs.
    _left = sum(1 for p in _paras if "<w:left " in p._p.xml and p.text.strip() not in _hw)
    if bool(_left) != _spec.rail:
        _rail_docx_bad.append((_tpl, _spec.rail, _left))
check(
    "docx: `rail` is a left paragraph border tiled down the entry's paragraphs "
    "for the template that declares it and for NO other — the same mechanism as "
    "the accent bar, so still no table (the per-role dot is a documented "
    "ornament carve-out and has no Word twin)",
    not _rail_docx_bad and any(_eff(t).rail for t in TEMPLATES),
    str(_rail_docx_bad[:3]),
)

# 18d. VECTOR ICONS on the contact row (21.8). Small drawn marks — envelope,
# handset, pin, link, globe — and optionally a calendar on an entry's dates.
# Everything here exists to prove one thing: they are PATHS, not glyphs. No
# bundled face has these characters, so a glyph would print a tofu box AND land
# in the extracted text, on the exact line an ATS parses as the email address.
import dataclasses as _dc  # noqa: E402

check(
    "icons are a design axis, not a default: some templates opt in and the "
    "austere ones (minimal / ivy / executive) stay bare",
    any(t.contact_icons for t in TEMPLATES.values())
    and not any(TEMPLATES[t].contact_icons or TEMPLATES[t].date_icon
                for t in ("minimal", "ivy", "executive")),
    str(sorted(t.id for t in TEMPLATES.values() if t.contact_icons)),
)

# A twin of `classic` with the ornament switched off. Registered temporarily so
# the icons-on and icons-off documents can be compared directly — the honest
# way to show that the icons cost the extracted text NOTHING.
TEMPLATES["_icons_off"] = _dc.replace(TEMPLATES["classic"], id="_icons_off",
                                      contact_icons=False, date_icon=False)
try:
    _ic_on, _ic_off = render_pdf(resume, "classic"), render_pdf(resume, "_icons_off")
    check(
        "pdf: the icons emit NO text — extraction is byte-identical with them on and off",
        _pdf_text(_ic_on) == _pdf_text(_ic_off),
        _pdf_text(_ic_on)[:160],
    )
    _ic_he_on, _ic_he_off = render_pdf(_he_full, "classic"), render_pdf(_he_full, "_icons_off")
    check(
        "pdf he: same in Hebrew — a mirrored icon still adds nothing to the text",
        _pdf_text(_ic_he_on) == _pdf_text(_ic_he_off),
    )
    # The point of "no text" is this line specifically: an ATS reads the contact
    # block for the email address, and a dingbat glued to it is a broken address.
    _ic_contact = [ln for ln in _pdf_text(_ic_on).splitlines() if resume.contact.email in ln]
    _ic_want = " · ".join(b for b in [resume.contact.email, resume.contact.phone,
                                      resume.contact.location, resume.contact.linkedin,
                                      resume.contact.website] if b)
    check(
        "pdf: the contact line holds the contact bits and NOTHING else — no glyph, "
        "no stray mark beside the email address",
        len(_ic_contact) == 1 and _ic_contact[0].strip() == _ic_want,
        str(_ic_contact),
    )

    # …and they really are drawn. Without this the check above would also pass
    # for icons that silently render nothing at all. Measured on a contact-only
    # résumé so the count is unambiguous: no chips, no heading rules, no bullets
    # — every curve and line on that page is an icon.
    def _vectors(b: bytes) -> int:
        with _pdfplumber.open(_io.BytesIO(b)) as pdf:
            return len(pdf.pages[0].curves) + len(pdf.pages[0].lines)

    _ic_bare = ResumeModel(contact=Contact(
        name="Dana Levi", email="dana@example.com", phone="+972-54-123-4567",
        location="Tel Aviv", linkedin="linkedin.com/in/dana", website="dana.dev"))
    check(
        "pdf: the icons are real vector geometry — five contact bits draw paths "
        "with them on and the page carries none at all with them off",
        _vectors(render_pdf(_ic_bare, "classic")) >= 5
        and _vectors(render_pdf(_ic_bare, "_icons_off")) == 0
        and _pdf_text(render_pdf(_ic_bare, "classic")) == _pdf_text(render_pdf(_ic_bare, "_icons_off")),
        f"on={_vectors(render_pdf(_ic_bare, 'classic'))} "
        f"off={_vectors(render_pdf(_ic_bare, '_icons_off'))}",
    )

    # THE CARVE-OUT. Icons are the one presentation option that does not
    # reproduce in both renderers: w:drawing / w:pict / graphicData are forbidden
    # and a unicode dingbat prints tofu in Calibri. So the Word file is the SAME
    # DOCUMENT without the ornament — byte-identical to the icons-off twin, which
    # is the strongest statement of "same document" available.
    check(
        "docx: an icon template renders the SAME document as its icons-off twin, "
        "byte for byte — the icons are the only difference and the DOCX drops them",
        _docx_parts(render_docx(resume, "classic")) == _docx_parts(render_docx(resume, "_icons_off")),
    )
    check(
        "docx: no drawing object ever appears for an icon template (en + he)",
        not any(tok in _docx_xml(render_docx(resume, "classic")) for tok in _ATS_FORBIDDEN)
        and not any(tok in _docx_xml(render_docx(_he_full, "classic")) for tok in _ATS_FORBIDDEN),
    )
finally:
    del TEMPLATES["_icons_off"]
_hl = resume.model_copy(deep=True)
_hl.headline = "Backend Engineer"
check(
    "headline (17.2) renders under the name in both formats",
    _hl.headline in _pdf_text(render_pdf(_hl))
    and _hl.headline in _li_extract_text("resume.docx", render_docx(_hl)),
)
_hl_he = _he_full.model_copy(deep=True)
_hl_he.headline = "מהנדס תוכנה"
check(
    "headline renders right-to-left in a hebrew résumé",
    _get_display(_hl_he.headline, base_dir="R") in _pdf_text(render_pdf(_hl_he)),
)


def _heading_order(text: str) -> list[str]:
    heads = [h for h in ("SUMMARY", "SKILLS", "EXPERIENCE", "EDUCATION") if h in text]
    return sorted(heads, key=text.index)


_pdf_senior = _heading_order(_pdf_text(render_pdf(_senior)))
_pdf_student = _heading_order(_pdf_text(render_pdf(_student)))
check(
    "17.5: the PDF lays the sections out in the profile's order",
    _pdf_senior == ["SUMMARY", "SKILLS", "EXPERIENCE", "EDUCATION"]
    and _pdf_student == ["SUMMARY", "SKILLS", "EDUCATION", "EXPERIENCE"],
    f"senior={_pdf_senior} student={_pdf_student}",
)
check(
    "17.5: the DOCX agrees with the PDF (one rule, both downloads)",
    _heading_order(_li_extract_text("resume.docx", render_docx(_senior))) == _pdf_senior
    and _heading_order(_li_extract_text("resume.docx", render_docx(_student))) == _pdf_student,
)

# 18e. GROUPED SKILLS (21.8). A real CV groups its skills under labels; ours had
# nowhere to put the grouping, so import destroyed it and the rendered CV showed
# one undifferentiated run of tokens. `skill_groups` carries the grouping and is
# ADDITIVE — empty means the old behaviour, unchanged.
from app.core.skills import skill_blocks as _skill_blocks  # noqa: E402
from app.models import SkillGroup as _SkillGroup  # noqa: E402

# THE INVARIANT: `skills` stays the flat surface everything SCORES — the scorer's
# keyword coverage, the ATS scan, the x-ray and résumé health all read it and
# none of them knows groups exist. So a payload that carries only the grouping
# must still come out with a full flat list.
_sg_only = ResumeModel(skill_groups=[
    _SkillGroup(label="AI & LLMs", items=["OpenAI API", "LangChain"]),
    _SkillGroup(label="Backend & Data", items=["Python", "PostgreSQL"]),
])
check(
    "grouped skills: `skills` is populated as the flat union of every group — "
    "the scorer and the ATS scan never see a grouped skill go missing",
    _sg_only.skills == ["OpenAI API", "LangChain", "Python", "PostgreSQL"],
    str(_sg_only.skills),
)
_sg_partial = ResumeModel(
    skills=["Python", "Hebrew keyboarding"],
    skill_groups=[_SkillGroup(label="Backend", items=["python", "FastAPI"])],
)
check(
    "grouped skills: a partial flat list is topped up, case-insensitively, and "
    "an ungrouped skill is never removed",
    _sg_partial.skills == ["Python", "Hebrew keyboarding", "FastAPI"],
    str(_sg_partial.skills),
)
# REMOVING a grouped skill is a TWO-FIELD write, and this pins the reason. The
# validator only ever ADDS, so dropping a skill from the flat list alone is
# undone on the very next construction — which is a silent no-op wearing a
# success toast. Both halves are asserted here because the one-field case
# passing is exactly what makes the bug invisible from the frontend.
_sg_removed_flat_only = ResumeModel(
    skills=["Python"],  # "FastAPI" dropped here...
    skill_groups=[_SkillGroup(label="Backend", items=["Python", "FastAPI"])],  # ...but not here
)
check(
    "grouped skills: dropping a skill from the flat list ALONE is silently undone",
    _sg_removed_flat_only.skills == ["Python", "FastAPI"],
    str(_sg_removed_flat_only.skills),
)
_sg_removed_both = ResumeModel(
    skills=["Python"],
    skill_groups=[_SkillGroup(label="Backend", items=["Python"])],
)
check(
    "grouped skills: dropping it from BOTH fields is the deletion that sticks",
    _sg_removed_both.skills == ["Python"],
    str(_sg_removed_both.skills),
)
check(
    "grouped skills: no groups = the pre-existing behaviour, untouched",
    ResumeModel(skills=["Python", "SQL"]).skills == ["Python", "SQL"]
    and ResumeModel(skills=["Python", "SQL"]).skill_groups == []
    and _skill_blocks(ResumeModel(skills=["Python", "SQL"])) == [("", ["Python", "SQL"])],
)
# NOTHING MAY BE HIDDEN. Groups that cover only part of `skills` still have to
# put the remainder on the page: an invisible skill is an x-ray "missing" on the
# document we told the user to send, not a tidier page.
check(
    "grouped skills: a skill no group claims is still rendered, in its own "
    "unlabelled block",
    _skill_blocks(_sg_partial) == [("Backend", ["python", "FastAPI"]), ("", ["Hebrew keyboarding"])],
    str(_skill_blocks(_sg_partial)),
)

# 18e-bis (PLAN 07). NORMALISING A MULTI-SKILL ENTRY. A CV that writes
# "Python, SQL, Go" on one line arrives from the structurer as a SINGLE skill:
# one chip on the page, one keyword to the scorer, one fact to the ATS x-ray.
# Splitting it changes what the document says, so it is a fix, not tidying.
from app.core.skills import normalize_resume_skills as _norm_resume  # noqa: E402
from app.core.skills import normalize_skills as _norm_skills  # noqa: E402

# THE FALSE-POSITIVE HALF SITS IN THE SAME CHECK AS THE POSITIVE, deliberately:
# "split multi-skill entries" is trivially satisfied by splitting on everything,
# and every entry below is legitimate. The first three are literally in this
# user's stored master (`/`); the next three are their own words (` and `); then
# three of ordinary Hebrew, where ו is an INSEPARABLE PREFIX orthographically
# identical to a word-initial vav — the Hebrew twin of check-mirrors 10.
#
# The last four are the BRACKET case, and it was a live defect rather than a
# hypothetical: a comma inside `()` is not a separator, and splitting on it wrote
# `Cloud (AWS` and `GCP)` — two fragments the user never typed, with unbalanced
# delimiters — into the master résumé and the downloaded PDF, at the one door
# that parses the user's own CV. The apostrophe entry is the guard on the guard:
# `'` may NOT be read as a quote delimiter, or `Bachelor's` opens a run that
# never closes and swallows every separator after it in the same entry.
_NS_ONE_SKILL_EACH = [
    "CI/CD", "TCP/IP", "A/B testing",
    "prompt and system design", "evaluation and fallback handling", "RTL and i18n",
    "פיתוח ווב", "עריכת וידאו", "ולידציה של נתונים",
    "Cloud (AWS, GCP, Azure)", "מסדי נתונים (פוסטגרס, מונגו)",
    "Data [ETL, ELT] pipelines", 'Testing "unit, e2e" suites',
]
_ns_kept, _ = _norm_skills(_NS_ONE_SKILL_EACH, [])
_ns_split, _ = _norm_skills(
    ["Python, SQL; Go", "Machine Learning | Deep Learning",
     "Docker · Kubernetes", "React\tVue\nSvelte",
     # A bracket that CLOSES still separates outside itself, and an apostrophe
     # never suppresses anything: the depth counter is not allowed to become a
     # blanket "stop splitting" rule.
     "Cloud (AWS, GCP), Redis", "Bachelor's, Statistics"],
    [],
)
check(
    "normalize_skills splits a punctuated list and NOTHING else — '/', ' and ', "
    "Hebrew's vav prefix and a separator inside brackets or quotes are all left whole",
    _ns_kept == _NS_ONE_SKILL_EACH
    and _ns_split == ["Python", "SQL", "Go", "Machine Learning", "Deep Learning",
                      "Docker", "Kubernetes", "React", "Vue", "Svelte",
                      "Cloud (AWS, GCP)", "Redis", "Bachelor's", "Statistics"],
    f"kept={_ns_kept} split={_ns_split}",
)
# NO CAP, in characters or in bytes. A skill is the user's own text, so "never
# truncate the user's own document" applies to it verbatim: a separator-free
# entry comes back whole however long it is. `_Chips` wraps it inside its own
# box and `ats_scan` reports it — neither of them shortens it.
_NS_SENTENCE = "Designing and operating distributed backend systems at scale"
_ns_long, _ = _norm_skills([_NS_SENTENCE], [])
check(
    "normalize_skills never truncates: a long separator-free entry passes "
    "through unchanged",
    _ns_long == [_NS_SENTENCE],
    str(_ns_long),
)
# THE TWO-FIELD WRITE, with the naive one-field form pinned beside it so the
# check documents why both fields are written. `_sync_skill_groups` only ever
# ADDS, so normalising the flat list ALONE lets the un-split entry resurrect out
# of its group on the very next construction — where it then coexists with its
# own fragments and that skill renders twice and scores twice.
_ns_raw = ResumeModel(
    skills=["Python, SQL", "Go"],
    skill_groups=[_SkillGroup(label="Backend", items=["Python, SQL", "Go"])],
)
_ns_fixed = _norm_resume(_ns_raw)
_ns_round = ResumeModel.model_validate(_json.loads(_ns_fixed.model_dump_json()))
# `model_copy` skips validation on purpose, so this is the un-split GROUP meeting
# the validator for the first time on the JSON round trip — exactly what a
# flat-only normaliser would ship.
_ns_naive = ResumeModel.model_validate(_json.loads(
    _ns_raw.model_copy(update={"skills": _norm_skills(_ns_raw.skills, [])[0]}).model_dump_json()
))
check(
    "normalising skills is a TWO-FIELD write: both fields survive the JSON round "
    "trip, while the flat-list-only form resurrects the un-split entry",
    _ns_fixed.skills == ["Python", "SQL", "Go"]
    and _ns_round.skills == _ns_fixed.skills
    and _ns_round.skill_groups[0].items == ["Python", "SQL", "Go"]
    and _ns_naive.skills == ["Python", "SQL", "Go", "Python, SQL"],
    f"fixed={_ns_fixed.skills} round={_ns_round.skills} naive={_ns_naive.skills}",
)
# SOURCE-PINNED, because behaviour alone cannot tell the two placements apart —
# a splitting `model_validator` produces split skills too. The whole risk here is
# someone tidying the normaliser into `ResumeModel`, where it would run on every
# CONSTRUCTION, i.e. every READ of every stored master, tracker résumé, saved kit
# and version snapshot: rewriting all of them without any of them being a write,
# bypassing `resume_versions.snapshot` (which only fires on a write) and breaking
# its byte-identical dedupe, so the first save after deploy burns one of 20 undo
# slots on a no-op. Same shape as the 22.10 /tools/ats-scan source pin. The
# behavioural twin — a stored résumé PUT and read back verbatim — is in section
# 27, and it is what catches an inline COPY of the splitter that this grep would
# not see.
import inspect as _ns_inspect  # noqa: E402

import app.models as _ns_models_mod  # noqa: E402

_ns_models_src = _ns_inspect.getsource(_ns_models_mod)
check(
    "skill normalisation is NOT a model_validator — `app/models` neither imports "
    "nor calls it, so no stored row is rewritten on READ",
    # Fail loudly rather than passing on a module we failed to read.
    len(_ns_models_src) > 2000
    and "normalize_skills" not in _ns_models_src
    and "app.core.skills" not in _ns_models_src,
    f"{len(_ns_models_src)} chars scanned",
)
# THE DOOR ITSELF, driven end to end rather than called directly — a check that
# calls the normaliser still passes with the call site deleted. The stub echoes
# the raw text's own grouping (`StubClient._stub_skill_groups`), so a semicolon
# inside a grouped item reaches `structure_resume` exactly as a real CV's would.
# The false-positive half rides in the same check: `CI/CD` goes through the same
# door and must come out whole.
_ns_imported = structure_resume(
    "Dana Levi\nSkills\nAI & LLMs: OpenAI API; LangChain, RAG pipelines\n"
    "Backend & Data: Python, CI/CD\n"
)
_ns_imported_items = [g.items for g in _ns_imported.skill_groups]
check(
    "structure_resume is the ONE server-side door: a multi-skill entry is split "
    "on import in both fields, and CI/CD survives the same door intact",
    _ns_imported_items == [["OpenAI API", "LangChain", "RAG pipelines"], ["Python", "CI/CD"]]
    and {"OpenAI API", "LangChain", "RAG pipelines", "CI/CD"} <= set(_ns_imported.skills)
    and not any(";" in s for s in _ns_imported.skills),
    str(_ns_imported_items),
)
# THE BRACKET CASE, through the same door. It cannot ride the raw-text path: the
# stub derives its groups by splitting the line on commas ITSELF (it stands in
# for the model), so a bracketed item is shredded before `normalize_skills` ever
# sees it. The STRUCTURE response is therefore canned with the exact group-item
# shape the prompt asks a real model for, and the door is driven from there. The
# entry beside it is a genuine two-skill line, so "stop splitting inside
# brackets" cannot be satisfied by not splitting.
from app.llm.client import get_llm_client as _ns_client  # noqa: E402

_ns_stub = _ns_client()
_ns_orig_cjson = _ns_stub.complete_json
_NS_CANNED_DOC = {
    "contact": {"name": "Dana Levi", "email": "dana@example.com"},
    "skills": [],
    "skill_groups": [{"label": "Cloud",
                      "items": ["Cloud (AWS, GCP, Azure)", "Terraform, Pulumi"]}],
}


def _ns_canned(system, user, **kw):
    if "STRUCTURE_RESUME" in system[:40]:
        return _NS_CANNED_DOC
    return _ns_orig_cjson(system, user, **kw)


_ns_stub.complete_json = _ns_canned
try:
    _ns_brackets = structure_resume("Dana Levi\nSkills\nCloud: Cloud (AWS, GCP, Azure)\n")
finally:
    _ns_stub.complete_json = _ns_orig_cjson
check(
    "structure_resume: a comma inside brackets is not a separator — the entry lands "
    "whole in both fields, with no unbalanced fragment the user never typed",
    [g.items for g in _ns_brackets.skill_groups]
        == [["Cloud (AWS, GCP, Azure)", "Terraform", "Pulumi"]]
    and "Cloud (AWS, GCP, Azure)" in _ns_brackets.skills
    and not any(s.count("(") != s.count(")") for s in _ns_brackets.skills),
    str([g.items for g in _ns_brackets.skill_groups]) + " / " + str(_ns_brackets.skills),
)

_grouped = resume.model_copy(deep=True)
_grouped.skill_groups = [
    _SkillGroup(label="AI & LLMs", items=["OpenAI API", "LangChain"]),
    _SkillGroup(label="Backend & Data", items=["Python", "PostgreSQL"]),
]
_grouped.skills = list(_grouped.skills) + ["OpenAI API", "LangChain", "PostgreSQL"]
_grouped_he = _he_full.model_copy(deep=True)
_grouped_he.skill_groups = [
    _SkillGroup(label="בינה מלאכותית", items=["OpenAI API", "LangChain"]),
    _SkillGroup(label="בקאנד ונתונים", items=["Python", "PostgreSQL"]),
]
_grouped_he.skills = list(_grouped_he.skills) + ["OpenAI API", "LangChain", "PostgreSQL"]

# Both renderers, both skills treatments (chips and the inline comma run), both
# languages. `classic` sets skills="chips"; `executive` sets skills="inline".
for _gt in ("classic", "executive"):
    _g_pdf = _re.sub(r"\s+", " ", _pdf_text(render_pdf(_grouped, template=_gt)))
    _g_docx = _re.sub(r"\s+", " ", _li_extract_text("resume.docx", render_docx(_grouped, template=_gt)))
    check(
        f"grouped skills[{_gt}]: every label and every item survives extraction "
        f"in BOTH downloads",
        all(v in _g_pdf and v in _g_docx
            for v in ("AI & LLMs", "Backend & Data", "OpenAI API", "PostgreSQL",
                      _grouped.skills[0])),
        _g_pdf[:200],
    )
    _gh_pdf = _pdf_text(render_pdf(_grouped_he, template=_gt))
    _gh_docx = _li_extract_text("resume.docx", render_docx(_grouped_he, template=_gt))
    check(
        f"grouped skills[{_gt}] he: hebrew labels render right-to-left in the PDF "
        f"and intact in the DOCX, latin items untouched",
        _get_display("בינה מלאכותית", base_dir="R") in _gh_pdf and "OpenAI API" in _gh_pdf
        and "בינה מלאכותית" in _gh_docx and "OpenAI API" in _gh_docx,
    )

# The x-ray is the executable version of "nothing is hidden": it renders the
# file, re-reads it with our own parser and reports every protected fact.
_gx = xray(_grouped, "classic", "pdf")
check(
    "x-ray: a grouped résumé still recovers every skill from the rendered PDF — "
    "the grouping changed the presentation, not the content",
    not [f for f in _gx.facts if f.kind == "skill" and f.status == "missing"],
    str([f.value for f in _gx.facts if f.kind == "skill" and f.status == "missing"]),
)

# The last-resort trim removes a skill from the flat list AND its group. Leaving
# it in the group would resurrect it on the next JSON round-trip (the model
# re-establishes the union), so the trim would silently do nothing.
from app.core.length_budget import _drop_unmatched_skill as _dus  # noqa: E402
from app.models import JDModel as _SgJD  # noqa: E402

_trim_src = ResumeModel(skill_groups=[
    _SkillGroup(label="Backend", items=["Python", "COBOL on a mainframe"]),
])
_trimmed = _dus(_trim_src, _SgJD(hard_skills=["Python"], keywords=["Python"]))
check(
    "length budget: dropping a skill drops it from its GROUP too, so it does not "
    "come back when the résumé round-trips through JSON",
    _trimmed is not None
    and "COBOL on a mainframe" not in _trimmed.skills
    and "COBOL on a mainframe" not in ResumeModel.model_validate(_trimmed.model_dump()).skills,
    str(_trimmed.skills if _trimmed else None) + " / " + str(_trimmed.skill_groups if _trimmed else None),
)

# The structurer is where grouping enters the app, so the stub has to route it —
# the rule that every LLM task carries a stub branch is what this suite exists
# to guard.
check(
    "STRUCTURE prompt asks for skill_groups and still pins `skills` as the flat "
    "list (Task tag unmoved)",
    "skill_groups" in _li_prompts.STRUCTURE_RESUME_SYSTEM
    and _li_prompts.STRUCTURE_RESUME_SYSTEM.startswith("Task: STRUCTURE_RESUME."),
)
_sg_src = structure_resume(
    "Dana Levi\nSkills\nAI & LLMs: OpenAI API, LangChain, RAG pipelines\n"
    "Backend & Data: Python, PostgreSQL\nEmail: dana@example.com\n"
)
check(
    "structurer: a CV that groups its skills keeps the grouping, and every "
    "grouped item lands in the flat list",
    [g.label for g in _sg_src.skill_groups] == ["AI & LLMs", "Backend & Data"]
    and {"OpenAI API", "LangChain", "RAG pipelines", "Python", "PostgreSQL"} <= set(_sg_src.skills),
    str([(g.label, g.items) for g in _sg_src.skill_groups]),
)
check(
    "structurer: a CV that lists skills flat gets NO invented groups — a "
    "one-value 'Email: ...' line is not a skill group",
    resume.skill_groups == [] and structure_resume("Jane Roe\nEngineer").skill_groups == [],
)

# One page is the convention this product ships for. A résumé that overflows by
# a few lines is compressed until it fits; one that is genuinely long is left to
# break naturally rather than squeezed into illegibility.
from app.render.pdf_renderer import fit_squeeze  # noqa: E402
from app.render.templates import get_template as _get_tpl  # noqa: E402

_fit_spec = _get_tpl(DEFAULT_TEMPLATE)


def _pdf_pages(b: bytes) -> int:
    with _pdfplumber.open(_io.BytesIO(b)) as pdf:
        return len(pdf.pages)


# Grow the résumé a bullet at a time until it is the first size that no longer
# fits — the near-miss the squeeze exists for. Self-calibrating, so changing the
# fixture above cannot silently turn this check into a no-op.
_long = resume.model_copy(deep=True)
while fit_squeeze(_long, _fit_spec, rtl=False) == 1.0 and len(_long.experience[0].bullets) < 200:
    _long.experience[0].bullets.append("Shipped an internal tool the whole team now uses daily.")
_long_squeeze = fit_squeeze(_long, _fit_spec, rtl=False)
check(
    "fit: a résumé that overflows slightly is squeezed onto one page",
    _long_squeeze < 1.0 and _pdf_pages(render_pdf(_long)) == 1,
    f"squeeze={_long_squeeze:.3f} bullets={len(_long.experience[0].bullets)}",
)
_huge = resume.model_copy(deep=True)
_huge.experience = [resume.experience[0].model_copy(deep=True) for _ in range(25)]
check(
    "fit: a genuinely long résumé is left at full size and flows onto more pages",
    fit_squeeze(_huge, _fit_spec, rtl=False) == 1.0 and _pdf_pages(render_pdf(_huge)) > 1,
)
check(
    "fit: a short résumé is never stretched",
    fit_squeeze(resume, _fit_spec, rtl=False) == 1.0,
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
        _cron.status_code == 200
        and _cron.json() == {"users": 0, "results": [], "skipped": 0},
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

    # --- users.last_seen_at: stamped by the GATE, not by a route -----------
    # Exists because `usage_log` could not answer "has this person ever opened
    # it": admins write no action rows at all, and the deterministic routes are
    # deliberately uncapped so they write nothing either.
    from app.db.models import User as _SeenUser  # noqa: E402

    def _seen(uid):
        _d = SessionLocal()
        try:
            return _d.get(_SeenUser, uid).last_seen_at
        finally:
            _d.close()

    def _clear_seen(uid):
        """Reset so the next request is outside SEEN_THROTTLE — otherwise every
        check after the first one passes for the wrong reason."""
        _d = SessionLocal()
        try:
            _d.get(_SeenUser, uid).last_seen_at = None
            _d.commit()
        finally:
            _d.close()

    check(
        "a freshly minted user reads UNKNOWN, not 'never visited'",
        _mint.json()["last_seen_at"] == "",
        _mint.json().get("last_seen_at"),
    )
    check("a real request stamps last_seen_at", _seen(_friend_id) is not None)

    _t1 = _seen(_friend_id)
    _tc.get("/applications", headers=_FRIEND_H)
    check(
        # `is not None` is load-bearing: with the stamp dead both reads are
        # None, they compare equal, and this passes by never firing.
        "a second request inside the throttle does NOT rewrite it",
        _t1 is not None and _seen(_friend_id) == _t1,
        f"{_t1} -> {_seen(_friend_id)}",
    )

    # THE placement pin. The gate runs before routing, so an unknown path still
    # stamps; a `Depends(current_user)` implementation could never do this, and
    # would silently re-open the /tools/* blind spot this column exists to close.
    _clear_seen(_friend_id)
    _r404 = _tc.get("/no-such-route-at-all", headers=_FRIEND_H)
    check(
        "an unrouted path still stamps (proves the stamp is in the middleware)",
        _r404.status_code == 404 and _seen(_friend_id) is not None,
        f"status {_r404.status_code}",
    )

    # False-positive half: a guard that stamps on a REJECTED code would report
    # visits that never happened. "Make it stamp" is otherwise trivially
    # satisfied by stamping unconditionally.
    _clear_seen(_friend_id)
    check(
        "a rejected access code stamps nobody",
        _tc.get("/applications", headers={"X-App-Key": "not-a-code"}).status_code == 401
        and _seen(_friend_id) is None,
    )
    _tc.get("/applications", headers=_FRIEND_H)  # restore for later sections

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

    # "Save for later" from a search result: the shape the Jobs card posts. It
    # has no tailored résumé and no cover letter BY DEFINITION — that is what
    # saving a job you have not acted on yet means — and it must land as
    # `saved`, the one status `hideApplied` deliberately does not hide. The
    # frontend wrapper used to type both as required, over-constraining the
    # schema it wraps; this pins the schema so it cannot drift back.
    _saved_row = _tc.post(
        "/applications",
        json={
            "job_title": "Saved For Later", "company": "LaterCo",
            "jd_text": "Python and SQL work.", "overall_score": 76.0,
            "job_url": "https://later.test/job-1",
        },
        headers=_ADMIN_H,
    )
    check(
        "save for later: a job saves with no tailored résumé and defaults to 'saved'",
        _saved_row.status_code == 200
        and _saved_row.json()["status"] == "saved"
        and _saved_row.json()["job_url"] == "https://later.test/job-1",
        f"{_saved_row.status_code} {str(_saved_row.json())[:120]}",
    )
    check(
        "save for later: the saved job comes back on the tracker to return to",
        any(
            r["job_title"] == "Saved For Later" and r["status"] == "saved"
            for r in _tc.get("/applications", headers=_ADMIN_H).json()
        ),
    )

    # Outcome feedback loop (PLAN 17.3): the tracker records WHAT WAS SENT, so
    # the analytics can attribute replies to a résumé instead of guessing. The
    # unknown case is the one that matters — an old row must stay unknown, not
    # become "guard-clean with a voice score of zero".
    _sent = _tc.post(
        "/applications",
        json={
            "job_title": "Backend Dev", "company": "SentCo", "status": "applied",
            "overall_score": 81.0, "template": "executive",
            "voice_score": 94.5, "fabrication_flag_count": 0,
        },
        headers=_ADMIN_H,
    ).json()
    check(
        "17.3: template + voice score + flag count round-trip onto the tracker row",
        _sent["template"] == "executive"
        and _sent["voice_score"] == 94.5
        and _sent["fabrication_flag_count"] == 0,
        str(_sent),
    )
    _unknown = _tc.post(
        "/applications",
        json={"job_title": "Legacy", "company": "OldCo", "status": "applied"},
        headers=_ADMIN_H,
    ).json()
    check(
        "17.3: a row that did not report what it sent stays unknown, never zero",
        _unknown["template"] == ""
        and _unknown["voice_score"] is None
        and _unknown["fabrication_flag_count"] is None,
        str(_unknown),
    )
    check(
        "17.3: the fields survive the list endpoint too (what the analytics reads)",
        any(
            a["id"] == _sent["id"] and a["voice_score"] == 94.5 and a["template"] == "executive"
            for a in _tc.get("/applications", headers=_ADMIN_H).json()
        ),
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

    # /profile/me + close-my-account (PLAN 23.5 — the Settings account surface).
    # Minted FRESH, not reusing the friend: the revoke check a few lines below
    # deactivates that friend, so closing them here would leave that check
    # passing for the wrong reason — the 21.7 failure mode.
    _quit = _tc.post(
        "/admin/users", json={"name": "Yael", "email": "yael@example.com"}, headers=_ADMIN_H
    ).json()
    _QUIT_H = {"X-App-Key": _quit["invite_code"]}
    _me = _tc.get("/profile/me", headers=_QUIT_H)
    check(
        "/profile/me returns the caller, not the admin the gate falls back to",
        _me.status_code == 200
        and _me.json() == {"name": "Yael", "email": "yael@example.com", "is_admin": False},
        _me.text[:200],
    )
    check(
        "/profile/me flags an admin, so Settings can disable Close-my-account",
        _tc.get("/profile/me", headers=_ADMIN_H).json().get("is_admin") is True,
    )
    check(
        # MeOut is not UserOut for this reason: the code would land in every
        # screenshot and error report of the settings page.
        "/profile/me never echoes the invite code back into a page body",
        "invite_code" not in _me.json(),
        str(_me.json()),
    )
    _close_admin = _tc.request("DELETE", "/profile/account", headers=_ADMIN_H)
    check(
        "admin can't close their own account, and is told which door to use",
        _close_admin.status_code == 400 and "Delete all my data" in _close_admin.text,
        _close_admin.text[:200],
    )
    _tc.put("/profile/resume", json={"resume": _resume_json, "label": "Yael CV"}, headers=_QUIT_H)
    _tc.post("/applications", json={"job_title": "SRE", "company": "QuitCo"}, headers=_QUIT_H)
    _close = _tc.request("DELETE", "/profile/account", headers=_QUIT_H)
    check(
        "closing an account wipes the same rows AND reports the deactivation",
        _close.status_code == 200
        and _close.json()["deactivated"] is True
        and _close.json()["data"]["resumes"] == 1
        and _close.json()["data"]["applications"] == 1,
        _close.text[:250],
    )
    check(
        "a closed account's code stops opening the gate",
        _tc.get("/applications", headers=_QUIT_H).status_code == 401,
    )
    check(
        # The half that keeps the two doors genuinely different — and it is what
        # the privacy copy promises verbatim ("Your access code keeps working").
        "delete-my-data still leaves the code working",
        _tc.request("DELETE", "/profile/data", headers=_FRIEND_H).status_code == 200
        and _tc.get("/applications", headers=_FRIEND_H).status_code == 200,
    )
    # The user-content COLUMNS on the row the wipe deliberately keeps. Every
    # other check above counts TABLES, and that is exactly how these two hid:
    # `writing_prefs_json` is quoted out of the user's own tailored bullets and
    # goes straight back into the next TAILOR prompt, `search_prefs_json`
    # prefills the Jobs panel with their job title and location. Set FIRST and
    # asserted set, then wiped: an "is empty" check alone passes on a user who
    # never saved either, which is the 21.7 failure mode — a guard green
    # because it never fired.
    _tc.put(
        "/jobs/search-prefs",
        json={"context": {"job_title": "SRE", "location": "Tel Aviv"}},
        headers=_FRIEND_H,
    )
    _tc.post(
        "/profile/writing-prefs",
        json={"rejected": ["spearheaded a paradigm shift"]},
        headers=_FRIEND_H,
    )
    _prefs_armed = (
        _tc.get("/jobs/search-prefs", headers=_FRIEND_H).json().get("context") is not None
        and _tc.get("/profile/writing-prefs", headers=_FRIEND_H).json()["avoid"] != []
    )
    _tc.request("DELETE", "/profile/data", headers=_FRIEND_H)
    check(
        "the wipe clears the prefs columns on the surviving user row",
        _prefs_armed
        and _tc.get("/jobs/search-prefs", headers=_FRIEND_H).json().get("context") is None
        and _tc.get("/profile/writing-prefs", headers=_FRIEND_H).json()["avoid"] == [],
        f"armed={_prefs_armed}",
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
_cron_results, _cron_skipped = run_all_alerts(_db3, search_fn=_canned_search)
check(
    "cron loop runs every enabled user's alert",
    len(_cron_results) == 2 and _cron_skipped == 0,
    f"{len(_cron_results)} ran, {_cron_skipped} skipped",
)
# Keyed by user_id, not by position: since PLAN 20.5/C2 the cron runs
# longest-unrun-first, so the admin (who already used "Run now" above) now comes
# AFTER dana. The outcome per user is what this check was ever about.
_by_user = {r.user_id: r for r in _cron_results}
check(
    "per-user diff: admin saw these urls before, dana never did",
    _by_user[_admin_id].new_count == 0 and _by_user[_dana.id].new_count == 2,
    str([(r.user_id, r.new_count, r.error) for r in _cron_results]),
)
check(
    "each cron result says which user it belongs to",
    set(_by_user) == {_admin_id, _dana.id},
    str(sorted(_by_user)),
)
check(
    "dana's run recorded into dana's own history",
    len(list_search_hits(_db3, _dana.id)) == 2
    and all(h.user_id == _dana.id for h in list_search_hits(_db3, _dana.id)),
)

# 19b-2. The cron's time budget + fair rotation (PLAN 20.5/C2). One alert is a
# full fan-out plus up to 25 LLM calls, and Vercel kills a function at 300s —
# this used to be an unbounded list comprehension that simply died partway, with
# the users at the end of the list silently never getting their email.
from app.core.alerts import due_user_ids as _due_ids  # noqa: E402

_eli = mint_user(_db3, "Eli")
_db3.add(_SR(user_id=_eli.id, language="en", resume_json=resume.model_dump_json()))
_db3.commit()
update_alert(_db3, _eli.id, enabled=True, email="eli@example.com",
             context=_AlertCtx(job_title="Backend Engineer"))
check(
    "a never-run alert sorts ahead of ones that already ran",
    _due_ids(_db3)[0] == _eli.id,
    f"order={_due_ids(_db3)} eli={_eli.id}",
)

# A clock that jumps past the budget right after the first user.
_ticks = iter([0.0] + [10_000.0] * 50)
_budget_results, _budget_skipped = run_all_alerts(
    _db3, search_fn=_canned_search, budget_s=240, clock=lambda: next(_ticks)
)
check(
    "the cron stops on its time budget and reports what it didn't reach",
    len(_budget_results) == 1 and _budget_skipped == 2,
    f"{len(_budget_results)} ran, {_budget_skipped} skipped",
)
check(
    "whoever got skipped is first in line on the next tick",
    _due_ids(_db3)[0] != _eli.id and _eli.id not in _due_ids(_db3)[:1],
    f"eli ran, next order={_due_ids(_db3)}",
)
check(
    "budget <= 0 disables the limit (local dev runs everyone)",
    len(run_all_alerts(_db3, search_fn=_canned_search, budget_s=0,
                       clock=lambda: 10_000.0)[0]) == 3,
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


def _fake_stream_search(resume, customize, progress=None, cache=None, sightings_fn=None):  # noqa: ANN001 - matches search_jobs' shape
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

        def _broken_stream_search(resume, customize, progress=None, cache=None, sightings_fn=None):  # noqa: ANN001
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

    # PLAN 15.9: the checkboxes are authoritative at the full-search level too —
    # the worldwide pass must not resurrect an unchecked global board into the
    # fan-out (it used to, and it read as a bug to the actual user).
    _spy_calls: list[str] = []

    class _SpyGlobalBoard:
        name = WORLDWIDE_BOARD

        def search(self, ctx):  # noqa: ANN001
            _spy_calls.append(ctx.job_title)
            raise _NoRes("the unchecked global board must never be queried")

        def fetch_description(self, hit):  # noqa: ANN001
            return hit.description

    _real_ww = _PROV.get(WORLDWIDE_BOARD)
    _PROV[WORLDWIDE_BOARD] = _SpyGlobalBoard()
    try:
        _ww_res = _fan_search(
            resume,
            _AlertCtx(
                job_title="Python", sources=["fake_ok"], work_mode="remote",
                include_worldwide=True, max_age_days=0,
            ),
        )
        check(
            "15.9: worldwide opt-in never queries an unchecked global board",
            _spy_calls == [] and {m.source for m in _ww_res.matches} == {"fake_ok"},
            f"spy_calls={_spy_calls} sources={ {m.source for m in _ww_res.matches} }",
        )
    finally:
        if _real_ww is not None:
            _PROV[WORLDWIDE_BOARD] = _real_ww
        else:
            _PROV.pop(WORLDWIDE_BOARD, None)
finally:
    for _k in _fakes:
        _PROV.pop(_k, None)

# 21a. Relevance tiering through the full search path (PLAN 15.6): an old
# posting whose title matches the keywords is still scored and comes back
# marked stale; the fresh loosely-matched hit rides along unmarked.
class _StaleBoard:
    name = "fake_stale"

    def search(self, ctx):  # noqa: ANN001
        return [
            _FanHit(source=self.name, title="Python Developer", company="OldCo",
                    description="Python and SQL work", url="https://fake.stale/old",
                    posted_at="2020-01-01"),
            _FanHit(source=self.name, title="Bookkeeper", company="FreshCo",
                    description="Python mentioned in passing", url="https://fake.stale/fresh",
                    posted_at="2099-01-01"),
        ]

    def fetch_description(self, hit):  # noqa: ANN001
        return hit.description


_PROV["fake_stale"] = _StaleBoard()
try:
    _st = _fan_search(
        resume,
        _AlertCtx(job_title="Python Developer", sources=["fake_stale"], max_age_days=30),
    )
    _st_by_url = {m.url: m for m in _st.matches}
    check(
        "full search: old-but-relevant hit survives the age window marked stale",
        len(_st.matches) == 2
        and _st_by_url["https://fake.stale/old"].stale is True
        and _st_by_url["https://fake.stale/fresh"].stale is False,
        str([(m.url, m.stale) for m in _st.matches]),
    )
finally:
    _PROV.pop("fake_stale", None)

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

# 21c. The geo gate END TO END. The pure-function block above proves the
# classifier works and NOTHING about the verdict reaching the user, so this
# drives a purpose-built board through the real fan-out. A purpose-built
# fixture is mandatory rather than lazy: the shared job-search fakes produce no
# restricted posting, so a check written against them would pass by never
# firing (the x-ray lesson, twice over in this file).
from app.core.job_search import (  # noqa: E402
    CachedScore as _GeoCached,
    WORLDWIDE_BOARD as _GEO_WW,
    _geo_for,
)

_GEO_BLOCK_TXT = "Python and SQL. Applicants must be legally authorized to work in the United States."
_GEO_REGION_TXT = "Python and SQL. We are hiring across APAC."
_GEO_CLEAN_TXT = "Python and SQL work on a distributed backend."


def _geo_hit(slug: str, text: str) -> "_FanHit":
    # Distinct title AND company per posting: the fan-out ALSO dedupes by
    # content (title|company, PLAN 15.1), so a fixture whose postings share
    # both collapses into one row with the rest as also_on links — and the
    # check then passes by never firing.
    return _FanHit(
        source=_GEO_WW, title=f"Python Developer {slug}", company=f"GeoCo {slug}",
        description="" if _GEO_NEEDS_FETCH else text, url=f"https://geo.test/{slug}",
    )


_GEO_TEXTS = {
    "restricted": _GEO_BLOCK_TXT, "both": _GEO_BLOCK_TXT, "local": _GEO_BLOCK_TXT,
    "region": _GEO_REGION_TXT, "clean": _GEO_CLEAN_TXT,
}
# Flipped for the cache run below, so the descriptions stop being inline and a
# skipped fetch becomes observable. With them inline, `fetches` is 0 either way
# and the cache check would pass without the cache branch doing anything.
_GEO_NEEDS_FETCH = False


class _GeoBoard:
    """Registered UNDER the worldwide board's name, because the origin stamp is
    only ever applied to that board — a fake under any other name can never
    reach the classifier, which is the gate this section exists to pin."""

    name = _GEO_WW

    def __init__(self, mode: str = "mixed"):
        self.mode = mode
        self.fetches = 0

    def search(self, ctx):  # noqa: ANN001
        if ctx.location == "United States":
            if self.mode == "all_blocked":
                return [_geo_hit("restricted", _GEO_BLOCK_TXT)]
            return [
                _geo_hit("restricted", _GEO_BLOCK_TXT),
                _geo_hit("region", _GEO_REGION_TXT),
                _geo_hit("clean", _GEO_CLEAN_TXT),
                # Also returned by the LOCAL query below: visible from Israel,
                # so its stamp is cleared and it is never classified.
                _geo_hit("both", _GEO_BLOCK_TXT),
            ]
        if ctx.location == "Tel Aviv" and self.mode != "all_blocked":
            # Same US-only text, no worldwide origin: the gate must skip it.
            return [_geo_hit("local", _GEO_BLOCK_TXT), _geo_hit("both", _GEO_BLOCK_TXT)]
        return []

    def fetch_description(self, hit):  # noqa: ANN001
        self.fetches += 1
        return hit.description or _GEO_TEXTS[hit.url.rsplit("/", 1)[-1]]


check(
    "geo gate: only a worldwide-origin hit is classified, identical text or not",
    _geo_for(_FanHit(origin_market="", title="x"), _GEO_BLOCK_TXT, "United States") is None
    and (_geo_for(_FanHit(origin_market="United States", title="x"), _GEO_BLOCK_TXT, "") or _F).blocking
    is True,
)

_geo_ctx = _AlertCtx(
    job_title="Python Developer", location="Tel Aviv", work_mode="remote",
    include_worldwide=True, sources=[_GEO_WW], max_age_days=0,
)
_geo_real_board = _PROV.get(_GEO_WW)
_geo_board = _GeoBoard()
_PROV[_GEO_WW] = _geo_board
try:
    _gr = _fan_search(resume, _geo_ctx)
    _gr_by_url = {m.url: m for m in _gr.matches}
    check(
        "geo search: the restricted posting is dropped, the other four are ranked",
        len(_gr.matches) == 4
        and [f.url for f in _gr.filtered] == ["https://geo.test/restricted"]
        and (_gr.filtered[0].geo_restriction or _F).blocking is True
        and "authorized to work in the United States" in (_gr.filtered[0].geo_restriction or _F).raw,
        f"matched={sorted(_gr_by_url)} filtered={[f.url for f in _gr.filtered]}",
    )
    check(
        "geo search: a filtered posting does NOT inflate `skipped` (its string means unfetchable)",
        _gr.skipped == 0,
        str(_gr.skipped),
    )
    check(
        "geo search: the local hit carries the same US-only text and is NOT classified",
        _gr_by_url["https://geo.test/local"].geo_restriction is None,
    )
    check(
        "geo search: a posting the local query ALSO found keeps its stamp cleared",
        _gr_by_url["https://geo.test/both"].geo_restriction is None,
    )
    check(
        "geo search: a Tier-2 region note rides along on a ranked match, never filtered",
        (_g2 := _gr_by_url["https://geo.test/region"].geo_restriction) is not None
        and _g2.blocking is False and _g2.kind == "region"
        and _gr_by_url["https://geo.test/clean"].geo_restriction is None,
        str(_g2),
    )
    check(
        "geo search: a filtered posting carries no score, because none was ever computed",
        not hasattr(_gr.filtered[0], "overall")
        and _gr.filtered[0].title == "Python Developer restricted",
    )

    # The cache branch skips BOTH the fetch and the LLM, so nothing in it looks
    # like work — which is exactly why it is the branch that gets forgotten.
    _GEO_NEEDS_FETCH = True  # descriptions stop being inline, so a skipped fetch shows
    _geo_board.fetches = 0
    _geo_cache = {
        "https://geo.test/restricted": _GeoCached(
            jd_text=_GEO_BLOCK_TXT, overall=80.0, keyword_coverage=70.0, fit_score=90.0,
            top_matched=("Python",), top_gaps=(), title="Cached", company="GeoCo",
            location="United States", posted_at="", logo_url="", is_full_match=True,
        )
    }
    _gc = _fan_search(resume, _geo_ctx, cache=_geo_cache)
    check(
        "geo search: a full-match CACHED posting is still filtered (the branch is not a bypass)",
        [f.url for f in _gc.filtered] == ["https://geo.test/restricted"]
        and "https://geo.test/restricted" not in {m.url for m in _gc.matches}
        and _geo_board.fetches == 4,  # the other four still fetched; the filtered one did not
        f"filtered={[f.url for f in _gc.filtered]} fetches={_geo_board.fetches}",
    )

    # 100% filtered is the maximum-suspicion case and the one where the reveal
    # must survive: raising here would destroy the list and send the user to
    # re-run a search that fails identically.
    _PROV[_GEO_WW] = _GeoBoard(mode="all_blocked")
    _ga = _fan_search(resume, _geo_ctx)
    check(
        "geo search: an all-filtered search returns 200 with the list, and does not raise",
        _ga.matches == [] and len(_ga.filtered) == 1
        and (_ga.filtered[0].geo_restriction or _F).blocking is True,
        f"matches={len(_ga.matches)} filtered={len(_ga.filtered)}",
    )
finally:
    _GEO_NEEDS_FETCH = False
    if _geo_real_board is not None:
        _PROV[_GEO_WW] = _geo_real_board
    else:
        _PROV.pop(_GEO_WW, None)

# 21d. The market memory (PLAN 28.3). `posting_sightings` is the only thing in
# this app that can say how long a posting has REALLY been open: `job_search_hits`
# updates in place and bumps `searched_at` on every write, is capped at the newest
# 100 rows, and is per-user. Everything below drives the real table through the
# real session, because the two rules that matter here — read-before-write and the
# continuity reset — are orderings, and an ordering cannot be pinned by reading a
# function on its own.
from sqlalchemy import select as _gh_sel  # noqa: E402

from app.core.job_search import content_key as _gh_ckey  # noqa: E402
from app.db.models import PostingSighting as _GhSightRow  # noqa: E402
from app.db.sightings import (  # noqa: E402
    SIGHTING_GAP_DAYS as _GH_GAP,
    SIGHTING_RETENTION_DAYS as _GH_RETAIN,
    load_sightings as _gh_load_sightings,
    record_sightings as _gh_record_sightings,
)

_gh_db = SessionLocal()
_GH_T0 = _gh_dt(2026, 6, 1, 9, 0, 0)
_GH_KEY = ("linkedin", _gh_ckey("Backend Engineer", "SightCo"))


def _gh_match(url: str, title: str = "Backend Engineer", company: str = "SightCo") -> JobMatch:
    return JobMatch(title=title, company=company, url=url, source="linkedin")


try:
    # READ BEFORE WRITE. `search_jobs` reads the sightings on the main thread and
    # the CALLER records this run afterwards, beside `record_search_hits`.
    # Recording first would stamp every posting `first_seen_at = now` and then
    # hand it its own stamp straight back: every posting in every search would be
    # "first seen today", `long_open` could never fire, and the whole feature
    # would ship green and inert — the 21.7 failure mode. Both halves are driven
    # in the real order, and the classifier is asked the question the search asks
    # it, because "load returns {}" alone does not prove the badge stays off.
    _gh_before = _gh_load_sightings(_gh_db, [_GH_KEY], now=_GH_T0)
    _gh_first_report = _gh_detect(
        title="Backend Engineer", jd_text="Python and SQL.",
        sighting=_gh_before.get(_GH_KEY), url="https://sight.test/1", now=_GH_T0,
    )
    _gh_record_sightings(_gh_db, [_gh_match("https://sight.test/1")], _GH_T0)
    _gh_after = _gh_load_sightings(_gh_db, [_GH_KEY], now=_GH_T0)
    check(
        "sightings: a posting seen for the FIRST time carries no long_open in that same search",
        _gh_before == {}
        and _gh_first_report is None
        and _gh_after[_GH_KEY].first_seen_at == _GH_T0
        and _gh_after[_GH_KEY].seen_count == 1
        and _gh_after[_GH_KEY].relist_count == 0
        # …and the row it just wrote still yields nothing: 0 days is not 30.
        and _gh_detect(title="Backend Engineer", jd_text="Python and SQL.",
                       sighting=_gh_after[_GH_KEY], url="https://sight.test/1",
                       now=_GH_T0) is None,
        str(_gh_after.get(_GH_KEY)),
    )

    # A URL CHANGE INSIDE ONE RUN is exactly what `reposted` reads: same board,
    # same title+company, new listing id. `first_url` is written once and left
    # alone while `last_url` follows the board, and the classifier compares the
    # two — so this check drives the row AND the rule that consumes it, because a
    # row that records the change nobody reads is worth nothing.
    _gh_record_sightings(_gh_db, [_gh_match("https://sight.test/2")], _GH_T0 + _gh_td(days=1))
    _gh_relist = _gh_load_sightings(_gh_db, [_GH_KEY], now=_GH_T0 + _gh_td(days=1))[_GH_KEY]
    check(
        "sightings: first_url is written once, last_url follows the board, and reposted reads the gap",
        _gh_relist.first_url == "https://sight.test/1"
        and _gh_relist.seen_count == 2
        and _gh_relist.first_seen_at == _GH_T0
        and _gh_kinds(
            _gh_detect(title="Backend Engineer", jd_text="Python.", sighting=_gh_relist,
                       url="https://sight.test/2", now=_GH_T0 + _gh_td(days=1))
        ) == {"reposted": "weak"}
        # …and the SAME url on the same row is a posting that is simply still up.
        and _gh_detect(title="Backend Engineer", jd_text="Python.", sighting=_gh_relist,
                       url="https://sight.test/1", now=_GH_T0 + _gh_td(days=1)) is None,
        str(_gh_relist),
    )

    # THE CONTINUITY RESET. A role filled in March and relisted in September must
    # not report as "open 200 days" — a lie in the direction that costs the user a
    # real job, since `long_open` is what the card uses to say don't bother. A gap
    # longer than SIGHTING_GAP_DAYS ends the run: first_seen_at, first_url and
    # seen_count reset, and relist_count — which is real history and the point of
    # the table — goes UP rather than being cleared with them.
    _gh_late = _GH_T0 + _gh_td(days=1 + _GH_GAP + 2)
    _gh_record_sightings(_gh_db, [_gh_match("https://sight.test/9")], _gh_late)
    _gh_db.expire_all()
    _gh_row = _gh_db.execute(
        _gh_sel(_GhSightRow).where(_GhSightRow.content_key == _GH_KEY[1])
    ).scalars().one()
    check(
        f"sightings: a gap over {_GH_GAP} days resets first_seen_at and bumps relist_count",
        _gh_row.first_seen_at == _gh_late
        and _gh_row.first_url == "https://sight.test/9"
        and _gh_row.seen_count == 1
        and _gh_row.relist_count == 1
        # …and a relisted role is therefore NOT reported as open since June.
        and _gh_detect(title="Backend Engineer", jd_text="Python.",
                       sighting=_gh_load_sightings(_gh_db, [_GH_KEY], now=_gh_late)[_GH_KEY],
                       url="https://sight.test/9", now=_gh_late) is None,
        f"first_seen={_gh_row.first_seen_at} relist={_gh_row.relist_count} seen={_gh_row.seen_count}",
    )
    # The reset is applied ON READ too, so the pure classifier is handed a
    # Sighting that is already about the CURRENT run. A stale row loses the three
    # fields that would be false about the run now starting and keeps
    # relist_count; first_seen_at becomes None — unknown, never `now`, because the
    # row for this run has not been written yet.
    _gh_stale = _gh_load_sightings(_gh_db, [_GH_KEY], now=_gh_late + _gh_td(days=_GH_GAP + 1))[_GH_KEY]
    check(
        "sightings: the reset is applied on READ, so a stale row reports unknown rather than zero",
        _gh_stale.first_seen_at is None and _gh_stale.first_url == ""
        and _gh_stale.seen_count == 0 and _gh_stale.relist_count == 1,
        str(_gh_stale),
    )

    # THE 180-DAY PRUNE keeps growth bounded without a second cron to forget
    # about, and it cannot evict a posting that is still open: every search that
    # sees one stamps `last_seen_at = now`, so the sweep only ever reaches
    # postings that have been gone for half a year. Both halves are pinned — a
    # sweep that took the live row too would delete the market memory the whole
    # table exists to hold.
    _gh_record_sightings(
        _gh_db, [_gh_match("https://sight.test/old", title="Old Role", company="OldCo")], _GH_T0
    )
    _gh_sweep_at = _GH_T0 + _gh_td(days=_GH_RETAIN + 1)
    _gh_record_sightings(
        _gh_db, [_gh_match("https://sight.test/z", title="Zed Role", company="ZedCo")], _gh_sweep_at
    )
    _gh_db.expire_all()
    _gh_keys_left = {
        r.content_key for r in _gh_db.execute(_gh_sel(_GhSightRow)).scalars().all()
    }
    check(
        f"sightings: rows untouched for {_GH_RETAIN} days are pruned, and fresher ones survive",
        _gh_ckey("Old Role", "OldCo") not in _gh_keys_left
        and _gh_ckey("Zed Role", "ZedCo") in _gh_keys_left
        and _GH_KEY[1] in _gh_keys_left,
        str(sorted(_gh_keys_left)),
    )
finally:
    _gh_db.close()

# NO `user_id`, AND THAT IS THE ONE PRIVACY DECISION IN PHASE 28. A row here is
# metadata a BOARD published — which board, the title+company fingerprint, when
# we first and last saw it, its URLs, a count. Nothing in it is derived from a
# résumé or from anything the user typed, and several users searching the same
# market legitimately SHARE one row. So it must stay out of `_wipe_user_rows`,
# which deletes `WHERE model.user_id == user.id`: wiping this table on any other
# key would destroy market memory OTHER users' searches wrote while saying
# nothing whatsoever about the person leaving.
#
# Both halves are pinned because either alone is satisfiable the wrong way. The
# COLUMN check is what makes the decision structural rather than a convention —
# add `user_id` and the helper below can express the delete, and the next person
# to read the wipe rule will add it. Inspected off the mapped table, not the
# source, so a column added through any spelling is seen.
import inspect as _ghw_inspect  # noqa: E402

from app.api import routes as _ghw_routes  # noqa: E402

_GH_WIPE_SRC = _ghw_inspect.getsource(_ghw_routes._wipe_user_rows)
check(
    "sightings: the table has NO user_id, so the privacy wipe cannot even express it",
    "user_id" not in {c.name for c in _GhSightRow.__table__.columns}
    and not hasattr(_GhSightRow, "user_id")
    and "PostingSighting" not in _GH_WIPE_SRC
    and "posting_sighting" not in _GH_WIPE_SRC
    # the helper is genuinely the wipe we think it is — a renamed function would
    # otherwise make this pass by scanning the wrong source
    and "SavedResume" in _GH_WIPE_SRC and "JobSearchHit" in _GH_WIPE_SRC,
    str(sorted(c.name for c in _GhSightRow.__table__.columns)),
)

# 21e. The ghost gate END TO END. Section 14c proves the classifier works and
# NOTHING about the verdict reaching the user, so this drives a purpose-built
# board through the real fan-out — the same reason 21c does, and the same
# purpose-built fixture rule: the shared job-search fakes produce no ghost, so a
# check written against them would pass by never firing.
#
# Registered under an ORDINARY board name, not `WORLDWIDE_BOARD`. That is the
# gate difference this section exists to pin: `_geo_for` is gated on
# `origin_market`, `_ghost_for` deliberately is not, because a ghost posting is a
# primary-market problem and gating it would disable the detector for every user
# who never turns the worldwide opt-in on — i.e. for the default search.
_GH_CLOSED_TXT = "Python and SQL. Backend work on a distributed platform."
_GH_POOL_TXT = "Python and SQL. Send us your CV and we will be in touch."
_GH_CLEAN_TXT = "Python and SQL work on a distributed backend."
_GH_BOARD_TEXTS = {"dead": _GH_CLOSED_TXT, "pool": _GH_POOL_TXT, "clean": _GH_CLEAN_TXT}
# Distinct title AND company per posting: the fan-out dedupes by content
# (title|company, PLAN 15.1), so a fixture whose postings share both collapses
# into one row and the check passes by never firing.
_GH_BOARD_CARDS = {
    "dead": ("Python Developer dead", "GhostCo dead"),
    "pool": ("Talent Pool - Python pool", "GhostCo pool"),
    "clean": ("Python Developer clean", "GhostCo clean"),
}


def _gh_hit(slug: str) -> "_FanHit":
    # `description` is EMPTY on purpose. `hit.closed` is a side effect of
    # `fetch_description`, and `_build_match` short-circuits the fetch whenever
    # the board inlined its text — so an inline fixture would make closure
    # unobservable and the filter check would pass without the gate existing.
    title, company = _GH_BOARD_CARDS[slug]
    return _FanHit(source="fake_ghost", title=title, company=company,
                   description="", url=f"https://ghost.test/{slug}")


class _GhostBoard:
    """A board with one dead posting, one talent pool and one ordinary job.

    `fetch_description` sets `hit.closed` for the dead one exactly as
    `LinkedInProvider.fetch_description` does — evidence text on the hit, with
    the description still returned, because a closed guest page serves its body
    untouched and "dead" and "no text" do not imply each other in either
    direction."""

    name = "fake_ghost"

    def __init__(self, slugs: tuple[str, ...] = ("dead", "pool", "clean")) -> None:
        self.slugs = slugs
        self.fetches = 0
        self.fetched: list[str] = []

    def search(self, ctx):  # noqa: ANN001
        return [_gh_hit(s) for s in self.slugs]

    def fetch_description(self, hit):  # noqa: ANN001
        slug = hit.url.rsplit("/", 1)[-1]
        self.fetches += 1
        self.fetched.append(slug)
        if slug == "dead":
            hit.closed = "No longer accepting applications"
        return _GH_BOARD_TEXTS[slug]


_gh_stub = _get_llm()
_gh_orig_cjson = _gh_stub.complete_json
_gh_llm_tasks: list[str] = []


def _gh_counting_cjson(system, user):  # noqa: ANN001
    _gh_llm_tasks.append(system[:40].upper())
    return _gh_orig_cjson(system, user)


def _gh_jdfit() -> int:
    return len([t for t in _gh_llm_tasks if "JD_FIT" in t])


# `sightings_fn` is what `search_jobs` calls once, on the main thread, before the
# scoring pool starts. Handing back a 90-day-old sighting for the CLEAN posting
# is how `long_open` is driven end to end without a clock: `search_jobs` builds
# its own `now` from the wall clock, so the fixture is anchored to the wall clock
# too. Note the caller swallows anything this raises (bookkeeping may never turn
# a served request into an error) — so a broken fixture here would silently
# produce no signal, which is why the check asserts the signal ARRIVED rather
# than that the function was called.
_gh_sfn_keys: list = []
_GH_OLD_SEEN = _gh_dt.now() - _gh_td(days=90)


def _gh_sightings_fn(keys):  # noqa: ANN001
    _gh_sfn_keys.append(list(keys))
    ck = _gh_ckey(*_GH_BOARD_CARDS["clean"])
    return {("fake_ghost", ck): _GhSighting(
        first_seen_at=_GH_OLD_SEEN, first_url="https://ghost.test/clean", seen_count=12,
    )}


_gh_ctx = _AlertCtx(job_title="Python Developer", sources=["fake_ghost"], max_age_days=0)
_gh_board = _GhostBoard()
_PROV["fake_ghost"] = _gh_board
_gh_stub.complete_json = _gh_counting_cjson
try:
    _ghr = _fan_search(resume, _gh_ctx, sightings_fn=_gh_sightings_fn)
    _ghr_by_url = {m.url: m for m in _ghr.matches}
    _ghr_filtered = {f.url: f for f in _ghr.filtered}
    # Bound before the check, never by a walrus inside it — see the note in 14c:
    # a name the and-chain short-circuits past makes the `extra` f-string raise
    # and aborts every check after it.
    _ghd = _ghr_filtered.get("https://ghost.test/dead")
    _ghf = _ghd.ghost if _ghd else None
    check(
        "ghost search: a posting the BOARD says is closed is filtered, carrying its own words",
        [f.url for f in _ghr.filtered] == ["https://ghost.test/dead"]
        and _ghd is not None and _ghd.reason == "closed"
        and _ghf is not None and _ghf.closed is True
        and _gh_sig0(_ghf).kind == "closed" and _gh_sig0(_ghf).strength == "certain"
        and _gh_sig0(_ghf).raw == "No longer accepting applications"
        # …and it carries no geo verdict, because nothing geographic fired: the
        # two lists answer different questions and `reason` is what says which.
        and _ghd.geo_restriction is None,
        f"filtered={[(f.url, f.reason) for f in _ghr.filtered]} ghost={_ghf}",
    )
    # Pinned right beside the geo twin above, which says the same thing for the
    # same reason: `skipped` means "listings found but NOT FETCHABLE/scorable",
    # and a closed posting was fetchable — more so than any other row here, since
    # we know it is closed BECAUSE we fetched it and the board said so. Folding it
    # into `skipped` would tell the user the boards were throttling us at the exact
    # moment we had the clearest possible answer from one.
    check(
        "ghost search: a closed posting does NOT inflate `skipped` (its string means unfetchable)",
        _ghr.skipped == 0 and len(_ghr.matches) == 2,
        f"skipped={_ghr.skipped} matched={sorted(_ghr_by_url)}",
    )
    # ZERO LLM CALLS for the dropped posting. The gate sits before
    # `analyze_and_score` for exactly the reason the geo gate does: it is the only
    # seam where every code path holds the text and no model call has been made.
    # Made observable the way 21c makes a skipped fetch observable — a count, not
    # an inference: three hits were fetched, two were scored.
    check(
        "ghost search: the closed posting is fetched and then costs ZERO scoring LLM calls",
        _gh_board.fetches == 3 and sorted(_gh_board.fetched) == ["clean", "dead", "pool"]
        and _gh_jdfit() == 2,
        f"fetches={_gh_board.fetched} jd_fit={_gh_jdfit()} llm={_gh_llm_tasks}",
    )
    # A SOFT SIGNAL IS A BADGE, NEVER A FILTER. `likely` is a suspicion and the
    # posting still ranks with its evidence attached — the same contract the
    # Tier-2 geo region note keeps one section up. Two independent mechanisms are
    # pinned here so a regression in either shows: the talent-pool TITLE (text)
    # and the 90-day sighting (`sightings_fn`, i.e. the market memory reaching the
    # search at all).
    _ghp_m = _ghr_by_url.get("https://ghost.test/pool")
    _ghp = _ghp_m.ghost if _ghp_m else None
    check(
        "ghost search: an evergreen title RANKS and carries its ghost, never filtered",
        _ghp is not None and _ghp.closed is False and _ghp.likely is True
        and _gh_kinds(_ghp) == {"evergreen": "strong"}
        and "Talent Pool" in _gh_sig0(_ghp).raw,
        str(_ghp),
    )
    _ghl_m = _ghr_by_url.get("https://ghost.test/clean")
    _ghl = _ghl_m.ghost if _ghl_m else None
    check(
        "ghost search: the market memory reaches the classifier — long_open on a ranked match",
        bool(_gh_sfn_keys)
        and ("fake_ghost", _gh_ckey(*_GH_BOARD_CARDS["clean"])) in _gh_sfn_keys[0]
        and _ghl is not None and _gh_kinds(_ghl) == {"long_open": "strong"}
        and _gh_sig0(_ghl).basis == "first_seen" and _gh_sig0(_ghl).days >= 89,
        f"keys={_gh_sfn_keys[0] if _gh_sfn_keys else None} ghost={_ghl}",
    )

    # THE CACHE BRANCH IS NOT A BYPASS. It skips the fetch AND the LLM, so nothing
    # in it looks like work — which is exactly why it is the branch that gets
    # forgotten, and why the geo section pins the same thing one screen up. The
    # wording rules read fine off cached text and `long_open` only gets stronger
    # with age, so a posting scored last week must not launder through
    # unclassified.
    _gh_board_c = _GhostBoard()
    _PROV["fake_ghost"] = _gh_board_c
    _gh_llm_tasks.clear()
    _gh_cache = {
        f"https://ghost.test/{slug}": _GeoCached(
            jd_text=_GH_BOARD_TEXTS[slug], overall=80.0, keyword_coverage=70.0, fit_score=90.0,
            top_matched=("Python",), top_gaps=(), title=_GH_BOARD_CARDS[slug][0],
            company=_GH_BOARD_CARDS[slug][1], location="Tel Aviv", posted_at="",
            logo_url="", is_full_match=True,
        )
        for slug in ("dead", "pool")
    }
    _ghc = _fan_search(resume, _gh_ctx, cache=_gh_cache, sightings_fn=_gh_sightings_fn)
    _ghc_by_url = {m.url: m for m in _ghc.matches}
    _ghcp_m = _ghc_by_url.get("https://ghost.test/pool")
    _ghcp = _ghcp_m.ghost if _ghcp_m else None
    check(
        "ghost search: a full-match CACHED posting is still classified (the branch is not a bypass)",
        _ghcp is not None and _gh_kinds(_ghcp) == {"evergreen": "strong"}
        and _gh_board_c.fetched == ["clean"]  # the two cached ones never fetched
        and _gh_jdfit() == 1,
        f"fetched={_gh_board_c.fetched} jd_fit={_gh_jdfit()} ghost={_ghcp}",
    )
    # THE HONEST GAP, pinned as a gap rather than papered over. `hit.closed` is set
    # by `fetch_description`, which is precisely what this branch skips, so a
    # posting that died since it was last scored still RANKS here with no closed
    # signal. It is deliberately not fixed with a liveness fetch: this branch's
    # whole purpose is not fetching (PLAN 12.4 — zero LLM calls, zero network), and
    # a HEAD per cached hit would spend the exact budget the cache exists to save
    # on every search. The cache TTL is the bound on how stale this can get.
    #
    # Written as an assertion so it goes RED the day someone closes it — at which
    # point this check is the thing that says the comment above is now a lie.
    check(
        "ghost search: KNOWN GAP — the cache branch cannot observe closure, and does not pretend to",
        "https://ghost.test/dead" in _ghc_by_url
        and (_ghc_by_url["https://ghost.test/dead"].ghost is None
             or _ghc_by_url["https://ghost.test/dead"].ghost.closed is False)
        and "dead" not in _gh_board_c.fetched
        and [f.url for f in _ghc.filtered] == [],
        f"ranked={sorted(_ghc_by_url)} filtered={[f.url for f in _ghc.filtered]}",
    )

    # 100% closed is the maximum-suspicion case, and the reveal must survive it:
    # raising here would destroy the list and send the user to re-run a search that
    # fails identically. `search_jobs` states no reason of its own — the response
    # carries `filtered[i].reason` and the UI switches on it — so a morning where
    # every posting had closed must not be reported as a hiring restriction.
    _PROV["fake_ghost"] = _GhostBoard(slugs=("dead",))
    _gh_llm_tasks.clear()
    # CAUGHT, not left to propagate. "does not raise" is half of what this check
    # asserts, and an uncaught raise here would abort the process — turning one
    # red check into 200 that silently never ran, with the traceback saying
    # nothing about the rest. Reproduced while probing: drop the `closed` arm of
    # `filter_reasons` and this call raises the board-throttling error instead.
    _gha, _gha_err = None, ""
    try:
        _gha = _fan_search(resume, _gh_ctx, sightings_fn=_gh_sightings_fn)
    except Exception as _gha_e:  # noqa: BLE001
        _gha_err = f"{type(_gha_e).__name__}: {_gha_e}"
    check(
        "ghost search: an all-closed search returns 200 with the list, and never says 'restriction'",
        _gha_err == "" and _gha is not None
        and _gha.matches == [] and len(_gha.filtered) == 1
        and _gha.filtered[0].reason == "closed"
        and _gha.filtered[0].geo_restriction is None
        and _gh_jdfit() == 0,
        _gha_err or f"matches={len(_gha.matches)} "
        f"filtered={[(f.url, f.reason) for f in _gha.filtered]} jd_fit={_gh_jdfit()}",
    )
finally:
    _gh_stub.complete_json = _gh_orig_cjson
    _PROV.pop("fake_ghost", None)

# 22. Batch auto-tailor kits (PLAN 8.1): enqueue high-fit jobs, drain the
# queue one tailor per request (the serverless-safe loop), guard flags mark
# kits never-auto-approvable, caps charged upfront, per-user isolation.
from datetime import datetime as _dt, timedelta as _td  # noqa: E402

from sqlalchemy import select as _ksel  # noqa: E402

from app.core import kits as _kits_mod  # noqa: E402
from app.core.kits import (  # noqa: E402
    _sent_signals,
    enqueue_kits as _enqueue_kits,
    process_next_kit as _process_next,
)
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
    # 17.3 on the kit path: the signals come off the kit's stored result, and
    # `template` stays unknown because kit review never offers a choice.
    _kit_app_out = next(
        a for a in _tc.get("/applications", headers=_KIM_H).json()
        if a["id"] == _apr.json()["application_id"]
    )
    check(
        "17.3: approving a kit carries its voice score + flag count onto the tracker row",
        _kit_app_out["voice_score"] is not None
        and _kit_app_out["fabrication_flag_count"] is not None
        and _kit_app_out["template"] == "",
        str(_kit_app_out),
    )
    check(
        "17.3: a kit written before the voice audit reports unknown, not the schema default",
        _sent_signals('{"tailored_resume": {}}') == (None, None)
        and _sent_signals("not json") == (None, None)
        and _sent_signals('{"voice_report": {"human_voice_score": 88.0}, "fabrication_flags": []}')
        == (88.0, 0),
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

# Kits must NOT re-derive a geo verdict. A backstop here was written and
# removed: it classified every job with no gate, while `search_jobs` gates on
# `JobHit.origin_market` — so a LinkedIn posting the user's OWN location query
# returned was ranked with no badge and then REFUSED by "Application kit" with a
# 400 saying it states a hiring restriction abroad, and an Israeli-board job
# needing an Israeli clearance failed the same way. Two surfaces contradicting
# each other about one posting is the thing this codebase refuses.
_geo_kit_db = SessionLocal()
_geo_kit_user = _geo_kit_db.execute(_ksel(_KUser).where(_KUser.name == "Kim")).scalars().first()
_geo_charges: list[int] = []
try:
    _geo_queued, _ = _enqueue_kits(
        _geo_kit_db,
        _geo_kit_user,
        [
            _KitJob(title="US Only", url="https://kit.test/geo-blocked",
                    jd_text="Python work. Applicants must be authorized to work in the United States."),
            _KitJob(title="Fine", url="https://kit.test/geo-ok", jd_text=_KIT_JD),
        ],
        charge=_geo_charges.append,
    )
    check(
        "kits: a posting the search would rank is never refused for a geo reason here",
        [k.url for k in _geo_queued]
        == ["https://kit.test/geo-blocked", "https://kit.test/geo-ok"]
        and _geo_charges == [2],
        f"queued={[k.url for k in _geo_queued]} charges={_geo_charges}",
    )
    # Greps for an IMPORT or a CALL, not the bare name — the comment explaining
    # why the backstop was removed names the function, and that comment is the
    # thing most likely to stop someone re-adding it.
    _kits_src = _geo_inspect.getsource(_kits_mod)
    check(
        "kits: the module neither imports nor calls the geo classifier",
        len(_kits_src) > 2000
        and "from app.core.geo_restriction import" not in _kits_src
        and "detect_geo_restriction(" not in _kits_src,
        f"{len(_kits_src)} chars scanned",
    )
finally:
    _geo_kit_db.rollback()
    _geo_kit_db.close()

# Function level: a tailor that invents facts marks the kit flagged (never
# auto-approvable), and a crashed "running" kit is requeued after the timeout.
_dbk = SessionLocal()
_kim_row = _dbk.execute(_ksel(_KUser).where(_KUser.name == "Kim")).scalars().first()
_flag_rows, _ = _enqueue_kits(
    _dbk, _kim_row, [_KitJob(title="Flagged", url="https://kit.test/flagged", jd_text=_KIT_JD)]
)


def _flagging_tailor(resume, jd, ledger=None, **_kw):  # noqa: ANN001 - matches tailor_resume's shape
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


# Pure reCAPTCHA-detection pins (PLAN 14.5): a position page with
# RECAPTCHA_ENABLED=true is gated; false / fetch-failure ⇒ not gated.
check(
    "position_requires_recaptcha: true page gated, false page not, fetch error ⇒ false",
    _asub.position_requires_recaptcha("u", fetch=lambda u: "x RECAPTCHA_ENABLED = true; y") is True
    and _asub.position_requires_recaptcha("u", fetch=lambda u: "RECAPTCHA_ENABLED = false") is False
    and _asub.position_requires_recaptcha(
        "u", fetch=lambda u: (_ for _ in ()).throw(RuntimeError("net down"))
    ) is False,
)

_real_post, _real_token = _asub._default_post, _asub._resolve_token
_asub._default_post = _fake_apply_post
_asub._resolve_token = lambda db, ref: "TOK123"
# Default every submit in this block to a NON-reCAPTCHA position; the dedicated
# reCAPTCHA-refusal check below overrides it. (Real sends still fetch the page.)
_real_recaptcha = _asub.position_requires_recaptcha
_asub.position_requires_recaptcha = lambda url, fetch=None: False
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

    # PLAN 14.5: a reCAPTCHA-gated position refuses BEFORE charging the cap or
    # sending — the real 423 the DriveNets position returned, caught pre-flight.
    _recaptcha_kit = _TKit(
        user_id=_sub_row.id, status="approved", source="comeet", flag_count=0,
        company="DriveNets", url="https://www.comeet.com/jobs/drivenets/72.006/ai/6A.D68",
        application_id=None,
    )
    _dbs.add(_recaptcha_kit)
    _dbs.commit()
    _charged = []
    try:
        _asub.submit_kit(
            _dbs, _sub_row, _recaptcha_kit,
            charge=lambda: _charged.append(1),
            recaptcha_fn=lambda url: True,
        )
        check("reCAPTCHA-gated position is refused before send", False)
    except ValueError as _e:
        check(
            "reCAPTCHA-gated position refused pre-flight (no cap charge, no send)",
            "reCAPTCHA" in str(_e) and not _charged and len(_sent_apps) == 1,
            str(_e)[:120],
        )
    check(
        "guardrail refusals left no extra network sends",
        len(_sent_apps) == 1,
        str(len(_sent_apps)),
    )
    _dbs.close()
finally:
    _asub._default_post = _real_post
    _asub._resolve_token = _real_token
    _asub.position_requires_recaptcha = _real_recaptcha

# 23. CV humanization (spec): deterministic voice audit + HUMANIZE LLM pass.
# The audit hunts AI tells (banned buzzwords, repeated verbs/phrases, outcome
# clauses, JD echo, uniform bullets); the humanizer fixes wording and is only
# accepted when guard-clean AND the re-audit confirms improvement.
from app.core.humanizer import humanize_resume as _humanize  # noqa: E402
from app.core.voice_audit import audit_voice as _audit  # noqa: E402
from app.llm.client import get_llm_client as _get_client  # noqa: E402
from app.models import JDModel as _VJD  # noqa: E402

# An honest stub tailor result must audit clean — and the pipeline must carry
# the report on TailorResult.
check(
    "tailor result carries a clean voice report for plain writing",
    result.voice_report.human_voice_score == 100.0
    and result.voice_report.issues == []
    and result.voice_report.revised is False,
    str(result.voice_report),
)

# Seed a resume dripping with AI tells and a JD it plagiarizes.
_v_jd = _VJD(
    job_title="Software Engineer",
    keywords=["Python", "REST APIs"],
    hard_skills=["Python"],
    responsibilities=["Design and build scalable REST services for our analytics platform"],
    qualifications=["Proven experience with Python in production"],
)
_v_bad = resume.model_copy(deep=True)
_v_bad.summary = "Results-driven dynamic professional passionate about cutting-edge technology."
_v_bad.experience[0].bullets = [
    "Spearheaded development of internal tools, resulting in improved efficiency.",
    "Leveraged Python to streamline workflows, resulting in faster delivery.",
    "Developed dashboards to improve visibility.",
    "Developed reports to improve tracking.",
    "Developed and build scalable REST services for our analytics platform.",
]
_v_report = _audit(_v_bad, _v_jd)
_v_cats = {i.category for i in _v_report.issues}
check(
    "voice audit catches banned phrases",
    "banned_phrase" in _v_cats
    and any(i.value.lower().startswith("spearhead") for i in _v_report.issues),
    str([(i.category, i.value) for i in _v_report.issues]),
)
check(
    "voice audit catches repeated starting verbs",
    any(i.category == "repeated_verb" and i.value == "developed" for i in _v_report.issues),
    str([(i.category, i.value) for i in _v_report.issues]),
)
check(
    "voice audit catches outcome-clause overuse ('resulting in' x2, 'to improve' x2)",
    any(i.category == "outcome_clause" and i.value == "resulting in" for i in _v_report.issues)
    and any(i.category == "outcome_clause" and i.value == "to improve" for i in _v_report.issues),
    str([(i.category, i.value) for i in _v_report.issues]),
)
check(
    "voice audit catches verbatim JD echo (5+ word copy)",
    any(i.category == "jd_echo" for i in _v_report.issues),
    str([(i.category, i.value) for i in _v_report.issues]),
)
check(
    "voice score drops with issues and stays in range",
    0 <= _v_report.human_voice_score < 100.0,
    str(_v_report.human_voice_score),
)

# HUMANIZE routes through the stub on its Task tag and echoes a fixed resume.
_v_hum = _get_client().complete_json(
    _prompts.HUMANIZE_SYSTEM,
    _prompts.humanize_user(_v_bad.model_dump_json(), "- [banned_phrase] spearheaded", ["Python"]),
)
check(
    "HUMANIZE stub routes and returns a revised_resume",
    isinstance(_v_hum.get("revised_resume"), dict),
    str(_v_hum)[:120],
)
check(
    "HUMANIZE stub swaps banned verbs for plain ones",
    "Led development" in _v_hum["revised_resume"]["experience"][0]["bullets"][0]
    and "Used Python" in _v_hum["revised_resume"]["experience"][0]["bullets"][1],
    str(_v_hum["revised_resume"]["experience"][0]["bullets"])[:200],
)

# The full component loop: humanize -> guard-clean vs the ledger -> better score.
_v_revised = _humanize(_v_bad, _v_report.issues, _v_jd)
check("humanizer returns a valid ResumeModel", _v_revised is not None)
if _v_revised is not None:
    _v_ledger = build_facts_ledger(_v_bad)
    check(
        "humanized resume stays guard-clean (facts untouched)",
        check_fabrication(_v_revised, _v_ledger) == [],
        str(check_fabrication(_v_revised, _v_ledger)),
    )
    _v_post = _audit(_v_revised, _v_jd)
    check(
        "humanizer pass improves the voice score",
        _v_post.human_voice_score > _v_report.human_voice_score,
        f"{_v_report.human_voice_score} -> {_v_post.human_voice_score}",
    )
check("humanizer with no issues is a no-op (no LLM call)", _humanize(_v_bad, [], _v_jd) is None)

# Prompt pins: stub routing tag stays first; the tailor prompt keeps the new
# anti-AI rules; the humanize user message keeps its stub-parsing markers.
check("HUMANIZE prompt Task tag first", _prompts.HUMANIZE_SYSTEM.startswith("Task: HUMANIZE."))
check("HUMANIZE prompt forbids fact changes", "Do NOT change facts" in _prompts.HUMANIZE_SYSTEM)
check("TAILOR prompt bans JD echo", "NEVER ECHO THE JD" in _prompts.TAILOR_SYSTEM)
check("TAILOR prompt self-check scans for JD echo", "JD-ECHO SCAN" in _prompts.TAILOR_SYSTEM)
check(
    "humanize_user keeps the stub's parse markers",
    "RESUME TO EDIT (JSON):" in _prompts.humanize_user("{}", "", [])
    and "END RESUME" in _prompts.humanize_user("{}", "", []),
)

# 24. Humanization spec — remaining stages: JD mandatory/preferred split,
# CV positioning plan (PLAN_CV), keyword
# stuffing + JD copy %, and the writing-prefs feedback loop (§26).
from app.core.cv_planner import plan_cv as _plan  # noqa: E402
from app.core import writing_prefs as _wprefs  # noqa: E402
from app.db.models import User as _WPUser  # noqa: E402
from sqlalchemy import select as _wpsel  # noqa: E402

# Stage 2: the JD parser separates mandatory from preferred and captures outcomes.
check(
    "jd analysis carries preferred skills and business outcomes",
    jd.preferred_skills == ["Docker", "Kubernetes"] and len(jd.business_outcomes) > 0,
    f"{jd.preferred_skills} / {jd.business_outcomes}",
)

# Stage 4: the positioning plan routes through the stub and lands on the result.
_p = _plan(resume, jd)
check("PLAN_CV stub routes to a positioning plan", _p is not None and _p.positioning != "", str(_p))
check(
    "tailor result carries the positioning plan",
    result.plan is not None
    and result.plan.positioning != ""
    f"plan={result.plan}",
)


# Stage 9: keyword stuffing + JD phrase-overlap percentage.
_s_resume = resume.model_copy(deep=True)
_s_resume.summary = "Python developer using Python daily."
_s_resume.experience[0].bullets = [
    "Built Python tools in Python for Python teams.",
    "Improved processes by 20%.",
]
_s_report = _audit(_s_resume, _v_jd)
check(
    "voice audit detects keyword stuffing (Python x6)",
    any(i.category == "keyword_stuffing" and i.value.lower() == "python" for i in _s_report.issues),
    str([(i.category, i.value) for i in _s_report.issues]),
)
# ...but naming a technology once per project is how a real CV reads. A résumé
# with eight projects, each carrying its own tech-stack line, says "Python"
# eight times without stuffing anything — flagging that sent the humanizer off
# to delete real technologies from real projects.
_ns_resume = resume.model_copy(deep=True)
_ns_resume.summary = "Engineer who ships backend services."
_ns_resume.experience[0].bullets = ["Built internal tools.", "Improved processes by 20%."]
from app.models import Project as _Project_ns  # noqa: E402

_ns_resume.projects = [
    _Project_ns(name=f"Service {i}", description="Python service with retries.", bullets=[])
    for i in range(8)
]
_ns_report = _audit(_ns_resume, _v_jd)
check(
    "one mention per project is not stuffing (8 projects naming Python once each)",
    not any(i.category == "keyword_stuffing" for i in _ns_report.issues),
    str([(i.category, i.value, i.detail) for i in _ns_report.issues]),
)
check(
    "voice audit reports JD copy % on the echoing resume, 0 on the clean one",
    _audit(_v_bad, _v_jd).jd_copy_pct > 0 and result.voice_report.jd_copy_pct == 0.0,
    f"bad={_audit(_v_bad, _v_jd).jd_copy_pct} clean={result.voice_report.jd_copy_pct}",
)

# 16.3 live-run fixes pinned: legit technical nouns are not banned-verb hits,
# and keyword counting is boundary-aware (no substring matches).
_t_resume = resume.model_copy(deep=True)
_t_resume.summary = "Owns workflow orchestration and the test harness for AI systems."
_t_resume.experience[0].bullets = ["Maintained email pipelines.", "Improved processes by 20%."]
_t_report = _audit(_t_resume, _VJD(job_title="X", keywords=["AI"], responsibilities=[]))
check(
    "voice audit: 'orchestration'/'test harness' nouns not flagged as banned verbs",
    not any(i.category == "banned_phrase" for i in _t_report.issues),
    str([(i.category, i.value) for i in _t_report.issues]),
)
check(
    "voice audit: keyword count is boundary-aware ('AI' never counts 'email'/'maintained')",
    not any(i.category == "keyword_stuffing" for i in _t_report.issues),
    str([(i.category, i.value) for i in _t_report.issues]),
)
_t_verbs = resume.model_copy(deep=True)
_t_verbs.summary = "Orchestrated teams while harnessing synergies."
check(
    "voice audit: verb forms 'orchestrated'/'harnessing' still banned",
    any(i.category == "banned_phrase" for i in _audit(_t_verbs, None).issues),
    str([(i.category, i.value) for i in _audit(_t_verbs, None).issues]),
)
check("HUMANIZE prompt covers keyword_stuffing", "keyword_stuffing" in _prompts.HUMANIZE_SYSTEM)

# §26 feedback loop: rejected phrases persist per user, dedupe, cap, and reach
# the tailor prompt as an avoid-list.
_wdb = SessionLocal()
_wuser = _wdb.execute(_wpsel(_WPUser)).scalars().first()
_stored = _wprefs.record_rejected(_wdb, _wuser, ["Leveraged synergies", "  ", "Leveraged synergies"])
check("writing prefs store rejected phrases deduped", _stored == ["Leveraged synergies"], str(_stored))
_stored = _wprefs.record_rejected(_wdb, _wuser, [f"phrase {i}" for i in range(60)])
check(
    "writing prefs cap at 50, newest first",
    len(_stored) == 50 and _stored[0] == "phrase 0" and _wprefs.avoid_phrases(_wuser) == _stored,
    f"len={len(_stored)} first={_stored[0]}",
)
_wdb.close()
_tu = _prompts.tailor_user("{}", "{}", plan_json='{"positioning":"X"}', avoid_phrases=["Leveraged synergies"])
check(
    "tailor prompt carries the plan and the rejected-phrase avoid-list",
    "POSITIONING PLAN" in _tu and '"Leveraged synergies"' in _tu,
)
check(
    "tailor prompt without plan/prefs stays clean (back-compat)",
    "POSITIONING PLAN" not in _prompts.tailor_user("{}", "{}")
    and "REJECTED BEFORE" not in _prompts.tailor_user("{}", "{}"),
)

# Prompt pins for the new tasks (stub routing + extraction rules).
check("PLAN_CV prompt Task tag first", _prompts.PLAN_CV_SYSTEM.startswith("Task: PLAN_CV."))
check(
    "ANALYZE_JD and JD_FIT extract the mandatory/preferred split",
    "preferred_skills" in _prompts.ANALYZE_JD_SYSTEM and "preferred_skills" in _prompts.JD_FIT_SYSTEM,
)

# ---------------------------------------------------------------------------
# 18. Page budget: a master résumé must not tailor into a 5-pager.
# ---------------------------------------------------------------------------
from app.core.cv_planner import plan_cv as _plan_cv_b  # noqa: E402
from app.core.length_budget import (  # noqa: E402
    fit_to_pages,
    project_relevance,
    rank_projects,
    ranked_indices,
)
from app.core.tailor import tailor_resume as _tailor_b  # noqa: E402
from app.models import (  # noqa: E402
    Contact as _Contact_b,
    CVPlan as _CVPlan_b,
    Education as _Education_b,
    Experience as _Experience_b,
    JDModel as _JDModel_b,
    LanguageSkill as _Lang_b,
    Project as _Project_b,
    ResumeModel as _Resume_b,
)
from app.render.pdf_renderer import page_count  # noqa: E402

_BLURB = (
    "Built the ingestion service that reads inbound events, normalizes them and "
    "writes structured records downstream. Handles retries, deduplication and a "
    "fallback path when the upstream API is unavailable. Runs in production and "
    "is monitored with structured logs and health checks. "
)


def _master_resume(n_projects: int = 20):
    """A master-CV-shaped résumé: every role kept, dozens of projects."""
    return _Resume_b(
        contact=_Contact_b(name="Master Candidate", email="master@example.com", phone="+972-5-0000000"),
        headline="AI Automation Engineer",
        summary=_BLURB * 2,
        skills=[f"Skill group {i}: " + ", ".join(f"tool{i}{j}" for j in range(14)) for i in range(8)],
        experience=[
            _Experience_b(
                company=f"Company {i}", title="Engineer", start_date="2021", end_date="Present",
                bullets=[f"{_BLURB[:150]} (role {i}, bullet {b})" for b in range(6)],
            )
            for i in range(2)
        ],
        education=[_Education_b(institution="State University", degree="BSc", field="CS")],
        projects=[
            _Project_b(
                name=f"Alpha {i} system",
                description=_BLURB + ("Uses Python and PostgreSQL. " if i % 3 == 0 else "Uses Figma. "),
                bullets=[f"Bullet {b} for project {i}." for b in range(3)],
            )
            for i in range(n_projects)
        ],
        certifications=["AI Engineering Certification"],
        languages=[_Lang_b(language="Hebrew", level="native"), _Lang_b(language="English", level="fluent")],
    )


_big = _master_resume()
_big_pages = page_count(_big)
check("master-shaped résumé really is long", _big_pages >= 4, f"{_big_pages} pages")

_jd_b = _JDModel_b(
    job_title="Backend Engineer",
    hard_skills=["Python", "PostgreSQL"],
    keywords=["Python", "PostgreSQL", "retries"],
)
_fit, _rep = fit_to_pages(_big, _jd_b, plan=None, max_pages=2, hard_max_pages=3)
_fit_pages = page_count(_fit)
check("length budget brings a master résumé inside the hard limit", _fit_pages <= 3,
      f"{_big_pages} -> {_fit_pages} pages")
check("length budget hits the 2-page target here", _fit_pages <= 2, f"{_fit_pages} pages")
check("length report records the trim", _rep.trimmed and _rep.pages_after == _fit_pages)
check("length report names the dropped projects", len(_rep.dropped_projects) > 0)

# Protected entries survive — dropping a role to save a line is the one thing
# the budget must never do.
check("budget keeps every role", len(_fit.experience) == len(_big.experience))
check("budget keeps education", len(_fit.education) == len(_big.education))
check("budget keeps certifications", len(_fit.certifications) == len(_big.certifications))
check("budget keeps languages", len(_fit.languages) == len(_big.languages))
check("budget keeps contact details", _fit.contact.email == _big.contact.email)
check("budget keeps at least one project", len(_fit.projects) >= 1)
_orig_names = {p.name for p in _big.projects}
check("budget invents no projects", all(p.name in _orig_names for p in _fit.projects))

# Relevance: the Python/PostgreSQL projects outrank the Figma ones here.
_rel_hit = project_relevance(_big.projects[0], _jd_b)
_rel_miss = project_relevance(_big.projects[1], _jd_b)
check("JD-relevant project outranks an irrelevant one", _rel_hit > _rel_miss,
      f"{_rel_hit} vs {_rel_miss}")

# The planner read the JD; its shortlist outranks raw keyword overlap.
_plan_pick = _CVPlan_b(select_projects=["Alpha 1 system"], drop_projects=["Alpha 0 system"])
_order = rank_projects(_big, _jd_b, _plan_pick)
check("planner's reject drops first and its pick drops last",
      _order[0] == "Alpha 0 system" and _order[-1] == "Alpha 1 system",
      f"first={_order[0]} last={_order[-1]}")
_fit_plan, _ = fit_to_pages(_big, _jd_b, plan=_plan_pick, max_pages=2, hard_max_pages=3)
_kept = {p.name for p in _fit_plan.projects}
check("planner-selected project is kept", "Alpha 1 system" in _kept, str(sorted(_kept)))
check("planner-dropped project is gone", "Alpha 0 system" not in _kept, str(sorted(_kept)))

# Name matching is token-wise: "Alpha 1 system" must not claim "Alpha 12 system".
from app.core.length_budget import _name_matches as _nm  # noqa: E402
check("plan name match does not confuse Alpha 1 with Alpha 12",
      _nm("Alpha 1 system", "Alpha 1 system") and not _nm("Alpha 1 system", "Alpha 12 system"))
check("plan name match still tolerates the planner's own wording",
      _nm("Ziko delivery platform", "Ziko delivery platform — single city"))

# Promoting a project into Experience invents an employer. Splitting the tailor
# rules into "roles protected / projects droppable" makes that an attractive way
# to rescue a project, and gpt-5.4-mini really did it on the CHEQ job — the CV
# came back claiming employment at "JobFinder AI".
from app.core.fabrication_guard import drop_invented_roles as _drop_roles  # noqa: E402
from app.parsers.structurer import build_facts_ledger as _build_ledger  # noqa: E402

_real = _Resume_b(
    contact=_Contact_b(name="Role Test", email="r@example.com"),
    experience=[_Experience_b(company="Fixr Solutions", title="Engineer",
                              start_date="2021", end_date="Present", bullets=["Built things."])],
)
_real_ledger = _build_ledger(_real)
_promoted = _real.model_copy(deep=True)
_promoted.experience.append(
    _Experience_b(company="JobFinder AI", title="Founder", start_date="2026",
                  end_date="Present", bullets=["Shipped a résumé tailoring app."])
)
_cleaned, _removed = _drop_roles(_promoted, _real_ledger)
check(
    "a project promoted into Experience is cut, not shipped as employment",
    len(_cleaned.experience) == 1
    and _cleaned.experience[0].company == "Fixr Solutions"
    and _removed == ["JobFinder AI"],
    f"kept={[e.company for e in _cleaned.experience]} removed={_removed}",
)
# ...and a real role that was merely reworded must survive untouched.
_reworded = _real.model_copy(deep=True)
_reworded.experience[0].title = "AI Automation Engineer"
_kept, _none = _drop_roles(_reworded, _real_ledger)
check(
    "a genuine role survives rewording",
    len(_kept.experience) == 1 and _none == [],
    f"removed={_none}",
)
check(
    "TAILOR prompt forbids moving content between sections",
    "SECTIONS ARE NOT INTERCHANGEABLE" in _prompts.TAILOR_SYSTEM
    and "A project is not a job" in _prompts.TAILOR_SYSTEM,
)

# A long project description must WRAP, not run off the page and get clipped.
# It used to ride in the single-line "Company · Location" meta slot, so a master
# résumé's prose descriptions were silently cut at the right margin.
import io as _io_b  # noqa: E402

import pdfplumber as _pdfplumber_b  # noqa: E402

from app.render.pdf_renderer import render_pdf as _render_pdf_b  # noqa: E402

_LONG_DESC = (
    "A resume-tailoring and job-search application, built and shipped solo. It fans out "
    "across five job boards, scores every posting against a stored master resume, and "
    "tailors the CV per job through a pipeline of parse, structure, analysis and review."
)
_wrap_resume = _Resume_b(
    contact=_Contact_b(name="Wrap Test", email="wrap@example.com"),
    projects=[_Project_b(name="JobFinder AI", description=_LONG_DESC, bullets=[])],
)
with _pdfplumber_b.open(_io_b.BytesIO(_render_pdf_b(_wrap_resume))) as _wd:
    _wrap_text = " ".join(" ".join((_p.extract_text() or "").split()) for _p in _wd.pages)
check(
    "long project description wraps instead of being clipped at the margin",
    "parse, structure, analysis and review." in _wrap_text,
    _wrap_text[-90:],
)

# The master résumé is an inventory and may grow without limit — only the
# TAILORED output is capped. Dropping one project at a time cost one render per
# drop and blew the measurement budget: a 126-project master shipped 7 pages,
# silently over the hard limit. The binary search has to hold at any size.
for _n_proj in (60, 150):
    _huge = _master_resume(n_projects=_n_proj)
    _huge_fit, _huge_rep = fit_to_pages(_huge, _jd_b, max_pages=2, hard_max_pages=3)
    check(
        f"a {_n_proj}-project master still tailors inside the hard limit",
        page_count(_huge_fit) <= 3,
        f"{_huge_rep.pages_before} -> {page_count(_huge_fit)} pages, "
        f"{len(_huge_fit.projects)} projects kept",
    )
    check(
        f"protected entries survive a {_n_proj}-project master",
        len(_huge_fit.experience) == len(_huge.experience)
        and len(_huge_fit.education) == len(_huge.education)
        and len(_huge_fit.languages) == len(_huge.languages),
    )
# When it genuinely cannot fit, it must SAY so rather than return a quiet
# over-length résumé.
_unfittable = _master_resume(n_projects=1)
_unfittable.experience = [
    _Experience_b(company=f"Company {i}", title="Engineer", start_date="2010",
                  end_date="2011", bullets=[f"{_BLURB} ({i})"] * 3)
    for i in range(40)
]
_uf_fit, _uf_rep = fit_to_pages(_unfittable, _jd_b, max_pages=2, hard_max_pages=3)
check(
    "an impossible résumé reports the overflow instead of hiding it",
    page_count(_uf_fit) <= 3 or any("could not get below" in n for n in _uf_rep.notes),
    f"{page_count(_uf_fit)} pages, notes={_uf_rep.notes}",
)

# Ranking must span the candidate's range, not repeat one strength. Pure keyword
# ranking is self-reinforcing: a JD saying "automation" over and over put eight
# near-identical n8n workflows above every shipped application, so the CHEQ CV
# proved one skill eight times and buried the full-stack products.
_dupe_jd = _JDModel_b(
    job_title="AI Engineer",
    hard_skills=["automation", "n8n", "workflow"],
    keywords=["automation", "n8n", "workflow", "Python", "React"],
)
_mixed = _Resume_b(
    contact=_Contact_b(name="Mixed", email="m@example.com"),
    projects=[
        _Project_b(name=f"Automation {i}",
                   description="n8n workflow automation with webhooks and retries.")
        for i in range(6)
    ] + [
        _Project_b(name="Shipped Web App",
                   description="Full-stack React and Python application deployed to production."),
        _Project_b(name="Desktop Tool",
                   description="Python desktop application with SQLite and an installer."),
    ],
)
_top3 = [_mixed.projects[i].name for i in ranked_indices(_mixed, _dupe_jd)[:3]]
check(
    "ranking does not fill the top with near-identical projects",
    any(not n.startswith("Automation") for n in _top3),
    f"top3={_top3}",
)
# ...but the planner still outranks diversity — it read the job description.
_dupe_plan = _CVPlan_b(select_projects=[f"Automation {i}" for i in range(3)])
_planned_top3 = [_mixed.projects[i].name for i in ranked_indices(_mixed, _dupe_jd, _dupe_plan)[:3]]
check(
    "the planner's picks still win over the diversity penalty",
    all(n.startswith("Automation") for n in _planned_top3),
    f"top3={_planned_top3}",
)

# Relevance decides HOW MANY projects, not an arbitrary cap: ten short relevant
# projects that fit inside the page budget must all survive.
_many = _Resume_b(
    contact=_Contact_b(name="Many Projects", email="many@example.com"),
    summary="Backend engineer.",
    skills=["Python", "PostgreSQL"],
    experience=[_Experience_b(company="Acme", title="Engineer", start_date="2021",
                              end_date="Present", bullets=["Built Python services."])],
    projects=[
        _Project_b(name=f"Service {i}",
                   description="Python and PostgreSQL service with retries and logging.")
        for i in range(10)
    ],
)
_many_fit, _many_rep = fit_to_pages(_many, _jd_b, max_pages=2, hard_max_pages=3)
check(
    "ten relevant projects that fit are all kept (no arbitrary cap)",
    len(_many_fit.projects) == 10 and not _many_rep.trimmed,
    f"kept {len(_many_fit.projects)}, trimmed={_many_rep.trimmed}",
)
check(
    "PLAN_CV prompt sets no fixed project count",
    "There is NO fixed number" in _prompts.PLAN_CV_SYSTEM,
)
check(
    "TAILOR prompt sets no fixed project count and scales detail to it",
    "no target count" in _prompts.TAILOR_SYSTEM
    and "THE MORE YOU KEEP, THE SHORTER EACH MUST BE" in _prompts.TAILOR_SYSTEM,
)

# A résumé already inside the budget is returned untouched.
_small = _master_resume(n_projects=2)
_small.skills = _small.skills[:2]
_small_fit, _small_rep = fit_to_pages(_small, _jd_b, max_pages=3, hard_max_pages=3)
check("short résumé passes through untouched",
      not _small_rep.trimmed and len(_small_fit.projects) == len(_small.projects))

# The stub planner echoes real project names into the select/drop split.
_stub_plan = _plan_cv_b(_master_resume(6), _jd_b)
check("stub PLAN_CV splits real project names into select/drop",
      _stub_plan is not None and len(_stub_plan.select_projects) == 3
      and len(_stub_plan.drop_projects) == 3,
      str(_stub_plan.select_projects if _stub_plan else None))

# End to end through the real pipeline.
_e2e = _tailor_b(_master_resume(12), _jd_b)
check("tailor result carries a length report", _e2e.length_report is not None)
check("tailored résumé is within the hard page limit",
      page_count(_e2e.tailored_resume) <= 3, f"{page_count(_e2e.tailored_resume)} pages")

# ---------------------------------------------------------------------------
# 18b. KEYWORD PRESERVATION. "Tailoring sometimes deletes keywords the job asks
# for" was the report, and it is not one bug: the TAILOR prompt orders curation
# with no rule against dropping a term the JD names, the page budget removes the
# prose that carried the only occurrence, the planner drops the project first,
# `drop_invented_roles` cuts a promoted row, and the humanizer's acceptance gate
# weighed fabrication, voice and pages — never coverage. `score_after` MEASURED
# the drop and nothing repaired it.
#
# `app/core/keyword_guard.py` is the floor. It lives beside the page budget here
# because it has to COMPOSE with it — a restore adds render height — and the
# fixtures (`_master_resume`, `_jd_b`, `page_count`) are already in scope.
# ---------------------------------------------------------------------------
import inspect as _kg_inspect  # noqa: E402
import json as _json_kg  # noqa: E402
from pathlib import Path as _Path_kg  # noqa: E402

import app.core.humanizer as _kg_humanizer_mod  # noqa: E402
from app.core.keyword_guard import (  # noqa: E402
    MAX_RESTORED as _KG_MAX,
    LostKeyword as _LostKeyword,
    lost_keywords as _lost_keywords,
    preserve_keywords as _preserve,
    report_restore as _report_restore,
    shed_restored as _shed_restored,
)
from app.core.scorer import _resume_text as _kg_resume_text  # noqa: E402
from app.models import SkillGroup as _SkillGroup_b  # noqa: E402

# Two blocks below can the LLM client's TAILOR (and one its HUMANIZE) branch, on
# the singleton, the way section 21b already cans `complete_json`. Both restore
# it in a `finally`: a leaked patch would silently re-route every later section.
_kg_stub = _get_client()
_kg_orig_cjson = _kg_stub.complete_json

_kg_orig = _Resume_b(
    contact=_Contact_b(name="Keyword Guard", email="kg@example.com"),
    summary="Engineer.",
    skills=["Python", "Kubernetes", "Terraform", "Communication"],
    experience=[_Experience_b(company="Acme", title="Engineer", start_date="2021",
                              end_date="Present", bullets=["Built services."])],
)
_kg_jd = _JDModel_b(
    job_title="Backend Engineer",
    hard_skills=["Python", "Kubernetes", "REST APIs"],
    keywords=["Python", "Terraform", "CI/CD"],
)

# THE CATCH, driven end to end. `_stub_tailor` hard-codes
# skills=["Python","REST APIs","SQL","Project Management"] regardless of input,
# which is exactly mechanism 1 made deterministic: Kubernetes and Terraform are
# deleted from a candidate who lists both, and coverage falls 60.0 -> 40.0.
# Measured with the guard removed, so this check is red before the change.
_kg_res = _tailor_b(_kg_orig, _kg_jd)
check(
    "a JD keyword the candidate HAS is put back after the tailor deleted it",
    "Kubernetes" in _kg_res.tailored_resume.skills
    and "Terraform" in _kg_res.tailored_resume.skills
    and _kg_res.score_after.keyword_coverage >= _kg_res.score_before.keyword_coverage,
    f"skills={_kg_res.tailored_resume.skills} "
    f"{_kg_res.score_before.keyword_coverage} -> {_kg_res.score_after.keyword_coverage}",
)
# ...and REPORTED, pinned separately so deleting the changelog write goes red on
# its own rather than hiding behind the résumé mutation.
_kg_put_back = [c for c in _kg_res.changelog if c.section == "skills" and "Put back" in c.change]
check(
    "the restore says what it did, in the changelog",
    len(_kg_put_back) == 1
    and "Kubernetes" in _kg_put_back[0].change
    and "Terraform" in _kg_put_back[0].change,
    str([c.change for c in _kg_res.changelog]),
)
# ...and it names THE ENTRIES IT WROTE, with the job's terms in the reason. The
# two are the same string in the fixture above, which is why this one spells them
# differently: "Put back: REST APIs" named the JD's phrase, and the entries
# behind it were `['REST', 'APIs']` — a sentence naming a string that appears
# nowhere in the shipped CV, on a restore that worked perfectly.
_kg_name_o = _Resume_b(
    contact=_Contact_b(name="Naming", email="na@example.com"),
    skills=["Python", "Kubernetes (K8s) administration", "Terraform Cloud"],
)
_kg_name_jd = _JDModel_b(job_title="Platform Engineer", hard_skills=["Kubernetes", "Terraform"])
_kg_name_payload = _kg_name_o.model_dump()
_kg_name_payload["skills"] = ["Python"]


def _kg_name_canned(system, user, **kw):
    if "TAILOR" in system[:40]:
        return {"tailored_resume": _kg_name_payload, "changelog": [], "covered_keywords": []}
    return _kg_orig_cjson(system, user, **kw)


_kg_stub.complete_json = _kg_name_canned
try:
    _kg_name_res = _tailor_b(_kg_name_o, _kg_name_jd)
finally:
    _kg_stub.complete_json = _kg_orig_cjson
_kg_name_entry = next((c for c in _kg_name_res.changelog
                       if c.section == "skills" and c.change.startswith("Put back")), None)
check(
    "'Put back' names the entries that are on the CV, and the job's own phrasing goes "
    "in the reason where it belongs",
    _kg_name_entry is not None
    and _kg_name_entry.change[len("Put back: "):].split(", ")
        == ["Kubernetes (K8s) administration", "Terraform Cloud"]
    and all(e in _kg_name_res.tailored_resume.skills
            for e in _kg_name_entry.change[len("Put back: "):].split(", "))
    and "Kubernetes" in _kg_name_entry.reason and "Terraform" in _kg_name_entry.reason,
    "" if _kg_name_entry is None else f"{_kg_name_entry.change} | {_kg_name_entry.reason}",
)
# The copy may never claim more than it did. CLAUDE.md's fabrication-guard rule
# ("can say 'no new claims detected'. It can never say 'verified'") applies to
# every report this pipeline emits, not only that one's.
_kg_all_copy = " ".join(c.change + " " + c.reason for c in _kg_res.changelog).lower()
check(
    "the guard's copy never claims a guarantee it cannot make",
    "guaranteed" not in _kg_all_copy
    and "verified" not in _kg_all_copy
    and "all keywords" not in _kg_all_copy,
    _kg_all_copy[:160],
)

# THE FALSE-POSITIVE PIN, next to the catch. A guard that fires on legitimate
# input teaches users to ignore it — and here "fires" is observable as a deep
# copy: the caller keys the refit, the voice re-audit and the changelog entry
# off a non-empty `restored`, so an identity check pins all four at once.
_kg_clean_t = _kg_orig.model_copy(deep=True)
_kg_clean_t.skills = ["Python", "Kubernetes", "Terraform"]
_kg_out, _kg_r, _kg_k = _preserve(_kg_orig, _kg_clean_t, _kg_jd)
check(
    "an unharmed tailored résumé is returned untouched — the SAME object, no copy",
    _kg_out is _kg_clean_t and _kg_r == [] and _kg_k == [],
    f"same={_kg_out is _kg_clean_t} restored={_kg_r} kept={_kg_k}",
)

# NEVER INVENTS, direction 1: a keyword the ORIGINAL never covered is never
# written, however loudly the JD asks for it.
_kg_none = _Resume_b(contact=_Contact_b(name="No Rust", email="n@example.com"), skills=["Python"])
_kg_inv_out, _kg_inv_r, _kg_inv_k = _preserve(
    _kg_none, _kg_none.model_copy(deep=True), _JDModel_b(hard_skills=["Rust", "Erlang"])
)
check(
    "a JD keyword the candidate never had is never invented",
    _kg_inv_r == []
    and "rust" not in _kg_resume_text(_kg_inv_out)
    and "erlang" not in _kg_resume_text(_kg_inv_out),
    f"restored={_kg_inv_r} skills={_kg_inv_out.skills}",
)
# NEVER INVENTS, direction 2 — the half that will still be true in a year.
# COMPUTED from the two lists rather than restated, so it survives any refactor
# of the carrier search: every string the guard appends must already exist
# verbatim in `original.skills`.
# Every entry is spelled DIFFERENTLY from the JD term it satisfies. That is what
# makes this check discriminate: with identical spellings, a guard that wrote the
# JD's own word instead of the candidate's entry would still satisfy
# `set(added) <= set(original.skills)` and the check would pass on a fabrication.
_kg_wide_orig = _Resume_b(
    contact=_Contact_b(name="Wide", email="w@example.com"),
    skill_groups=[
        _SkillGroup_b(label="Backend & Data",
                      items=["Python", "Kubernetes (K8s) administration", "Apache Kafka Streams"]),
        _SkillGroup_b(label="Platform", items=["Terraform Cloud", "gRPC services"]),
        _SkillGroup_b(label="Other", items=["Communication"]),
    ],
)
_kg_wide_t = _kg_wide_orig.model_copy(deep=True)
_kg_wide_t.skills = ["Python"]
# A tailored CV is deliberately FLAT — the TAILOR prompt returns skill_groups: []
# because the grouping is the master's taxonomy and one job's CV is a shortlist.
_kg_wide_t.skill_groups = []
_kg_wide_out, _kg_wide_r, _ = _preserve(
    _kg_wide_orig, _kg_wide_t,
    _JDModel_b(hard_skills=["Kubernetes", "Apache Kafka"], keywords=["Terraform", "gRPC"]),
)
_kg_added = [s for s in _kg_wide_out.skills if s not in _kg_wide_t.skills]
check(
    "every string the guard writes already existed verbatim in the original's skills",
    _kg_added and set(_kg_added) <= set(_kg_wide_orig.skills)
    # ...and it is the CANDIDATE's wording that landed, not the job ad's.
    and "Kubernetes" not in _kg_added and "Terraform" not in _kg_added,
    f"added={_kg_added}",
)
check(
    "the restore is FLAT ONLY — it never imports the master's grouping",
    _kg_wide_orig.skill_groups and _kg_wide_out.skill_groups == [],
    str(_kg_wide_out.skill_groups),
)

# PROSE CLASS IS REPORTED, NEVER REPAIRED. Re-inserting a sentence into a
# rewritten résumé either duplicates a claim or grafts a token into the model's
# own prose — new writing the fabrication guard structurally cannot see.
_kg_prose_o = _Resume_b(
    contact=_Contact_b(name="Prose", email="p@example.com"),
    skills=["Python"],
    experience=[_Experience_b(company="Acme", title="Engineer", start_date="2021",
                              end_date="Present", bullets=["Ran the Kafka ingest path."])],
)
_kg_prose_t = _kg_prose_o.model_copy(deep=True)
_kg_prose_t.experience[0].bullets = ["Ran the event ingest path."]
_kg_prose_out, _kg_prose_r, _kg_prose_k = _preserve(
    _kg_prose_o, _kg_prose_t, _JDModel_b(hard_skills=["Kafka"])
)
check(
    "a keyword that lived only in prose is reported, not written back",
    _kg_prose_r == []
    and [k.keyword for k in _kg_prose_k] == ["Kafka"]
    and _kg_prose_k[0].reason == "prose"
    and _kg_prose_k[0].where == "experience"
    and _kg_prose_out is _kg_prose_t
    and _kg_prose_out.skills == _kg_prose_t.skills
    and _kg_prose_out.experience[0].bullets == ["Ran the event ingest path."],
    f"restored={_kg_prose_r} kept={_kg_prose_k}",
)
# ...and it reaches the user, in the changelog, with its own sentence. Driven
# end to end so a report written but never appended goes red.
_kg_prose_res = _tailor_b(_kg_prose_o, _JDModel_b(hard_skills=["Kafka"], keywords=["Python"]))
check(
    "a prose-class loss is disclosed in the changelog under its own section",
    any(c.section == "keywords" and "Kafka" in c.change for c in _kg_prose_res.changelog),
    str([(c.section, c.change) for c in _kg_prose_res.changelog]),
)

# THE UNION CASE, which is why the carrier search is INCREMENTAL rather than one
# probe per entry: "REST APIs" is covered by ['REST', 'APIs'] together and by
# neither alone, so a per-entry probe abandons it as prose.
_kg_union_o = _Resume_b(contact=_Contact_b(name="U", email="u@example.com"),
                        skills=["REST", "APIs", "Python"])
_kg_union_t = _kg_union_o.model_copy(deep=True)
_kg_union_t.skills = ["Python"]
_, _kg_union_r, _ = _preserve(_kg_union_o, _kg_union_t, _JDModel_b(hard_skills=["REST APIs"]))
check(
    "a keyword carried by the UNION of two skill entries is still restored",
    _kg_union_r == ["REST APIs"],
    str(_kg_union_r),
)

# PARTIAL BEATS MISSING, and the report has to say which of the two happened.
# The carrier search can reach `partial` and never the original's `covered` —
# the job asks for "REST APIs", the skills list holds `REST`, and the phrase
# itself lived in a sentence. The restore used to be ALL-OR-NOTHING there: it
# threw away the carriers it had found and reported the keyword as "prose",
# which contradicts itself about an entry sitting in the skills list — `where`
# names that section in the same breath. The entries are kept now (the
# candidate's own text, same byte-for-byte rule as any other write, and partial
# outranks missing on the ATS surface) and the keyword is still reported.
#
# The FALSE-POSITIVE half is in the same check, because "keep what was found" is
# trivially satisfied by appending the whole skills list: `Basket weaving` must
# not come along, since only an entry that strictly RAISED the rank is a carrier.
_kg_part_o = _Resume_b(
    contact=_Contact_b(name="Partial", email="pa@example.com"),
    summary="Built REST APIs for internal teams.",
    skills=["REST", "Basket weaving", "Python"],
)
_kg_part_t = _kg_part_o.model_copy(deep=True)
_kg_part_t.skills = ["Python"]
_kg_part_t.summary = "Built internal services."   # the phrase's only home, rewritten
_kg_part_out, _kg_part_r, _kg_part_k = _preserve(
    _kg_part_o, _kg_part_t, _JDModel_b(hard_skills=["REST APIs"])
)
check(
    "a keyword the skills list only PARTLY carries keeps the entries it does have, "
    "and is reported as partial rather than as prose",
    _kg_part_out.skills == ["Python", "REST"]
    and _kg_part_r == []
    and [(k.keyword, k.reason, k.where) for k in _kg_part_k]
        == [("REST APIs", "partial", "skills")],
    f"skills={_kg_part_out.skills} restored={_kg_part_r} "
    f"kept={[(k.keyword, k.reason, k.where) for k in _kg_part_k]}",
)
# ...and its own sentence reaches the user. Driven end to end, because the prose
# copy is what a partial loss used to be printed under and the two sentences are
# three lines apart in `tailor.py`.
_kg_part_payload = _kg_part_t.model_dump()


def _kg_part_canned(system, user, **kw):
    if "TAILOR" in system[:40]:
        return {"tailored_resume": _kg_part_payload, "changelog": [], "covered_keywords": []}
    return _kg_orig_cjson(system, user, **kw)


_kg_stub.complete_json = _kg_part_canned
try:
    _kg_part_res = _tailor_b(_kg_part_o, _JDModel_b(hard_skills=["REST APIs"]))
finally:
    _kg_stub.complete_json = _kg_orig_cjson
_kg_part_log = [(c.section, c.change, c.reason) for c in _kg_part_res.changelog]
check(
    "a partial restore is disclosed as partial, and never under the 'only inside "
    "wording' sentence that would be false about a skills entry",
    "REST" in _kg_part_res.tailored_resume.skills
    and any(sec == "keywords" and ch.startswith("Partly carried over") and "REST APIs" in ch
            for sec, ch, _ in _kg_part_log)
    and not any("only inside wording" in reason for _, _, reason in _kg_part_log),
    str(_kg_part_log),
)

# PREFERRED SKILLS ARE IN SCOPE, and deliberately wider than the coverage
# percentage: `scorer.keyword_analysis` reads keywords + hard_skills only, so a
# preferred skill the candidate HAS and we deleted raises no visible number —
# but it is still a deletion. Widening `keyword_analysis` instead would change
# every coverage figure in the app, a behaviour change with no defect behind it.
_kg_pref_o = _Resume_b(contact=_Contact_b(name="P", email="pr@example.com"), skills=["Docker", "Python"])
_kg_pref_t = _kg_pref_o.model_copy(deep=True)
_kg_pref_t.skills = ["Python"]
_kg_pref_jd = _JDModel_b(preferred_skills=["Docker"])
_, _kg_pref_r, _ = _preserve(_kg_pref_o, _kg_pref_t, _kg_pref_jd)
from app.core.scorer import keyword_analysis as _kg_cov  # noqa: E402
check(
    "a preferred_skill is preserved even though coverage never counts it",
    _kg_pref_r == ["Docker"] and _kg_cov(_kg_pref_t, _kg_pref_jd) == (0.0, []),
    f"restored={_kg_pref_r} coverage={_kg_cov(_kg_pref_t, _kg_pref_jd)}",
)

# HEBREW, and this is the check that pins the guard to `scorer._keyword_present`
# rather than to a second matcher. Hebrew's inseparable prefixes (ב/ל/ה/ו/מ/ש)
# are word characters, so `פייתון` has to match INSIDE `בפייתון` — the verbatim-
# phrase-first branch is the only thing that makes it. A boundary-anchored
# re-implementation reads the ORIGINAL as not covering the term at all, sees no
# loss, and goes red here and only here (check-mirrors 10 is its TS twin).
_kg_he_o = _Resume_b(
    contact=_Contact_b(name="דנה לוי", email="dana@example.com"),
    summary="מהנדסת נתונים עם ניסיון בעיבוד נתונים בענן.",
    skills=["פיתוח בפייתון", "עיבוד נתונים", "SQL"],
)
_kg_he_t = _kg_he_o.model_copy(deep=True)
_kg_he_t.skills = ["SQL"]
_kg_he_t.summary = "מהנדסת נתונים."  # the rewrite dropped the prose copy too
_, _kg_he_r, _ = _preserve(
    _kg_he_o, _kg_he_t, _JDModel_b(language="he", hard_skills=["פייתון"], keywords=["עיבוד נתונים"])
)
check(
    "a Hebrew skill is restored, including behind an inseparable prefix",
    _kg_he_r == ["פייתון", "עיבוד נתונים"],
    str(_kg_he_r),
)
# The false-positive half of the same property, in the same fixture family, and
# the shape of it is worth stating: the guard is EXACTLY as permissive as
# `_keyword_present` and not one character more. That matcher is substring-FIRST
# on purpose, so it genuinely reads `Java` as covered by `JavaScript` — adding a
# boundary here to "fix" that is re-implementing the matcher, which is the one
# thing this module may not do (it would then disagree with the coverage number
# on screen). What the guard must never do is restore a term the original does
# NOT cover under that matcher, in Hebrew as in English.
_kg_he_fp_t2 = _kg_he_o.model_copy(deep=True)
_kg_he_fp_t2.skills = []
_kg_he_fp_out, _kg_he_fp_r, _ = _preserve(
    _kg_he_o, _kg_he_fp_t2,
    _JDModel_b(language="he", hard_skills=["קוברנטיס"], keywords=["פייתון"]),
)
check(
    "a Hebrew term the résumé never claimed is never written in",
    _kg_he_fp_r == ["פייתון"]
    and "קוברנטיס" not in _kg_resume_text(_kg_he_fp_out),
    f"restored={_kg_he_fp_r} skills={_kg_he_fp_out.skills}",
)

# NO FABRICATION FLAG FROM A RESTORE — and the REASON, pinned separately.
# Pinning only the flag count passes by coincidence on a fixture whose skills
# happen not to collide with the ledger.
_kg_led_o = _Resume_b(
    contact=_Contact_b(name="Ledger", email="l@example.com"),
    skills=["Kubernetes", "Terraform", "Python"],
    experience=[_Experience_b(company="Acme", title="Engineer", start_date="2021",
                              end_date="Present", bullets=["Built services for 40 teams."])],
    education=[_Education_b(institution="State University", degree="BSc", field="CS")],
    certifications=["AI Engineering Certification"],
)
_kg_led = _build_ledger(_kg_led_o)
_kg_led_t = _kg_led_o.model_copy(deep=True)
_kg_led_t.skills = ["Python"]
_kg_led_out, _kg_led_r, _ = _preserve(_kg_led_o, _kg_led_t, _JDModel_b(hard_skills=["Kubernetes", "Terraform"]))
from app.core.fabrication_guard import check_fabrication as _kg_check_fab  # noqa: E402
check(
    "restoring a skill creates no fabrication flag",
    _kg_led_r == ["Kubernetes", "Terraform"]
    and len(_kg_check_fab(_kg_led_out, _kg_led)) == len(_kg_check_fab(_kg_led_t, _kg_led)),
    f"restored={_kg_led_r} before={len(_kg_check_fab(_kg_led_t, _kg_led))} "
    f"after={len(_kg_check_fab(_kg_led_out, _kg_led))}",
)
_kg_led_strings = {
    s.casefold()
    for field in ("employers", "titles", "dates", "institutions", "degrees",
                  "certifications", "military", "numbers", "headlines")
    for s in getattr(_kg_led, field)
}
check(
    "...and the reason it holds: the ledger holds no string from `skills`",
    not (_kg_led_strings & {s.casefold() for s in _kg_led_o.skills}),
    f"ledger={sorted(_kg_led_strings)}",
)

# VOICE REPORT DESCRIBES WHAT SHIPPED. `voice_audit` scans the skills list for
# banned phrases, so a restored entry can add an issue the pre-restore audit
# never saw — and the re-audit must carry the humanizer's own bookkeeping
# across. Both halves in one check: "re-audit" alone is trivially satisfied by
# throwing `revised`/`fixed` away.
from app.core.voice_audit import audit_voice as _kg_audit  # noqa: E402
_kg_voice_o = _Resume_b(
    contact=_Contact_b(name="Voice", email="v@example.com"),
    skills=["Python", "Cutting-edge ML tooling"],
)
_kg_voice_t = _kg_voice_o.model_copy(deep=True)
_kg_voice_t.skills = ["Python"]
_kg_voice_out, _kg_voice_r, _ = _preserve(
    _kg_voice_o, _kg_voice_t, _JDModel_b(hard_skills=["Cutting-edge ML tooling"])
)
_kg_pre_issues = {(i.category, i.value) for i in _kg_audit(_kg_voice_t, None).issues}
_kg_post_issues = {(i.category, i.value) for i in _kg_audit(_kg_voice_out, None).issues}
check(
    "a restored skill can carry a banned phrase, so the voice report has to be recomputed",
    _kg_voice_r == ["Cutting-edge ML tooling"] and _kg_post_issues > _kg_pre_issues,
    f"pre={sorted(_kg_pre_issues)} post={sorted(_kg_post_issues)}",
)
# ...and END TO END, where the second half of the rule bites: the humanizer's own
# bookkeeping has to survive the re-audit. A fresh `audit_voice` knows nothing
# about a revision that was accepted, so zeroing `revised`/`fixed` silently
# erases the record of the only stage that rewrote anything — and "we re-audited"
# is trivially satisfied by doing exactly that. Both halves live in ONE check.
#
# TAILOR and HUMANIZE are canned so the humanizer branch genuinely runs AND a
# restore genuinely happens in the same pass; the default stub tailor audits
# clean, so neither would.
_kg_vh_o = _Resume_b(
    contact=_Contact_b(name="Voice Bookkeeping", email="vb@example.com"),
    summary="Engineer.",
    skills=["Python", "Cutting-edge Kubernetes tooling"],
    experience=[_Experience_b(company="Acme", title="Engineer", start_date="2021",
                              end_date="Present",
                              bullets=["Spearheaded the platform migration.",
                                       "Wrote Python services."])],
)
_kg_vh_jd = _JDModel_b(job_title="Platform Engineer", hard_skills=["Kubernetes"], keywords=["Python"])
_kg_vh_tailored = _kg_vh_o.model_dump()
_kg_vh_tailored["skills"] = ["Python"]          # the shortlist dropped the Kubernetes entry
_kg_vh_revised = _json_kg.loads(_json_kg.dumps(_kg_vh_tailored))
# Fixes the banned verb and drops no keyword, so the gate accepts it.
_kg_vh_revised["experience"][0]["bullets"] = ["Led the platform migration.",
                                              "Wrote Python services."]


def _kg_vh_canned(system, user, **kw):
    head = system[:40]
    if "TAILOR" in head:
        return {"tailored_resume": _kg_vh_tailored, "changelog": [], "covered_keywords": []}
    if "HUMANIZE" in head:
        return {"revised_resume": _kg_vh_revised}
    return _kg_orig_cjson(system, user, **kw)


_kg_stub.complete_json = _kg_vh_canned
try:
    _kg_voice_res = _tailor_b(_kg_vh_o, _kg_vh_jd)
finally:
    _kg_stub.complete_json = _kg_orig_cjson
check(
    "the returned voice report describes the RESTORED résumé, and still records the "
    "humanizer revision that produced it",
    "Cutting-edge Kubernetes tooling" in _kg_voice_res.tailored_resume.skills
    and any(i.category == "banned_phrase" and "utting-edge" in i.value
            for i in _kg_voice_res.voice_report.issues)
    and _kg_voice_res.voice_report.revised is True
    and any(i.value.lower().startswith("spearhead") for i in _kg_voice_res.voice_report.fixed),
    f"skills={_kg_voice_res.tailored_resume.skills} "
    f"revised={_kg_voice_res.voice_report.revised} "
    f"fixed={[i.value for i in _kg_voice_res.voice_report.fixed]} "
    f"issues={[(i.category, i.value) for i in _kg_voice_res.voice_report.issues]}",
)

# THE COMPOSITION PROPERTY, pinned on its own line rather than only through the
# end-to-end path. The last-resort skills trim is the one thing that can undo a
# restore, and it must protect an entry in the SAME TERMS the carrier search
# picks it with — `scorer._keyword_present`, phrase-first — or the two disagree
# about the same entry.
#
# The old protection was whole-token overlap (`if tokens & jd_tokens: continue`)
# and the check under it used a token-identical fixture, so it was true only for
# the easy half. Every carrier matched through the SUBSTRING branch shared no
# token with the JD and was fully eligible for a trim that picks the LONGEST
# unmatched entry: the guard restored 10 carriers on a Hebrew master and this
# removed 9 of them under "dropped skills the job never asked for", while the
# changelog still said it had put them back.
#
# The table is check-mirrors 10's shape: the Hebrew case sits beside the Latin
# one, and the throwaway in each row is the FALSE-POSITIVE half — protecting
# every entry is the trivial way to make the first column pass, and a widened
# guard that did that would leave the trim unable to remove anything at all.
from app.core.length_budget import _drop_unmatched_skill as _kg_drop  # noqa: E402
# The protected entry is deliberately the LONGEST in each row: this trim picks
# the longest candidate, so with a shorter one the check passes whether or not
# the guard is there, and pins nothing.
_KG_PROTECT_CASES = (
    # (JD keyword, the entry it must protect, the entry that must go instead)
    # whole-token — true before this change and after it
    ("Kubernetes", "Kubernetes cluster operations and multi-region failover automation",
     "Basket weaving"),
    # substring, Latin — `Postgres` ⊂ `PostgreSQL`, no shared token
    ("Postgres", "PostgreSQL administration and replication tuning at scale",
     "Basket weaving"),
    # substring, Hebrew — ב/ל/ה/ו/מ/ש glue onto the noun, so `פייתון` lives
    # inside the token `בפייתון` and the token rule read the entry as unmatched
    ("פייתון", "פיתוח בפייתון ואוטומציה של תהליכי נתונים בענן", "סריגה ואריגה כתחביב"),
)
_kg_protect = []
for _kw_p, _keep_p, _go_p in _KG_PROTECT_CASES:
    _kg_dropped = _kg_drop(
        _Resume_b(contact=_Contact_b(name="Compose", email="c@example.com"),
                  skills=[_keep_p, _go_p]),
        _JDModel_b(hard_skills=[_kw_p]),
    )
    _kg_protect.append(_kg_dropped is not None and _kg_dropped.skills == [_keep_p])
check(
    "the last-resort skills trim can never remove a JD-matched (i.e. restored) entry, "
    "even when it is the longest line on the page and the match is a substring — "
    "and it still drops the entry that carries nothing",
    all(_kg_protect) and len(_kg_protect) == 3,
    str(_kg_protect),
)

# COMPOSES WITH THE PAGE BUDGET, end to end on a master-shaped fixture. The
# restore ADDS render height, so this is the assertion most likely to catch a
# mistake here — and (iii) is what proves the pair CONVERGES rather than the
# refit quietly undoing the restore one entry at a time.
_kg_big = _master_resume(14)
_kg_big.skills = [f"tool{i}" for i in range(60)] + ["Kubernetes", "Terraform"]
_kg_big_jd = _JDModel_b(
    job_title="Backend Engineer",
    hard_skills=["Python", "PostgreSQL", "Kubernetes"],
    keywords=["Python", "Terraform", "retries"],
)
# A tailored shortlist that dropped both, put through the budget exactly as the
# pipeline does before the guard runs.
_kg_big_t = _kg_big.model_copy(deep=True)
_kg_big_t.skills = ["Python", "PostgreSQL", "SQL"]
_kg_big_t, _kg_big_rep = fit_to_pages(_kg_big_t, _kg_big_jd, None, max_pages=2, hard_max_pages=3)
_kg_big_out, _kg_big_r, _ = _preserve(_kg_big, _kg_big_t, _kg_big_jd)
if page_count(_kg_big_out) > max(_kg_big_rep.pages_after, 2):
    _kg_big_out, _ = fit_to_pages(_kg_big_out, _kg_big_jd, None, max_pages=2, hard_max_pages=3)
_, _kg_big_r2, _kg_big_k2 = _preserve(_kg_big, _kg_big_out, _kg_big_jd)
check(
    "restore + refit: both entries survive, the page limit holds, and a second pass "
    "finds nothing newly lost",
    "Kubernetes" in _kg_big_out.skills
    and "Terraform" in _kg_big_out.skills
    and page_count(_kg_big_out) <= 3
    and _kg_big_r2 == [] and _kg_big_k2 == [],
    f"restored={_kg_big_r} pages={page_count(_kg_big_out)} "
    f"second_pass=({_kg_big_r2}, {_kg_big_k2})",
)

# ...and the same composition THROUGH `tailor_resume`, because the refit sits in
# a branch nothing else reaches: `if page_count(...) > max(pages_after, max_pages)`.
# The default stub tailor is a one-pager, so a fixture built on it would never
# enter that branch and would pass by never firing — the 21.7 failure mode. TAILOR
# is therefore canned with a 2-page résumé whose restore genuinely spills onto a
# third page, and THAT is asserted first: a render change that stops the fixture
# crossing the boundary must go red as "stale fixture", never quietly green.
_kg_e2e_blurb = (
    "Built the ingestion service that reads inbound events, normalizes them and writes "
    "structured records downstream, with retries, deduplication and a fallback path. "
)
# Distinct leading token per entry on purpose: with a shared vocabulary
# `_keyword_present` covers the later terms out of the earlier ones' tokens and
# the restore stops after five, which is correct behaviour and a useless fixture.
_kg_e2e_kw = [f"Zephyr{i} orchestration, telemetry and capacity planning tooling" for i in range(25)]
# The LAST bullet carries a term that lives nowhere else, and the refit is what
# trims it — which is the whole reason the report is recomputed AFTER the refit
# rather than before. Judged on the pre-refit résumé this keyword was present, so
# a single-pass report would say nothing about a loss that shipped.
_kg_e2e_master = _Resume_b(
    contact=_Contact_b(name="Refit", email="refit@example.com"),
    summary=_kg_e2e_blurb,
    skills=["Python", "PostgreSQL"] + _kg_e2e_kw,
    experience=[_Experience_b(company="Acme", title="Engineer", start_date="2021",
                              end_date="Present",
                              bullets=[f"{_kg_e2e_blurb} (item {b})" for b in range(21)]
                                       + ["Ran the Quicksilver replay tool."])],
    projects=[_Project_b(name="Alpha", description=_kg_e2e_blurb, bullets=[])],
)
_kg_e2e_tailored = _kg_e2e_master.model_dump()
_kg_e2e_tailored["skills"] = ["Python", "PostgreSQL"]   # the shortlist that dropped all 25
_kg_e2e_tailored["skill_groups"] = []
_kg_e2e_jd = _JDModel_b(job_title="Backend Engineer",
                        hard_skills=["Python", "PostgreSQL"] + _kg_e2e_kw,
                        keywords=["Quicksilver"])
_kg_e2e_pre = _Resume_b.model_validate(_kg_e2e_tailored)
_kg_e2e_spill, _, _ = _preserve(_kg_e2e_master, _kg_e2e_pre, _kg_e2e_jd)


def _kg_e2e_canned(system, user, **kw):
    if "TAILOR" in system[:40]:
        return {"tailored_resume": _kg_e2e_tailored, "changelog": [], "covered_keywords": []}
    return _kg_orig_cjson(system, user, **kw)


_kg_stub.complete_json = _kg_e2e_canned
try:
    _kg_e2e_res = _tailor_b(_kg_e2e_master, _kg_e2e_jd)
finally:
    _kg_stub.complete_json = _kg_orig_cjson
_kg_e2e_final = _kg_e2e_res.tailored_resume
_kg_e2e_budget = max(page_count(_kg_e2e_pre), get_settings().resume_max_pages)
check(
    "tailor_resume: a restore that spills onto another page is refitted back inside "
    "the budget, every restored entry survives it, and length_report describes what shipped",
    page_count(_kg_e2e_spill) > page_count(_kg_e2e_pre)          # fixture still bites
    and all(k in _kg_e2e_final.skills for k in _kg_e2e_kw)       # the refit undid nothing
    # The promise the pipeline already made about size is the one it has to keep.
    # `<= hard_max` would pass on a résumé that quietly grew a page, which is the
    # whole thing the refit exists to prevent.
    and page_count(_kg_e2e_final) <= _kg_e2e_budget
    and _kg_e2e_res.length_report.pages_after == page_count(_kg_e2e_final)
    and _kg_e2e_res.length_report.pages_before == page_count(_kg_e2e_pre)
    # CONVERGENCE: a second pass over the shipped résumé finds no SKILL-class
    # loss, i.e. the refit undid none of the restore. (Its prose-class finding is
    # the deliberate "Quicksilver" trim below; the pure form — both lists empty —
    # is pinned on the component-level fixture above.)
    and _preserve(_kg_e2e_master, _kg_e2e_final, _kg_e2e_jd)[1] == [],
    f"{page_count(_kg_e2e_pre)} -> {page_count(_kg_e2e_spill)} -> {page_count(_kg_e2e_final)} pages "
    f"(budget {_kg_e2e_budget}), kept {sum(1 for k in _kg_e2e_kw if k in _kg_e2e_final.skills)}/25, "
    f"report={_kg_e2e_res.length_report.pages_before}->{_kg_e2e_res.length_report.pages_after}, "
    f"notes={_kg_e2e_res.length_report.notes}",
)
# THE SECOND PASS, pinned behaviourally. The refit trimmed the bullet carrying
# "Quicksilver", so the honest report has to be recomputed against what shipped:
# the FIRST `preserve_keywords` saw that bullet intact and had nothing to say.
check(
    "a keyword the REFIT trimmed away is reported, so the changelog describes what shipped",
    "quicksilver" not in _kg_resume_text(_kg_e2e_final)
    and any(c.section == "keywords" and "Quicksilver" in c.change
            for c in _kg_e2e_res.changelog),
    f"bullets={len(_kg_e2e_final.experience[0].bullets)} "
    f"changelog={[(c.section, c.change[:60]) for c in _kg_e2e_res.changelog]}",
)

# A REPAIR IS NOT A MEASUREMENT, and using one as the other is how a keyword
# shipped missing, unrepaired AND unreported — in the one code path this module
# creates. `preserve_keywords` answers with the losses IT COULD NOT REPAIR, in a
# copy it then discards, on a fresh `MAX_RESTORED` budget. Point it at the
# résumé that SHIPPED and it says "nothing was lost" about a keyword the refit
# has just deleted: it restores it into the copy, files it under `restored`, and
# throws the copy away. Meanwhile the caller's own `restored` list was computed
# BEFORE the refit and still reads "Put back: X". Neither list names it.
#
# The old answer is asserted beside the new one on purpose: this cannot be
# "fixed" by going back to the wrapper, and a reader can see exactly what the
# repairer says when it is asked a question it does not answer.
_kg_meas_o = _Resume_b(
    contact=_Contact_b(name="Measure", email="me@example.com"),
    skills=["Python", "Kubernetes (K8s) administration", "Terraform Cloud"],
)
_kg_meas_before = _kg_meas_o.model_copy(deep=True)
_kg_meas_before.skills = ["Python"]
_kg_meas_jd = _JDModel_b(hard_skills=["Kubernetes", "Terraform"])
_kg_meas_guarded, _kg_meas_claim, _kg_meas_att = _preserve(
    _kg_meas_o, _kg_meas_before, _kg_meas_jd
)
# What ships: the page budget gave one of the two entries back — which is
# exactly what `shed_restored` does below — so the claim is now false about half
# of itself.
_kg_meas_ship = _kg_meas_guarded.model_copy(deep=True)
_kg_meas_ship.skills = [s for s in _kg_meas_ship.skills if s != "Terraform Cloud"]
_kg_meas_repair = _preserve(_kg_meas_o, _kg_meas_ship, _kg_meas_jd)
_kg_meas_restored, _kg_meas_kept = _report_restore(
    _kg_meas_o, _kg_meas_before, _kg_meas_ship, _kg_meas_jd, _kg_meas_att
)
check(
    "a repair is not a measurement: the repairer reports NO loss for a keyword the "
    "shipped CV is missing, while lost_keywords names it and the report files it "
    "under its own reason",
    _kg_meas_claim == ["Kubernetes", "Terraform"]        # the pre-refit claim
    and _kg_meas_repair[2] == []                         # the old detector: "nothing lost"
    and _lost_keywords(_kg_meas_o, _kg_meas_ship, _kg_meas_jd) == ["Terraform"]
    and _kg_meas_restored == ["Kubernetes"]              # only what SHIPPED at target
    and [(k.keyword, k.reason) for k in _kg_meas_kept] == [("Terraform", "trimmed")],
    f"claim={_kg_meas_claim} repair_kept={_kg_meas_repair[2]} "
    f"restored={_kg_meas_restored} kept={[(k.keyword, k.reason) for k in _kg_meas_kept]}",
)
# ...and a reason the restore already established is CARRIED, never recomputed:
# "only in prose" is a fact about the ORIGINAL's wording and no later trim
# changes it. Only a loss that was NOT there when the restore ran is ours, and
# only that one gets `trimmed`. Both directions in one check — reading every
# loss as "trimmed" is the trivial way to make the check above pass.
_kg_carry_r, _kg_carry_k = _report_restore(
    _kg_meas_o, _kg_meas_before, _kg_meas_before, _kg_meas_jd,
    [_LostKeyword("Kubernetes", "prose", "experience")],
)
check(
    "report_restore carries the restore's own reasons and invents 'trimmed' only for "
    "a loss that appeared after it",
    _kg_carry_r == []
    and [(k.keyword, k.reason) for k in _kg_carry_k]
        == [("Kubernetes", "prose"), ("Terraform", "trimmed")],
    str([(k.keyword, k.reason) for k in _kg_carry_k]),
)
# THE DETECTOR'S OWN FALSE NEGATIVE, which the wrapper inherited: it early-
# returned on `not original.skills`, so "nothing to repair from" was
# indistinguishable from "nothing was lost" — and the humanizer gate ACCEPTED a
# revision that deleted the JD's hard skills from a bullet. A rank comparison
# has no such door. The second half is the false-positive pin: an untouched pair
# must still measure as no loss.
_kg_ns_before = _Resume_b(contact=_Contact_b(name="No Skills", email="ns@example.com"),
                          experience=[_Experience_b(company="Acme", title="Engineer",
                                                    start_date="2021", end_date="Present",
                                                    bullets=["Ran the Kafka and Spark path."])])
_kg_ns_after = _kg_ns_before.model_copy(deep=True)
_kg_ns_after.experience[0].bullets = ["Ran the data path."]
check(
    "lost_keywords measures a résumé with an empty skills list — 'nothing to repair "
    "from' is not 'nothing was lost'",
    _kg_ns_before.skills == []
    and _lost_keywords(_kg_ns_before, _kg_ns_after,
                       _JDModel_b(hard_skills=["Kafka", "Spark"])) == ["Kafka", "Spark"]
    and _lost_keywords(_kg_ns_before, _kg_ns_before,
                       _JDModel_b(hard_skills=["Kafka", "Spark"])) == [],
    str(_lost_keywords(_kg_ns_before, _kg_ns_after, _JDModel_b(hard_skills=["Kafka", "Spark"]))),
)

# THE BACK-OFF (component level). The refit cannot always give the height back —
# everything trimmable can be at its floor and the skills trim is forbidden from
# touching a restored entry — so the guard hands entries back itself, LONGEST
# first, and stops the moment the budget holds rather than giving everything up.
# The identity half is the false-positive pin: a résumé that already fits is
# returned as the SAME object, so nothing is ever traded for nothing.
_kg_shed_src = _Resume_b(
    contact=_Contact_b(name="Shed", email="sh@example.com"),
    skills=["Python", "A very long restored entry indeed", "Short one"],
)
_kg_shed_out, _kg_shed_gone = _shed_restored(
    _kg_shed_src, ["A very long restored entry indeed", "Short one"],
    lambda r: len(" ".join(r.skills)) <= 30,
)
_kg_shed_same, _kg_shed_nothing = _shed_restored(
    _kg_shed_src, ["Short one"], lambda r: True
)
check(
    "the back-off gives restored entries back longest-first, stops as soon as it fits, "
    "and touches nothing at all when the résumé already fits",
    _kg_shed_out.skills == ["Python", "Short one"]
    and _kg_shed_gone == ["A very long restored entry indeed"]
    and _kg_shed_same is _kg_shed_src and _kg_shed_nothing == [],
    f"skills={_kg_shed_out.skills} shed={_kg_shed_gone}",
)

# ...and THROUGH `tailor_resume`, which is the only place the two gates that make
# it correct actually meet. The fixture puts the bulk of the CV in the SUMMARY —
# protected content the budget may not touch at all — so the refit genuinely
# cannot fit the restore, exactly as reproduced: 4 pages against a hard max of 3,
# with `fit_to_pages` writing "could not get below 3 pages" into its notes and
# nothing acting on it.
#
# Three things are asserted about the fixture itself before anything is asserted
# about the fix, because each one silently stops biting on a render change and a
# check that passes by never firing is the 21.7 failure mode: the pre-restore CV
# is INSIDE the limit, the restored one is OVER it, and `fit_to_pages` really
# cannot get it back.
from app.core.length_budget import OVERFLOW_NOTE as _KG_OVERFLOW  # noqa: E402

_kg_bo_master = _Resume_b(
    contact=_Contact_b(name="Backoff", email="bo@example.com"),
    summary=_kg_e2e_blurb * 44,
    skills=["Python"] + _kg_e2e_kw,
    experience=[_Experience_b(company="Acme", title="Engineer", start_date="2021",
                              end_date="Present", bullets=["Ran the platform."])],
)
_kg_bo_jd = _JDModel_b(job_title="Backend Engineer", hard_skills=["Python"] + _kg_e2e_kw)
_kg_bo_tailored = _kg_bo_master.model_dump()
_kg_bo_tailored["skills"] = ["Python"]
_kg_bo_tailored["skill_groups"] = []
_kg_bo_pre = _Resume_b.model_validate(_kg_bo_tailored)
_kg_bo_spill, _, _ = _preserve(_kg_bo_master, _kg_bo_pre, _kg_bo_jd)
_, _kg_bo_refit_rep = fit_to_pages(_kg_bo_spill, _kg_bo_jd, None, max_pages=2, hard_max_pages=3)


def _kg_bo_canned(system, user, **kw):
    head = system[:40]
    if "TAILOR" in head:
        return {"tailored_resume": _kg_bo_tailored, "changelog": [], "covered_keywords": []}
    # Echoing the input makes the voice gate reject it (the score cannot rise),
    # so the humanizer cannot quietly become the thing that changed the page count.
    if "HUMANIZE" in head:
        return {"revised_resume": _kg_bo_tailored}
    return _kg_orig_cjson(system, user, **kw)


_kg_stub.complete_json = _kg_bo_canned
try:
    _kg_bo_res = _tailor_b(_kg_bo_master, _kg_bo_jd)
finally:
    _kg_stub.complete_json = _kg_orig_cjson
_kg_bo_final = _kg_bo_res.tailored_resume
_kg_bo_kept = [k for k in _kg_e2e_kw if k in _kg_bo_final.skills]
_kg_bo_put = next((c.change for c in _kg_bo_res.changelog
                   if c.section == "skills" and c.change.startswith("Put back")), "")
_kg_bo_dropped = " | ".join(c.change for c in _kg_bo_res.changelog if c.section == "keywords")
check(
    "tailor_resume: a restore the refit cannot fit is handed back until the hard page "
    "limit holds — and the CV ships inside it",
    page_count(_kg_bo_pre) <= 3                       # fixture: started inside the limit
    and page_count(_kg_bo_spill) > 3                  # fixture: the restore broke it
    and any(n.startswith(_KG_OVERFLOW) for n in _kg_bo_refit_rep.notes)  # fixture: unfittable
    and page_count(_kg_bo_final) <= 3                 # ...and this is the fix
    and 0 < len(_kg_bo_kept) < len(_kg_e2e_kw),       # some given back, not all
    f"{page_count(_kg_bo_pre)} -> {page_count(_kg_bo_spill)} -> {page_count(_kg_bo_final)} pages, "
    f"kept {len(_kg_bo_kept)}/{len(_kg_e2e_kw)}, refit notes={_kg_bo_refit_rep.notes}",
)
check(
    "...and the changelog describes THAT résumé: every entry it says it put back is on "
    "the CV, every entry given back is reported as not carried over, and the budget's "
    "'could not get below' note is retracted because it stopped being true",
    # NAMED ⟺ SHIPPED, both directions, entry by entry. Splitting the sentence on
    # ", " would not do it — these entries contain a comma of their own.
    bool(_kg_bo_put)
    and all((e in _kg_bo_put) == (e in _kg_bo_final.skills) for e in _kg_e2e_kw)
    and all((e in _kg_bo_dropped) == (e not in _kg_bo_final.skills) for e in _kg_e2e_kw)
    and not any(n.startswith(_KG_OVERFLOW) for n in _kg_bo_res.length_report.notes)
    and any("gave back" in n for n in _kg_bo_res.length_report.notes)
    and _kg_bo_res.length_report.pages_after == page_count(_kg_bo_final),
    f"put_back={_kg_bo_put[:80]} notes={_kg_bo_res.length_report.notes}",
)

# THE RESTORE CAN GROW THE CV WITHOUT ANY TRIM RUNNING, and the report has to
# have a word for it. Under `max_pages=2` a 1-page CV that the restore takes to
# 2 never enters the refit branch at all, so the report read pages_before=1,
# pages_after=2, trimmed=False, notes=[] — a document that grew a page with no
# vocabulary anywhere for why. The false-positive half is the second conjunct:
# the note is only appended when the size actually CHANGED, so the earlier
# restore-on-a-one-pager fixture must not carry it.
_kg_grow_master = _Resume_b(
    contact=_Contact_b(name="Grow", email="gr@example.com"),
    summary=_kg_e2e_blurb * 14,
    skills=["Python"] + _kg_e2e_kw,
    experience=[_Experience_b(company="Acme", title="Engineer", start_date="2021",
                              end_date="Present", bullets=["Ran the platform."])],
)
_kg_grow_tailored = _kg_grow_master.model_dump()
_kg_grow_tailored["skills"] = ["Python"]
_kg_grow_tailored["skill_groups"] = []


def _kg_grow_canned(system, user, **kw):
    head = system[:40]
    if "TAILOR" in head:
        return {"tailored_resume": _kg_grow_tailored, "changelog": [], "covered_keywords": []}
    if "HUMANIZE" in head:
        return {"revised_resume": _kg_grow_tailored}
    return _kg_orig_cjson(system, user, **kw)


_kg_stub.complete_json = _kg_grow_canned
try:
    _kg_grow_res = _tailor_b(_kg_grow_master,
                             _JDModel_b(job_title="Backend Engineer",
                                        hard_skills=["Python"] + _kg_e2e_kw))
finally:
    _kg_stub.complete_json = _kg_orig_cjson
check(
    "a restore that grows the CV with no trim in sight says so in the length report",
    _kg_grow_res.length_report.pages_before == 1
    and _kg_grow_res.length_report.pages_after == 2
    and page_count(_kg_grow_res.tailored_resume) == 2
    and any("putting back skills" in n for n in _kg_grow_res.length_report.notes)
    and not any("putting back skills" in n for n in _kg_res.length_report.notes),
    f"{_kg_grow_res.length_report.pages_before} -> {_kg_grow_res.length_report.pages_after} "
    f"notes={_kg_grow_res.length_report.notes}",
)

# THE CAP IS A REAL TRADE, not a formality, and it reports itself. A restored
# entry is immune to `_drop_unmatched_skill`, so an uncapped restore is paid for
# by the refit out of PROJECTS and BULLETS — losing prose keywords to save skill
# keywords. Overflow is disclosed as `reason="cap"`, which is the only class a
# bigger number would fix.
_kg_cap_o = _Resume_b(
    contact=_Contact_b(name="Cap", email="cap@example.com"),
    skills=[f"skill{i}" for i in range(_KG_MAX + 5)],
)
_kg_cap_t = _kg_cap_o.model_copy(deep=True)
_kg_cap_t.skills = []
_kg_cap_out, _kg_cap_r, _kg_cap_k = _preserve(
    _kg_cap_o, _kg_cap_t, _JDModel_b(hard_skills=[f"skill{i}" for i in range(_KG_MAX + 5)])
)
check(
    "the restore is capped, and the overflow is reported as a cap rather than as prose",
    len(_kg_cap_r) == _KG_MAX
    and len(_kg_cap_out.skills) == _KG_MAX
    and [k.reason for k in _kg_cap_k] == ["cap"] * 5,
    f"restored={len(_kg_cap_r)} kept={[(k.keyword, k.reason) for k in _kg_cap_k]}",
)

# THE HUMANIZER GATE (mechanism 5). DRIVEN through `tailor_resume`, never by
# calling the predicate — a check that calls the gate helper directly still
# passes with the call site deleted, which is the reasoning CLAUDE.md records for
# the `finish_reason == "length"` pins.
#
# The default stub tailor audits CLEAN, so the humanizer branch never runs on it
# and a fixture built on it would pass by never firing (21.7's failure mode). So
# TAILOR and HUMANIZE are canned for this one block, on the singleton client, the
# way section 21b already cans `complete_json` — everything else delegates.
#
# The revision deletes "Kubernetes" from the one bullet that carries it, which is
# PROSE: the guard reports that class and never repairs it, so rejecting the
# revision is the only thing standing between the user and a permanently lost
# keyword. And it must be rejected FOR THAT REASON — the second check proves the
# three pre-existing conjuncts would all have accepted it, so nothing else can be
# doing the work.
_kg_hum_o = _Resume_b(
    contact=_Contact_b(name="Humanize Gate", email="hg@example.com"),
    summary="Engineer.",
    skills=["Python"],
    experience=[_Experience_b(company="Acme", title="Engineer", start_date="2021",
                              end_date="Present",
                              bullets=["Spearheaded the Kubernetes migration.",
                                       "Wrote Python services."])],
)
_kg_hum_jd = _JDModel_b(job_title="Platform Engineer", hard_skills=["Kubernetes"],
                        keywords=["Python"])
_kg_hum_tailored = _kg_hum_o.model_dump()
_kg_hum_revised = _json_kg.loads(_json_kg.dumps(_kg_hum_tailored))
# Banned verb gone (the voice score genuinely rises) — and Kubernetes with it.
_kg_hum_revised["experience"][0]["bullets"] = ["Led the container migration.",
                                               "Wrote Python services."]
def _kg_canned(system, user, **kw):
    head = system[:40]
    if "TAILOR" in head:
        return {"tailored_resume": _kg_hum_tailored, "changelog": [], "covered_keywords": []}
    if "HUMANIZE" in head:
        return {"revised_resume": _kg_hum_revised}
    return _kg_orig_cjson(system, user, **kw)


_kg_stub.complete_json = _kg_canned
try:
    _kg_hum_res = _tailor_b(_kg_hum_o, _kg_hum_jd)
finally:
    _kg_stub.complete_json = _kg_orig_cjson
check(
    "a humanizer revision that deletes a JD keyword is refused, and the keyword ships",
    "Kubernetes" in _kg_hum_res.tailored_resume.experience[0].bullets[0]
    and _kg_hum_res.voice_report.revised is False
    and _lost_keywords(_kg_hum_o, _kg_hum_res.tailored_resume, _kg_hum_jd) == [],
    f"bullets={_kg_hum_res.tailored_resume.experience[0].bullets} "
    f"revised={_kg_hum_res.voice_report.revised}",
)
_kg_hum_t_model = _Resume_b.model_validate(_kg_hum_tailored)
_kg_hum_r_model = _Resume_b.model_validate(_kg_hum_revised)
check(
    "...and it was refused for THAT reason: every pre-existing conjunct accepted it",
    _kg_check_fab(_kg_hum_r_model, _build_ledger(_kg_hum_o)) == []
    and _kg_audit(_kg_hum_r_model, _kg_hum_jd).human_voice_score
    > _kg_audit(_kg_hum_t_model, _kg_hum_jd).human_voice_score
    and page_count(_kg_hum_r_model) <= page_count(_kg_hum_t_model),
    f"voice {_kg_audit(_kg_hum_t_model, _kg_hum_jd).human_voice_score} -> "
    f"{_kg_audit(_kg_hum_r_model, _kg_hum_jd).human_voice_score} "
    f"flags={_kg_check_fab(_kg_hum_r_model, _build_ledger(_kg_hum_o))}",
)
# The humanizer's keep-list ("Keep the listed ATS keywords present") now carries
# `preferred_skills` too. Pinned by CAPTURING the prompt the humanizer actually
# builds, not by grepping its source: the source also carries a comment saying
# `preferred_skills`, so a grep stays green with the term deleted from the code.
_kg_keep_seen: list[str] = []


def _kg_keep_capture(system, user, **kw):
    if "HUMANIZE" in system[:40]:
        _kg_keep_seen.append(user)
    return _kg_orig_cjson(system, user, **kw)


_kg_stub.complete_json = _kg_keep_capture
try:
    _kg_humanizer_mod.humanize_resume(
        _kg_vh_o,
        _kg_audit(_kg_vh_o, None).issues,
        _JDModel_b(hard_skills=["Python"], preferred_skills=["Kubernetes Operators"]),
    )
finally:
    _kg_stub.complete_json = _kg_orig_cjson
check(
    "the humanizer's keep-list carries preferred_skills too",
    _kg_keep_seen and "Kubernetes Operators" in _kg_keep_seen[0],
    f"prompts captured={len(_kg_keep_seen)}",
)

# DETERMINISM, SOURCE-PINNED — the 22.10 / geo shape. Behaviour alone cannot pin
# this: an LLM-backed restorer returns a résumé and two lists exactly like this
# one, passes every check above, and puts a temperature=0.3 sample in charge of
# what the CV says. The length floor makes an unreadable module go red instead
# of passing by never firing.
import app.core.keyword_guard as _kg_mod  # noqa: E402
import app.core.tailor as _kg_tailor_mod  # noqa: E402
_KG_SRC = _kg_inspect.getsource(_kg_mod)
# Flattened so a check can read the SENTENCE the user is shown rather than the
# source lines it happens to be split across: collapse whitespace, then close the
# `" "` seam Python's implicit string concatenation leaves behind. Without this a
# re-wrap of the same literal — which changes nothing a user can see — turns a
# copy assertion red, and the tempting fix is to weaken it to a fragment.
_KG_TAILOR_FLAT = " ".join(_kg_inspect.getsource(_kg_tailor_mod).split()).replace('" "', "")
check(
    "keyword guard: source-pinned to no LLM and no network",
    len(_KG_SRC) > 2000
    and "get_llm_client" not in _KG_SRC
    and "complete_json" not in _KG_SRC
    and "complete_text" not in _KG_SRC
    and "import openai" not in _KG_SRC
    and "urllib" not in _KG_SRC
    and "requests" not in _KG_SRC,
    f"{len(_KG_SRC)} chars scanned",
)
# ...and it imports the ONE true matcher rather than carrying its own. A second
# matcher would disagree with the coverage number the user can see, in Hebrew,
# in the primary market — the Python twin of check-mirrors check 4.
#
# PARSED, NOT GREPPED, because the substring form did not fire on the likeliest
# defect there is here: this module already imports from `app.core.scorer`, and
# `scorer` itself imports `get_llm_client`. Append `fit_score` to that existing
# import line and the guard reaches the model — while the check above still finds
# no "get_llm_client"/"complete_json" anywhere in this source, and a check
# asserting the import LINE is a substring still finds it verbatim. Reading the
# ImportFrom node and demanding the set be EXACTLY the three matcher helpers is
# the only form that goes red on it. Probed with that exact line.
import ast as _kg_ast  # noqa: E402

_KG_SCORER_IMPORTS = {
    _kg_alias.name
    for _kg_node in _kg_ast.walk(_kg_ast.parse(_KG_SRC))
    if isinstance(_kg_node, _kg_ast.ImportFrom) and _kg_node.module == "app.core.scorer"
    for _kg_alias in _kg_node.names
}
check(
    "keyword guard: imports EXACTLY the scorer's three matcher helpers — never a "
    "second matcher, and never a fourth name off the module that reaches the LLM",
    _KG_SCORER_IMPORTS == {"_keyword_present", "_resume_text", "_tokens"}
    and "def _keyword_present" not in _KG_SRC
    and "def _resume_text" not in _KG_SRC,
    str(sorted(_KG_SCORER_IMPORTS)),
)
# This is NOT an LLM task, so CLAUDE.md's "any new LLM task must add a stub
# branch" rule deliberately does not apply — and a future reader must not add
# one. Pinned by comparing the client's branch count against the tasks that
# genuinely exist.
import app.llm.client as _kg_client_mod  # noqa: E402
_KG_CLIENT_SRC = _kg_inspect.getsource(_kg_client_mod)
check(
    "keyword guard: app/llm/client.py gained no stub branch for it",
    "KEYWORD_GUARD" not in _KG_CLIENT_SRC and "PRESERVE_KEYWORD" not in _KG_CLIENT_SRC,
)
# THE CEILING GETS THE SAME PINS AS THE FLOOR. `skills_shortlist` is the other
# half of the same trade and sits one line from it in `tailor.py`, so every way
# `keyword_guard` could go wrong is a way this can: reaching the model would put
# an LLM in charge of which skills ship, and carrying its own matcher would make
# it disagree with the guard about the same entry while both run on the same
# résumé, one line apart.
import app.core.skills_shortlist as _ss_mod  # noqa: E402

_SS_SRC = _kg_inspect.getsource(_ss_mod)
# IDENTIFIERS THE CODE ACTUALLY REFERENCES, not a substring scan of the file.
# The substring form went red the moment this module's docstring EXPLAINED the
# hazard by name — the module warns that `scorer` imports the client factory, so
# writing that warning down tripped the guard against it. That is the same
# can't-tell-an-import-from-a-mention defect the keyword-guard pins above are
# parsed to avoid, arriving from the other direction: there a mention passed as
# safe, here a mention failed as dangerous. Reading Name/Attribute/import nodes
# answers the question the check is actually asking.
_SS_TREE = _kg_ast.parse(_SS_SRC)
_SS_USED = (
    {n.id for n in _kg_ast.walk(_SS_TREE) if isinstance(n, _kg_ast.Name)}
    | {n.attr for n in _kg_ast.walk(_SS_TREE) if isinstance(n, _kg_ast.Attribute)}
    # DOTTED SEGMENTS as well as the bound name. `import urllib.request` binds
    # the single string "urllib.request", so a set built from `a.asname or
    # a.name` alone never intersects "urllib" and this check stayed GREEN with
    # the network imported. Found in 2026-09-03 by probing that exact line into
    # `ghost_signals`, whose pin is a copy of this one; fixed in both.
    | {
        part
        for n in _kg_ast.walk(_SS_TREE)
        if isinstance(n, (_kg_ast.Import, _kg_ast.ImportFrom))
        for a in n.names
        for part in {a.asname or a.name, *a.name.split(".")}
    }
    | {
        part
        for n in _kg_ast.walk(_SS_TREE)
        if isinstance(n, _kg_ast.ImportFrom) and n.module
        for part in {n.module, *n.module.split(".")}
    }
)
check(
    "skills shortlist: source-pinned to no LLM and no network",
    len(_SS_SRC) > 2000
    and not _SS_USED & {
        "get_llm_client", "complete_json", "complete_text",
        "openai", "urllib", "requests", "httpx", "socket",
    },
    f"{len(_SS_SRC)} chars, {len(_SS_USED)} identifiers",
)
_SS_SCORER_IMPORTS = {
    _ss_alias.name
    for _ss_node in _kg_ast.walk(_kg_ast.parse(_SS_SRC))
    if isinstance(_ss_node, _kg_ast.ImportFrom) and _ss_node.module == "app.core.scorer"
    for _ss_alias in _ss_node.names
}
check(
    "skills shortlist: imports EXACTLY the scorer's two matcher helpers — appending "
    "a fourth name to that line is how the model gets a vote on the CV",
    _SS_SCORER_IMPORTS == {"_keyword_present", "_tokens"}
    and "def _keyword_present" not in _SS_SRC,
    str(sorted(_SS_SCORER_IMPORTS)),
)
check(
    "skills shortlist: app/llm/client.py gained no stub branch for it",
    "SHORTLIST" not in _KG_CLIENT_SRC and "SKILLS_CAP" not in _KG_CLIENT_SRC,
)
# THE ANTI-MINTING RULE, AND ESPECIALLY ITS SECOND HALF. Measured over 18 real-key
# runs per arm: naming the observed leaks and forbidding minting cut unambiguous
# fabrications (Linux, Agile, ChatGPT, Slack, Jira, bash, AWS/GCP/Azure,
# "candidate sourcing") from 0.78 to 0.22 per run, p=0.0018 against the pooled
# control rate.
#
# The RELOCATION PERMISSION is what makes it safe, and it is the half a future
# edit would delete while "tightening" the rule. Two independently designed arms
# forbade moving a term from a bullet up into the skills list and BOTH lost 9-13
# keyword-coverage points, because the page budget deletes the project that
# carried the term and the skills list is the only place left to keep it. Any
# rewrite that drops these sentences re-opens a measured regression, so both
# halves are pinned, not just the prohibition.
from app.llm import prompts as _mint_prompts  # noqa: E402

check(
    "TAILOR prompt: the anti-minting rule survives",
    "THE TEST FOR A SKILLS ENTRY IS A SEARCH, NOT A JUDGEMENT" in _mint_prompts.TAILOR_SYSTEM
    and "found only in the job ad, forbidden" in _mint_prompts.TAILOR_SYSTEM,
)
check(
    "TAILOR prompt: ...and so does the relocation permission that keeps it from "
    "costing coverage",
    "PROMOTING IS NOT INVENTING" in _mint_prompts.TAILOR_SYSTEM
    and "The boundary is the RESUME, not the section" in _mint_prompts.TAILOR_SYSTEM,
)
# ONE CALL SITE, inside `tailor_resume`. Not `routes.py` ("thin FastAPI
# handlers... No business logic here"), not `kits.py` (which reaches the same
# function through `tailor_fn`). A second site would classify on a DIFFERENT gate
# and contradict this one about the same résumé — the geo-restriction correction,
# which CLAUDE.md records as the one that mattered most.
#
# The importer set is COMPUTED by walking every module the app ships rather than
# by naming the two files that got it wrong last time: `routes.py` and `kits.py`
# are where a second site would go TODAY, and a scan finds tomorrow's too.
#
# PARSED, not grepped, for the same reason the matcher pin above is: a text
# search cannot tell an IMPORT from a MENTION. The two modules that have to
# agree about the matcher now cross-reference each other in their comments —
# `length_budget` records which matcher it protects an entry with and why it is
# that one — and a grep read that documentation as a second call site. Every
# import spelling is read (`from app.core.keyword_guard import x`, `from
# app.core import keyword_guard`, `import app.core.keyword_guard`, and the
# relative forms), so the check cannot be dodged by writing it differently, and
# the scanned count keeps a broken glob from passing on an empty walk.
_KG_APP_DIR = _Path_kg(_kg_humanizer_mod.__file__).parents[1]   # …/app, never cwd
_KG_IMPORTERS: list[str] = []
_KG_SCANNED = 0
for _kg_py in sorted(_KG_APP_DIR.rglob("*.py")):
    _KG_SCANNED += 1
    for _kg_n in _kg_ast.walk(_kg_ast.parse(_kg_py.read_text(encoding="utf-8"))):
        if isinstance(_kg_n, _kg_ast.ImportFrom):
            _kg_hit = ((_kg_n.module or "").split(".")[-1] == "keyword_guard"
                       or any(a.name == "keyword_guard" for a in _kg_n.names))
        elif isinstance(_kg_n, _kg_ast.Import):
            _kg_hit = any(a.name.split(".")[-1] == "keyword_guard" for a in _kg_n.names)
        else:
            continue
        if _kg_hit:
            _KG_IMPORTERS.append(str(_kg_py.relative_to(_KG_APP_DIR)).replace("\\", "/"))
            break
check(
    "keyword guard: exactly one importer in the whole app — core/tailor.py",
    _KG_IMPORTERS == ["core/tailor.py"] and _KG_SCANNED > 40,
    f"{_KG_IMPORTERS} ({_KG_SCANNED} modules scanned)",
)

# STEP 5: the prompt is the first line of defence and the guard is the floor
# under it — the same relationship `length_budget`'s docstring describes ("the
# LLM is *asked* to curate... but asked is not guaranteed"). Both halves of the
# prompt change are pinned, because a self-check the model never reads is not a
# defence.
check(
    "TAILOR rule 2 forbids dropping a skill the job asks for",
    "NEVER DROP A SKILL THIS JOB ASKS FOR" in _prompts.TAILOR_SYSTEM
    and "It never means one it does." in _prompts.TAILOR_SYSTEM
    and "plus however many" in _prompts.TAILOR_SYSTEM,
)
check(
    "TAILOR's self-check runs the REVERSE scan, not only output ⊆ original",
    "THE REVERSE SCAN" in _prompts.TAILOR_SYSTEM
    and "ONE TERM AT A TIME" in _prompts.TAILOR_SYSTEM,
)

# STEP 6 (option ii): `drop_invented_roles` filters `tailored.experience` and
# appends NOTHING to `projects`, so the old reason string — "Kept in Projects
# where they belong" — asserted a preservation the code does not perform
# whenever the model moved a project up rather than copying it. Reproduced: a
# promoted row carrying "Go" and "delivery platform" was cut while the changelog
# claimed the content survived. Fixed by making the sentence true, not by
# re-homing the row: that would take content the ledger could not verify and
# move it into the section the fabrication guard checks least.
_kg_promo = _Resume_b(
    contact=_Contact_b(name="Promoted", email="pm@example.com"),
    experience=[_Experience_b(company="Fixr Solutions", title="Engineer", start_date="2021",
                              end_date="Present", bullets=["Built things."])],
)
_kg_promo_led = _build_ledger(_kg_promo)
_kg_promo_t = _kg_promo.model_copy(deep=True)
_kg_promo_t.experience.append(
    _Experience_b(company="Ziko", title="Founder", start_date="2024", end_date="Present",
                  bullets=["Built a Go delivery platform."])
)
_kg_promo_out, _kg_promo_removed = _drop_roles(_kg_promo_t, _kg_promo_led)
check(
    "the invented-role changelog no longer claims a preservation the code does not perform",
    _kg_promo_removed == ["Ziko"]
    and _kg_promo_out.projects == []          # nothing was re-homed — the claim was false
    and "Kept in Projects where they belong" not in _KG_TAILOR_FLAT
    and "it is in Projects only if the rewrite kept it there" in _KG_TAILOR_FLAT,
    f"projects={_kg_promo_out.projects}",
)

# ---------------------------------------------------------------------------
# 24b. One bad posting must not sink a whole search (PLAN 20.5 / C3). A search
# fires up to 25 concurrent LLM calls, so a single 500 or a mangled JSON body is
# not a rare event — it used to propagate through future.result() and turn 24
# scored jobs into a 502.
# ---------------------------------------------------------------------------
import app.core.job_search as _js_mod  # noqa: E402


class _FlakyBoard:
    """Three postings; the middle one's description makes scoring explode."""

    name = "fake_flaky"

    def search(self, ctx):  # noqa: ANN001
        return [
            _FanHit(source=self.name, title="Python Developer", company="OkCo",
                    description="Python and SQL work", url="https://fake.flaky/1"),
            _FanHit(source=self.name, title="Python Developer", company="BoomCo",
                    description="BOOM Python and SQL work", url="https://fake.flaky/2"),
            _FanHit(source=self.name, title="Python Developer", company="AlsoOkCo",
                    description="Python and REST work", url="https://fake.flaky/3"),
        ]

    def fetch_description(self, hit):  # noqa: ANN001
        return hit.description


_orig_analyze_and_score = _js_mod.analyze_and_score


def _boom_on_marker(_resume, jd_text):  # noqa: ANN001
    if "BOOM" in jd_text:
        raise RuntimeError("simulated model 500")
    return _orig_analyze_and_score(_resume, jd_text)


_PROV["fake_flaky"] = _FlakyBoard()
_js_mod.analyze_and_score = _boom_on_marker
try:
    _flaky_res = _fan_search(resume, _AlertCtx(job_title="Python Developer", sources=["fake_flaky"]))
    check(
        "a job that fails to score is skipped, the rest of the search survives",
        len(_flaky_res.matches) == 2
        and _flaky_res.skipped == 1
        and "https://fake.flaky/2" not in {m.url for m in _flaky_res.matches},
        f"{len(_flaky_res.matches)} matches, skipped={_flaky_res.skipped}",
    )

    # Every job failing must report the REAL reason, not "the boards may be throttling".
    _js_mod.analyze_and_score = lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("simulated model 500"))
    _all_failed_msg = ""
    try:
        _fan_search(resume, _AlertCtx(job_title="Python Developer", sources=["fake_flaky"]))
    except ValueError as _e:
        _all_failed_msg = str(_e)
    check(
        "an all-failed search names the real error instead of blaming the boards",
        "couldn't score any of them" in _all_failed_msg
        and "simulated model 500" in _all_failed_msg
        and "throttling" not in _all_failed_msg,
        _all_failed_msg[:90],
    )
finally:
    _js_mod.analyze_and_score = _orig_analyze_and_score
    _PROV.pop("fake_flaky", None)


# ---------------------------------------------------------------------------
# 25. SSRF guard + upload limits (PLAN 20.6 / S1+S3). Hermetic: every host here
# is a literal IP or `localhost`, so getaddrinfo never leaves the machine.
# ---------------------------------------------------------------------------
from app.core.net_guard import (  # noqa: E402
    BlockedURLError,
    _GuardedRedirectHandler,
    assert_fetchable,
    is_public_ip,
)

check(
    "is_public_ip allows real public v4/v6",
    all(is_public_ip(ip) for ip in ("8.8.8.8", "93.184.216.34", "2606:4700::1111")),
)
check(
    "is_public_ip blocks loopback / RFC1918 / link-local / CGNAT / v6-local / junk",
    not any(
        is_public_ip(ip)
        for ip in (
            "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1",
            "169.254.169.254",  # the cloud metadata endpoint — the one that matters
            "100.64.0.1",       # CGNAT: is_private does NOT catch this, is_global does
            "0.0.0.0", "::1", "fd00::1", "fe80::1", "224.0.0.1", "not-an-ip", "",
        )
    ),
)


def _blocked(url: str) -> bool:
    try:
        assert_fetchable(url)
    except BlockedURLError:
        return True
    return False


check(
    "assert_fetchable refuses metadata, loopback and private literals",
    all(
        _blocked(u)
        for u in (
            "http://169.254.169.254/latest/meta-data/",
            "http://127.0.0.1:8000/admin/users",
            "http://localhost:8000/health",
            "http://[::1]:8000/",
            "http://10.0.0.5/jobs/1",
            "http://100.64.0.1/",
        )
    ),
)
check(
    "assert_fetchable refuses non-http schemes and host-less URLs",
    all(_blocked(u) for u in ("file:///etc/passwd", "gopher://x/", "ftp://internal/", "http:///x")),
)
check(
    "assert_fetchable allows a publicly routable host",
    not _blocked("https://8.8.8.8/jobs/view/1"),
)
# The redirect hop is the bypass that makes checking only the typed URL
# worthless: harmless.example -> 302 -> 169.254.169.254.
_redir_blocked = False
try:
    _GuardedRedirectHandler().redirect_request(
        None, None, 302, "Found", {}, "http://169.254.169.254/latest/meta-data/"
    )
except BlockedURLError:
    _redir_blocked = True
check("guarded redirect handler re-checks each hop", _redir_blocked)

# Upload caps. MAX_UPLOAD_MB is 1 for this suite (set at the top).
with TestClient(_fastapi_app) as _tc:
    _too_big = b"x" * (1024 * 1024 + 1024)
    check(
        "public scan refuses an over-cap upload with 413",
        _tc.post(
            "/public/scan",
            files={"file": ("big.txt", _too_big, "text/plain")},
            data={"jd_text": "Python developer"},
        ).status_code == 413,
    )
    # A prompt-size limit must reach the user as a 413 carrying a STRUCTURED
    # detail, not as the generic 502 the 26 route wrappers produce. Both halves
    # matter: 502 is a 5xx, so Sentry keeps filing an issue the user could have
    # acted on, and the sentence would be an untranslatable English string.
    # This is the one check that covers the `except _SIZE_ERRORS: raise`
    # clauses — deleting them makes the guard fire and the response still wrong.
    _size_resp = _tc.post(
        "/resume/upload",
        files={"file": ("huge.txt", ("Jane Doe\n" + "Built services. " * 22000).encode(), "text/plain")},
        headers=_ADMIN_H,
    )
    _size_detail = _size_resp.json().get("detail")
    check(
        "an oversize résumé is a 413 with a structured detail, not an 'LLM error' 502",
        _size_resp.status_code == 413
        and isinstance(_size_detail, dict)
        and _size_detail.get("code") == "input_too_large"
        and _size_detail.get("kind") == "resume"
        and _size_detail.get("cap_kb") == get_settings().max_resume_kb,
        f"{_size_resp.status_code} {_size_detail}",
    )
    _jd_resp = _tc.post(
        "/jd/analyze", json={"jd_text": "x" * (40 * 1024)}, headers=_ADMIN_H
    )
    check(
        "an oversize pasted JD is a 413 naming the JD, not the résumé",
        _jd_resp.status_code == 413
        and (_jd_resp.json().get("detail") or {}).get("kind") == "jd",
        f"{_jd_resp.status_code} {_jd_resp.json().get('detail')}",
    )
    check(
        "an under-cap upload still goes through",
        _tc.post(
            "/public/scan",
            files={"file": ("resume.txt", b"Dana Levi\nPython, SQL\n" + b"filler " * 1000, "text/plain")},
            data={"jd_text": "Python and SQL required."},
        ).status_code == 200,
    )

# PDF page ceiling: refused BEFORE extraction, which is the expensive half.
import io as _io  # noqa: E402

from reportlab.pdfgen import canvas as _rl_canvas  # noqa: E402

from app.config import get_settings as _get_settings  # noqa: E402

_many = _io.BytesIO()
_c = _rl_canvas.Canvas(_many)
for _i in range(_get_settings().max_pdf_pages + 10):
    _c.drawString(72, 720, f"page {_i}")
    _c.showPage()
_c.save()
_pdf_bomb_refused = False
try:
    _li_extract_text("bomb.pdf", _many.getvalue())
except ValueError:
    _pdf_bomb_refused = True
check(
    "a PDF over the page ceiling is refused before extraction",
    _pdf_bomb_refused,
    f"limit {_get_settings().max_pdf_pages}",
)
check(
    "a normal-length PDF still parses",
    bool(_li_extract_text("resume.pdf", render_pdf(resume)).strip()),
)

# ---------------------------------------------------------------------------
# 26. LLM cost control (PLAN 20.6/S2 + 20.8/N2): the 17 previously-free routes
# are capped, and what they actually SPEND is recorded.
# ---------------------------------------------------------------------------
from sqlalchemy import select as _select  # noqa: E402

from app.core.usage import TOKENS_ACTION  # noqa: E402
from app.db.database import SessionLocal as _Session  # noqa: E402
from app.db.models import UsageLog as _UsageLog  # noqa: E402
from app.llm.metering import meter as _meter, record as _record  # noqa: E402

# --- N2: tokens spent inside the search's WORKER THREADS reach the request's
# tally. This is the check that matters: a pool worker starts from an empty
# context, so without copy_context() the biggest spender in the app reports 0
# and nothing anywhere goes red.
_meter_calls = {"n": 0}


class _MeterBoard:
    name = "fake_meter"

    def search(self, ctx):  # noqa: ANN001
        return [
            _FanHit(source=self.name, title="Python Developer", company=f"Co{i}",
                    description="Python and SQL work", url=f"https://fake.meter/{i}")
            for i in range(3)
        ]

    def fetch_description(self, hit):  # noqa: ANN001
        return hit.description


def _recording_analyze(_resume, jd_text):  # noqa: ANN001
    _meter_calls["n"] += 1
    _record(100, 20)  # what OpenAIClient._metered does with resp.usage
    return _orig_analyze_and_score(_resume, jd_text)


_PROV["fake_meter"] = _MeterBoard()
_js_mod.analyze_and_score = _recording_analyze
try:
    with _meter() as _tally:
        _fan_search(resume, _AlertCtx(job_title="Python Developer", sources=["fake_meter"]))
    check(
        "tokens spent in the search's worker threads reach the request tally",
        _meter_calls["n"] == 3 and _tally.calls == 3 and _tally.prompt == 300 and _tally.completion == 60,
        f"scored={_meter_calls['n']} tally calls={_tally.calls} prompt={_tally.prompt}",
    )
finally:
    _js_mod.analyze_and_score = _orig_analyze_and_score
    _PROV.pop("fake_meter", None)

check("record() outside a meter is a harmless no-op", _record(999, 999) is None)

with TestClient(_fastapi_app) as _tc:
    _cap_user = _tc.post("/admin/users", json={"name": "Cap Tester"}, headers=_ADMIN_H).json()
    _CAP_H = {"X-App-Key": _cap_user["invite_code"]}

    # --- S2: a previously-free route now charges the llm cap (3 for this suite).
    _jd_body = {"jd_text": "Python developer. Python and SQL required."}
    _codes = [_tc.post("/jd/analyze", json=_jd_body, headers=_CAP_H).status_code for _ in range(4)]
    check(
        "previously-uncapped LLM routes now charge the daily llm cap",
        _codes[:3] == [200, 200, 200] and _codes[3] == 429,
        str(_codes),
    )
    _over = _tc.post("/tools/follow-up",
                     json={"company": "Acme", "role": "Engineer", "stage": "after_apply", "context": ""},
                     headers=_CAP_H)
    check(
        "the cap is shared across all of them, with the structured detail",
        _over.status_code == 429
        and _over.json()["detail"] == {"code": "daily_limit", "action": "llm", "cap": 3},
        _over.text[:120],
    )
    check(
        "admin stays exempt from the llm cap",
        all(_tc.post("/jd/analyze", json=_jd_body, headers=_ADMIN_H).status_code == 200 for _ in range(4)),
    )
    # This pin used to send `jd_text: ""` — the ONE value that never enters the
    # coverage branch — under a label asserting the route calls no model, while
    # the route ran analyze_jd on any real posting. It could not fail in either
    # direction: with text it spent silently (no Depends to 429 it), without it
    # the branch was skipped. A check that passes by never firing, verbatim.
    #
    # Three pins now, each of which can actually go red. The behavioural one
    # alone is still not enough — a re-introduced analyze_jd would return 200
    # too, since there is no cap to trip — so the SHAPE and the SOURCE are
    # pinned as well. Those are what make a regression impossible to miss.
    _ats_jd = {"hard_skills": ["Python", "SQL"], "keywords": ["Python"]}
    _ats_ok = _tc.post("/tools/ats-scan", json={"resume": _resume_json, "jd": _ats_jd}, headers=_CAP_H)
    check(
        "deterministic tools are NOT charged (ats-scan scores a REAL jd on an exhausted cap)",
        _ats_ok.status_code == 200 and _ats_ok.json()["keyword_coverage"] > 0,
        _ats_ok.text[:120],
    )
    check(
        "ats-scan refuses raw job-ad text — an uncapped route may never reach the model",
        _tc.post("/tools/ats-scan", json={"resume": _resume_json, "jd_text": "we need python"},
                 headers=_CAP_H).status_code == 422,
    )
    import inspect as _inspect_ats  # noqa: E402

    import app.core.ats_scan as _ats_mod  # noqa: E402

    _ats_src = _inspect_ats.getsource(_ats_mod)
    check(
        "ats_scan's SOURCE reaches no model — the uncapped route's whole justification",
        # Fail loudly rather than silently passing on an unreadable module.
        len(_ats_src) > 2000
        and "analyze_jd" not in _ats_src
        and "get_llm_client" not in _ats_src,
        f"{len(_ats_src)} chars scanned",
    )
    check(
        "deterministic tools are NOT charged (ats-xray renders + re-parses, no model)",
        all(_tc.post("/tools/ats-xray", json={"resume": _resume_json, "template": "classic"},
                     headers=_CAP_H).status_code == 200 for _ in range(3)),
    )
    check(
        "deterministic tools are NOT charged (page-count is one reportlab build, no model)",
        all(_tc.post("/tools/page-count", json={"resume": _resume_json, "template": "classic"},
                     headers=_CAP_H).status_code == 200 for _ in range(3)),
    )
    _jd_json = jd.model_dump(mode="json")
    check(
        "deterministic tools are NOT charged (coverage is pure Python, no model)",
        all(_tc.post("/tools/coverage", json={"resume": _resume_json, "jd": _jd_json},
                     headers=_CAP_H).status_code == 200 for _ in range(3)),
    )
    # The route must report the SAME number the scorer computes, not a literal.
    from app.core.scorer import keyword_analysis as _ka  # noqa: E402

    _cov = _tc.post("/tools/coverage", json={"resume": _resume_json, "jd": _jd_json},
                    headers=_CAP_H).json()
    _pct, _gaps = _ka(ResumeModel.model_validate(_resume_json), jd)
    check(
        f"coverage route == scorer.keyword_analysis() — {_cov['keyword_coverage']}%",
        _cov["keyword_coverage"] == _pct and _cov["total"] == len(_gaps),
        _cov,
    )
    check(
        "coverage tallies partition the gaps exactly — no keyword counted twice or dropped",
        _cov["covered"] + _cov["partial"] + _cov["missing"] == _cov["total"],
        _cov,
    )
    # The route takes an ANALYSED JDModel and nothing else. A `jd_text` field
    # would have to be run through analyze_jd to be useful, which is an LLM
    # call — and this route is uncapped, so that would be a free door onto the
    # model. Pin the shape, not just the behaviour.
    check(
        "coverage refuses raw job-ad text — an uncapped route may never reach the model",
        _tc.post("/tools/coverage", json={"resume": _resume_json, "jd_text": "we need python"},
                 headers=_CAP_H).status_code == 422,
    )

    # --- /jobs/fit: "check fit" before any tailoring ------------------------ #
    # It reads the posting, so it IS charged — the whole point of the surface is
    # that the cost is stated rather than hidden.
    _fit_body = {"resume": _resume_json, "jd_text": "Python developer. Python, SQL and REST APIs required."}
    _fit = _tc.post("/jobs/fit", json=_fit_body, headers=_ADMIN_H).json()
    check(
        f"/jobs/fit returns BOTH halves plus the analysed JD from one round-trip — cov={_fit['keyword_coverage']} fit={_fit['fit_score']}",
        _fit["jd"]["keywords"] is not None
        and _fit["total"] == len(_fit["gaps"])
        and _fit["covered"] + _fit["partial"] + _fit["missing"] == _fit["total"],
        {k: _fit[k] for k in ("keyword_coverage", "fit_score", "covered", "partial", "missing", "total")},
    )
    check(
        "/jobs/fit carries NO `overall` — a live half averaged with a frozen sample is the "
        "number this surface exists to stop showing",
        "overall" not in _fit,
        sorted(_fit),
    )
    # The JD it hands back must be tailorable, or "check fit then tailor" pays to
    # read the same posting twice. job_search already relies on this internally;
    # the route makes it a contract.
    from app.models import JDModel as _JD_fit  # noqa: E402

    _fit_jd = _JD_fit.model_validate(_fit["jd"])
    _fit_tailored = tailor_resume(ResumeModel.model_validate(_resume_json), _fit_jd)
    check(
        "/jobs/fit's JD is tailorable — so checking fit first costs no extra model call",
        isinstance(_fit_tailored.tailored_resume, ResumeModel) and _fit_tailored.tailored_resume.experience is not None,
    )
    check(
        "/jobs/fit IS charged — reading a posting is a model call and the UI says so",
        _tc.post("/jobs/fit", json=_fit_body, headers=_CAP_H).status_code in (200, 429)
        and _tc.post("/jobs/fit", json=_fit_body, headers=_CAP_H).status_code == 429,
    )
    check(
        "/jobs/fit refuses empty text instead of spending a call on nothing",
        _tc.post("/jobs/fit", json={"resume": _resume_json, "jd_text": "   "},
                 headers=_ADMIN_H).status_code == 400,
    )
    check(
        "/render is NOT charged either — CLAUDE.md claims this exclusion is pinned, so pin it",
        _tc.post("/render", json={"resume": _resume_json, "fmt": "pdf", "template": "classic"},
                 headers=_CAP_H).status_code == 200,
    )

    # The route must report the SAME number the renderer measures, not a literal
    # — otherwise it drifts silently the first time pagination changes.
    from app.render.pdf_renderer import page_count as _pc  # noqa: E402

    _pc_body = _tc.post("/tools/page-count", json={"resume": _resume_json, "template": "classic"},
                        headers=_CAP_H).json()
    check(
        f"page-count route == pdf_renderer.page_count() — {_pc_body['pages']}",
        _pc_body["pages"] == _pc(ResumeModel.model_validate(_resume_json), template="classic"),
        _pc_body,
    )
    check(
        "page-count echoes the RESOLVED template, so an unknown id cannot silently measure another doc",
        _tc.post("/tools/page-count", json={"resume": _resume_json, "template": "no-such-template"},
                 headers=_CAP_H).json()["template"] == "classic",
    )
    check(
        "page-count carries the live budget, so the UI never reads a stale length_report",
        _pc_body["max_pages"] == get_settings().resume_max_pages
        and _pc_body["hard_max_pages"] == get_settings().resume_hard_max_pages,
        _pc_body,
    )
    # The true-positive, and it needs its OWN fixture: the shared `resume` stub
    # carries zero projects, so the obvious `projects * 8` grows nothing and the
    # check would pass by never firing — the 21.7 failure mode exactly.
    # Restoring curated content must be able to CHANGE the number, or the badge
    # the UI draws from it is decoration.
    _big = ResumeModel.model_validate(_resume_json).model_copy(deep=True)
    _big.projects = [
        Project(name=f"Restored project {i}", description="A substantial delivery with real scope. " * 12)
        for i in range(12)
    ]
    _big_pages = _tc.post("/tools/page-count",
                          json={"resume": _big.model_dump(mode="json"), "template": "classic"},
                          headers=_CAP_H).json()["pages"]
    check(
        f"page-count grows when curated content is restored — {_pc_body['pages']} -> {_big_pages}",
        _big_pages > _pc_body["pages"],
    )

    # --- N2 end to end: middleware tally -> endpoint -> dependency -> UsageLog.
    import app.api.routes as _routes_mod  # noqa: E402

    _orig_route_analyze = _routes_mod.analyze_jd

    def _spending_analyze(jd_text):  # noqa: ANN001
        _record(1234, 567)
        return _orig_route_analyze(jd_text)

    _routes_mod.analyze_jd = _spending_analyze
    try:
        _tc.post("/jd/analyze", json=_jd_body, headers=_ADMIN_H)
    finally:
        _routes_mod.analyze_jd = _orig_route_analyze

    _tok_db = _Session()
    try:
        _tok_row = _tok_db.execute(
            _select(_UsageLog).where(_UsageLog.action == TOKENS_ACTION).order_by(_UsageLog.id.desc())
        ).scalars().first()
    finally:
        _tok_db.close()
    check(
        "a metered request writes real token counts to usage_log",
        _tok_row is not None
        and _tok_row.prompt_tokens >= 1234
        and _tok_row.completion_tokens >= 567,
        f"prompt={getattr(_tok_row, 'prompt_tokens', None)} completion={getattr(_tok_row, 'completion_tokens', None)}",
    )
    check(
        "token rows never collide with the count-based cap actions",
        _tok_row is not None and _tok_row.action == TOKENS_ACTION and TOKENS_ACTION not in ("llm", "tailor", "search"),
    )

# ---------------------------------------------------------------------------
# 27. Master résumé version history (PLAN 20.8 / N1): PUT /profile/resume
# overwrites in place, so these are the undo.
# ---------------------------------------------------------------------------
from app.db.resume_versions import MAX_VERSIONS as _MAX_VERSIONS  # noqa: E402

with TestClient(_fastapi_app) as _tc:
    _vu = _tc.post("/admin/users", json={"name": "Version Tester"}, headers=_ADMIN_H).json()
    _VH = {"X-App-Key": _vu["invite_code"]}

    def _put_resume(headline: str, headers=_VH):  # noqa: ANN001
        r = resume.model_copy(deep=True)
        r.headline = headline
        return _tc.put("/profile/resume", json={"resume": r.model_dump(), "label": "M"}, headers=headers)

    def _versions(headers=_VH):  # noqa: ANN001
        return _tc.get("/profile/resume/versions", headers=headers).json()["versions"]

    _put_resume("Backend Engineer")
    check("the first save creates no version (nothing was overwritten)", _versions() == [])

    _put_resume("Platform Engineer")
    _v = _versions()
    check(
        "overwriting snapshots the OUTGOING content, not the incoming one",
        len(_v) == 1 and _v[0]["headline"] == "Backend Engineer",
        str([x["headline"] for x in _v]),
    )

    _put_resume("Platform Engineer")  # byte-identical re-save
    check(
        "an identical re-save is not a new restore point",
        len(_versions()) == 1,
        str(len(_versions())),
    )

    # Restore must bring back the old content AND keep the current one reachable,
    # so a mis-click in the picker can't be what loses the résumé.
    _restore = _tc.post(f"/profile/resume/versions/{_v[0]['id']}/restore", headers=_VH)
    check(
        "restore makes the old content current again",
        _restore.status_code == 200 and _restore.json()["resume"]["headline"] == "Backend Engineer",
        f"{_restore.status_code} {_restore.text[:90]}",
    )
    check(
        "the master really changed, not just the response",
        _tc.get("/profile/resume", headers=_VH).json()["resume"]["headline"] == "Backend Engineer",
    )
    check(
        "restoring is itself undoable — the replaced state became a version",
        "Platform Engineer" in [x["headline"] for x in _versions()],
        str([x["headline"] for x in _versions()]),
    )

    # Language isolation: the he/en masters are separate slots and a restore
    # must never cross them.
    _he = ResumeModel(
        contact=Contact(name="דנה לוי"), headline="מהנדסת תוכנה",
        summary="מהנדסת תוכנה עם ניסיון בפייתון.",
        experience=[Experience(company="אקמי", title="מהנדסת", start_date="2020", end_date="2023")],
    )
    _tc.put("/profile/resume", json={"resume": _he.model_dump(), "label": "HE"}, headers=_VH)
    _he2 = _he.model_copy(deep=True)
    _he2.headline = "מפתחת בכירה"
    _tc.put("/profile/resume", json={"resume": _he2.model_dump(), "label": "HE"}, headers=_VH)
    _he_versions = [x for x in _versions() if x["language"] == "he"]
    check("hebrew saves version into their own language slot", len(_he_versions) == 1, str(_he_versions))
    _tc.post(f"/profile/resume/versions/{_he_versions[0]['id']}/restore", headers=_VH)
    check(
        "restoring a hebrew version leaves the english master untouched",
        _tc.get("/profile/resume", params={"lang": "en"}, headers=_VH).json()["resume"]["headline"]
        == "Backend Engineer"
        and _tc.get("/profile/resume", params={"lang": "he"}, headers=_VH).json()["resume"]["headline"]
        == "מהנדסת תוכנה",
    )

    # Another user's version is invisible AND unrestorable — it holds a full résumé.
    _other = _tc.post("/admin/users", json={"name": "Other"}, headers=_ADMIN_H).json()
    _OH = {"X-App-Key": _other["invite_code"]}
    _victim_id = _v[0]["id"]
    check(
        "another user can neither read nor restore your version",
        _tc.get(f"/profile/resume/versions/{_victim_id}", headers=_OH).status_code == 404
        and _tc.post(f"/profile/resume/versions/{_victim_id}/restore", headers=_OH).status_code == 404
        and _versions(_OH) == [],
    )

    # The buffer is capped: this is undo, not an archive.
    for _i in range(_MAX_VERSIONS + 5):
        _put_resume(f"Role {_i}")
    _en_versions = [x for x in _versions() if x["language"] == "en"]
    check(
        f"version history is capped at {_MAX_VERSIONS} per language",
        len(_en_versions) == _MAX_VERSIONS,
        str(len(_en_versions)),
    )
    check(
        "the cap drops the OLDEST, keeping the most recent restore points",
        _en_versions[0]["headline"] == f"Role {_MAX_VERSIONS + 3}",
        str([x["headline"] for x in _en_versions[:3]]),
    )

    # Privacy: these rows hold full past résumés, so the wipe must take them.
    _wiped = _tc.delete("/profile/data", headers=_VH)
    check(
        "delete-my-data wipes version history too",
        _wiped.status_code == 200
        and _wiped.json()["resume_versions"] >= _MAX_VERSIONS
        and _versions() == [],
        _wiped.text[:120],
    )

    # PLAN 07/7: the user's STORED document is never rewritten. Skill
    # normalisation lives at exactly one door — `structure_resume`, on the LLM's
    # fresh output — and a `model_validator` would have made every read of this
    # row a silent rewrite. The behavioural twin of the source pin in 18e, and
    # the half that catches an inline COPY of the splitter, which the grep
    # cannot see. Both halves here: what comes back is what went in, AND the
    # byte-identical dedupe still recognises the re-save, so an unchanged save
    # burns none of the 20 undo slots.
    _ns_user = _tc.post("/admin/users", json={"name": "Skill Saver"}, headers=_ADMIN_H).json()
    _NSH = {"X-App-Key": _ns_user["invite_code"]}
    _ns_stored = resume.model_copy(deep=True)
    _ns_stored.skills = ["Python, SQL", "Go"]
    _ns_stored.skill_groups = []
    _ns_body = {"resume": _ns_stored.model_dump(), "label": "S"}
    _tc.put("/profile/resume", json=_ns_body, headers=_NSH)
    _ns_back = _tc.get("/profile/resume", headers=_NSH).json()["resume"]["skills"]
    _tc.put("/profile/resume", json=_ns_body, headers=_NSH)  # byte-identical re-save
    check(
        "a STORED résumé is never re-written: the un-split entry comes back "
        "verbatim and the identical re-save still burns no undo slot",
        _ns_back == ["Python, SQL", "Go"]
        and _tc.get("/profile/resume/versions", headers=_NSH).json()["versions"] == [],
        str(_ns_back),
    )

_reached_end = True
print(f"\n{_ran} checks ran.")
print("ALL PASSED" if not failures else f"FAILURES: {failures}")
raise SystemExit(1 if failures else 0)
