"""Real-key harness for the ghost-posting precision measurement (PLAN 28.5).

**Never part of the smoke test, and never run by CI.** A real run searches the
live job boards from this machine AND makes one real OpenAI call per posting it
scores, which spends the owner's credit. **`--stub` is FULLY OFFLINE — synthetic
postings, canned LinkedIn pages, the stub model, no board request, no OpenAI
call, no money — and it is the only mode an unattended run may use**, exactly as
for `ab_tailor.py` and `inbox_eval.py`. A socket-level tripwire enforces that:
any network attempt during `--stub` fails the run.

WHAT IT MEASURES. How often each ghost signal is RIGHT when it fires: precision
per signal kind, read by hand against the posting, never computed by a second
matcher. The verdicts are the app's own: every posting goes through the real
`job_search.search_jobs`, and the harness only listens at three seams, each
patched where it is BOUND and restored in `finally` —
  * `app.core.job_search._ghost_for`: every verdict, including those on
    postings whose scoring later failed (the classifier runs BEFORE the model);
  * each provider's `fetch_description`, on the instance: what the fetch
    returned and what `hit.closed` became;
  * `app.core.providers.linkedin._http_get`: the HTTP status per LinkedIn job
    id, the ONLY place a 404/410 can be told apart from a 429, a 999, a timeout
    or a login wall (`fetch_description` swallows the status).
The verdicts do not depend on the model; the model only produces the fit
scores, which the email question needs (the alert emails carry jobs at 75+).

WHAT A LOCAL RUN CAN AND CANNOT SEE (the critique's corrected Option A):
  * closed (LinkedIn banner, and HTTP 404/410), evergreen (title / body / weak)
    and long_open by Greenhouse `first_published`: measured here.
  * long_open by `first_seen` and `reposted`: NOT measured here. They need our
    own sightings, and a fresh local DB has none. Seeding it from production
    was rejected: production stores `www.linkedin.com` URLs while a run from
    Israel gets `il.linkedin.com`, so every shared posting would fire a
    `reposted` this harness itself created. Both are judged from production
    rows, read-only; `first_seen` cannot reach 30 days before about 2026-10-05.
  * An HTTP 404/410 LinkedIn posting never reaches `_ghost_for` (empty text, so
    `_build_match` never classifies it) and lands in `skipped`, not `filtered`
    — a defect against PLAN 28.2. The harness records it from the fetch seam as
    a would-be `closed` firing, so the owner's check can decide it.
  * A geo-blocked posting (the worldwide run) leaves before the ghost check. It
    is recorded as out of population, never as a posting with no signal.

THE DECISION RULE is in PLAN.md 28.5, written before any data. `--report`
applies it to the labelled worksheets.

MODES (from `backend/`):

    python -m tests.ghost_eval --stub                     # offline plumbing check, free
    python -m tests.ghost_eval --stub --replay RUN.json   # re-classify a recorded run offline
    python -m tests.ghost_eval --run R1 --price gpt-5.4-mini=IN,OUT [--env-file PATH] [--resume PATH]
    python -m tests.ghost_eval --report [RUN_DIR_OR_WORKSHEET ...]

A REAL RUN (`--run R1|R2|R3`) refuses to start unless every one of these holds,
all checked before any board or model is reached:
  * the key comes from `--env-file` (default: this checkout's `backend/.env`,
    else the main checkout's). Only OPENAI_API_KEY and MODEL_ID are read from
    it, into this process's environment. The key is never printed, never
    written to any file, and every file this run writes is scanned for it;
  * `get_llm_client()` is `OpenAIClient` and MODEL_ID is `--expect-model`
    (production's model; default gpt-5.4-mini);
  * `--price MODEL=IN,OUT` (USD per 1M tokens) names that model — the guard
    below cannot bound money with a price it guessed;
  * the ledger allows it: at most $1.00 and 75 billed model calls in total,
    and at most 3 paid runs, across every run ever recorded in the ledger; and
    the previous real run ended at least 10 minutes ago (LinkedIn throttles).

THE BUDGET GUARD wraps `OpenAIClient._metered`, the one method that sends a
request. A call is admitted only if (a) the billed calls so far, in flight and
this one stay within 75; (b) the money spent so far, plus the WORST case of
every call in flight and of this one (every prompt byte a token, and the full
`LLM_MAX_OUTPUT_TOKENS` of completion), stays within the $1.00 still unspent;
and (c) this run's spend, estimated the same way from the tokens metered so
far, stays within its fair share (what is left, divided by the runs left). A
call that does not fit waits for the calls in flight; with none in flight the
run's budget closes and every later call is refused. A refused posting keeps
its ghost verdict and simply has no fit score. Money is costed from the
metered `usage` of every response (the same numbers `metering` writes to
`usage_log`), every prompt token at the full input price (cached tokens are
cheaper, so this over-counts). A 4xx is not billed and not counted; a timeout
or 5xx is counted at its estimate. The ledger is rewritten on every admit and
every settle, with in-flight calls at their worst case, so a crashed run still
counts. One residual it cannot see: the OpenAI SDK's own internal retries of a
timed-out request.

OUTPUT. Every run writes to `<out>/<run_id>/`: `run.json` (the full corpus:
context, per-board counts and errors, every selected posting with its text,
fetch outcome, verdict and fit score, token and cost totals) and
`worksheet.csv` (one row per posting that fired, for labelling: `label` is
GHOST / LIVE / UNCLEAR / BUG, `bug` names a signal whose stated fact is false).
`<out>` defaults to the MAIN checkout's `backend/tests/fixtures/ghost_eval/`,
so every checkout shares one ledger; it is git-ignored, and the harness also
drops a `.gitignore` of `*` into it. `--stub` writes to this checkout's
`tests/fixtures/ghost_eval/stub/` and never touches the ledger.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Iterator

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

# NOTHING from `app` is imported at module level, and that is load-bearing:
# `get_settings()` is lru_cached and `app.db.database` builds its engine at
# import, so the scratch DATABASE_URL, the blank SENTRY_DSN and the stub-or-key
# choice must be in the environment BEFORE the first `app` import. `_boot` is
# the only place that imports the app, and it refuses to run twice.

# --- the owner's budget (PLAN 28.5, approved 2026-09-21) ---------------------
BUDGET_USD = 1.00
MAX_CALLS = 75
MAX_PAID_RUNS = 3
MIN_GAP_MINUTES = 10
EXPECT_MODEL = "gpt-5.4-mini"  # production's model per SENIOR_REVIEW.md; its env var is Sensitive
FIRST_SEEN_FROM = "2026-10-05"  # posting_sightings starts 2026-09-05; the weak line is 30 days

ALL_BOARDS = ["linkedin", "drushim", "comeet", "jobmaster", "greenhouse"]
# Custom titles on every preset, so `_resolve_context` never makes the
# SEARCH_CONTEXT model call: the only model calls a run makes are JD_FIT.
PRESETS: dict[str, dict[str, Any]] = {
    "R1": {
        "label": "local",
        "job_titles": ["AI Engineer", "AI Automation Engineer"],
        "location": "Israel",
        "work_mode": "any",
        "include_worldwide": False,
        "max_age_days": 30,
        "sources": ALL_BOARDS,
    },
    "R2": {
        "label": "worldwide-remote",
        "job_titles": ["AI Engineer", "AI Automation Engineer"],
        "location": "Israel",
        "work_mode": "remote",
        "include_worldwide": True,
        "max_age_days": 30,
        "sources": ALL_BOARDS,
    },
    "R3": {
        "label": "hebrew",
        "job_titles": ["מהנדס בינה מלאכותית"],
        "location": "תל אביב",
        "work_mode": "any",
        "include_worldwide": False,
        "max_age_days": 30,
        "sources": ["drushim", "jobmaster"],
    },
}

# --- the decision rule's bars (PLAN 28.5) -------------------------------------
HIDE_MIN_N = 20        # nothing is hidden on a soft signal below 20 labelled postings...
HIDE_MAX_WRONG = 0     # ...or with a single wrong call
EMAIL_MIN_N = 10       # `likely` leaves the email only at 10+ labelled likely postings...
EMAIL_MIN_PRECISION = 0.80  # ...with 80%+ correct, and only with the owner's approval
LABELS = ("GHOST", "LIVE", "UNCLEAR", "BUG")
SOFT_KINDS = ("evergreen", "long_open", "reposted")
AGE_BUCKETS = ((90, "90+"), (60, "60-89"), (45, "45-59"), (30, "30-44"))

WS_FIELDS = [
    "run_id", "url", "source", "title", "company", "location", "posted_at",
    "first_published", "fetch_outcome", "in_app", "signals", "likely",
    "evergreen_rule", "long_open_days", "long_open_basis", "age_bucket",
    "closed_evidence", "quote", "fit_overall", "owner_check",
    "label", "bug", "evidence", "checked_on",
]
OWNER_LINKEDIN = "LinkedIn, logged in: the owner's part (never click Apply)"

_TLS = threading.local()  # the posting a worker thread is scoring, for LLM attribution
_SECRET_RE = re.compile(r"sk-[A-Za-z0-9_\-\*]{6,}")


def _k(url: str) -> str:
    """The URL key `search_jobs` dedupes and caches on."""
    return (url or "").rstrip("/")


def _scrub(text: str, secret: str = "") -> str:
    """An OpenAI 401 quotes a masked key ("sk-proj-****abcd"); nothing that
    looks like one is ever printed or stored."""
    text = str(text or "")
    if secret:
        text = text.replace(secret, "[redacted]")
    return _SECRET_RE.sub("sk-[redacted]", text)


def _now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _git(*args: str) -> str:
    try:
        out = subprocess.run(["git", *args], cwd=BACKEND, capture_output=True, text=True, timeout=15)
    except Exception:  # noqa: BLE001 - provenance only
        return ""
    return out.stdout.strip() if out.returncode == 0 else ""


def _main_checkout() -> Path | None:
    """The main working tree, found through git's common dir, so a worktree and
    the main checkout share ONE ledger — two ledgers would split the budget."""
    common = _git("rev-parse", "--path-format=absolute", "--git-common-dir")
    if not common:
        return None
    root = Path(common).parent
    return root if (root / "backend").is_dir() else None


def _default_out_dir() -> Path:
    main = _main_checkout()
    return (main / "backend" / "tests" / "fixtures" / "ghost_eval") if main else HERE / "fixtures" / "ghost_eval"


def _default_file(rel: str) -> Path:
    here = BACKEND / rel
    if here.exists():
        return here
    main = _main_checkout()
    return (main / "backend" / rel) if main else here


def _ensure_out(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    ignore = root / ".gitignore"
    if not ignore.exists():
        # Self-ignoring, whatever the checkout's own .gitignore says: before
        # this branch is merged, the main checkout does not list this folder.
        ignore.write_text("*\n", encoding="utf-8")


def _write_json(path: Path, data: Any) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    os.replace(tmp, path)


# =========================================================================== #
# Boot: the environment first, then the app
# =========================================================================== #
def _read_env_file(path: Path) -> dict[str, str]:
    """ONLY the two values a real run needs. Nothing is printed; the caller
    reports "present / absent" and the model id, never the key."""
    from dotenv import dotenv_values  # python-dotenv ships with pydantic-settings

    values = dotenv_values(path)
    return {name: str(values.get(name) or "").strip() for name in ("OPENAI_API_KEY", "MODEL_ID")}


def _boot(*, db_path: Path, stub: bool, key: str = "", model: str = "") -> SimpleNamespace:
    if any(name == "app" or name.startswith("app.") for name in sys.modules):
        raise RuntimeError("ghost_eval: the app was imported before the environment was set")
    os.environ["DATABASE_URL"] = "sqlite:///" + db_path.resolve().as_posix()
    os.environ["SENTRY_DSN"] = ""  # belt and braces: only app.main initialises Sentry
    if stub:
        os.environ["USE_STUB_LLM"] = "true"
        os.environ["OPENAI_API_KEY"] = ""
    else:
        os.environ["USE_STUB_LLM"] = "false"
        os.environ["OPENAI_API_KEY"] = key
        if model:
            os.environ["MODEL_ID"] = model

    from app.config import get_settings
    from app.core import ghost_signals, job_search
    from app.core.providers import PROVIDERS, JobHit
    from app.core.providers import linkedin as linkedin_mod
    from app.core.providers.linkedin import LinkedInProvider
    from app.db import database
    from app.llm import metering
    from app.llm.client import OpenAIClient, StubClient, get_llm_client
    from app.models import ResumeModel, SearchContext

    url = database.engine.url
    if url.get_backend_name() != "sqlite" or Path(url.database or "").resolve() != db_path.resolve():
        raise RuntimeError(f"ghost_eval: refusing a non-scratch database ({url.get_backend_name()})")
    # Greenhouse and Comeet read their company registries from the DB and seed
    # them on first use of an EXISTING table. Without this every search would
    # drop both boards into `source_errors`, and long_open/first_published
    # (Greenhouse-only) would read as "no firings" instead of "unmeasured".
    database.init_db()
    import app.core.providers.comeet as comeet_mod
    import app.core.providers.drushim as drushim_mod
    import app.core.providers.greenhouse as greenhouse_mod
    import app.core.providers.jobmaster as jobmaster_mod
    from app.core import job_match

    return SimpleNamespace(
        settings=get_settings(), ghost_signals=ghost_signals, job_search=job_search,
        PROVIDERS=PROVIDERS, JobHit=JobHit, linkedin_mod=linkedin_mod, LinkedInProvider=LinkedInProvider,
        database=database, metering=metering, OpenAIClient=OpenAIClient, StubClient=StubClient,
        get_llm_client=get_llm_client, ResumeModel=ResumeModel, SearchContext=SearchContext,
        http_modules=[job_match, comeet_mod, drushim_mod, greenhouse_mod, jobmaster_mod],
    )


# =========================================================================== #
# The ledger and the budget guard
# =========================================================================== #
class Ledger:
    """Every real run ever made from this out dir, with what it spent."""

    def __init__(self, path: Path):
        self.path = path
        if path.exists():
            self.data = json.loads(path.read_text(encoding="utf-8"))
        else:
            self.data = {"version": 1, "runs": []}
        self.data.update(budget_usd=BUDGET_USD, max_calls=MAX_CALLS, max_paid_runs=MAX_PAID_RUNS)

    @property
    def runs(self) -> list[dict[str, Any]]:
        return self.data["runs"]

    def totals(self) -> SimpleNamespace:
        usd = sum(float(r.get("usd", 0) or 0) for r in self.runs)
        calls = sum(int(r.get("calls", 0) or 0) for r in self.runs)
        paid = sum(1 for r in self.runs if int(r.get("calls", 0) or 0) > 0)
        ends = [r.get("ended_at") or r.get("started_at") for r in self.runs]
        return SimpleNamespace(usd=usd, calls=calls, paid=paid, last_end=max((e for e in ends if e), default=""))

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        _write_json(self.path, self.data)


class BudgetExhausted(RuntimeError):
    """Raised INSTEAD of a model call. `_score_hit` records it and the posting
    lands in `skipped`; its ghost verdict was already taken."""


class BudgetGuard:
    def __init__(
        self,
        *,
        price: tuple[float, float],
        calls_left: int,
        usd_left: float,
        run_share_usd: float,
        worst_completion: int,
        run_entry: dict[str, Any] | None = None,
        on_change: Callable[[], None] | None = None,
    ):
        self.cv = threading.Condition()
        self.price_in, self.price_out = price
        self.calls_left = calls_left
        self.usd_left = usd_left
        self.run_share_usd = run_share_usd
        self.worst_completion = worst_completion
        self.run_entry = run_entry if run_entry is not None else {}
        self.on_change = on_change or (lambda: None)
        self.inflight: dict[int, tuple[float, float]] = {}
        self.next_id = 0
        self.billed = 0
        self.unbilled_failures = 0
        self.usd = 0.0
        self.prompt = 0
        self.completion = 0
        self.refused = 0
        self.max_completion = 0
        self.closed_reason = ""
        self.per_posting: dict[str, dict[str, Any]] = {}

    def cost(self, prompt: float, completion: float) -> float:
        return prompt / 1e6 * self.price_in + completion / 1e6 * self.price_out

    def worst(self, nbytes: int) -> float:
        # A BPE token is at least one byte, so the prompt cannot exceed its
        # UTF-8 length; the completion cannot exceed the output cap.
        return self.cost(nbytes + 64, self.worst_completion)

    def estimate(self, nbytes: int) -> float:
        return self.cost(nbytes / 3 + 16, max(1500, 2 * self.max_completion))

    def _posting(self, url: str) -> dict[str, Any]:
        return self.per_posting.setdefault(
            _k(url), {"calls": 0, "prompt": 0, "completion": 0, "usd": 0.0, "refused": 0, "errors": []}
        )

    def _persist(self) -> None:
        self.run_entry.update(
            calls=self.billed + len(self.inflight),
            usd=round(self.usd + sum(w for w, _ in self.inflight.values()), 6),
            prompt_tokens=self.prompt,
            completion_tokens=self.completion,
            refused=self.refused,
            budget_stop=self.closed_reason,
        )
        self.on_change()

    def admit(self, nbytes: int, url: str = "") -> tuple[int, str, float]:
        with self.cv:
            while True:
                if self.closed_reason:
                    self.refused += 1
                    self._posting(url)["refused"] += 1
                    self._persist()
                    raise BudgetExhausted(self.closed_reason)
                worst, est = self.worst(nbytes), self.estimate(nbytes)
                n_in = len(self.inflight)
                reason = ""
                if self.billed + n_in + 1 > self.calls_left:
                    reason = f"call cap ({self.calls_left} left for this run)"
                elif self.usd + sum(w for w, _ in self.inflight.values()) + worst > self.usd_left:
                    reason = f"money cap, worst case (${self.usd_left:.4f} left in the budget)"
                elif self.usd + sum(e for _, e in self.inflight.values()) + est > self.run_share_usd:
                    reason = f"this run's share (${self.run_share_usd:.4f})"
                if not reason:
                    break
                if n_in:
                    self.cv.wait()  # the calls in flight may settle below their worst case
                    continue
                self.closed_reason = "budget stop: " + reason
            self.next_id += 1
            self.inflight[self.next_id] = (worst, est)
            self._persist()
            return self.next_id, url, est

    def settle(self, ticket: tuple[int, str, float], prompt: int | None, completion: int | None) -> None:
        tid, url, est = ticket
        with self.cv:
            self.inflight.pop(tid, None)
            usd = est if prompt is None or completion is None else self.cost(prompt, completion)
            self.billed += 1
            self.usd += usd
            row = self._posting(url)
            row["calls"] += 1
            row["usd"] = round(row["usd"] + usd, 6)
            if prompt is not None and completion is not None:
                self.prompt += prompt
                self.completion += completion
                self.max_completion = max(self.max_completion, completion)
                row["prompt"] += prompt
                row["completion"] += completion
            self._persist()
            self.cv.notify_all()

    def fail(self, ticket: tuple[int, str, float], exc: BaseException) -> None:
        tid, url, est = ticket
        status = getattr(exc, "status_code", None)
        billed = status is None or status >= 500
        with self.cv:
            self.inflight.pop(tid, None)
            self._posting(url)["errors"].append(f"{type(exc).__name__} {status or ''}".strip())
            if billed:  # a timeout or a 5xx may still have been billed: count its estimate
                self.billed += 1
                self.usd += est
            else:
                self.unbilled_failures += 1
                if status in (401, 403):
                    self.closed_reason = f"budget stop: the API refused the key (HTTP {status})"
            self._persist()
            self.cv.notify_all()


# =========================================================================== #
# Instrumentation: listen at the seams, restore everything
# =========================================================================== #
class Recorder:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.ghost: dict[str, dict[str, Any]] = {}
        self.fetch: dict[str, dict[str, Any]] = {}
        self.http: list[dict[str, Any]] = []
        self.queries: dict[str, list[dict[str, Any]]] = {}
        self.selections: list[list[Any]] = []
        self.now: datetime | None = None
        self.net_attempts: list[str] = []


def _patch(undo: list, obj: Any, name: str, value: Any) -> None:
    had = name in getattr(obj, "__dict__", {})
    undo.append((obj, name, had, getattr(obj, name, None) if had else None))
    setattr(obj, name, value)


@contextmanager
def instrument(
    A: SimpleNamespace,
    rec: Recorder,
    guard: BudgetGuard,
    *,
    stub: bool,
    boards: dict[str, Any] | None = None,
    linkedin_transport: Callable[..., str] | None = None,
    fixed_now: datetime | None = None,
) -> Iterator[None]:
    undo: list = []
    swapped: dict[str, Any] = {}
    try:
        for name, board in (boards or {}).items():
            swapped[name] = A.PROVIDERS.get(name)
            A.PROVIDERS[name] = board

        # 1. The verdict, for EVERY posting that reaches the classifier.
        orig_ghost = A.job_search._ghost_for

        def ghost_for(hit, jd_text, sighting, now):  # noqa: ANN001
            _TLS.url = hit.url
            report = orig_ghost(hit, jd_text, sighting, now)
            with rec.lock:
                rec.ghost[_k(hit.url)] = {
                    "jd_text": jd_text,
                    "report": report.model_dump() if report is not None else None,
                    "had_sighting": sighting is not None,
                }
            return report

        _patch(undo, A.job_search, "_ghost_for", ghost_for)

        # 2. The one instant the run classifies against.
        orig_now = A.job_search.utc_now

        def utc_now() -> datetime:
            value = fixed_now or orig_now()
            rec.now = value
            return value

        _patch(undo, A.job_search, "utc_now", utc_now)

        # 3. The selection. `_displaced_low_pay` runs `select_hits` over COPIES
        # first, so the LAST call is the kept selection (asserted after the run).
        orig_select = A.job_search.select_hits

        def select_hits(tiers, limit):  # noqa: ANN001
            out = orig_select(tiers, limit)
            rec.selections.append(list(out))
            return out

        _patch(undo, A.job_search, "select_hits", select_hits)

        # 4. Every board's queries and fetches, on the INSTANCE.
        for name, prov in A.PROVIDERS.items():
            def search(ctx, _orig=prov.search, _name=name):  # noqa: ANN001
                q: dict[str, Any] = {"title": ctx.job_title, "location": ctx.location, "work_mode": ctx.work_mode}
                try:
                    hits = _orig(ctx)
                except Exception as e:
                    q["error"] = f"{type(e).__name__}: {_scrub(str(e))[:200]}"
                    raise
                else:
                    q["hits"] = len(hits)
                    return hits
                finally:
                    with rec.lock:
                        rec.queries.setdefault(_name, []).append(q)

            def fetch_description(hit, _orig=prov.fetch_description):  # noqa: ANN001
                _TLS.url = hit.url
                entry: dict[str, Any] = {"text": "", "closed": ""}
                try:
                    entry["text"] = _orig(hit) or ""
                    return entry["text"]
                except Exception as e:
                    entry["error"] = f"{type(e).__name__}: {_scrub(str(e))[:200]}"
                    raise
                finally:
                    entry["closed"] = hit.closed
                    with rec.lock:
                        rec.fetch[_k(hit.url)] = entry

            _patch(undo, prov, "search", search)
            _patch(undo, prov, "fetch_description", fetch_description)

        # 5. LinkedIn's status per job id: the only seam where a 404 differs
        # from a 429, a 999, a timeout or a login wall. Under --stub with no
        # canned transport the inner call is a tripwire, never the network.
        inner = linkedin_transport or (
            _tripwire(rec, "linkedin._http_get") if stub else A.linkedin_mod._http_get
        )

        def http_get(url, *args, **kwargs):  # noqa: ANN001
            what = "posting" if "/jobPosting/" in url else "search"
            entry: dict[str, Any] = {"what": what, "url": url}
            if what == "posting":
                entry["job_id"] = url.rstrip("/").rsplit("/", 1)[-1]
            try:
                body = inner(url, *args, **kwargs)
            except urllib.error.HTTPError as e:
                entry["status"] = e.code
                raise
            except Exception as e:
                entry["error"] = type(e).__name__
                raise
            else:
                entry["status"] = 200
                entry["bytes"] = len(body or "")
                return body
            finally:
                with rec.lock:
                    rec.http.append(entry)

        _patch(undo, A.linkedin_mod, "_http_get", http_get)

        # 6. The budget guard, on the one method that sends a request.
        if stub:
            orig_cj = A.StubClient.complete_json

            def complete_json(self, system, user):  # noqa: ANN001
                nbytes = len(system.encode("utf-8")) + len(user.encode("utf-8"))
                ticket = guard.admit(nbytes, getattr(_TLS, "url", ""))
                try:
                    out = orig_cj(self, system, user)
                except Exception as e:
                    guard.fail(ticket, e)
                    raise
                # The stub reports no usage; synthesise it so the guard AND the
                # request's metering tally see a number, the way OpenAIClient does.
                p, c = nbytes // 4, len(json.dumps(out, ensure_ascii=False).encode("utf-8")) // 4
                A.metering.record(p, c)
                guard.settle(ticket, p, c)
                return out

            _patch(undo, A.StubClient, "complete_json", complete_json)
            # The offline contract, enforced: nothing below may reach a socket.
            for mod in A.http_modules:
                _patch(undo, mod, "_http_get", _tripwire(rec, f"{mod.__name__}._http_get"))
            _patch(undo, socket, "getaddrinfo", _tripwire(rec, "socket.getaddrinfo"))
            _patch(undo, socket, "create_connection", _tripwire(rec, "socket.create_connection"))
            _patch(undo, socket.socket, "connect", _tripwire(rec, "socket.socket.connect"))
        else:
            orig_metered = A.OpenAIClient._metered

            def _metered(self, kwargs):  # noqa: ANN001
                nbytes = sum(len(str(m.get("content", "")).encode("utf-8")) for m in kwargs.get("messages", []))
                ticket = guard.admit(nbytes, getattr(_TLS, "url", ""))
                try:
                    resp = orig_metered(self, kwargs)
                except Exception as e:
                    guard.fail(ticket, e)
                    raise
                usage = getattr(resp, "usage", None)
                if usage is None:
                    guard.settle(ticket, None, None)
                else:
                    guard.settle(
                        ticket,
                        int(getattr(usage, "prompt_tokens", 0) or 0),
                        int(getattr(usage, "completion_tokens", 0) or 0),
                    )
                return resp

            _patch(undo, A.OpenAIClient, "_metered", _metered)
        yield
    finally:
        for obj, name, had, old in reversed(undo):
            if had:
                setattr(obj, name, old)
            else:
                delattr(obj, name)
        for name, prov in swapped.items():
            if prov is None:
                A.PROVIDERS.pop(name, None)
            else:
                A.PROVIDERS[name] = prov


def _tripwire(rec: Recorder, what: str) -> Callable[..., Any]:
    def trip(*args: Any, **kwargs: Any) -> Any:
        with rec.lock:
            rec.net_attempts.append(what)
        raise RuntimeError(f"ghost_eval --stub is offline: {what} was called")

    return trip


# =========================================================================== #
# One search, and its corpus
# =========================================================================== #
def run_search(A: SimpleNamespace, resume: Any, ctx: Any) -> tuple[Any, str, Any]:
    with A.metering.meter() as tally:
        try:
            result = A.job_search.search_jobs(resume, ctx, cache=None, sightings_fn=None)
            error = ""
        except Exception as e:  # noqa: BLE001 - the verdicts were logged; keep them
            result, error = None, f"{type(e).__name__}: {_scrub(str(e))[:400]}"
    return result, error, tally


def _bucket(days: int) -> str:
    for floor, name in AGE_BUCKETS:
        if days >= floor:
            return name
    return ""


def _outcome(hit: Any, fetch: dict | None, http: dict | None) -> str:
    if hit.source == "linkedin" and http is not None:
        if http.get("status") == 200:
            if hit.closed:
                return "closed_banner"
            return "ok" if fetch and fetch.get("text") else "no_body"
        if "status" in http:
            return f"http_{http['status']}"
        return "network_error"
    if fetch is not None:
        return "fetched" if fetch.get("text") else "fetched_empty"
    return "inline"


def build_corpus(
    A: SimpleNamespace, rec: Recorder, guard: BudgetGuard, result: Any, error: str, ctx: Any
) -> dict[str, Any]:
    now = rec.now
    selected = rec.selections[-1] if rec.selections else []
    matches = {_k(m.url): m for m in (result.matches if result else [])}
    filtered = {_k(f.url): f for f in (result.filtered if result else [])}
    http_by_job = {e["job_id"]: e for e in rec.http if e.get("what") == "posting"}
    selected_keys = {_k(h.url) for h in selected}
    problems = [
        f"a ranked or per-hit filtered url was not in the recorded selection: {u}"
        for u in list(matches) + [u for u, f in filtered.items() if f.reason != "market"]
        if u not in selected_keys
    ]
    postings: list[dict[str, Any]] = []
    for hit in selected:
        u = _k(hit.url)
        g, f = rec.ghost.get(u), rec.fetch.get(u)
        jid = A.linkedin_mod._linkedin_job_id(hit.url) if hit.source == "linkedin" else ""
        http = http_by_job.get(jid) if jid else None
        fil = filtered.get(u)
        if g is not None:
            population, jd_text = "classified", g["jd_text"]
        elif fil is not None and fil.reason == "restriction":
            population, jd_text = "geo_blocked", hit.description or (f or {}).get("text", "")
        elif hit.closed:
            # Closed with no text (HTTP 404/410, or a banner over an empty body):
            # `_build_match` classifies only inside `if jd_text:`, so search_jobs
            # counts it in `skipped`. Recorded as the would-be closed firing.
            population, jd_text = "closed_unclassified", ""
        else:
            population, jd_text = "no_text", ""
        report = g["report"] if g else None
        signals = list(report["signals"]) if report else []
        if population == "closed_unclassified":
            signals = [{"kind": "closed", "strength": "certain", "raw": hit.closed, "days": 0, "since": "", "basis": ""}]
        rule = ""
        if any(s["kind"] == "evergreen" for s in signals):
            ev = next(s for s in signals if s["kind"] == "evergreen")
            if ev["strength"] == "weak":
                rule = "weak"
            else:
                # The app's own classifier on the title alone, never a second
                # matcher: a strong evergreen it still finds is the title rule.
                alone = A.ghost_signals.detect_ghost_signals(title=hit.title, jd_text="", now=now)
                rule = "title" if alone and any(s.kind == "evergreen" for s in alone.signals) else "body"
        lo = next((s for s in signals if s["kind"] == "long_open"), None)
        m = matches.get(u)
        in_app = "ranked" if m else (f"filtered:{fil.reason}" if fil else "skipped")
        postings.append({
            "url": hit.url,
            "source": hit.source,
            "external_id": hit.external_id,
            "title": hit.title,
            "company": hit.company,
            "location": hit.location,
            "posted_at": hit.posted_at,
            "first_published": str((hit.raw or {}).get("first_published") or ""),
            "origin_market": hit.origin_market,
            "stale": hit.stale,
            "also_on": list(hit.also_on),
            "description_inline": bool(hit.description),
            "fetch_outcome": _outcome(hit, f, http),
            "http_status": (http or {}).get("status"),
            "fetch_error": (http or {}).get("error") or (f or {}).get("error", ""),
            "closed": hit.closed,
            "population": population,
            "jd_text": jd_text,
            "signals": signals,
            "likely": bool(report and report["likely"]),
            "evergreen_rule": rule,
            "long_open_days": lo["days"] if lo else None,
            "long_open_basis": lo["basis"] if lo else "",
            "age_bucket": _bucket(lo["days"]) if lo else "",
            "in_app": in_app,
            "fit": {"overall": m.overall, "keyword_coverage": m.keyword_coverage, "fit_score": m.fit_score} if m else None,
            "llm": guard.per_posting.get(u, {"calls": 0, "refused": 0, "errors": []}),
        })
    out_of_population = [
        {"url": f.url, "source": f.source, "title": f.title, "company": f.company,
         "location": f.location, "reason": f.reason}
        for f in (result.filtered if result else []) if f.reason == "market"
    ]
    boards: dict[str, Any] = {}
    for name in ctx.sources:
        qs = rec.queries.get(name, [])
        boards[name] = {
            "queries": qs,
            "hits": sum(q.get("hits", 0) for q in qs),
            "selected": sum(1 for p in postings if p["source"] == name),
            "classified": sum(1 for p in postings if p["source"] == name and p["population"] == "classified"),
            "source_error": (result.source_errors.get(name, "") if result else ""),
            "source_empty": (result.source_empty.get(name, "") if result else ""),
        }
    http_summary: dict[str, int] = {}
    for e in rec.http:
        key = f"{e['what']}:{e.get('status', e.get('error', '?'))}"
        http_summary[key] = http_summary.get(key, 0) + 1
    return {
        "now": now.isoformat() if now else "",
        "error": error,
        "skipped": result.skipped if result else None,
        "boards": boards,
        "http_summary": http_summary,
        "measurable": _measurable(postings, boards, ctx),
        "postings": postings,
        "out_of_population": out_of_population,
        "problems": problems,
    }


def _measurable(postings: list[dict], boards: dict[str, Any], ctx: Any) -> dict[str, str]:
    """Which signal kinds this run could have seen fire. A kind whose only
    source board errored or returned nothing is UNMEASURED, never zero."""
    out: dict[str, str] = {}
    li = [p for p in postings if p["source"] == "linkedin"]
    # A page that rendered, or a 404/410. A 200 with no body is usually a login
    # wall, which can carry no banner, so it cannot say whether the job closed.
    answered = [p for p in li if p["fetch_outcome"] in ("ok", "closed_banner", "http_404", "http_410")]
    if "linkedin" not in ctx.sources:
        out["closed"] = "unmeasured: LinkedIn was not searched"
    elif not li:
        why = boards.get("linkedin", {}).get("source_error") or "no LinkedIn posting was selected"
        out["closed"] = f"unmeasured: {why}"
    elif not answered:
        seen = sorted({p["fetch_outcome"] for p in li})
        out["closed"] = f"unmeasured: no LinkedIn detail page answered ({', '.join(seen)})"
    else:
        out["closed"] = f"measured: {len(answered)} of {len(li)} LinkedIn detail pages answered"
    gh = [p for p in postings if p["source"] == "greenhouse" and p["population"] == "classified"]
    if "greenhouse" not in ctx.sources:
        out["long_open/first_published"] = "unmeasured: Greenhouse was not searched"
    elif not gh:
        why = boards.get("greenhouse", {}).get("source_error") or "no Greenhouse posting was classified"
        out["long_open/first_published"] = f"unmeasured: {why}"
    else:
        dated = sum(1 for p in gh if p["first_published"])
        out["long_open/first_published"] = f"measured: {len(gh)} Greenhouse postings classified, {dated} with first_published"
    n = sum(1 for p in postings if p["population"] == "classified")
    out["evergreen"] = f"measured: {n} postings classified" if n else "unmeasured: nothing was classified"
    out["long_open/first_seen"] = (
        f"unmeasured: local runs carry no sightings; production rows only, from about {FIRST_SEEN_FROM}"
    )
    out["reposted"] = "not measured locally: production rows only (a local seed would manufacture host-mismatch reposts)"
    return out


def worksheet_rows(run_id: str, corpus: dict[str, Any]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for p in corpus["postings"]:
        if not p["signals"]:
            continue
        kinds = {s["kind"]: s for s in p["signals"]}
        closed = kinds.get("closed")
        quote = next((s["raw"] for s in p["signals"] if s.get("raw")), "")
        rows.append({
            "run_id": run_id,
            "url": p["url"],
            "source": p["source"],
            "title": p["title"],
            "company": p["company"],
            "location": p["location"],
            "posted_at": p["posted_at"],
            "first_published": p["first_published"],
            "fetch_outcome": p["fetch_outcome"],
            "in_app": p["in_app"],
            "signals": "; ".join(f"{s['kind']}:{s['strength']}" for s in p["signals"]),
            "likely": "yes" if p["likely"] else "no",
            "evergreen_rule": p["evergreen_rule"],
            "long_open_days": "" if p["long_open_days"] is None else str(p["long_open_days"]),
            "long_open_basis": p["long_open_basis"],
            "age_bucket": p["age_bucket"],
            "closed_evidence": closed["raw"] if closed else "",
            "quote": quote,
            "fit_overall": "" if not p["fit"] else str(p["fit"]["overall"]),
            "owner_check": OWNER_LINKEDIN if closed and p["source"] == "linkedin" else "",
            "label": "", "bug": "", "evidence": "", "checked_on": "",
        })
    return rows


def write_worksheet(path: Path, rows: list[dict[str, str]]) -> None:
    # utf-8-sig so Excel opens the Hebrew correctly; save back as "CSV UTF-8".
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=WS_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def read_worksheet(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as fh:
        return [{k: (v or "").strip() for k, v in row.items() if k} for row in csv.DictReader(fh)]


def find_secret(paths: list[Path], secret: str) -> list[Path]:
    if not secret:
        return []
    return [p for p in paths if p.exists() and secret in p.read_text(encoding="utf-8", errors="ignore")]


# =========================================================================== #
# The report: the decision rule applied to labelled worksheets
# =========================================================================== #
def wilson_lower(k: int, n: int, z: float = 1.959964) -> float | None:
    if n <= 0:
        return None
    p = k / n
    centre = p + z * z / (2 * n)
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (centre - margin) / (1 + z * z / n)


def _kinds(row: dict[str, str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in (row.get("signals") or "").split(";"):
        kind, _, strength = part.strip().partition(":")
        if kind:
            out[kind] = strength
    return out


def _bugs(row: dict[str, str]) -> set[str]:
    return {b.strip().lower() for b in (row.get("bug") or "").split(",") if b.strip()}


def firing_outcome(row: dict[str, str], kind: str) -> str:
    """correct | wrong | bug | unclear | unlabelled, for one signal on one posting.
    A BUG (the signal's stated fact is false) is wrong whatever the posting is."""
    label = (row.get("label") or "").upper()
    bugs = _bugs(row)
    if label == "BUG" or kind in bugs or "all" in bugs:
        return "bug"
    return {"GHOST": "correct", "LIVE": "wrong", "UNCLEAR": "unclear"}.get(label, "unlabelled")


def posting_outcome(row: dict[str, str]) -> str:
    label = (row.get("label") or "").upper()
    if label == "BUG" or _bugs(row):
        return "bug"
    return {"GHOST": "correct", "LIVE": "wrong", "UNCLEAR": "unclear"}.get(label, "unlabelled")


def _cells_for(row: dict[str, str]) -> list[tuple[str, str]]:
    """(cell name, kind) pairs this posting's firings count toward."""
    out: list[tuple[str, str]] = []
    for kind in _kinds(row):
        if kind == "closed":
            http = (row.get("closed_evidence") or "").upper().startswith("HTTP")
            out.append(("closed · HTTP 404/410 (in skipped today)" if http else "closed · banner", kind))
        elif kind == "evergreen":
            out += [(f"evergreen · {row.get('evergreen_rule') or '?'}", kind), ("evergreen (all rules)", kind)]
        elif kind == "long_open":
            basis = row.get("long_open_basis") or "?"
            if basis == "first_published":
                out.append((f"long_open · first_published · {row.get('age_bucket') or '?'}", kind))
            else:
                out.append((f"long_open · {basis}", kind))
            out.append(("long_open (all)", kind))
        else:
            out.append((kind, kind))
    return out


def merge_rows(worksheets: list[Path]) -> tuple[list[dict[str, str]], list[str]]:
    """One row per posting, first observation wins; a label on any later row of
    the same URL is carried over, and two different labels are a conflict."""
    by_url: dict[str, dict[str, str]] = {}
    notes: list[str] = []
    for path in sorted(worksheets, key=lambda p: p.parent.name):
        for row in read_worksheet(path):
            key = _k(row.get("url", ""))
            if not key:
                continue
            if key not in by_url:
                by_url[key] = row
                continue
            first = by_url[key]
            for col in ("label", "bug", "evidence", "checked_on"):
                if row.get(col) and not first.get(col):
                    first[col] = row[col]
                elif col == "label" and row.get(col) and row[col].upper() != first[col].upper():
                    notes.append(f"label conflict on {key}: {first[col]} vs {row[col]} (treated as unlabelled)")
                    first["label"] = ""
    return list(by_url.values()), notes


def evaluate(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    cells: dict[str, dict[str, Any]] = {}

    def cell(name: str) -> dict[str, Any]:
        return cells.setdefault(name, {"cell": name, "fired": 0, "correct": 0, "wrong": 0, "bug": 0,
                                       "unclear": 0, "unlabelled": 0})

    for fixed in ("closed · banner", "closed · HTTP 404/410 (in skipped today)", "evergreen · title",
                  "evergreen · body", "evergreen · weak", "evergreen (all rules)",
                  *[f"long_open · first_published · {b}" for _, b in reversed(AGE_BUCKETS)],
                  "long_open (all)", "long_open · first_seen", "reposted", "likely (the badge)"):
        cell(fixed)
    for row in rows:
        for name, kind in _cells_for(row):
            c = cell(name)
            c["fired"] += 1
            c[firing_outcome(row, kind)] += 1
        if (row.get("likely") or "").lower() == "yes":
            c = cell("likely (the badge)")
            c["fired"] += 1
            c[posting_outcome(row)] += 1
    out = []
    for c in cells.values():
        n = c["correct"] + c["wrong"] + c["bug"]
        judged = n + c["unclear"]
        c["n"] = n
        c["precision"] = (c["correct"] / n) if n else None
        c["wilson"] = wilson_lower(c["correct"], n)
        c["decidable"] = judged > 0 and c["unclear"] * 2 <= judged
        c["verdict"] = _verdict(c)
        out.append(c)
    return out


def _verdict(c: dict[str, Any]) -> str:
    name, n, wrong = c["cell"], c["n"], c["wrong"] + c["bug"]
    if name == "long_open · first_seen":
        return f"unmeasured until about {FIRST_SEEN_FROM}: production rows only" if not c["fired"] else "production rows"
    if name == "reposted" and not c["fired"]:
        return "not measured locally: production rows only"
    if n == 0:
        return "unmeasured (n=0)" + (f", {c['unlabelled']} awaiting labels" if c["unlabelled"] else "")
    if not c["decidable"]:
        return "undecidable: UNCLEAR is more than half"
    if name == "closed · banner":
        return "P0 DEFECT: a live posting was called closed" if wrong else "no live posting called closed"
    if name.startswith("closed · HTTP"):
        return f"{c['correct']} of {n} really closed: evidence for the owner's 404/410 decision"
    if name == "likely (the badge)":
        met = n >= EMAIL_MIN_N and c["precision"] >= EMAIL_MIN_PRECISION
        return ("EMAIL BAR MET: may be PROPOSED to leave the email; owner approval required" if met
                else f"email bar not met (needs n>={EMAIL_MIN_N} at >={EMAIL_MIN_PRECISION:.0%}): badge only")
    met = n >= HIDE_MIN_N and wrong <= HIDE_MAX_WRONG
    return ("HIDE BAR MET: may be PROPOSED as a filter; owner decides" if met
            else f"hide bar not met (needs n>={HIDE_MIN_N}, 0 wrong): badge only")


def print_report(worksheets: list[Path]) -> int:
    rows, notes = merge_rows(worksheets)
    print(f"{len(worksheets)} worksheet(s), {len(rows)} postings that fired (deduped by URL, first observation wins)")
    for ws in worksheets:
        run_json = ws.parent / "run.json"
        if run_json.exists():
            meta = json.loads(run_json.read_text(encoding="utf-8"))
            print(f"\n  {ws.parent.name}: {meta.get('preset', '')} · model {meta.get('model', '')} · "
                  f"{meta.get('llm', {}).get('billed_calls', 0)} calls · ${meta.get('llm', {}).get('usd', 0):.4f}")
            for kind, state in (meta.get("measurable") or {}).items():
                print(f"      {kind:<28} {state}")
    head = (f"\n{'cell':<44}{'fired':>6}{'GHOST':>6}{'LIVE':>6}{'BUG':>5}{'UNCL':>6}{'todo':>6}"
            f"{'n':>5}{'prec':>7}{'wilson':>8}  verdict")
    print(head)
    print("-" * (len(head) + 30))
    for c in evaluate(rows):
        prec = "-" if c["precision"] is None else f"{c['precision']:.2f}"
        wil = "-" if c["wilson"] is None else f"{c['wilson']:.2f}"
        print(f"{c['cell']:<44}{c['fired']:>6}{c['correct']:>6}{c['wrong']:>6}{c['bug']:>5}{c['unclear']:>6}"
              f"{c['unlabelled']:>6}{c['n']:>5}{prec:>7}{wil:>8}  {c['verdict']}")
    print(f"\nBars (PLAN 28.5): hide on a soft signal only at n>={HIDE_MIN_N} labelled with 0 wrong; "
          f"`likely` leaves the email only at n>={EMAIL_MIN_N} with >={EMAIL_MIN_PRECISION:.0%} correct "
          "AND the owner's approval. Below them: badge only. Precision = GHOST / (GHOST + LIVE + BUG); "
          "UNCLEAR is never folded in.")
    owner = [r for r in rows if r.get("owner_check") and not r.get("label")]
    if owner:
        print(f"\nOWNER CHECK ({len(owner)}): open each while logged in to LinkedIn; never click Apply.")
        for r in owner:
            print(f"  {r['url']}  [{r.get('closed_evidence', '')}]  {r.get('title', '')} · {r.get('company', '')}")
    for note in notes:
        print("NOTE:", note)
    return 0


# =========================================================================== #
# Fake boards: synthetic postings (--stub) or a recorded corpus (--replay)
# =========================================================================== #
class FakeBoard:
    """Returns each posting only for the query of its own origin market — the
    fan-out stamps `origin_market` from the query, so that is how a recorded
    worldwide posting comes back stamped exactly as it was."""

    def __init__(self, A: SimpleNamespace, name: str, postings: list[dict], local: str, fetch: Callable):
        self.A, self.name, self.postings, self.local, self._fetch = A, name, postings, local, fetch

    def search(self, ctx: Any) -> list[Any]:
        origin = "" if ctx.location == self.local else ctx.location
        return [self._hit(p) for p in self.postings if (p.get("origin_market") or "") == origin]

    def _hit(self, p: dict) -> Any:
        return self.A.JobHit(
            source=self.name,
            external_id=p.get("external_id", ""),
            title=p["title"],
            company=p["company"],
            location=p.get("location", ""),
            description=p.get("description", ""),
            url=p["url"],
            posted_at=p.get("posted_at", ""),
            raw={"first_published": p["first_published"]} if p.get("first_published") else {},
        )

    def fetch_description(self, hit: Any) -> str:
        return self._fetch(hit)


_SYN_NOW = datetime(2026, 9, 22, 9, 0, 0)  # naive UTC, the stub's fixed instant


def _ago(days: float) -> str:
    return (_SYN_NOW - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S+00:00")


_EN = ("We build backend services in Python and PostgreSQL. You will own APIs and data pipelines. "
       "Requirements: 3+ years of Python, SQL and REST.")
_HE = "חברת תוכנה מובילה מחפשת מפתח/ת Backend. דרישות: ניסיון של 3 שנים לפחות בפייתון ו-SQL."


def _li_page(body: str) -> str:
    return f'<section class="show-more-less-html"><div class="show-more-less-html__markup">{body}</div></section>'


def synthetic_postings() -> list[dict[str, Any]]:
    """Every seam the harness listens at, each with its expected reading.
    `expect` is (fetch_outcome, population, {kind: strength}, in_app)."""
    li = [
        ("open", ("fixture", "linkedin_job_open.html"), "", ("ok", "classified", {}, "ranked")),
        ("banner", ("fixture", "linkedin_job_closed.html"), "",
         ("closed_banner", "classified", {"closed": "certain"}, "filtered:closed")),
        ("gone404", ("status", 404), "", ("http_404", "closed_unclassified", {"closed": "certain"}, "skipped")),
        ("gone410", ("status", 410), "", ("http_410", "closed_unclassified", {"closed": "certain"}, "skipped")),
        ("throttled", ("status", 429), "", ("http_429", "no_text", {}, "skipped")),
        ("blocked", ("status", 999), "", ("http_999", "no_text", {}, "skipped")),
        ("timeout", ("timeout",), "", ("network_error", "no_text", {}, "skipped")),
        ("wall", ("html", "<html><title>Sign Up | LinkedIn</title><body>Sign in to view more jobs. authwall</body></html>"),
         "", ("no_body", "no_text", {}, "skipped")),
        ("usonly", ("html", _li_page("Python and SQL. Applicants must be legally authorized to work in the United States.")),
         "United States", ("ok", "geo_blocked", {}, "filtered:restriction")),
        # Hidden by `pay_market` BEFORE selection, so `select_hits` also runs
        # over copies first: the harness must keep the LAST (kept) selection.
        ("sofia", ("html", _li_page(_EN)), "European Union", ("", "market", {}, "")),
    ]
    places = {"United States": "United States", "European Union": "Sofia, Bulgaria"}
    out: list[dict[str, Any]] = []
    for i, (slug, resp, origin, expect) in enumerate(li, 1):
        out.append({"source": "linkedin", "slug": slug, "title": "Backend Engineer", "company": f"Linked Co {i}",
                    "location": places.get(origin, "Tel Aviv, Israel"), "origin_market": origin,
                    "posted_at": "2026-09-20",
                    "url": f"https://www.linkedin.com/jobs/view/backend-engineer-{slug}-40000000{i:02d}",
                    "response": resp, "expect": expect})
    gh = [
        ("old", "Backend Engineer", 75, ("inline", "classified", {"long_open": "strong"}, "ranked")),
        ("mid", "Backend Engineer", 40, ("inline", "classified", {"long_open": "weak"}, "ranked")),
        ("young", "Backend Engineer", 10, ("inline", "classified", {}, "ranked")),
        ("pool", "Talent Pool - Engineering", 100,
         ("inline", "classified", {"evergreen": "strong", "long_open": "strong"}, "ranked")),
    ]
    for i, (slug, title, age, expect) in enumerate(gh, 1):
        out.append({"source": "greenhouse", "slug": slug, "title": title, "company": f"Green Co {i}",
                    "location": "Tel Aviv, Israel", "posted_at": _ago(1), "first_published": _ago(age),
                    "description": _EN, "url": f"https://boards.greenhouse.io/greenco{i}/jobs/50000{i}",
                    "expect": expect})
    dr = [
        ("nospecific", _HE + " לא מדובר במשרה ספציפית, אלא בהגשת קורות חיים כללית.",
         ("inline", "classified", {"evergreen": "strong"}, "ranked")),
        ("privacy", _HE + " קורות החיים יישמרו במאגר החברה לצורך משרות עתידיות.",
         ("inline", "classified", {}, "ranked")),
        ("weak", _HE + " אנחנו תמיד מחפשים אנשים מוכשרים שיצטרפו אלינו.",
         ("inline", "classified", {"evergreen": "weak"}, "ranked")),
    ]
    for i, (slug, body, expect) in enumerate(dr, 1):
        out.append({"source": "drushim", "slug": slug, "title": "מפתח/ת Backend", "company": f"חברה {i}",
                    "location": "תל אביב", "posted_at": _ago(2), "description": body,
                    "url": f"https://www.drushim.co.il/job/3000000{i}/abc{i}/", "expect": expect})
    cm = [
        ("plain", _EN, ("inline", "classified", {}, "ranked")),
        ("openings", _EN + " There are no specific openings at the moment, but we are happy to hear from you.",
         ("inline", "classified", {"evergreen": "strong"}, "ranked")),
    ]
    for i, (slug, body, expect) in enumerate(cm, 1):
        out.append({"source": "comeet", "slug": slug, "title": "Backend Engineer", "company": f"Comeet Co {i}",
                    "location": "Tel Aviv, Israel", "posted_at": _ago(3), "description": body,
                    "url": f"https://www.comeet.com/jobs/comeetco{i}/00.00{i}/backend-engineer/0{i}.00{i}",
                    "expect": expect})
    out.append({"source": "jobmaster", "slug": "fetched", "title": "מפתח/ת Backend", "company": "ג'ובמאסטר בע\"מ",
                "location": "תל אביב", "posted_at": _ago(1), "description": "", "fetch_text": _HE,
                "url": "https://www.jobmaster.co.il/jobs/checknum.asp?key=7000001",
                "expect": ("fetched", "classified", {}, "ranked")})
    return out


def _linkedin_transport(postings: list[dict]) -> Callable[..., str]:
    by_id = {p["url"].rsplit("-", 1)[-1]: p["response"] for p in postings if p["source"] == "linkedin"}

    def get(url: str, *args: Any, **kwargs: Any) -> str:
        if "/jobPosting/" not in url:
            raise RuntimeError("stub transport: only guest posting pages are canned")
        kind, *arg = by_id[url.rsplit("/", 1)[-1]]
        if kind == "status":
            raise urllib.error.HTTPError(url, arg[0], "canned", None, None)  # type: ignore[arg-type]
        if kind == "timeout":
            raise urllib.error.URLError("timed out")
        if kind == "fixture":
            return (HERE / "fixtures" / arg[0]).read_text(encoding="utf-8")
        return arg[0]

    return get


def _boards_for(
    A: SimpleNamespace, names: list[str], postings: list[dict], local: str, fetch_for: Callable[[str], Callable]
) -> dict:
    """A fake for EVERY board the context names, empty where no posting came
    from it: a real provider left in place would reach the network."""
    return {
        name: FakeBoard(A, name, [p for p in postings if p["source"] == name], local, fetch_for(name))
        for name in dict.fromkeys([*names, *(p["source"] for p in postings)])
    }


# =========================================================================== #
# Modes
# =========================================================================== #
class Checks:
    def __init__(self) -> None:
        self.passed = 0
        self.failed: list[str] = []

    def __call__(self, name: str, ok: bool, detail: str = "") -> None:
        if ok:
            self.passed += 1
        else:
            self.failed.append(name + (f" — {detail}" if detail else ""))
            print(f"  FAIL {name}" + (f" — {detail}" if detail else ""))


def _stub_ctx(A: SimpleNamespace) -> Any:
    return A.SearchContext(job_titles=["Backend Engineer"], location="Israel", work_mode="any",
                           include_worldwide=True, max_age_days=30, limit=25, sources=list(ALL_BOARDS))


def _stub_pass(A, resume, postings, guard, run_dir: Path, run_id: str) -> tuple[dict, Recorder, Any]:
    rec = Recorder()
    by_url = {_k(p["url"]): p for p in postings}
    real_li = A.LinkedInProvider()

    def fetch_for(name: str) -> Callable:
        if name == "linkedin":
            return real_li.fetch_description  # the REAL seam, over the canned transport
        return lambda hit: by_url[_k(hit.url)].get("fetch_text", "")

    ctx = _stub_ctx(A)
    boards = _boards_for(A, ctx.sources, postings, ctx.location, fetch_for)
    with instrument(A, rec, guard, stub=True, boards=boards,
                    linkedin_transport=_linkedin_transport(postings), fixed_now=_SYN_NOW):
        result, error, tally = run_search(A, resume, ctx)
    corpus = build_corpus(A, rec, guard, result, error, ctx)
    corpus.update(run_id=run_id, preset="stub", model="stub", context=ctx.model_dump(),
                  llm=_llm_summary(guard, tally))
    run_dir.mkdir(parents=True, exist_ok=True)
    _write_json(run_dir / "run.json", corpus)
    write_worksheet(run_dir / "worksheet.csv", worksheet_rows(run_id, corpus))
    return corpus, rec, tally


def _llm_summary(guard: BudgetGuard, tally: Any) -> dict[str, Any]:
    return {"billed_calls": guard.billed, "unbilled_failures": guard.unbilled_failures, "refused": guard.refused,
            "prompt_tokens": guard.prompt, "completion_tokens": guard.completion, "usd": round(guard.usd, 6),
            "budget_stop": guard.closed_reason,
            "tally": {"calls": tally.calls, "prompt": tally.prompt, "completion": tally.completion}}


def replay(A: SimpleNamespace, run_json: Path, run_dir: Path) -> tuple[dict, dict]:
    """Re-classify a recorded corpus offline: the same postings, the same text,
    the same closure evidence and the same instant, through the current code."""
    rec_corpus = json.loads(run_json.read_text(encoding="utf-8"))
    postings = [dict(p) for p in rec_corpus["postings"]]
    for p in postings:
        # Inline boards handed the classifier `hit.description`; fetched ones
        # went through `fetch_description`. Replay each the way it arrived.
        p["description"] = p["jd_text"] if p.get("description_inline") else ""
    by_url = {_k(p["url"]): p for p in postings}

    def fetch_for(name: str) -> Callable:
        def fetch(hit: Any) -> str:
            p = by_url[_k(hit.url)]
            hit.closed = p.get("closed", "")
            return p.get("jd_text", "")
        return fetch

    ctx_data = dict(rec_corpus["context"])
    ctx_data["limit"] = max(1, min(25, len(postings)))
    ctx = A.SearchContext(**ctx_data)
    now = datetime.fromisoformat(rec_corpus["now"])
    # The verdicts do not depend on the model, and a replay is offline: the
    # stub scores, so the resume only has to exist.
    resume = A.ResumeModel(headline="replay")
    guard = BudgetGuard(price=(1.0, 1.0), calls_left=10_000, usd_left=1e9, run_share_usd=1e9, worst_completion=16000)
    rec = Recorder()
    with instrument(A, rec, guard, stub=True, boards=_boards_for(A, ctx.sources, postings, ctx.location, fetch_for),
                    linkedin_transport=_linkedin_transport([]), fixed_now=now):
        result, error, _tally = run_search(A, resume, ctx)
    corpus = build_corpus(A, rec, guard, result, error, ctx)
    corpus["net_attempts"] = rec.net_attempts

    def shape(p: dict | None) -> tuple:
        if p is None:
            return ("missing", [])
        return (p["population"], sorted((s["kind"], s["strength"], s.get("basis", ""), s.get("days", 0))
                                        for s in p["signals"]))

    new = {_k(p["url"]): p for p in corpus["postings"]}
    diffs = {
        old["url"]: {"recorded": shape(old), "now": shape(new.get(key))}
        for key, old in by_url.items()
        if shape(old) != shape(new.get(key))
    }
    run_dir.mkdir(parents=True, exist_ok=True)
    _write_json(run_dir / "replay.json", {"source": str(run_json), "diffs": diffs, "corpus": corpus})
    return corpus, diffs


def stub_mode(args: argparse.Namespace) -> int:
    stub_root = HERE / "fixtures" / "ghost_eval" / "stub"
    _ensure_out(stub_root.parent)
    stub_root.mkdir(parents=True, exist_ok=True)
    A = _boot(db_path=stub_root / "scratch.db", stub=True)
    check = Checks()
    check("--stub runs on StubClient", type(A.get_llm_client()) is A.StubClient)

    if args.replay:
        corpus, diffs = replay(A, Path(args.replay), stub_root / "replay")
        print(f"replayed {len(corpus['postings'])} postings from {args.replay}: {len(diffs)} verdict change(s)")
        for url, d in diffs.items():
            print(f"  {url}\n    recorded {d['recorded']}\n    now      {d['now']}")
        return 0

    resume = A.ResumeModel(headline="Backend Engineer", skills=["Python", "SQL", "PostgreSQL", "REST"])
    postings = synthetic_postings()
    print(f"--stub: {len(postings)} synthetic postings, offline, stub model\n")

    # --- pass 1: the plumbing, end to end ------------------------------------
    ledger = Ledger(stub_root / "ledger.json")
    entry: dict[str, Any] = {"run_id": "stub-pass1", "started_at": _now_utc().isoformat()}
    ledger.runs[:] = [entry]
    guard = BudgetGuard(price=(0.75, 4.50), calls_left=MAX_CALLS, usd_left=BUDGET_USD, run_share_usd=BUDGET_USD,
                        worst_completion=A.settings.llm_max_output_tokens, run_entry=entry, on_change=ledger.save)
    corpus, rec, tally = _stub_pass(A, resume, postings, guard, stub_root / "pass1", "stub-pass1")
    check("no network was attempted", not rec.net_attempts, ", ".join(rec.net_attempts))
    check("the search completed", not corpus["error"], corpus["error"])
    check("no selection inconsistencies", not corpus["problems"], "; ".join(corpus["problems"]))
    got = {_k(p["url"]): p for p in corpus["postings"]}
    kept = [p for p in postings if p["expect"][1] != "market"]
    check("every kept synthetic posting was selected, and only those",
          set(got) == {_k(p["url"]) for p in kept}, f"{len(got)} of {len(kept)}")
    market = {_k(r["url"]) for r in corpus["out_of_population"] if r["reason"] == "market"}
    check("a low-pay worldwide posting is out of population, never a posting with no signal",
          market == {_k(p["url"]) for p in postings if p["expect"][1] == "market"}, str(market))
    for p in kept:
        g = got.get(_k(p["url"]))
        want_outcome, want_pop, want_kinds, want_app = p["expect"]
        name = f"{p['source']}/{p['slug']}"
        if g is None:
            check(name + " recorded", False)
            continue
        kinds = {s["kind"]: s["strength"] for s in g["signals"]}
        check(name + " fetch outcome", g["fetch_outcome"] == want_outcome, f"{g['fetch_outcome']} != {want_outcome}")
        check(name + " population", g["population"] == want_pop, f"{g['population']} != {want_pop}")
        check(name + " signals", kinds == want_kinds, f"{kinds} != {want_kinds}")
        check(name + " in app", g["in_app"] == want_app, f"{g['in_app']} != {want_app}")
    slug = {f"{p['source']}/{p['slug']}": got.get(_k(p["url"]), {}) for p in kept}
    check("gh/old bucket 60-89, basis first_published, 75 days",
          (slug["greenhouse/old"].get("age_bucket"), slug["greenhouse/old"].get("long_open_basis"),
           slug["greenhouse/old"].get("long_open_days")) == ("60-89", "first_published", 75))
    check("gh/mid bucket 30-44", slug["greenhouse/mid"].get("age_bucket") == "30-44")
    check("gh/pool is likely, evergreen by the title rule",
          slug["greenhouse/pool"].get("evergreen_rule") == "title" and slug["greenhouse/pool"].get("likely"))
    check("drushim/nospecific is evergreen by the body rule", slug["drushim/nospecific"].get("evergreen_rule") == "body")
    check("drushim/weak is the weak rule and not likely",
          slug["drushim/weak"].get("evergreen_rule") == "weak" and not slug["drushim/weak"].get("likely"))
    check("the banner-closed posting is not `likely` (closure is past suspicion)",
          not slug["linkedin/banner"].get("likely"))
    scored = sum(1 for p in postings if p["expect"][3] == "ranked")
    check("one model call per scored posting", guard.billed == scored, f"{guard.billed} != {scored}")
    check("the metering tally crossed the scoring pool",
          tally.calls == guard.billed and tally.prompt == guard.prompt, f"tally {tally.calls} calls")
    check("no filtered or skipped posting reached the model",
          all(got[_k(p["url"])]["llm"]["calls"] == 0 for p in kept if p["expect"][3] != "ranked"))
    check("closed postings measurable", corpus["measurable"]["closed"].startswith("measured"))
    check("first_published measurable", corpus["measurable"]["long_open/first_published"].startswith("measured"))
    check("first_seen recorded as unmeasured", corpus["measurable"]["long_open/first_seen"].startswith("unmeasured"))
    check("ledger persisted the run", json.loads((stub_root / "ledger.json").read_text(encoding="utf-8"))
          ["runs"][0]["calls"] == scored)
    ws = read_worksheet(stub_root / "pass1" / "worksheet.csv")
    fired = [p for p in postings if p["expect"][2]]
    check("worksheet has one row per posting that fired", len(ws) == len(fired), f"{len(ws)} != {len(fired)}")
    owner = [r for r in ws if r["owner_check"]]
    check("LinkedIn closures (banner, 404, 410) are the owner's rows", len(owner) == 3, str(len(owner)))
    check("a 404 row carries its evidence", any(r["closed_evidence"] == "HTTP 404" for r in owner))

    # --- pass 2: the budget guard stops the run, the verdicts survive --------
    guard2 = BudgetGuard(price=(0.75, 4.50), calls_left=3, usd_left=BUDGET_USD, run_share_usd=BUDGET_USD,
                         worst_completion=A.settings.llm_max_output_tokens)
    corpus2, rec2, _ = _stub_pass(A, resume, postings, guard2, stub_root / "pass2", "stub-pass2")
    check("call cap: exactly 3 calls admitted", guard2.billed == 3, str(guard2.billed))
    check("call cap: the rest refused", guard2.refused == scored - 3, f"{guard2.refused} != {scored - 3}")
    check("call cap: every verdict still recorded", len(rec2.ghost) == len(rec.ghost), f"{len(rec2.ghost)}")
    check("call cap: ranked matches are exactly the admitted calls",
          sum(1 for p in corpus2["postings"] if p["in_app"] == "ranked") == 3)
    check("call cap: the stop is named", guard2.closed_reason.startswith("budget stop: call cap"), guard2.closed_reason)

    # --- the guard's money arithmetic, directly -------------------------------
    g = BudgetGuard(price=(1.0, 1.0), calls_left=100, usd_left=0.05, run_share_usd=0.05, worst_completion=10_000)
    t1 = g.admit(10_000)  # worst 0.020064
    t2 = g.admit(10_000)  # worst 0.040128 in flight
    waited: list[str] = []

    def third() -> None:
        try:
            g.admit(10_000)
            waited.append("admitted")
        except BudgetExhausted:
            waited.append("refused")

    th = threading.Thread(target=third)
    th.start()
    time.sleep(0.2)
    check("money cap: a third worst case waits for the calls in flight", not waited and th.is_alive())
    g.settle(t1, 10_000, 10_000)  # 0.02 spent, 0.020064 in flight: a third worst case still does not fit
    g.settle(t2, 10_000, 10_000)  # 0.04 spent: nothing in flight, the third cannot fit -> refused
    th.join(5)
    check("money cap: refused once nothing in flight can free it", waited == ["refused"], str(waited))
    check("money cap: spend stayed under the cap", g.usd <= 0.05, f"{g.usd}")
    g2 = BudgetGuard(price=(1.0, 1.0), calls_left=1, usd_left=1.0, run_share_usd=1.0, worst_completion=100)
    t = g2.admit(100)
    g2.fail(t, SimpleNamespace(status_code=400))  # a 400 is not billed and frees its slot
    check("a 4xx is not counted against the call cap", g2.billed == 0 and g2.unbilled_failures == 1)
    t = g2.admit(100)
    g2.fail(t, TimeoutError())  # a timeout may have been billed: counted at its estimate
    check("a timeout is counted", g2.billed == 1 and g2.usd > 0)
    try:
        g2.admit(100)
        check("the call cap refuses the call past it", False)
    except BudgetExhausted:
        check("the call cap refuses the call past it", True)
    g3 = BudgetGuard(price=(1.0, 1.0), calls_left=9, usd_left=1.0, run_share_usd=1.0, worst_completion=100)
    g3.fail(g3.admit(100), SimpleNamespace(status_code=401))
    try:
        g3.admit(100)
        check("a rejected key stops the run", False)
    except BudgetExhausted as e:
        check("a rejected key stops the run", "401" in str(e), str(e))
    ghost_ledger = Ledger(stub_root / "ledger-probe.json")
    ghost_ledger.runs[:] = [{"calls": 25, "usd": 0.2}, {"calls": 25, "usd": 0.3}, {"calls": 20, "usd": 0.1}]
    refusal = _ledger_refusal(ghost_ledger, now=_now_utc())
    check("a fourth paid run is refused", refusal.startswith("3 paid runs"), refusal)
    ghost_ledger.runs[:] = [{"calls": 25, "usd": 0.2, "ended_at": _now_utc().isoformat()}]
    check("a run within 10 minutes of the last is refused",
          "minutes" in _ledger_refusal(ghost_ledger, now=_now_utc()))
    ghost_ledger.runs[:] = [{"calls": 25, "usd": 0.2, "ended_at": "2026-01-01T00:00:00"}]
    check("an allowed run is allowed", _ledger_refusal(ghost_ledger, now=_now_utc()) == "")
    check("fair share: what is left, over the runs left", abs(_run_share(ghost_ledger) - 0.4) < 1e-9,
          str(_run_share(ghost_ledger)))

    # --- replay: the recorded corpus re-classifies identically ---------------
    _, diffs = replay(A, stub_root / "pass1" / "run.json", stub_root / "replay")
    check("replay of pass 1 reproduces every verdict", not diffs, json.dumps(diffs, ensure_ascii=False)[:300])
    # ...and a replay that could never report a difference would pass that
    # check forever, so plant one: a recorded run that says the talent-pool
    # posting fired nothing must come back as exactly one changed verdict.
    planted_run = json.loads((stub_root / "pass1" / "run.json").read_text(encoding="utf-8"))
    pool_url = next(p["url"] for p in postings if p["slug"] == "pool")
    for p in planted_run["postings"]:
        if _k(p["url"]) == _k(pool_url):
            p["signals"] = []
    (stub_root / "replay-probe").mkdir(parents=True, exist_ok=True)
    _write_json(stub_root / "replay-probe" / "run.json", planted_run)
    _, planted_diffs = replay(A, stub_root / "replay-probe" / "run.json", stub_root / "replay-probe")
    check("replay reports a planted verdict change, and only that one", list(planted_diffs) == [pool_url],
          str(list(planted_diffs)))

    # --- the report and the decision rule, on labels whose answer is known ---
    check("wilson 20/20", abs((wilson_lower(20, 20) or 0) - 0.8389) < 1e-3)
    check("wilson 8/10", abs((wilson_lower(8, 10) or 0) - 0.4902) < 1e-3)
    check("wilson n=0 is unknown, never 1.0", wilson_lower(0, 0) is None)

    def rows_for(signals: str, labels: list[str], **extra: str) -> list[dict[str, str]]:
        return [{"url": f"https://x.test/{signals}/{i}", "signals": signals, "label": lab, "bug": "",
                 **extra} for i, lab in enumerate(labels)]

    def verdict(rows: list[dict[str, str]], cell_name: str) -> dict[str, Any]:
        return next(c for c in evaluate(rows) if c["cell"] == cell_name)

    title = {"evergreen_rule": "title"}
    check("hide bar met at 20 GHOST, 0 wrong",
          "HIDE BAR MET" in verdict(rows_for("evergreen:strong", ["GHOST"] * 20, **title), "evergreen · title")["verdict"])
    check("hide bar NOT met at 19",
          "not met" in verdict(rows_for("evergreen:strong", ["GHOST"] * 19, **title), "evergreen · title")["verdict"])
    check("hide bar NOT met with one LIVE among 30",
          "not met" in verdict(rows_for("evergreen:strong", ["GHOST"] * 29 + ["LIVE"], **title),
                               "evergreen · title")["verdict"])
    bug_rows = rows_for("evergreen:strong", ["GHOST"] * 20, **title)
    bug_rows[0]["bug"] = "evergreen"
    check("a BUG is a wrong call", "not met" in verdict(bug_rows, "evergreen · title")["verdict"])
    unclear = rows_for("evergreen:strong", ["GHOST"] * 20 + ["UNCLEAR"] * 21, **title)
    check("UNCLEAR over half is undecidable", "undecidable" in verdict(unclear, "evergreen · title")["verdict"])
    unclear_ok = rows_for("evergreen:strong", ["GHOST"] * 20 + ["UNCLEAR"] * 5, **title)
    check("UNCLEAR is never folded into n", verdict(unclear_ok, "evergreen · title")["n"] == 20)
    check("email bar met at 8 of 10",
          "EMAIL BAR MET" in verdict(rows_for("evergreen:strong", ["GHOST"] * 8 + ["LIVE"] * 2, likely="yes", **title),
                                     "likely (the badge)")["verdict"])
    check("email bar NOT met at 7 of 10",
          "not met" in verdict(rows_for("evergreen:strong", ["GHOST"] * 7 + ["LIVE"] * 3, likely="yes", **title),
                               "likely (the badge)")["verdict"])
    check("email bar NOT met at 9 of 9 (n<10)",
          "not met" in verdict(rows_for("evergreen:strong", ["GHOST"] * 9, likely="yes", **title),
                               "likely (the badge)")["verdict"])
    check("an empty cell reads unmeasured", verdict([], "evergreen · body")["verdict"].startswith("unmeasured"))
    check("first_seen reads unmeasured", "unmeasured" in verdict([], "long_open · first_seen")["verdict"])
    check("a LIVE banner is a P0",
          "P0" in verdict(rows_for("closed:certain", ["LIVE"], closed_evidence="No longer accepting applications"),
                          "closed · banner")["verdict"])
    labelled = read_worksheet(stub_root / "pass1" / "worksheet.csv")
    for r in labelled:
        r["label"] = "GHOST"
    write_worksheet(stub_root / "pass1" / "worksheet-labelled.csv", labelled)
    merged, _ = merge_rows([stub_root / "pass1" / "worksheet-labelled.csv"])
    check("a labelled worksheet round-trips", len(merged) == len(ws) and all(r["label"] == "GHOST" for r in merged))
    (stub_root / "pass1" / "worksheet-labelled.csv").unlink()

    # --- the offline tripwire and the secret scan, probed both ways ----------
    rec_probe = Recorder()
    with instrument(A, rec_probe, BudgetGuard(price=(1, 1), calls_left=1, usd_left=1, run_share_usd=1,
                                              worst_completion=1), stub=True):
        installed = getattr(socket.getaddrinfo, "__name__", "") == "trip"
        if installed:  # never call the REAL resolver to find out
            try:
                socket.getaddrinfo("ghost-eval.invalid", 443)
            except RuntimeError:
                pass
    check("the tripwire is installed and records a DNS lookup",
          installed and rec_probe.net_attempts == ["socket.getaddrinfo"], str(rec_probe.net_attempts))
    check("the tripwire is removed afterwards", socket.getaddrinfo.__name__ != "trip")
    planted = stub_root / "secret-probe.txt"
    planted.write_text("prefix sk-test-SENTINEL-000 suffix", encoding="utf-8")
    check("the secret scan finds a planted key", find_secret([planted], "sk-test-SENTINEL-000") == [planted])
    check("the secret scan passes a clean file", find_secret([stub_root / "pass1" / "run.json"], "sk-test-SENTINEL-000") == [])
    planted.unlink()
    check("errors are scrubbed of anything key-shaped", "abcd1234" not in _scrub("Incorrect API key provided: sk-proj-****abcd1234"))

    print(f"\nghost_eval --stub: {check.passed} checks passed, {len(check.failed)} failed")
    print(f"outputs: {stub_root}")
    print_report([stub_root / "pass1" / "worksheet.csv"])
    return 0 if not check.failed else 1


def _ledger_refusal(ledger: Ledger, *, now: datetime) -> str:
    t = ledger.totals()
    if t.paid >= MAX_PAID_RUNS:
        return f"{t.paid} paid runs are already recorded (the owner approved {MAX_PAID_RUNS})"
    if t.calls >= MAX_CALLS:
        return f"{t.calls} of {MAX_CALLS} model calls are already spent"
    if t.usd >= BUDGET_USD:
        return f"${t.usd:.4f} of ${BUDGET_USD:.2f} is already spent"
    if t.last_end:
        last = datetime.fromisoformat(t.last_end)
        wait = MIN_GAP_MINUTES - (now - last).total_seconds() / 60
        if wait > 0:
            return f"the last real run ended {MIN_GAP_MINUTES - wait:.1f} minutes ago; wait {wait:.1f} more minutes"
    return ""


def _run_share(ledger: Ledger) -> float:
    t = ledger.totals()
    return (BUDGET_USD - t.usd) / max(1, MAX_PAID_RUNS - t.paid)


def _parse_price(items: list[str]) -> dict[str, tuple[float, float]]:
    prices: dict[str, tuple[float, float]] = {}
    for item in items:
        name, _, pair = item.partition("=")
        low, _, high = pair.partition(",")
        prices[name.strip()] = (float(low), float(high))
    return prices


def real_mode(args: argparse.Namespace) -> int:
    def refuse(why: str) -> int:
        print(f"REFUSED: {why}\nNothing was searched and no model was called.")
        return 2

    preset = dict(PRESETS[args.run])
    if args.titles:
        preset["job_titles"] = [t.strip() for t in args.titles.split("|") if t.strip()]
    if args.location is not None:
        preset["location"] = args.location
    if not preset["job_titles"]:
        return refuse("a run needs custom titles, or it would spend a SEARCH_CONTEXT call")
    out_root = Path(args.out_dir) if args.out_dir else _default_out_dir()
    env_file = Path(args.env_file) if args.env_file else _default_file(".env")
    resume_path = Path(args.resume) if args.resume else _default_file("tests/fixtures/ab/master.json")
    if not env_file.exists():
        return refuse(f"no env file at {env_file} (pass --env-file)")
    env = _read_env_file(env_file)
    if not env["OPENAI_API_KEY"]:
        return refuse(f"{env_file} has no OPENAI_API_KEY")
    model = env["MODEL_ID"]
    if model != args.expect_model:
        return refuse(f"MODEL_ID in {env_file} is {model or '(unset)'!r}, not {args.expect_model!r} (production's)")
    prices = _parse_price(args.price)
    if model not in prices:
        return refuse(f"pass --price {model}=IN,OUT (USD per 1M tokens, from OpenAI's pricing page)")
    if not resume_path.exists():
        return refuse(f"no resume at {resume_path} (pass --resume)")
    _ensure_out(out_root)
    ledger = Ledger(out_root / "ledger.json")
    started = _now_utc()
    why = _ledger_refusal(ledger, now=started)
    if why:
        return refuse(why)
    totals = ledger.totals()
    run_id = started.strftime("%Y-%m-%dT%H%MZ") + f"-{args.run}"
    run_dir = out_root / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    A = _boot(db_path=run_dir / "scratch.db", stub=False, key=env["OPENAI_API_KEY"], model=model)

    def refuse_after_boot(why: str) -> int:
        A.database.engine.dispose()
        for leftover in run_dir.iterdir():
            leftover.unlink()
        run_dir.rmdir()
        return refuse(why)

    client = A.get_llm_client()
    if type(client) is not A.OpenAIClient:
        return refuse_after_boot(f"get_llm_client() is {type(client).__name__}, not OpenAIClient")
    if A.settings.model_id != args.expect_model:
        return refuse_after_boot(f"the app resolved MODEL_ID {A.settings.model_id!r}")
    resume = A.ResumeModel.model_validate_json(resume_path.read_text(encoding="utf-8"))
    ctx = A.SearchContext(job_titles=preset["job_titles"], location=preset["location"],
                          work_mode=preset["work_mode"], include_worldwide=preset["include_worldwide"],
                          max_age_days=preset["max_age_days"], limit=args.limit, sources=preset["sources"])
    usd_left = BUDGET_USD - totals.usd
    share = _run_share(ledger)
    calls_left = MAX_CALLS - totals.calls
    entry: dict[str, Any] = {"run_id": run_id, "preset": args.run, "model": model, "price": prices[model],
                             "started_at": started.isoformat(), "status": "started", "calls": 0, "usd": 0.0}
    ledger.runs.append(entry)
    ledger.save()
    lock = threading.Lock()

    def save() -> None:
        with lock:
            ledger.save()

    # <= 0 switches the output cap off, and then no completion bound exists:
    # assume one well past any JD_FIT answer rather than zero.
    cap = A.settings.llm_max_output_tokens
    guard = BudgetGuard(price=prices[model], calls_left=calls_left, usd_left=usd_left, run_share_usd=share,
                        worst_completion=cap if cap > 0 else 32_000, run_entry=entry, on_change=save)
    print(f"REAL RUN {run_id}: live boards + real OpenAI ({model}), spends money.")
    print(f"  key: loaded from {env_file} (not shown)   resume: {resume_path} (a PROXY for production's master)")
    print(f"  budget: ${usd_left:.4f} of ${BUDGET_USD:.2f} left, {calls_left} of {MAX_CALLS} calls left, "
          f"this run's share ${share:.4f}, price in/out ${prices[model][0]}/${prices[model][1]} per 1M")
    print(f"  context: {ctx.job_titles} · {ctx.location} · {ctx.work_mode} · worldwide={ctx.include_worldwide} · "
          f"{ctx.max_age_days}d · limit {ctx.limit} · {ctx.sources}\n")
    rec = Recorder()
    try:
        with instrument(A, rec, guard, stub=False):
            result, error, tally = run_search(A, resume, ctx)
        corpus = build_corpus(A, rec, guard, result, error, ctx)
    except BaseException:
        # The money the guard recorded stays in the ledger either way.
        entry.update(status="crashed", ended_at=_now_utc().isoformat())
        save()
        raise
    corpus.update(run_id=run_id, preset=args.run, preset_label=preset["label"], model=model, price=prices[model],
                  context=(result.context if result else ctx).model_dump(), git_head=_git("rev-parse", "HEAD"),
                  resume={"path": str(resume_path), "sha256": hashlib.sha256(resume_path.read_bytes()).hexdigest(),
                          "note": "PROXY: tests/fixtures/ab/master.json, not production's stored master"},
                  llm=_llm_summary(guard, tally))
    entry.update(status="finished", ended_at=_now_utc().isoformat())
    save()
    written = [run_dir / "run.json", run_dir / "worksheet.csv", out_root / "ledger.json"]
    _write_json(written[0], corpus)
    rows = worksheet_rows(run_id, corpus)
    write_worksheet(written[1], rows)
    leaked = find_secret(written, env["OPENAI_API_KEY"])
    for path in leaked:
        path.unlink()
    if leaked:
        print(f"ABORTED: the key was found in {len(leaked)} output file(s), which were deleted.")
        return 3
    _print_run_summary(corpus, rows, guard, tally, run_dir, ledger)
    return 0


def _print_run_summary(corpus, rows, guard, tally, run_dir: Path, ledger: Ledger) -> None:  # noqa: ANN001
    if corpus["error"]:
        print(f"search error: {corpus['error']}")
    for name, b in corpus["boards"].items():
        err = f"  ERROR: {b['source_error']}" if b["source_error"] else ""
        print(f"  {name:<11} {b['hits']:>4} hits  {b['selected']:>3} selected  {b['classified']:>3} classified{err}")
    print(f"  LinkedIn requests: {corpus['http_summary']}")
    for kind, state in corpus["measurable"].items():
        print(f"  {kind:<28} {state}")
    fired: dict[str, int] = {}
    for p in corpus["postings"]:
        for s in p["signals"]:
            fired[f"{s['kind']}:{s['strength']}"] = fired.get(f"{s['kind']}:{s['strength']}", 0) + 1
    print(f"  firings: {fired or 'none'} · out of population: {len(corpus['out_of_population'])} market rows, "
          f"{sum(1 for p in corpus['postings'] if p['population'] == 'geo_blocked')} geo-blocked")
    llm = corpus["llm"]
    print(f"  model: {llm['billed_calls']} calls, {llm['prompt_tokens']} + {llm['completion_tokens']} tokens, "
          f"${llm['usd']:.4f}; refused {llm['refused']}{' (' + llm['budget_stop'] + ')' if llm['budget_stop'] else ''}")
    if (tally.prompt, tally.completion) != (guard.prompt, guard.completion):
        print(f"  WARNING: metering tally {tally.prompt}+{tally.completion} != guard {guard.prompt}+{guard.completion}")
    t = ledger.totals()
    print(f"  ledger: ${t.usd:.4f} of ${BUDGET_USD:.2f}, {t.calls} of {MAX_CALLS} calls, {t.paid} of {MAX_PAID_RUNS} paid runs")
    owner = [r for r in rows if r["owner_check"]]
    if owner:
        print(f"\n  OWNER CHECK ({len(owner)}): open each while logged in to LinkedIn; never click Apply.")
        for r in owner:
            print(f"    {r['url']}  [{r['closed_evidence']}]")
    print(f"\n  corpus:    {run_dir / 'run.json'}\n  worksheet: {run_dir / 'worksheet.csv'} ({len(rows)} rows to label)")


def report_mode(args: argparse.Namespace) -> int:
    targets = [Path(p) for p in args.report] or [_default_out_dir()]
    sheets: list[Path] = []
    for t in targets:
        if t.is_file():
            sheets.append(t)
        elif (t / "worksheet.csv").exists():
            sheets.append(t / "worksheet.csv")
        elif t.is_dir():
            sheets += sorted(p for p in t.glob("*/worksheet.csv") if p.parent.name != "stub")
    if not sheets:
        print(f"no worksheets under {', '.join(str(t) for t in targets)}")
        return 1
    return print_report(sheets)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):  # Hebrew on a Windows console
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    ap = argparse.ArgumentParser(description="Ghost-posting precision harness (PLAN 28.5)")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--stub", action="store_true", help="offline plumbing check: no network, no money")
    mode.add_argument("--run", choices=sorted(PRESETS), help="REAL: live boards + real OpenAI (spends money)")
    mode.add_argument("--report", nargs="*", help="apply the decision rule to labelled worksheets")
    ap.add_argument("--replay", default="", help="with --stub: re-classify a recorded run.json offline")
    ap.add_argument("--env-file", default="", help="where OPENAI_API_KEY and MODEL_ID are read from")
    ap.add_argument("--resume", default="", help="resume JSON (default: tests/fixtures/ab/master.json)")
    ap.add_argument("--price", action="append", default=[], metavar="MODEL=IN,OUT",
                    help="USD per 1M input,output tokens (required for a real run)")
    ap.add_argument("--expect-model", default=EXPECT_MODEL, help="refuse unless MODEL_ID is this")
    ap.add_argument("--titles", default="", help="override the preset's titles, '|'-separated")
    ap.add_argument("--location", default=None, help="override the preset's location")
    ap.add_argument("--limit", type=int, default=25, help="postings to select (1-25)")
    ap.add_argument("--out-dir", default="", help="default: the main checkout's tests/fixtures/ghost_eval")
    args = ap.parse_args(argv)
    if args.stub:
        return stub_mode(args)
    if args.run:
        return real_mode(args)
    return report_mode(args)


if __name__ == "__main__":
    raise SystemExit(main())
