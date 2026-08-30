"""Real-key A/B harness for the TAILOR prompt.

**NOT part of the smoke test, and it must never become part of it.** Every run
makes ~5 real OpenAI calls and spends the account's credit; `tests/smoke_test.py`
is the offline suite and stays offline. This module exists because every
prompt-quality claim in this repo is otherwise unmeasured: the smoke test drives
`tailor_resume` through `StubClient`, which pins the *mechanism* and says nothing
about whether the real model curates well.

The defect it was written for, in the user's own words after using the live app:
*"i just tried it and its still bad, too many skills under the skills part."*
Measured baseline: the stored master carries 66 skills and three real tailored
CVs in `jobfinder.db` shipped 60, 66 and 64 -- against a prompt that asks for
"roughly 15-25".

METHOD. Hold the resume and the JDs constant, vary one thing (the TAILOR system
prompt, optionally a knob), run every (variant x job x rep) cell, and score each
result on numbers that already exist in the app. Two rules make the comparison
honest:

  1. **The JD is analysed ONCE and cached.** `analyze_jd` is itself an LLM call
     at temperature, so re-running it per variant would vary the *input* while
     claiming to vary the prompt -- and it would silently move the coverage
     denominator, which is the metric under test.
  2. **Every variant is scored by the same deterministic functions the app
     ships** (`scorer.keyword_analysis`, `keyword_guard.lost_keywords`,
     `voice_audit`, `pdf_renderer.page_count`). A harness that invents its own
     matcher measures its own opinion -- the mistake CLAUDE.md's "one matcher,
     one answer" rule exists to prevent.

THE COUNTERWEIGHT METRIC IS THE POINT. Cutting skills is trivially easy and the
last release fixed the opposite defect (the tailor deleting JD keywords the
candidate genuinely has). So no variant may be judged on `n_skills` alone:
`lost_keywords` and `coverage_after` sit beside it, and a variant that ships
fewer skills by dropping ones the job named is a REGRESSION, not a win.

USAGE (from `backend/`, with a real key in .env and USE_STUB_LLM=false):

    .\\.venv\\Scripts\\python.exe -m tests.ab_tailor --prepare      # cache fixtures (1 call/job)
    .\\.venv\\Scripts\\python.exe -m tests.ab_tailor --stub         # free plumbing check
    .\\.venv\\Scripts\\python.exe -m tests.ab_tailor --variants baseline,tight --reps 3
    .\\.venv\\Scripts\\python.exe -m tests.ab_tailor --report runs/x.json

Fixtures and results land in `tests/fixtures/ab/`, which is git-ignored: it holds
the owner's real resume and is the same class of local-only data as
`reference-screenshots/`.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.core import keyword_guard, length_budget, scorer  # noqa: E402
from app.core.jd_analyzer import analyze_jd  # noqa: E402
# The REAL module, not a twin. An A/B that measured a prototype and shipped a
# different implementation would be reporting a number about code that does
# not exist -- the whole failure this harness was built to stop.
from app.core.skills_shortlist import shortlist_skills  # noqa: E402
from app.core.tailor import tailor_resume  # noqa: E402
from app.llm import metering, prompts  # noqa: E402
from app.models import JDModel, ResumeModel, TailorResult  # noqa: E402
from app.parsers.structurer import build_facts_ledger  # noqa: E402
from app.render.pdf_renderer import page_count  # noqa: E402
from app.render.templates import DEFAULT_TEMPLATE  # noqa: E402

HERE = Path(__file__).resolve().parent
AB = HERE / "fixtures" / "ab"
VARIANTS_DIR = AB / "variants"
RUNS_DIR = AB / "runs"
MASTER_JSON = AB / "master.json"
JOBS_JSON = AB / "jobs.json"
DB_PATH = HERE.parent / "jobfinder.db"


# --------------------------------------------------------------------------- #
# Per-call probe: latency and task attribution (PLAN 20.1 rides along for free)
# --------------------------------------------------------------------------- #
# PLAN 20.1 has been open since 2026-08-16 as "needs the real key: measure the
# tailor's serial LLM latency before parallelising". It needs exactly the runs
# this harness already makes, so it is measured here rather than in a second
# sitting that would spend the credit twice.
#
# The probe wraps the CLIENT CLASSES, not the factory. Nine modules do
# `from app.llm.client import get_llm_client`, so the name is already bound in
# their namespaces and patching the factory would miss every one of them; the
# class object is shared by all of them.
_local = threading.local()

# A 429 IS NOT A RESULT, AND A HARNESS THAT RECORDS IT AS ONE LIES BY OMISSION.
# The first full run put 7 arms x 6 jobs x 3 reps through 6 workers and lost 74
# of 126 cells to `RateLimitError: ... tokens per min (TPM): Limit 200000`. The
# cells did not fail at random: they clustered by arm and by job, so the surviving
# medians compared different arms over DIFFERENT jobs and the table read as a
# clean result. `OpenAIClient` sets `max_retries=2`, which is the app's setting
# for a live user waiting on one request, not for a batch that deliberately
# saturates the account.
#
# Retrying here rather than at the cell level is what keeps the measurement
# intact: a re-run cell is a fresh sample of a nondeterministic pipeline, so
# discarding half a tailor and starting over changes what is being measured. One
# call is replayed; the run continues.
_RATE_LIMIT_ATTEMPTS = 6


def _with_backoff(fn, self, system: str, user: str):
    delay = 4.0
    for attempt in range(_RATE_LIMIT_ATTEMPTS):
        try:
            return fn(self, system, user)
        except Exception as exc:  # noqa: BLE001
            text = f"{type(exc).__name__} {exc}"
            if "RateLimit" not in text and "rate_limit" not in text and "429" not in text:
                raise
            if attempt == _RATE_LIMIT_ATTEMPTS - 1:
                raise
            # Deterministic, staggered by thread: every worker backing off by the
            # same amount re-collides on the next tick and the batch stalls in
            # lockstep. The thread id is a stable, dependency-free jitter source.
            time.sleep(delay + (threading.get_ident() % 1000) / 1000.0)
            delay *= 1.8
    raise RuntimeError("unreachable")


def _install_probe() -> None:
    from app.llm import client as client_mod

    for cls_name in ("OpenAIClient", "StubClient"):
        cls = getattr(client_mod, cls_name, None)
        if cls is None or getattr(cls, "_ab_probed", False):
            continue
        for meth in ("complete_json", "complete_text"):
            orig = getattr(cls, meth)

            def wrap(orig=orig):
                def probed(self, system: str, user: str):
                    started = time.perf_counter()
                    try:
                        out = _with_backoff(orig, self, system, user)
                        # THE DECISIVE NUMBER. "Too many skills" has two possible
                        # authors -- the model, or the deterministic guard that
                        # puts deleted keywords back -- and the shipped count
                        # cannot tell them apart. This records what the MODEL
                        # returned, before any guard has touched it.
                        if isinstance(out, dict) and system.startswith("Task: TAILOR."):
                            try:
                                _local.model_skills = len(
                                    (out.get("tailored_resume") or {}).get("skills") or []
                                )
                            except Exception:
                                pass
                        return out
                    finally:
                        log = getattr(_local, "calls", None)
                        if log is not None:
                            # The `Task: X.` tag is the first line of every
                            # system prompt (it is what StubClient routes on),
                            # so it is already the right attribution key.
                            head = system.split("\n", 1)[0].strip()
                            log.append(
                                {
                                    "task": head[:40],
                                    "seconds": round(time.perf_counter() - started, 3),
                                    "user_chars": len(user),
                                }
                            )

                return probed

            setattr(cls, meth, wrap())
        cls._ab_probed = True

    # And the other half of the same question: how many entries the keyword
    # guard PUT BACK. Patched on `app.core.tailor`, not on `keyword_guard`,
    # because tailor.py does `from app.core.keyword_guard import
    # preserve_keywords` -- the name is already bound in the caller's namespace,
    # so patching the definition module would be a no-op. (The same trap the
    # `max_restored` knob has to work around, one level up.)
    import app.core.tailor as tailor_mod

    if not getattr(tailor_mod, "_ab_probed", False):
        orig_preserve = tailor_mod.preserve_keywords

        def probed_preserve(original, tailored, jd):
            out, restored, kept_back = orig_preserve(original, tailored, jd)
            # Measured SEPARATELY from the cap below. Folding them into one delta
            # reported the deterministic arm as "+guard -40", i.e. it read a trim
            # as a negative restore -- two different mechanisms under one number,
            # which is the exact confusion this probe exists to resolve.
            guard_out = len(out.skills)
            cap = getattr(_local, "skills_cap", None)
            if cap and getattr(_local, "cap_stage", "after") in ("after", "both"):
                # AFTER the restore: the guard's carriers are protected, or a cap
                # would silently undo a restore the changelog then claims it made.
                pre = set(tailored.skills)
                out, _dropped = shortlist_skills(
                    out, jd, cap, protected=frozenset(s for s in out.skills if s not in pre)
                )
            _local.guard = {
                "in": len(tailored.skills),
                "guard_out": guard_out,
                "out": len(out.skills),
                "restored_keywords": len(restored),
                "kept_back": len(kept_back),
                "kept_back_reasons": sorted({k.reason for k in kept_back}),
            }
            return out, restored, kept_back

        tailor_mod.preserve_keywords = probed_preserve

        # PLACEMENT IS THE DECISION, and it is not a detail. Trimming AFTER the
        # restore lands the count where the user wants it, but `fit_to_pages` has
        # by then already paid for a 67-entry skills list out of the PROJECT
        # list — measured, the budget keeps 8 projects at 10 skills and 4 at 66,
        # at a constant 2 pages, so the bloat was never free, it was just billed
        # somewhere nobody was looking. Trimming BEFORE the budget buys those
        # projects back, but then `preserve_keywords` runs afterwards and its
        # fixed point on this master is ~35 entries, so the count creeps back.
        #
        # Hooking `fit_to_pages` is what makes "before" measurable without
        # touching the shipped function: it is the first thing the parsed résumé
        # meets. The flag matters — the budget is called a SECOND time inside the
        # restore refit, and trimming there would be the "after" arm wearing the
        # "before" label.
        orig_fit = tailor_mod.fit_to_pages

        def probed_fit(tailored, jd, plan, **kw):
            cap = getattr(_local, "skills_cap", None)
            stage = getattr(_local, "cap_stage", "after")
            if cap and stage in ("before", "both") and not getattr(_local, "fit_seen", False):
                _local.fit_seen = True
                tailored, _dropped = shortlist_skills(tailored, jd, cap)
            return orig_fit(tailored, jd, plan, **kw)

        tailor_mod.fit_to_pages = probed_fit
        tailor_mod._ab_probed = True


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
def _load_master_from_db() -> dict[str, Any]:
    import sqlite3

    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    row = con.execute(
        "select resume_json, language from saved_resumes order by id limit 1"
    ).fetchone()
    con.close()
    if row is None:
        raise SystemExit("no saved_resumes row in " + str(DB_PATH))
    return json.loads(row["resume_json"])


def _load_jobs_from_db(limit: int) -> list[dict[str, Any]]:
    """Real postings the owner actually saw, widest-first.

    Deliberately drawn from BOTH tables: `applications` holds the JDs a tailor
    was really run against (so a regression here is a regression on the exact
    input that produced the complaint), and `job_search_hits` supplies the
    variety a three-job panel cannot -- different seniorities, different boards,
    and jobs the resume fits badly, which is where over-inclusion shows worst."""
    import sqlite3

    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    # `order by length(jd_text)` on a UNION is a SQLite error ("1st ORDER BY term
    # does not match any column in the result set") -- the sort key has to be a
    # selected column, hence the explicit `n`.
    #
    # `rank` puts the tracker's own JDs FIRST regardless of length. They are the
    # postings a tailor was really run against, so they are the inputs the
    # complaint is about; sorting the whole union by length alone dropped all
    # three off a six-job panel in favour of longer postings nobody applied to.
    q = (
        "select 0 as rank, 'app-' || id as ref, job_title as title, company, jd_text, "
        "length(jd_text) as n from applications where length(coalesce(jd_text,'')) > 1500 "
        "union all "
        "select 1 as rank, 'hit-' || id as ref, title, company, jd_text, "
        "length(jd_text) as n from job_search_hits where length(coalesce(jd_text,'')) > 1500 "
        "order by rank asc, n desc"
    )
    for row in con.execute(q):
        key = (row["title"] or "").strip().lower() + "|" + (row["company"] or "").strip().lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "ref": row["ref"],
                "title": row["title"] or "",
                "company": row["company"] or "",
                "jd_text": row["jd_text"],
            }
        )
    con.close()
    return out[:limit]


def prepare(limit: int, force: bool) -> None:
    """Cache the resume and the ANALYSED JDs once, so every variant is scored
    against byte-identical inputs. Costs one LLM call per job, once, ever."""
    AB.mkdir(parents=True, exist_ok=True)
    VARIANTS_DIR.mkdir(parents=True, exist_ok=True)
    RUNS_DIR.mkdir(parents=True, exist_ok=True)

    if force or not MASTER_JSON.exists():
        master = _load_master_from_db()
        MASTER_JSON.write_text(json.dumps(master, ensure_ascii=False, indent=2), encoding="utf-8")
        print("master.json written: %d skills" % len(master.get("skills") or []))

    baseline = VARIANTS_DIR / "baseline.txt"
    if force or not baseline.exists():
        baseline.write_text(prompts.TAILOR_SYSTEM, encoding="utf-8")
        print("variants/baseline.txt written from the live prompt (%d chars)" % len(prompts.TAILOR_SYSTEM))

    if not force and JOBS_JSON.exists():
        jobs = json.loads(JOBS_JSON.read_text(encoding="utf-8"))
        print("jobs.json already holds %d analysed jobs (use --force to re-analyse)" % len(jobs))
        return

    raw = _load_jobs_from_db(limit)
    print("analysing %d JDs (one LLM call each, cached forever)..." % len(raw))
    jobs = []
    for j in raw:
        jd = analyze_jd(j["jd_text"])
        jobs.append(
            {
                **j,
                "jd": json.loads(jd.model_dump_json()),
                "jd_terms": length_budget._jd_terms(jd),
            }
        )
        print(
            "  %-8s %-46s hard=%2d kw=%2d pref=%2d"
            % (j["ref"], j["title"][:44], len(jd.hard_skills), len(jd.keywords), len(jd.preferred_skills))
        )
    JOBS_JSON.write_text(json.dumps(jobs, ensure_ascii=False, indent=2), encoding="utf-8")
    print("jobs.json written: %d jobs" % len(jobs))


def load_fixtures() -> tuple[ResumeModel, list[dict[str, Any]]]:
    if not MASTER_JSON.exists() or not JOBS_JSON.exists():
        raise SystemExit("fixtures missing -- run with --prepare first")
    master = ResumeModel.model_validate(json.loads(MASTER_JSON.read_text(encoding="utf-8")))
    jobs = json.loads(JOBS_JSON.read_text(encoding="utf-8"))
    return master, jobs


# --------------------------------------------------------------------------- #
# Scoring one tailored resume
# --------------------------------------------------------------------------- #
def _wanted(entry: str, terms: list[str]) -> str:
    """Does THIS job ask for this one skill entry?

    Reuses `scorer._keyword_present`, which is the same matcher
    `length_budget._drop_unmatched_skill` protects entries with and the same one
    `keyword_guard` selects carriers with. Answering it a second way here would
    make the harness a fourth opinion on a question the app already answers --
    and a metric that disagrees with the code it is grading is worse than no
    metric."""
    text = entry.lower()
    tokens = scorer._tokens(entry)
    best = "missing"
    for kw in terms:
        got = scorer._keyword_present(kw, text, tokens)
        if got == "covered":
            return "covered"
        if got == "partial":
            best = "partial"
    return best


def _body_words(r: ResumeModel) -> int:
    parts = [r.summary, " ".join(r.skills)]
    for e in r.experience:
        parts += [e.title, e.company, *e.bullets]
    for p in r.projects:
        parts += [p.name, p.description, *p.bullets]
    for ed in r.education:
        parts += [ed.degree, ed.field, ed.institution, ed.details]
    return len(" ".join(parts).split())


def score_run(
    master: ResumeModel,
    jd: JDModel,
    terms: list[str],
    res: TailorResult,
    template: str,
) -> dict[str, Any]:
    t = res.tailored_resume
    cov_after, gaps_after = scorer.keyword_analysis(t, jd)
    cov_before, _ = scorer.keyword_analysis(master, jd)

    verdicts = [_wanted(s, terms) for s in t.skills]
    lost = keyword_guard.lost_keywords(master, t, jd)
    changelog_skills = [c.change for c in res.changelog if c.section == "skills"]

    # THE CLOSED-SET AUDIT, and the reason it is scored here rather than by the
    # app: `check_fabrication` deliberately does not read skills at all
    # (CLAUDE.md: "skills are unchecked by design", because the prompt lets the
    # model adopt the JD's SPELLING for something the candidate has). So the one
    # section the model is most tempted to import the JD into is the one section
    # no guard looks at -- and measurement found 20 distinct strings shipping on
    # the CV with no token of them anywhere in the master (Slack, Jira, Agile,
    # Linux, ChatGPT, "candidate sourcing"...).
    #
    # TWO numbers, because the rule has two edges and only one of them is a
    # violation. `unowned` means NO token of the entry appears anywhere in the
    # original -- that cannot be a rewording of anything, so it is an invented
    # claim. `not_verbatim` is the wider set that also catches the LEGITIMATE
    # rewording the prompt permits, so it is a diagnostic, never a verdict:
    # scoring on it alone would fire on exactly the behaviour the prompt asks
    # for, which is this codebase's definition of a guard worse than none.
    mtext, mtok = keyword_guard._read(master)
    own = [scorer._keyword_present(s, mtext, mtok) for s in t.skills]
    unowned = [s for s, o in zip(t.skills, own) if o == "missing"]
    # THE THIRD NUMBER, AND IT IS THE ONE THE TRADE TURNS ON. An entry absent
    # from `master.skills` but present in the master's PROSE is not a fabrication
    # — it is the model relocating a term the candidate demonstrates in a bullet
    # into the list, which is what keeps it covered after the page budget deletes
    # the project that carried it. Two independently designed prompt arms
    # forbade that relocation and both lost 12-15 coverage points; the arms that
    # cut the same ~40 entries WITHOUT touching it held coverage. So the count
    # cut is not what costs coverage — banning relocation is. Without this column
    # both look identical, and `skills_unowned` cannot tell them apart: it reads
    # the whole master, so `JavaScript` (in a bullet, not in the skills array)
    # scores as owned.
    master_entries = {s.strip().casefold() for s in master.skills}
    relocated = [
        s
        for s, o in zip(t.skills, own)
        if o != "missing" and s.strip().casefold() not in master_entries
    ]

    return {
        # --- the metric under test ---------------------------------------- #
        "n_skills": len(t.skills),
        "skills_covered_by_jd": verdicts.count("covered"),
        "skills_partial": verdicts.count("partial"),
        "skills_unasked": verdicts.count("missing"),
        "skills_precision": round(100.0 * verdicts.count("covered") / len(t.skills), 1)
        if t.skills
        else 0.0,
        # --- the closed-set audit ------------------------------------------ #
        "skills_unowned": len(unowned),
        "skills_unowned_list": unowned,
        "skills_relocated": len(relocated),
        "skills_relocated_list": relocated,
        "skills_not_verbatim": sum(1 for o in own if o != "covered"),
        # --- the counterweights: cutting must not cost coverage ------------ #
        "coverage_before": cov_before,
        "coverage_after": cov_after,
        "coverage_delta": round(cov_after - cov_before, 1),
        "lost_keywords_n": len(lost),
        "lost_keywords": lost,
        "covered_n": sum(1 for g in gaps_after if g.status == "covered"),
        "partial_n": sum(1 for g in gaps_after if g.status == "partial"),
        "missing_n": sum(1 for g in gaps_after if g.status == "missing"),
        "jd_terms_n": len(terms),
        # --- truthfulness and voice, which no variant may trade away ------- #
        "fabrication_flags": len(res.fabrication_flags),
        "credibility_flags": len(res.credibility_flags),
        # The credibility reviewer already has a `tool_padding` risk category,
        # so the app may be diagnosing this defect internally and reporting it as
        # an advisory warning instead of acting on it. Recorded per risk so a
        # variant that cuts the list can be checked for whether it also quiets
        # the reviewer -- two independent readings of the same document.
        "credibility_risks": sorted(
            {r: sum(1 for f in res.credibility_flags if f.risk == r) for r in {f.risk for f in res.credibility_flags}}.items()
        ),
        "credibility_texts": [f.text[:120] for f in res.credibility_flags[:10]],
        "voice_score": res.voice_report.human_voice_score,
        "voice_issues": len(res.voice_report.issues),
        "voice_revised": res.voice_report.revised,
        "jd_copy_pct": res.voice_report.jd_copy_pct,
        # --- shape of the document ----------------------------------------- #
        "pages": page_count(t, template),
        "body_words": _body_words(t),
        "n_projects": len(t.projects),
        "n_experience": len(t.experience),
        "n_bullets": sum(len(e.bullets) for e in t.experience),
        "n_skill_groups": len(t.skill_groups or []),
        "headline": t.headline,
        # --- what the model and the guards said they did -------------------- #
        "fit_before": res.score_before.fit_score,
        "fit_after": res.score_after.fit_score,
        "plan_projects": len(res.plan.select_projects) if res.plan else None,
        "changelog_skills": changelog_skills,
        "skills": t.skills,
    }


# --------------------------------------------------------------------------- #
# Running one cell
# --------------------------------------------------------------------------- #
@dataclass
class Variant:
    name: str
    system: str
    knobs: dict[str, Any] = field(default_factory=dict)


def load_variants(names: list[str]) -> list[Variant]:
    knobs_file = AB / "knobs.json"
    knobs = json.loads(knobs_file.read_text(encoding="utf-8")) if knobs_file.exists() else {}
    out = []
    for n in names:
        f = VARIANTS_DIR / (n + ".txt")
        if not f.exists():
            raise SystemExit("no variant file " + str(f))
        text = f.read_text(encoding="utf-8")
        # The stub router and `with_resume_language` both key off the first
        # line; a variant that loses the tag silently misroutes and the whole
        # comparison measures the wrong task.
        if not text.startswith("Task: TAILOR."):
            raise SystemExit("variant %s does not start with 'Task: TAILOR.'" % n)
        out.append(Variant(n, text, knobs.get(n, {})))
    return out


def run_cell(
    variant: Variant,
    master: ResumeModel,
    job: dict[str, Any],
    rep: int,
    template: str,
) -> dict[str, Any]:
    jd = JDModel.model_validate(job["jd"])
    terms = job["jd_terms"]
    _local.calls = []
    _local.model_skills = None
    _local.guard = None
    # Thread-local, not a module global like the prompt patch: `run_cell` is what
    # runs in the worker, so this is the only scope the trim can read from.
    _local.skills_cap = variant.knobs.get("skills_cap")
    _local.cap_stage = variant.knobs.get("cap_stage", "after")
    _local.fit_seen = False
    started = time.perf_counter()
    row: dict[str, Any] = {
        "variant": variant.name,
        "job": job["ref"],
        "title": job["title"],
        "company": job["company"],
        "rep": rep,
        # Recorded per ROW, from the settings the cell actually ran under, not
        # from the knob that was meant to apply. If a cache-clear is ever missed
        # the rows say so instead of the table quietly comparing one model twice.
        "model": get_settings().model_id,
    }
    try:
        with metering.meter() as tally:
            res = tailor_resume(
                master,
                jd,
                ledger=build_facts_ledger(master),
                template=template,
            )
        row.update(score_run(master, jd, terms, res, template))
        row["tokens_prompt"] = tally.prompt
        row["tokens_completion"] = tally.completion
        row["llm_calls"] = tally.calls
        row["error"] = ""
    except Exception as exc:  # a bad cell must not destroy the other 47
        row["error"] = "%s: %s" % (type(exc).__name__, exc)
    row["wall_seconds"] = round(time.perf_counter() - started, 2)
    row["calls"] = list(getattr(_local, "calls", []))
    row["llm_seconds"] = round(sum(c["seconds"] for c in row["calls"]), 2)
    # Attribution: what the model returned, what the guard added, what shipped.
    guard = getattr(_local, "guard", None) or {}
    row["model_skills"] = getattr(_local, "model_skills", None)
    row["guard_in"] = guard.get("in")
    row["guard_out"] = guard.get("out")
    row["guard_added"] = (
        guard["guard_out"] - guard["in"] if guard.get("in") is not None else None
    )
    row["cap_removed"] = (
        guard["guard_out"] - guard["out"] if guard.get("in") is not None else None
    )
    row["guard_kept_back"] = guard.get("kept_back")
    row["guard_reasons"] = guard.get("kept_back_reasons", [])
    return row


def run_variant(
    variant: Variant,
    master: ResumeModel,
    jobs: list[dict[str, Any]],
    reps: int,
    template: str,
    workers: int,
) -> list[dict[str, Any]]:
    """One variant at a time, its cells in parallel.

    The patch is a MODULE GLOBAL, so two variants can never be in flight at
    once -- the second would silently score the first's prompt. Cells inside one
    variant are safe because they all read the same patched value."""
    import app.core.tailor as tailor_mod
    from app.llm.client import get_llm_client

    prev_prompt = prompts.TAILOR_SYSTEM
    # THE PLANNER IS A PROMPT TOO, and until now the harness could not vary it.
    # `cv_planner` decides which projects survive -- measured at 3, 3 and 7 on three
    # identical runs of one job -- so it owns more of "how the resume turned out"
    # than the skills list does. A variant names its planner file with the
    # `plan_variant` knob; the TAILOR prompt stays at baseline so the arm is
    # attributable to the planner alone.
    prev_plan = prompts.PLAN_CV_SYSTEM
    if variant.knobs.get("plan_variant"):
        pf = VARIANTS_DIR / (variant.knobs["plan_variant"] + ".plan.txt")
        if not pf.exists():
            raise SystemExit("no planner variant file " + str(pf))
        text = pf.read_text(encoding="utf-8")
        if not text.startswith("Task: PLAN_CV."):
            raise SystemExit("planner variant must keep the 'Task: PLAN_CV.' routing tag")
        prompts.PLAN_CV_SYSTEM = text
    prev_kg = keyword_guard.MAX_RESTORED
    prev_tailor_kg = tailor_mod.MAX_RESTORED
    prev_model = os.environ.get("MODEL_ID")
    prompts.TAILOR_SYSTEM = variant.system
    # A MODEL IS JUST ANOTHER ARM. `MODEL_ID` is already config, so comparing two
    # models is the same experiment as comparing two prompts — and it has to be,
    # because the last model choice for this app was recorded in `.env` as "0
    # fabrication in A/B tests (gpt-4o-mini leaked unowned skills)" and
    # `fabrication_flags` structurally cannot see the skills list. That decision
    # was made on a metric blind to the failure it claimed to rule out.
    #
    # BOTH caches, or the swap silently does nothing: `get_settings` is
    # lru_cached, and so is `get_llm_client` — it is a process-wide singleton
    # that captured `settings.model_id` at first call, so clearing only the
    # settings cache leaves the old client, and every "new model" cell would
    # quietly re-measure the old one.
    if variant.knobs.get("model"):
        os.environ["MODEL_ID"] = variant.knobs["model"]
        get_settings.cache_clear()
        get_llm_client.cache_clear()
    if "max_restored" in variant.knobs:
        # Two bindings, because `tailor.py` does `from ... import MAX_RESTORED`
        # (a value import) while `preserve_keywords` reads its own module
        # global. Patching one and not the other measures a half-applied knob.
        keyword_guard.MAX_RESTORED = variant.knobs["max_restored"]
        tailor_mod.MAX_RESTORED = variant.knobs["max_restored"]
    try:
        cells = [(j, r) for j in jobs for r in range(reps)]
        rows: list[dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = [pool.submit(run_cell, variant, master, j, r, template) for j, r in cells]
            for i, f in enumerate(futs, 1):
                row = f.result()
                rows.append(row)
                if row["error"]:
                    mark = "ERR " + row["error"][:60]
                else:
                    mark = (
                        "skills=%3d cov=%5.1f lost=%2d pages=%d flags=%d voice=%.0f"
                        % (
                            row["n_skills"],
                            row["coverage_after"],
                            row["lost_keywords_n"],
                            row["pages"],
                            row["fabrication_flags"],
                            row["voice_score"],
                        )
                    )
                print("  [%s] %d/%d %-8s rep%d %s" % (variant.name, i, len(cells), row["job"], row["rep"], mark))
        return rows
    finally:
        prompts.TAILOR_SYSTEM = prev_prompt
        prompts.PLAN_CV_SYSTEM = prev_plan
        keyword_guard.MAX_RESTORED = prev_kg
        tailor_mod.MAX_RESTORED = prev_tailor_kg
        if variant.knobs.get("model"):
            if prev_model is None:
                os.environ.pop("MODEL_ID", None)
            else:
                os.environ["MODEL_ID"] = prev_model
            get_settings.cache_clear()
            get_llm_client.cache_clear()


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #
SUMMARY_COLS = [
    ("model_skills", "model"),
    ("guard_added", "+guard"),
    ("cap_removed", "-trim"),
    ("n_skills", "skills"),
    ("skills_unasked", "unasked"),
    ("skills_unowned", "unowned"),
    ("skills_precision", "prec%"),
    ("coverage_after", "cov"),
    ("coverage_delta", "d-cov"),
    ("lost_keywords_n", "lost"),
    ("fabrication_flags", "fab"),
    ("credibility_flags", "cred"),
    ("voice_score", "voice"),
    ("pages", "pages"),
    ("body_words", "words"),
    ("n_projects", "proj"),
    ("llm_seconds", "llm_s"),
]


def _agg(rows: list[dict[str, Any]], key: str) -> str:
    vals = [r[key] for r in rows if not r["error"] and isinstance(r.get(key), (int, float))]
    if not vals:
        return "-"
    med = statistics.median(vals)
    lo, hi = min(vals), max(vals)
    if lo == hi:
        return "%g" % med
    return "%g [%g-%g]" % (med, lo, hi)


def report(rows: list[dict[str, Any]]) -> str:
    variants: list[str] = []
    for r in rows:
        if r["variant"] not in variants:
            variants.append(r["variant"])
    head = "%-14s%3s " % ("variant", "n") + " ".join("%12s" % lab for _, lab in SUMMARY_COLS)
    lines = [head, "-" * len(head)]
    for v in variants:
        ok = [r for r in rows if r["variant"] == v and not r["error"]]
        cells = " ".join("%12s" % _agg(ok, k) for k, _ in SUMMARY_COLS)
        lines.append("%-14s%3d %s" % (v, len(ok), cells))
    # AN INCOMPLETE MATRIX MUST ANNOUNCE ITSELF. When cells fail, they fail in
    # clusters (a rate limit takes out whichever arm was running), so the
    # survivors compare different arms over DIFFERENT jobs -- and the table above
    # looks exactly as clean as a complete one. This is the "no silent caps" rule:
    # the reader has to be told what is missing before they read a median.
    jobs_all = sorted({r["job"] for r in rows})
    holes = []
    for v in variants:
        got = sorted({r["job"] for r in rows if r["variant"] == v and not r["error"]})
        if len(got) < len(jobs_all):
            holes.append("%s is missing %s" % (v, ", ".join(j for j in jobs_all if j not in got)))
    if holes:
        lines += [
            "",
            "!! THE MATRIX IS INCOMPLETE -- these medians are NOT comparable across arms:",
        ]
        lines += ["     " + h for h in holes]

    lines += [
        "",
        "median [min-max] across every (job x rep) cell. `unasked` = skills entries no JD",
        "term matches even partially; `lost` = JD keywords the master had and the tailored CV",
        "does not (keyword_guard.lost_keywords) -- a variant that cuts skills by raising `lost`",
        "is a regression, not a win.",
        "",
        "PER JOB (n_skills / unasked / coverage / lost):",
    ]
    jobs: list[str] = []
    for r in rows:
        if r["job"] not in jobs:
            jobs.append(r["job"])
    for j in jobs:
        title = next((r["title"] for r in rows if r["job"] == j), j)
        lines.append("  %-8s %s" % (j, title[:50]))
        for v in variants:
            jr = [r for r in rows if r["job"] == j and r["variant"] == v and not r["error"]]
            if not jr:
                continue
            lines.append(
                "    %-14s %12s %10s %12s %8s"
                % (
                    v,
                    _agg(jr, "n_skills"),
                    _agg(jr, "skills_unasked"),
                    _agg(jr, "coverage_after"),
                    _agg(jr, "lost_keywords_n"),
                )
            )
    return "\n".join(lines)


PAIRED_COLS = ["n_skills", "skills_unasked", "skills_unowned", "skills_relocated",
               "coverage_after", "lost_keywords_n", "n_projects", "voice_score", "pages"]


def paired_report(rows: list[dict[str, Any]], control: str = "baseline") -> str:
    """Per-job deltas against a CO-RUN control, which is the only comparison this
    experiment can actually support.

    THE NOISE FLOOR IS THE REASON. The identical baseline prompt was run twice
    over the same six jobs: per-job medians moved by a mean of 4.9 coverage
    points (max 10.4) and 6.2 skills entries (max 11), and the pooled medians
    read 70.7/66.0 one time and 66.7/67.5 the other. So a pooled median is one
    draw from a wide distribution, and a variant beating it by three points has
    shown nothing. Pairing removes the job -- which dominates every metric here,
    since coverage against a 71-term JD and a 24-term one are not the same
    quantity -- and leaves the prompt as the only thing that differs.

    Reported as the median over jobs of (arm's median on that job - control's
    median on that job), with the per-job spread, so a delta carried by one job
    is visible as one.
    """
    variants: list[str] = []
    for r in rows:
        if r["variant"] not in variants:
            variants.append(r["variant"])
    if control not in variants:
        return "\n(no co-run '%s' arm — a paired comparison is not available)" % control
    jobs = sorted({r["job"] for r in rows})

    def med(v: str, j: str, k: str):
        vals = [r[k] for r in rows
                if r["variant"] == v and r["job"] == j and not r["error"]
                and isinstance(r.get(k), (int, float))]
        return statistics.median(vals) if vals else None

    head = "%-14s%6s " % ("vs baseline", "jobs") + " ".join("%17s" % c for c in PAIRED_COLS)
    lines = ["", "PAIRED PER-JOB DELTAS (median over jobs of arm - baseline, [min..max])", head,
             "-" * len(head)]
    for v in variants:
        if v == control:
            continue
        cells, n_jobs = [], 0
        for k in PAIRED_COLS:
            ds = []
            for j in jobs:
                a, b = med(v, j, k), med(control, j, k)
                if a is not None and b is not None:
                    ds.append(a - b)
            n_jobs = max(n_jobs, len(ds))
            if not ds:
                cells.append("%17s" % "-")
            elif min(ds) == max(ds):
                cells.append("%17s" % ("%+g" % statistics.median(ds)))
            else:
                cells.append("%17s" % ("%+g [%+g..%+g]" % (statistics.median(ds), min(ds), max(ds))))
        lines.append("%-14s%6d %s" % (v, n_jobs, " ".join(cells)))
    lines += [
        "",
        "`skills_relocated` = entries absent from master.skills but present in the master's",
        "PROSE. Forbidding those is what costs coverage; cutting the COUNT does not.",
    ]
    return "\n".join(lines)


CONSISTENCY_COLS = ["n_projects", "n_skills", "skills_precision", "coverage_after",
                    "fit_after", "body_words"]


def consistency_report(rows: list[dict[str, Any]]) -> str:
    """WITHIN-JOB SPREAD -- does the same input produce the same CV twice?

    Every other view in this file reports a median, and a median is blind to the
    defect this measures: `cv_planner` selected 3, 3 and 7 projects on three
    identical runs of one job, and the median said 3 both times it mattered. A
    user pressing Tailor twice on the same posting gets two materially different
    documents, which is not a quality anyone can see in an average.

    Reported as the median over jobs of (max - min) across that job's reps, so a
    single erratic job shows up in the range rather than being averaged away.
    Lower is better; 0 means the arm is reproducible on this input.
    """
    variants: list[str] = []
    for r in rows:
        if r["variant"] not in variants:
            variants.append(r["variant"])
    jobs = sorted({r["job"] for r in rows})
    head = "%-14s " % "arm" + " ".join("%16s" % c for c in CONSISTENCY_COLS)
    lines = ["", "RUN-TO-RUN SPREAD ON IDENTICAL INPUT (median over jobs of max-min across reps)",
             head, "-" * len(head)]
    for v in variants:
        cells = []
        for k in CONSISTENCY_COLS:
            spreads = []
            for j in jobs:
                vals = [r[k] for r in rows
                        if r["variant"] == v and r["job"] == j and not r["error"]
                        and isinstance(r.get(k), (int, float))]
                if len(vals) > 1:
                    spreads.append(max(vals) - min(vals))
            cells.append("%16s" % (
                "-" if not spreads
                else "%g [%g..%g]" % (statistics.median(spreads), min(spreads), max(spreads))))
        lines.append("%-14s %s" % (v, " ".join(cells)))
    lines.append("")
    lines.append("0 = pressing Tailor twice on one job gives the same document.")
    return "\n".join(lines)


def latency_report(rows: list[dict[str, Any]]) -> str:
    """PLAN 20.1: the tailor's serial LLM latency, per task, measured."""
    by_task: dict[str, list[float]] = {}
    for r in rows:
        for c in r.get("calls", []):
            by_task.setdefault(c["task"], []).append(c["seconds"])
    ok = max(1, len([r for r in rows if not r["error"]]))
    lines = ["", "LLM LATENCY (PLAN 20.1) -- seconds per call, by task:"]
    total = 0.0
    for task, secs in sorted(by_task.items(), key=lambda kv: -statistics.median(kv[1])):
        med = statistics.median(secs)
        per_run = len(secs) / ok
        total += med * per_run
        lines.append(
            "  %-26s n=%4d  median %6.2fs  min %5.2f  max %6.2f  calls/run %.2f"
            % (task, len(secs), med, min(secs), max(secs), per_run)
        )
    lines.append("  %-26s       %13.2fs per tailor" % ("SERIAL TOTAL (median)", total))
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
def main() -> int:
    ap = argparse.ArgumentParser(description="Real-key A/B harness for the TAILOR prompt")
    ap.add_argument("--prepare", action="store_true", help="cache resume + analysed JDs")
    ap.add_argument("--force", action="store_true", help="re-analyse JDs even if cached")
    ap.add_argument("--jobs", type=int, default=6, help="how many JDs to cache (--prepare)")
    ap.add_argument("--variants", default="baseline", help="comma-separated variant names")
    ap.add_argument("--reps", type=int, default=2, help="runs per (variant, job)")
    ap.add_argument("--only-jobs", default="", help="comma-separated job refs to run")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--template", default=DEFAULT_TEMPLATE)
    ap.add_argument("--stub", action="store_true", help="free plumbing check via StubClient")
    ap.add_argument("--report", default="", help="re-print the table from a saved runs .json")
    ap.add_argument("--tag", default="run", help="name for the output file")
    args = ap.parse_args()

    if args.report:
        rows = []
        for p in args.report.split(","):
            rows += json.loads(Path(p.strip()).read_text(encoding="utf-8"))
        # Backfill metrics added after a run was recorded. Only the ones that are
        # a pure function of the stored `skills` list and the master can be
        # backfilled -- `model_skills` and `guard_added` are observations of a
        # run that is over, and inventing them here would be the "a row that
        # predates the field means unknown, never zero" mistake CLAUDE.md names.
        master = ResumeModel.model_validate(json.loads(MASTER_JSON.read_text(encoding="utf-8")))
        mtext, mtok = keyword_guard._read(master)
        for r in rows:
            if r.get("skills") and ("skills_unowned" not in r or "skills_relocated" not in r):
                own = [scorer._keyword_present(s, mtext, mtok) for s in r["skills"]]
                r["skills_unowned"] = sum(1 for o in own if o == "missing")
                r["skills_unowned_list"] = [s for s, o in zip(r["skills"], own) if o == "missing"]
                r["skills_not_verbatim"] = sum(1 for o in own if o != "covered")
                ms = {x.strip().casefold() for x in master.skills}
                reloc = [x for x, o in zip(r["skills"], own)
                         if o != "missing" and x.strip().casefold() not in ms]
                r["skills_relocated"] = len(reloc)
                r["skills_relocated_list"] = reloc
        print(report(rows))
        print(paired_report(rows))
        print(consistency_report(rows))
        print(latency_report(rows))
        return 0

    if args.stub:
        os.environ["USE_STUB_LLM"] = "true"
        get_settings.cache_clear()
    _install_probe()

    if args.prepare:
        prepare(args.jobs, args.force)
        return 0

    settings = get_settings()
    if not args.stub and (settings.use_stub_llm or not settings.openai_api_key):
        raise SystemExit(
            "this harness measures the REAL model: set USE_STUB_LLM=false and a key, "
            "or pass --stub for a free plumbing check"
        )
    print("model: %s   stub: %s" % (settings.model_id, settings.use_stub_llm))

    master, jobs = load_fixtures()
    if args.only_jobs:
        want = {j.strip() for j in args.only_jobs.split(",")}
        jobs = [j for j in jobs if j["ref"] in want]
    variants = load_variants([v.strip() for v in args.variants.split(",") if v.strip()])
    cells = len(variants) * len(jobs) * args.reps
    print(
        "%d variants x %d jobs x %d reps = %d tailor runs (~%d LLM calls)"
        % (len(variants), len(jobs), args.reps, cells, cells * 5)
    )

    rows: list[dict[str, Any]] = []
    for v in variants:
        print("\n=== variant: %s %s ===" % (v.name, v.knobs or ""))
        rows += run_variant(v, master, jobs, args.reps, args.template, args.workers)

    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    out = RUNS_DIR / (args.tag + ".json")
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print()
    print(report(rows))
    print(latency_report(rows))
    print("\nrows -> %s" % out)
    errs = [r for r in rows if r["error"]]
    if errs:
        print("\n%d cells errored:" % len(errs))
        for e in errs[:10]:
            print("  %-14s %-8s rep%d  %s" % (e["variant"], e["job"], e["rep"], e["error"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
