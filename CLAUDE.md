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
Vite proxies `/api/*` → `127.0.0.1:8000` during dev (see `vite.config.ts`). **127.0.0.1, not `localhost`** — Node resolves `localhost` to `::1` first while uvicorn binds `127.0.0.1`, which surfaces as a misleading ECONNREFUSED. The same trap applies to anything else you point at the dev servers, `vite preview` included.

**Offline mode (no API key needed):**
Set `USE_STUB_LLM=true` in `.env`. The entire pipeline (parse, score, tailor, render, tracker) works with canned LLM responses.

## Testing

**Offline end-to-end smoke test** — exercises the full pipeline without an API key:
```powershell
cd backend
.\.venv\Scripts\python.exe -m tests.smoke_test
```
Exit 0 = all pass (697 checks as of Phase 21). Run this after any backend change. There are no other test files; the smoke test covers parsing, ledger building, JD analysis, tailoring, fabrication guard, DOCX/PDF rendering, cover letter, the SSRF guard, upload caps, LLM cost caps + token metering, the alerts-cron budget, and résumé version history — **plus every LLM task** (interview questions/answer/feedback, job match, ATS scan, LinkedIn optimizer, follow-up email). **Any new LLM task must add a stub branch and a smoke-test check** — the smoke test is what guards the stub-routing invariant.

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
- **Tools**: `app/core/ats_scan.py` (11 deterministic format/content checks + optional keyword coverage — dates, acronym pairing, pronouns, bullet length, length vs. experience), `app/core/ats_xray.py` (**ATS X-ray**: render the résumé, read it back with our own parser, and report every protected fact as clean / split / polluted / missing — see below), `app/core/linkedin.py`, `app/core/follow_up.py`.
- **Shared résumé logic**: `app/core/dates.py` (résumé date parsing, the ATS-safe rewrite, and years-of-experience over the *union* of role spans), `app/core/section_order.py` (Education above Experience for early-career résumés) and `app/core/skills.py` (`skill_blocks()` — how a grouped skills list becomes rendered blocks). Both renderers and `ResumeView` read the section order, so preview and download always agree; both renderers read `skill_blocks`, so they can never describe the Skills section differently, and `ResumeView` mirrors it in TypeScript for the same reason it mirrors the section order — a preview that groups the Skills section differently from the downloaded file is the one place a user can catch us contradicting ourselves.
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
- `app/api/routes.py` — thin FastAPI handlers that wire the pipeline. No business logic here. **A route that calls the model takes `Depends(llm_user)`** (daily cap + token metering); routes with their own specific cap (tailor, search, kit drain) take `Depends(metered_user)` instead so they meter without a second charge. Deterministic routes (`/tools/ats-scan`, `/tools/ats-xray`, `/public/scan`, `/render`) are deliberately uncapped, and that exclusion is smoke-pinned.
- `app/db/` — SQLAlchemy + SQLite (`applications` tracker + `saved_resumes` master résumé + `saved_resume_versions` undo buffer + `job_search_hits` search history + `usage_log` caps/tokens). `init_db()` is called via the FastAPI lifespan hook and includes a lightweight SQLite ADD-COLUMN shim that adds any ORM columns missing from pre-existing tables. Job-search results are auto-persisted as history via `app/db/history.py` (deduped by URL, capped at the newest 100) and exposed at `GET`/`DELETE /jobs/history`. **Anything holding user content must be wiped by `DELETE /profile/data`** — add new tables to that handler, or a privacy wipe silently leaves PII behind.
- `app/render/` — `docx_renderer.py` (python-docx) and `pdf_renderer.py` (reportlab), both driving one shared design system out of `templates.py` (palette, type, rhythm, page size, **presentation**) and `labels.py` (section names, EN/HE). ATS-safe: no tables/images/headers/footers, and single column everywhere except the two PDF-only sidebar templates.
  - **The PDF has its own layout engine.** Every run is line-broken by `_wrap_lines` and drawn with a text object, so Hebrew (bidi-reordered per line, right-to-left) and English share one set of flowables — `_Text`, `_Row` (title + flush-far-edge dates), `_Segments` (inline list with per-item colour/link/icon), `_Heading`, `_BarHeading`, `_Chips`, `_Cols`. reportlab's `Paragraph` is deliberately unused: its wrapping is direction-blind.
  - **The RTL contract — get this wrong and every Hebrew heading reverses.** `_draw_line` calls `_visual()` **itself**. A flowable drawing through it passes **logical** text (`_wrap_lines` returns logical lines on purpose); a flowable drawing with a raw `canv.drawString` applies `_visual()` itself (`_Chips` does). Pre-reordering before `_draw_line` double-reverses: תקציר renders as ריצקת while body text stays correct, so it is easy to miss.
  - **Every bare Flowable that can exceed a page needs `split()`.** reportlab cannot place one that doesn't and raises `LayoutError` — which reached production as a 500 from `POST /render` for any résumé with a long summary. `_Text.split()` pins its already-computed line break onto each half (`_pinned`) because re-wrapping the re-joined text can break differently and drop a word; the head keeps the bullet glyph, the tail must not grow a second one. Smoke-pinned per template.
  - **Icons are drawn paths, never glyphs** (`_draw_icon`, `_ICONS`). No bundled face has an envelope or a map pin, so a glyph would print a tofu box *and* land in the extracted text — on the exact line an ATS parses as the email address. A path emits no text operators, which is the whole reason this is safe. Each icon is defined in a **unit box** and drawn through a scaled CTM (stroke weight included), so one definition serves every size. In RTL the icon leads its label from the **right** — it sits at the far end of the item's own box in `_Segments` — and a directional shape (`_ICON_MIRRORED`: the handset, the link) is mirrored with it.
  - **A two-column template's sidebar must be incapable of overflowing.** reportlab reacts to a full frame by advancing to the NEXT one — which is the main column — so sidebar overflow lands there, and the `FrameBreak` that follows then pushes the real main content onto page 2, *into page 2's side frame*. That shipped: a 138-skill résumé rendered its Summary and Experience inside the 30%-wide rail. `_flow` now measures each sidebar section at the rail's width and DEMOTES any that will not fit into the main column, and page 2+ is a single full-width frame because the rail is a page-1 device like the header band. Both halves are needed; either alone still breaks. Smoke-pinned positionally — the old checks rendered every template but never asserted *where* content landed, which is exactly why the bug survived them.
  - **`KeepTogether` and `keepWithNext` both REFUSE to split**, and reportlab implements the latter *as* the former. So neither may wrap a run that can grow page-sized: it moves whole to the next frame and leaves the column it came from empty. `KeepTogether` is for gluing a heading to its FIRST item only. The skills block is the one section that can be page-sized, so it is emitted bare and `_Chips.split()` breaks it at a row boundary — verified by probe, since with either wrapper in place `split` is never called at all.
  - **Never nest `KeepTogether`.** It reports a sentinel height, so a nested one pushes every section onto its own page.
  - `_flow` returns **`(header, main, side)`**. `side` is non-empty only for a sidebar template; `header` is split out so a `header="band"` template can put it in its own frame *inside* the painted rectangle. A `_Band` spacer in the body frame does **not** work — it pushes the reversed-out white name below the band, where it renders white on white.
  - **Two-column is PDF-only, and that is a measured decision, not caution.** PDF text extraction y-sorts across the full page width, so a sidebar glues itself to the front of the main-column line at the same height (`"Python Go PostgreSQL Senior Backend Engineer"`). Individual bullets always survive intact — keyword matching is unaffected — but title/employer attribution is polluted. Ordering the content stream main-column-first does **not** help; pdfminer y-sorts regardless. So `split`/`panel` set `docx_fallback` and the Word file renders the named single-column sibling. Both facts are smoke-pinned.
  - **`pdf_family` is Latin-only.** RTL reads `he_family`; before that split every template resolved to the same Hebrew face and `executive` silently lost its serif in our primary market. In DOCX, Word formats Hebrew through `w:cs`, so `docx_font_he` must name a family that *has* Hebrew glyphs — pinning the Latin `docx_font` there asked Word for Georgia on a Hebrew résumé and it substituted something else.
  - reportlab gotchas, both learned the hard way: **`FrameBreak` is not a class** in 4.2.5 (`isinstance` raises `TypeError` — track the header block by index), and a page template **repeats itself** unless you set `autoNextPageTemplate`, so without it page 2 of a band template paints the band again.
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
- **The ATS X-ray shows rather than asserts** (`app/core/ats_xray.py`, `POST /tools/ats-xray`, `/tools/xray`). Every competitor *claims* its templates are ATS-safe; we own both the renderer and a parser, so the tool renders the file the user would actually send and re-reads it with `resume_parser.extract_text`, then marks every protected fact `clean` / `split` / `polluted` / `missing` and prints the parser's verbatim text. It is deterministic — no LLM, no network — which is why the route is uncapped.
  Two things keep it honest, and both are smoke-pinned. **The false-positive pin:** no single-column template may ever report pollution. A guard that fires on clean input teaches users to ignore it, and the naive version did exactly that — a headline reading "Senior Backend Engineer · Distributed Systems" contains the *skill* "Distributed Systems" because the candidate wrote it there. Pollution therefore has a required SHAPE (`_collision`): the sidebar value must sit at one END of the line, because extraction fuses columns end-to-end, and the header block is excluded outright since it spans both columns. **The true-positive pin** uses its own fixture: interleaving is content-dependent — it needs sidebar content at the same height as a main-column entry — and the shared `resume` fixture happens to produce none, so a check written against it would have passed by never firing.
- **A template must differ from the others in SHAPE, not in hue.** The original five were one document in five colours, and that — not any single element — is what made the downloads read as undesigned. `TemplateSpec` therefore carries a presentation vocabulary (`header`, `heading`, `entry`, `skills`, `list_cols`, `rail`, `layout`, `page_bg`, `bullet_glyph`) and every option in it is reproducible in **both** renderers, so the two downloads can never disagree about what the document SAYS: a filled band is paragraph shading (`w:shd`) in DOCX, an accent bar is a left paragraph border (`w:pBdr`), a chip is a bordered run (`w:bdr`). None of them needs a table. A smoke check asserts the set stays structurally diverse, and another asserts no template ships a heading smaller than its own body text (the original five did — 9.5pt headings over 10.2pt body).
  **The one carve-out is `contact_icons` / `date_icon` (21.8), and it is a carve-out for ORNAMENT, never for layout.** The PDF draws small vector marks on the contact row; the DOCX draws none and renders the same document without them. There is no honest DOCX twin: `w:drawing`, `w:pict` and `graphicData` are the drawing objects the ATS rules forbid, and a unicode dingbat prints tofu in Calibri *and* lands in the extracted text right beside the email address. The omission is safe because an icon **carries no text and its absence changes no content** — the two files still say the same words in the same order, which is the property the rule above actually protects. A layout option that differed would change what the document says, and none of those may. Two smoke checks hold the line: the icon template's DOCX is **byte-identical** to an icons-off twin, and its PDF's extracted text is byte-identical to the same twin's.
- ATS rendering rules are enforced in both renderers: no tables, no text-boxes, no images, no headers/footers, standard section names. Everything that makes the download *look* designed is achieved without breaking those rules — hairlines are paragraph borders, flush-right dates are a tab stop (DOCX) or a drawn string (PDF), letter-spacing is small enough that extractors still read whole words, and the contact icons are drawn paths (a stroked vector is not an image, carries no text, and nothing has to un-pick it). The smoke test pins all of it.
- **`ResumeModel.skills` is the flat surface everything SCORES; `skill_groups` is presentation.** The scorer's keyword coverage, the ATS scan, the ATS x-ray and résumé health all read `skills` and none of them knows groups exist, so `skills` stays populated as the flat union of every group's items — enforced by a `model_validator` on `ResumeModel` rather than at each call site, because an LLM response, a stored JSON row and a test fixture all need the same guarantee. The validator only ever ADDS; the one place that removes a skill (`length_budget._drop_unmatched_skill`) drops it from its group too, or the union would resurrect it on the next round-trip and the trim would silently do nothing. Two consequences worth keeping: **nothing may be hidden** — a skill no group claims is still rendered, in a trailing unlabelled block, because an invisible skill is an x-ray "missing" on the file we told the user to send; and **group labels are not claims**, so the fabrication guard leaves them alone for exactly the reason it leaves skills alone. A tailored CV is deliberately flat (the TAILOR prompt returns `skill_groups: []`): the grouping is the master résumé's taxonomy, and one job's CV is a shortlist.
- `FactsLedger` is derived from the **original** resume (before tailoring) and is never mutated. It is the source of truth for the guard.
- `ResumeModel.headline` (the target-title line) is a **claim**, so the guard reads it — but only for rank. The ledger keeps `headlines` separate from `titles` on purpose: running the headline through the generic title diff would flag every honest reposition and teach users to ignore flags. Only a seniority word no real title carries is a fabrication.
- Tracker rows record what was sent (`template`, `voice_score`, `fabrication_flag_count`). All three are nullable/`""` — a row that predates the field means **unknown**, never zero, and the analytics drops it from that dimension instead of scoring it. When reading these off a stored kit, parse the RAW result JSON: validating through `TailorResult` silently substitutes schema defaults.
- **A ContextVar cannot be bound inside a FastAPI `yield` dependency.** FastAPI runs setup and teardown through `contextmanager_in_threadpool`, so they can land in different contexts: `reset()` raises `"Token was created in a different Context"`, and — worse — the endpoint never sees the value at all. Request-scoped state that the endpoint must read gets bound in **middleware** (one context for set and reset) and handed to dependencies via `request.state`. This is why `llm_metering` lives in `app/main.py` and not in `deps.py`.
- **A `ThreadPoolExecutor` worker starts from an EMPTY context.** Any pool whose work makes LLM calls must submit through `copy_context().run` or its tokens vanish silently — `job_search`'s scoring pool is the case that matters, since it is the biggest spender in the app. The tally is a mutable object precisely so a copied context still writes to the request's instance.
- **A search must survive one bad posting.** `_score_hit` never raises for a per-job problem: a failed fetch or a model error leaves that index `None` and lands in the existing `skipped` count. With up to 25 concurrent LLM calls per search, letting one propagate discarded 24 good results.
- **Overwriting the master résumé snapshots it first** (`db/resume_versions.snapshot`, called from `PUT /profile/resume` and from restore). The dedupe compares the incoming content against the **current row**, not against the newest stored version — the latter looks right and lets an unchanged save through whenever the previous save did change something.
- The alerts cron runs on a **wall-clock budget** (`ALERT_CRON_BUDGET_S`, under the 300 s platform ceiling) and orders users longest-unrun-first, so it degrades and reports `skipped` instead of being killed partway with the tail of the list silently never emailed. Check the budget *before* starting a user, never mid-run: an alert that already scraped and scored must finish and record its history, or the next tick redoes the work and calls the same postings "new".
