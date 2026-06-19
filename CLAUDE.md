# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
Vite proxies `/api/*` → `localhost:8000` during dev (see `vite.config.ts`).

**Offline mode (no API key needed):**
Set `USE_STUB_LLM=true` in `.env`. The entire pipeline (parse, score, tailor, render, tracker) works with canned LLM responses.

## Testing

**Offline end-to-end smoke test** — exercises the full pipeline without an API key:
```powershell
cd backend
.\.venv\Scripts\python.exe -m tests.smoke_test
```
Exit 0 = all pass. Run this after any backend change. There are no other test files; the smoke test covers parsing, ledger building, JD analysis, tailoring, fabrication guard, DOCX/PDF rendering, and cover letter generation.

**Frontend type-check + build:**
```powershell
cd frontend
npm run build   # runs tsc -b then vite build; 0 errors expected
```

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

**Backend package layout:**
- `app/models/__init__.py` — all Pydantic schemas (`ResumeModel`, `JDModel`, `TailorResult`, `Score`, `FactsLedger`, etc.). Edit this when adding fields.
- `app/llm/client.py` — `OpenAIClient` and `StubClient`. The stub routes on `Task: <TOKEN>.` tags at the top of each system prompt — don't remove those tags or the stub misroutes.
- `app/llm/prompts.py` — every prompt template. LLM behavior tuning happens here.
- `app/core/fabrication_guard.py` — builds a new ledger from the tailored resume, diffs against the original; flags anything that wasn't in the original. Tolerates containment matches to avoid false positives on light rephrasing.
- `app/core/scorer.py` — keyword coverage is pure Python (deterministic, explainable); `fit_score` is the only part that calls the LLM. Both combined into `overall`.
- `app/api/routes.py` — thin FastAPI handlers that wire the pipeline. No business logic here.
- `app/db/` — SQLAlchemy + SQLite tracker. `init_db()` is called via the FastAPI lifespan hook.
- `app/render/` — `docx_renderer.py` (python-docx) and `pdf_renderer.py` (reportlab). ATS-safe: single column, no tables/images/headers/footers.

**Frontend layout:**
- `src/types.ts` — mirrors the backend Pydantic schemas. Keep in sync when models change.
- `src/api/client.ts` — all `axios` calls; every endpoint has a typed wrapper here.
- `src/pages/TailorPage.tsx` — orchestrates the full upload→analyze→tailor→download→save flow.
- `src/pages/TrackerPage.tsx` — application tracker with status select and delete.

## LLM configuration

The model is provider-agnostic. To swap the model, change `MODEL_ID` in `.env`. The `get_llm_client()` factory in `app/llm/client.py` returns `StubClient` when `USE_STUB_LLM=true` or the API key is empty, and `OpenAIClient` otherwise. All calls use `response_format: json_object` (JSON mode) for structured outputs.

The confirmed OpenAI model id should be set in `.env` — "GPT 5.4" was not a verified model id at build time.

## Key invariants

- The fabrication guard runs **after** every tailor call, not just in tests. If the LLM invents an employer/title/date/credential/number, the API still returns it but `fabrication_flags` will be non-empty. The UI surfaces these as warnings.
- ATS rendering rules are enforced in both renderers: no tables, no text-boxes, no images, no headers/footers, single column, standard section names.
- `FactsLedger` is derived from the **original** resume (before tailoring) and is never mutated. It is the source of truth for the guard.
