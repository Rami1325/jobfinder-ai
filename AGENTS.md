# AGENTS.md

This file provides guidance to Codex when working with code in this repository.

> Kept byte-identical to `CLAUDE.md` apart from this header, on purpose. It drifted once —
> missing everything from Phase 17 onward, which made it a second and WRONG source of truth
> about the renderers and the page budget. If you change one, copy it to the other.

## Running the app

**Python is NOT on the system PATH.** Use the full path:
```
C:\Users\RAMI_\AppData\Local\Programs\Python\Python312\python.exe
```

**Backend (FastAPI):**
```powershell
cd backend
# First time only:
python.exe -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
copy .env.example .env   # then fill in OPENAI_API_KEY and MODEL_ID

.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```
API docs at `http://localhost:8000/docs`. DB auto-creates at `backend/jobfinder.db` on first start.

**Frontend (React/Vite):**
```powershell
cd frontend
npm install
npm run dev   # http://localhost:5173
```
Vite proxies `/api/*` → `127.0.0.1:8000` during dev (see `vite.config.ts`). **127.0.0.1, not `localhost`** — Node resolves `localhost` to `::1` first while uvicorn binds `127.0.0.1`, which surfaces as a misleading ECONNREFUSED. The same trap applies to anything else you point at the dev servers, `vite preview` included.

**Offline mode (no API key needed):**
Set `USE_STUB_LLM=true` in `.env`. The entire pipeline (parse, score, tailor, render, tracker) works with canned LLM responses.

## Testing

**Offline end-to-end smoke test** — exercises the full pipeline without an API key:
```powershell
cd backend
.\.venv\Scripts\python.exe -m tests.smoke_test
```
Exit 0 = all pass (609 checks as of Phase 20). Run this after any backend change. There are no other test files; the smoke test covers parsing, ledger building, JD analysis, tailoring, fabrication guard, DOCX/PDF rendering, cover letter, the SSRF guard, upload caps, LLM cost caps + token metering, the alerts-cron budget, and résumé version history — **plus every LLM task** (interview questions/answer/feedback, job match, ATS scan, LinkedIn optimizer, follow-up email). **Any new LLM task must add a stub branch and a smoke-test check** — the smoke test is what guards the stub-routing invariant.

Two habits this suite has repaid, both from real misses: **pin the false-positive case next to the catch** (a guard that fires correctly and also fires on legitimate input is worse than no guard), and when a change alters observable behaviour, **fix the assertion rather than weaken it** — the 20.5/C2 reordering broke a check that identified cron runs by list position, and the right answer was to give the result a `user_id`, not to loosen the test.

**Frontend type-check + build:**
```powershell
cd frontend
npm run build   # runs tsc -b then vite build; 0 errors expected
```
Stack: React 18 + Vite + **react-router-dom** (routing) + **Tailwind CSS** (styling, theme in `tailwind.config.js` seeded from the original CSS vars) + **framer-motion** (animation) + **lucide-react** (icons). A shared UI kit lives in `src/components/ui/`.

## Architecture

The pipeline flows strictly left to right — each step's output is the next step's input:

```
File upload → resume_parser (DOCX/PDF → raw text)
           → structurer (LLM → ResumeModel JSON + FactsLedger)
           → jd_analyzer (LLM → JDModel JSON)
           → scorer (deterministic keyword coverage + LLM fit score → Score before)
           → tailor (LLM → tailored ResumeModel + changelog)
           → fabrication_guard (diff tailored facts vs. ledger → FabricationFlags)
           → scorer again (Score after)
           → docx_renderer / pdf_renderer (bytes)
```

Beyond the core pipeline, the backend also exposes standalone feature modules (each reuses the pipeline where possible and routes through the stub):
- **Interview prep** (`app/core/interview.py`): questions, model answers (STAR, résumé-grounded), and feedback on a practice answer.
- **Job match** (`app/core/job_match.py`): rank multiple pasted/URL-fetched listings by fit against the master résumé, reusing `jd_analyzer` + `scorer`.
- **Job search** (`app/core/job_search.py`): multi-board fan-out over the provider registry (`app/core/providers/` — LinkedIn, Drushim, Comeet, JobMaster, Greenhouse; per-board failure isolation) for jobs matching the résumé (context auto-derived via the `SEARCH_CONTEXT` LLM task, user-overridable: title/location/work mode/limit/sources), then fetch + score each posting like job match. Every provider parser is a pure function pinned by a smoke-test fixture — if a board changes its markup/API shape, fix the parser and keep the fixture green.
- **Auto-submit** (`app/core/auto_submit.py`, PLAN 8.4): sends an approved, guard-clean Comeet kit's application through Comeet's public careers-api apply endpoint (the same wire call the board's own Apply button makes). Every guardrail is server-side: approved + guard-clean + Comeet-only, per-company dedupe, `DAILY_SUBMIT_CAP`, audit trail on the tracker application. LinkedIn is never automated.
- **Tools**: `app/core/ats_scan.py` (11 deterministic format/content checks + optional keyword coverage — dates, acronym pairing, pronouns, bullet length, length vs. experience), `app/core/linkedin.py`, `app/core/follow_up.py`.
- **Shared résumé logic**: `app/core/dates.py` (résumé date parsing, the ATS-safe rewrite, and years-of-experience over the *union* of role spans) and `app/core/section_order.py` (Education above Experience for early-career résumés). Both renderers and `ResumeView` read the section order, so preview and download always agree.
- **Master résumé** (`app/db/models.py::SavedResume`): persisted once, reused across Tailor / Interview / Job Match via `GET`/`PUT /profile/resume`. One row per language (paired he/en). Every overwrite is versioned — see `app/db/resume_versions.py`.
- **Cost control** (`app/core/usage.py` + `app/llm/metering.py`): per-user daily caps on `search` / `tailor` / `llm` / `submit`, plus real prompt/completion token totals under the reserved `action="tokens"` row. The caps count requests; the token columns are what they actually cost.

**Backend package layout:**
- `app/models/__init__.py` — all Pydantic schemas (`ResumeModel`, `JDModel`, `TailorResult`, `Score`, `FactsLedger`, plus interview/job-match/tools/master-résumé schemas). Edit this when adding fields.
- `app/llm/client.py` — `OpenAIClient` and `StubClient`. The stub routes on `Task: <TOKEN>.` tags at the top of each system prompt — don't remove those tags or the stub misroutes. **Every new LLM task needs a matching `if "<TOKEN>" in head` branch here.**
- `app/llm/prompts.py` — every prompt template. LLM behavior tuning happens here.
- `app/core/fabrication_guard.py` — builds a new ledger from the tailored resume, diffs against the original; flags anything that wasn't in the original. Tolerates containment matches to avoid false positives on light rephrasing.
- `app/core/scorer.py` — keyword coverage is pure Python (deterministic, explainable); `fit_score` is the only part that calls the LLM. Both combined into `overall`.
- `app/core/net_guard.py` — SSRF guard. **Every outbound fetch goes through `job_match._http_get`, which calls `assert_fetchable` and uses `guarded_opener`.** Do not add a bare `urllib`/`requests` call: two routes take a caller-supplied URL and return the body, so a fetch that skips this can be aimed at cloud metadata or a loopback port. The predicate is `is_global`, not `is_private` (the latter misses CGNAT `100.64/10`), and redirects are re-checked per hop.
- `app/llm/metering.py` — per-request token tally. `OpenAIClient` reports `resp.usage` into it; the `metered_user`/`llm_user` dependencies write it to `usage_log`. Two non-obvious constraints live here, both learned the hard way — see **Key invariants**.
- `app/api/routes.py` — thin FastAPI handlers that wire the pipeline. No business logic here. **A route that calls the model takes `Depends(llm_user)`** (daily cap + token metering); routes with their own specific cap (tailor, search, kit drain) take `Depends(metered_user)` instead so they meter without a second charge. Deterministic routes (`/tools/ats-scan`, `/public/scan`, `/render`) are deliberately uncapped, and that exclusion is smoke-pinned.
- `app/db/` — SQLAlchemy + SQLite (`applications` tracker + `saved_resumes` master résumé + `saved_resume_versions` undo buffer + `job_search_hits` search history + `usage_log` caps/tokens). `init_db()` is called via the FastAPI lifespan hook and includes a lightweight SQLite ADD-COLUMN shim that adds any ORM columns missing from pre-existing tables. Job-search results are auto-persisted as history via `app/db/history.py` (deduped by URL, capped at the newest 100) and exposed at `GET`/`DELETE /jobs/history`. **Anything holding user content must be wiped by `DELETE /profile/data`** — add new tables to that handler, or a privacy wipe silently leaves PII behind.
- `app/render/` — `docx_renderer.py` (python-docx) and `pdf_renderer.py` (reportlab), both driving one shared design system out of `templates.py` (palette, type, rhythm, page size) and `labels.py` (section names, EN/HE). ATS-safe: single column, no tables/images/headers/footers.
  - **The PDF has its own layout engine.** Every run is line-broken by `_wrap_lines` and drawn with a text object, so Hebrew (bidi-reordered per line, right-to-left) and English share one set of flowables — `_Text`, `_Row` (title + flush-far-edge dates), `_Segments` (inline list with per-item colour/links), `_Heading` (letter-spaced, over a hairline). reportlab's `Paragraph` is deliberately unused: its wrapping is direction-blind.
  - **Never nest `KeepTogether`.** It reports a sentinel height, so a nested one pushes every section onto its own page.
  - `fit_squeeze()` decides one page vs. two by measuring the built flow, and compresses the vertical rhythm (never the type size) when the résumé overflows by a little. The DOCX renderer calls the same function so both downloads agree.
  - Hebrew DOCX must mirror `w:b`/`w:sz` onto `w:bCs`/`w:szCs` — Word formats Hebrew through the complex-script properties and ignores the plain ones.
  - Fonts are bundled under OFL (see `fonts/README.md`); a missing file degrades to base-14 rather than failing the download.
  - **`_wrap_lines` is memoized** (`_wrap_cached`, LRU 4096) because the page budget is allowed 60 real reportlab builds per tailor and every one re-wraps the same bullets. It must stay pure in `(text, font, size, width, tracking)`; it returns a fresh list of a cached tuple so a caller that mutates its lines can't poison the next render. Keying on the font NAME is what makes it safe — a missing-file fallback registers under a different name.

**Frontend layout:**
- `src/types.ts` — mirrors the backend Pydantic schemas. Keep in sync when models change.
- `src/api/client.ts` — all `axios` calls; every endpoint has a typed wrapper here.
- `src/App.tsx` — routes. `/` is the marketing landing (`MarketingLayout`); the app pages (`/app`, `/interview`, `/jobs`, `/tools/*`, `/tracker`) sit under `AppLayout`.
- `src/pages/Landing.tsx` + `src/components/marketing/*` — the honesty-first landing page.
- `src/pages/TailorPage.tsx` — the upload→analyze→tailor→download→save flow (guided stepper; auto-loads/saves the master résumé).
- `src/pages/TrackerPage.tsx` — kanban application tracker.
- `src/pages/InterviewPage.tsx`, `JobsPage.tsx`, `ToolsPage.tsx`, `tools/*` — the new feature pages.
- `src/components/ui/` — shared UI kit (Button, Card, Badge, ProgressRing, Stepper, Modal, Toast, Skeleton…).
- `src/hooks/useMasterResume.ts` — loads the persisted master résumé for Interview/Jobs/Tools.
- `src/lib/accessCode.ts` — the two access-code constants, dependency-free and **deliberately not in `api/client.ts`**. `AccessGate` is mounted eagerly, so importing them from the client dragged axios and every typed wrapper into the entry chunk (162 → 142 kB gzip when moved out). Don't "tidy" them back.
- `src/fonts.css` — **generated** by `scripts/gen-fonts.js`; keeps only the latin / latin-ext / hebrew subsets. Regenerate rather than hand-editing the unicode-ranges if either fontsource package is bumped. The dropped heebo-math/heebo-symbols subsets were not merely unused: their ranges cover the `←` and `✓` in the Hebrew locale strings, so they pulled a real font request during first paint.

## LLM configuration

The model is provider-agnostic. To swap the model, change `MODEL_ID` in `.env`. The `get_llm_client()` factory in `app/llm/client.py` returns `StubClient` when `USE_STUB_LLM=true` or the API key is empty, and `OpenAIClient` otherwise. All JSON tasks use `response_format: json_object` (JSON mode) for structured outputs.

Default `MODEL_ID` is **`gpt-4o-mini`** — cheap, fast, and strong at this JSON-extraction/rewrite work. Step up to `gpt-4.1-mini` or `gpt-4o` if you want higher-stakes tailoring quality. (Do not use unverified ids like `gpt-5.5`.)

## Key invariants

- The fabrication guard runs **after** every tailor call, not just in tests. If the LLM invents an employer/title/date/credential/number, the API still returns it but `fabrication_flags` will be non-empty. The UI surfaces these as warnings. Numbers are read from experience, military, the summary **and projects** — projects were missing until Phase 20 and the gap was invisible precisely because it was symmetric (the guard rebuilds the ledger the same way from the tailored résumé, so nothing ever went red). Skills are still deliberately unguarded: the tailor is explicitly allowed to adopt the JD's wording for something the candidate has, so a strict check would false-positive on exactly that.
- ATS rendering rules are enforced in both renderers: no tables, no text-boxes, no images, no headers/footers, single column, standard section names. Everything that makes the download *look* designed is achieved without breaking those rules — hairlines are paragraph borders, flush-right dates are a tab stop (DOCX) or a drawn string (PDF), and letter-spacing is small enough that extractors still read whole words. The smoke test pins all three.
- `FactsLedger` is derived from the **original** resume (before tailoring) and is never mutated. It is the source of truth for the guard.
- `ResumeModel.headline` (the target-title line) is a **claim**, so the guard reads it — but only for rank. The ledger keeps `headlines` separate from `titles` on purpose: running the headline through the generic title diff would flag every honest reposition and teach users to ignore flags. Only a seniority word no real title carries is a fabrication.
- Tracker rows record what was sent (`template`, `voice_score`, `fabrication_flag_count`). All three are nullable/`""` — a row that predates the field means **unknown**, never zero, and the analytics drops it from that dimension instead of scoring it. When reading these off a stored kit, parse the RAW result JSON: validating through `TailorResult` silently substitutes schema defaults.
- **A ContextVar cannot be bound inside a FastAPI `yield` dependency.** FastAPI runs setup and teardown through `contextmanager_in_threadpool`, so they can land in different contexts: `reset()` raises `"Token was created in a different Context"`, and — worse — the endpoint never sees the value at all. Request-scoped state that the endpoint must read gets bound in **middleware** (one context for set and reset) and handed to dependencies via `request.state`. This is why `llm_metering` lives in `app/main.py` and not in `deps.py`.
- **A `ThreadPoolExecutor` worker starts from an EMPTY context.** Any pool whose work makes LLM calls must submit through `copy_context().run` or its tokens vanish silently — `job_search`'s scoring pool is the case that matters, since it is the biggest spender in the app. The tally is a mutable object precisely so a copied context still writes to the request's instance.
- **A search must survive one bad posting.** `_score_hit` never raises for a per-job problem: a failed fetch or a model error leaves that index `None` and lands in the existing `skipped` count. With up to 25 concurrent LLM calls per search, letting one propagate discarded 24 good results.
- **Overwriting the master résumé snapshots it first** (`db/resume_versions.snapshot`, called from `PUT /profile/resume` and from restore). The dedupe compares the incoming content against the **current row**, not against the newest stored version — the latter looks right and lets an unchanged save through whenever the previous save did change something.
- The alerts cron runs on a **wall-clock budget** (`ALERT_CRON_BUDGET_S`, under the 300 s platform ceiling) and orders users longest-unrun-first, so it degrades and reports `skipped` instead of being killed partway with the tail of the list silently never emailed. Check the budget *before* starting a user, never mid-run: an alert that already scraped and scored must finish and record its history, or the next tick redoes the work and calls the same postings "new".
