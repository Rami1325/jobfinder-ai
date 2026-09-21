# The skills section — the ceiling, the ordering, and the measured dead ends

> **Handbook file.** Split out of `CLAUDE.md` on 2026-09-21, **verbatim** — `CLAUDE.md` keeps the index and the
> house rules, this file keeps the full record for one department. Section titles are the originals, so an older
> pointer such as "CLAUDE.md's *Phase 22* section" (PLAN.md, code comments) resolves here. Every bullet records a
> defect that shipped or a measurement that cost money: edit it the way you would edit code, and add new findings
> here, not back in `CLAUDE.md`.
>
> **Read before touching** `core/skills_shortlist.py`, `core/skills.py`, the skill splitter in
> `parsers/structurer.py`, or before proposing ANY change to the TAILOR / PLAN_CV prompts, to `MODEL_ID`, or to
> per-task model routing — roughly thirteen were measured and rejected here, each with its numbers. The floor
> this ceiling pairs with is in `tailoring.md`; how a chip is drawn is in `rendering.md`; the harness is in
> `testing.md`.

### The skills ceiling — the other half of the trade (2026-08-30)

- **`keyword_guard` is the floor; `app/core/skills_shortlist.py` is the ceiling, and they run one line apart in `tailor_resume` on purpose.** The floor guarantees a JD keyword the candidate's own skills list carried is not deleted; the ceiling guarantees the section is a shortlist rather than the master's inventory. Same matcher, adjacent call sites, so nothing between them can see a list only one of them has finished with. `resume_max_skills` (default 20) is the cap; `<= 0` disables it.
- **This is CODE because the prompt was measured and found insufficient — that is the whole justification.** The TAILOR prompt has always asked for "roughly 15-25 INDIVIDUAL skills". Measured on the owner's real 66-skill master across 6 real job ads × 3 reps × 2 independent runs (`tests/ab_tailor.py`): the shipped CV carried a **median of 63.5 skills — more than the master it was cut from** — at **18.6% precision**. Every other size promise in this pipeline is already code (`length_budget` guarantees the page count the prompt asks for; `keyword_guard` guarantees the keyword floor it asks for); this was the one the prompt asked for and no code made.
- **The result, paired per job over 12 job-pairs: 63.5 → 20 skills, better on 12 of 12; entries the job never names 48.5 → 7.5; precision 18.6% → 55.0%; and coverage, lost keywords, fabrication flags, voice score and page count ALL UNCHANGED** (coverage delta median 0.0, lost keywords tied 12/12). Five independently-designed prompt-only variants were measured beside it and **every one that cut the count paid for it in coverage** — up to −13.2 points, with `lost_keywords` going from 0 to 3.
- **The mechanism behind that, and it is the non-obvious finding: cutting the COUNT is free; banning RELOCATION is what costs keywords.** A skills entry absent from `master.skills` but present in the master's *prose* is the model moving a term the candidate demonstrates in a bullet up into the list — which is what keeps it on the page after the budget deletes the project that carried it. The correlation is exact across arms (−4 relocations → −13.2 coverage; −2 → −9.05; −1.5 → −3.85; 0 → +0). Any future prompt work here must leave relocation alone.
- **Three rules inside it, each avoiding a defect already paid for once.** It uses `scorer._keyword_present` — the same call `keyword_guard` picks carriers with and `length_budget._drop_unmatched_skill` protects entries with, so it cannot become a second opinion. **A `covered` entry is never dropped and neither is a restored carrier**, cap or no cap — a carrier for a multi-word keyword ranks `partial` on its own ("REST" against "REST APIs"), and evicting it would silently undo a restore the changelog then claims it made. And **the model's own order survives**, because the tailor is told to put JD-relevant entries first and does that well.
- **The cut is REPORTED in the changelog, never silent**, and by count plus a sample — the master's tail runs to forty entries and naming them all is the section over again, not a log.
- **`MAX_RESTORED` was never the cause, and the instrumentation is what proved it.** A probe recorded what the MODEL returned versus what `preserve_keywords` then added: the guard added **zero** on 18 of 18 runs. Lowering the constant would have changed nothing and re-opened the keyword-deletion defect. **Its contribution is inversely proportional to how well the model curates**, though — driven offline, a curated 20-entry list converges back to ~35 because the guard's fixed point on this master is 35 — so "the guard adds nothing" is true of the current model output and must not be read as a property of the guard.
- **A tailored CV is flat, and `ResumeModel`'s union validator has to be told so BEFORE it runs.** `tailor.py` strips `skill_groups` from the raw response whenever it carries both that and a flat list. Measured: 20 flat entries plus the real master's five groups validates to **66**, silently, with nothing reporting that the curation was reversed. The model complied on all 30 measured runs — but an instruction is not a guarantee, and when it fails it defeats every other thing that shortens this section. Both halves of the condition matter: a response with groups and no flat list has the union as its only content.
- **`ats_scan`'s skills verdict is two-sided, and only when there is a job to be two-sided about.** It used to return `severity="good"` for any count ≥ 5 with no upper bound, so a 79-skill tailored CV was told "79 skills listed: good" while the owner's complaint was that the section was overstuffed. The bound now exists **only when a JD is supplied**: a 66-skill master with no job attached is an inventory, which is what a master is FOR, and warning on it would be a guard firing on legitimate input. It REPLACES the count verdict rather than adding an issue — `format_health` is `good/len(issues)`, and whether the paper parses has nothing to do with which job it is aimed at.
- **The closed-set violation is a PROMPT fix, not a code one, and that asymmetry is measured.** The model mints skills the candidate never claimed — `Linux`, `Agile`, `ChatGPT`, `Slack`, `Jira`, `bash`, `AWS`/`GCP`/`Azure`, `gRPC`, `candidate sourcing` — all lifted from the job ad. `check_fabrication` does not read skills by design, and the shortlist cannot help: an imported JD term *is* JD-relevant, so a relevance trim keeps it preferentially. **A deterministic filter is also off the table**, and that was checked rather than assumed: no lexical rule separates an invented claim from a legitimate rewording. `LLMs` (master: "LLM cost optimization"), `prompting` ("prompt and system design") and `vector databases` (`pgvector`) all score as unsupported on a token test, and a looser stem test "justifies" `custom scripts` from *customer*. So the TAILOR prompt gained the anti-minting rule (2026-08-30): name the observed leaks, make the test a SEARCH of the original resume, and — the load-bearing half — **explicitly permit relocation**. Measured over 18 real-key runs per arm, unambiguous fabrications fell **0.78 → 0.22 per run (p = 0.0018** against the pooled control rate, two same-prompt arms giving 19 and 9 events per 18 runs**)**, at no measurable coverage cost and zero keyword regression.
- **THE CAP IS 30, NOT 20, AND THE STORY OF WHY IS THE MOST IMPORTANT THING IN THIS SECTION.** At 20 the shipped list filled with the model's JD-shaped PARAPHRASE — `orchestration patterns`, `tool use`, `feedback loops`, `unstructured data processing`, `software engineering` — and cut the candidate's actual toolchain: FastAPI, PostgreSQL, pgvector, RAG, embeddings, n8n, Vapi, MCP all absent from an AI-engineering application. **No metric here could see it, and one actively rewarded it**: `skills_precision` scores an entry as good when a JD term matches it, so a paraphrase derived from the ad counts as a win and `FastAPI` counts as noise. It read 18.6% → 55% while the document got worse. It was found by rendering the PDF and reading it — the repo's oldest lesson, arriving again.
  **Two fixes were tried and both are dead ends worth not repeating.** Re-ranking `shortlist_skills` to favour the candidate's own wording: three different rank rules produced **byte-identical output**, because the model front-ranks its own paraphrases, so its ordering and the JD-relevance ordering agree and no reordering can recover the toolchain. And a prompt arm telling the model to name the tool rather than describe the capability: on the job that motivated the whole investigation it changed **nothing** (own-wording 50% → 50%), and on the job where it did work it cost **30.7 coverage points**. Where it worked it hurt; where it was safe it did nothing.
  **Raising the cap is free, and that is provable rather than argued.** `shortlist_skills` never drops an entry the job named, so simulated against eighteen real 52-74 entry model outputs the JD coverage of the shipped list is **constant at 55.1 for every cap from 20 to 40** — a bigger cap can only add. Measured 20 → 30: own wording 72% → 82%, concrete tools 9.0 → 15.5, page count unchanged at 2, and still less than half the 66 that produced the original complaint. **A deterministic function applied to real recorded inputs IS a measurement**; it needed no further spend.
- **`skills_unowned` is a SCREEN, never a verdict** — the fabrication guard's own contract, one level down. It over-flags legitimate rewordings, so judge a prompt change on the DELTA between arms (the over-count is identical across arms and cancels) plus the unambiguous tool/platform names, never on the absolute number.
- **gpt-5.6-luna was measured and REJECTED — do not re-litigate it without new data.** It is 73% cheaper ($0.0084 vs $0.0314 per tailor), curates far better unprompted (returns 32 skills where gpt-5.4-mini returns 59) and mints **zero** unambiguous fabrications. It still loses: paired per-job coverage **−8.6 points** (outside the ±4.9 noise floor), `lost_keywords` 0 → 1, and **3.2× the latency (55.0 s vs 17.2 s per tailor)**. Coverage is the ATS gate on a job-application product, so a cheaper, cleaner model that costs keyword coverage is not a trade this app can take. The mechanism is the one already documented above: Luna relocates less (`skills_relocated` −2), and banning relocation is what costs coverage. Note also that OpenAI retired the mini/nano suffixes — Luna is priced at the old *nano* point and Terra, the balanced tier, is **2.7× dearer than gpt-5.4-mini**, so there is no like-for-like successor. The open idea worth measuring is **per-task routing**: TAILOR is the call that needs instruction-following, while FIT_SCORE and PLAN_CV are mechanical and could run on the cheap tier.
- **The prompt's apparent self-contradiction about the skills count is LOAD-BEARING. Do not "tidy" it.** Strategy rule 2 still says "roughly 15-25 INDIVIDUAL skills — plus however many more it takes" and "This OUTRANKS the shortlist length below", while `skills_shortlist` hard-caps at 20. That reads like stale documentation of behaviour the code now overrides, and removing it is the obvious cleanup. **It was measured, and it makes the CV worse.** Deleting the escape hatch and the OUTRANKS sentence — and telling the model a deterministic pass would cut the list, so it should rank honestly and stop — did exactly what it was supposed to on its own terms: the model returned **66 → 48.5** skills. But `skills_precision` fell **52.5 → 32.5** and `n_projects` fell by **1.5**, because the trim selects the best 20 *out of what the model returns, in the model's own order* — so a shorter, earlier-truncated list gives it fewer good candidates to choose from. **Over-production plus deterministic selection beats self-restraint.** The arm was rejected against a decision rule written down before the data ("ship only if precision does not fall"), and the variant is kept at `tests/fixtures/ab/variants/rule2.txt` so the next person can re-run it rather than re-derive it.
- **`cv_planner`'s project count varies run to run, TWO prompt fixes were measured, and BOTH made it worse.** The rubric says "There is NO fixed number", which is the same open-ended shape that let the skills list reach 59, and the planner picked 3, 3 and 7 projects on three identical runs of one job. **Calibrate that before acting on it: 3/3/7 is the WORST job, not the typical one** — the median within-job spread is **1 project** (range 0-4), measured twice on separate rounds. Two arms were tried against a decision rule written before the data, TAILOR held byte-identical so the planner was the only variable: `planrank` (rank strictly, err generous, let the page budget cut — today's proven pattern applied to projects) took the spread **1 → 2** and cost 10 points of skills precision; `plananchor` (derive the count from the posting's distinct requirements, so the same posting yields the same number) breached no quality floor but took the spread **1 → 3**. Neither shipped. Both variants are kept at `tests/fixtures/ab/variants/plan{rank,anchor}.plan.txt`. The lesson is the one this whole phase keeps teaching: **a prompt instruction about a COUNT is weakly followed, whatever shape it takes** — and unlike skills, project selection is judgement, so the deterministic answer that worked there would be worse here. Treat the residual spread as accepted, not open.
- **Trimming BEFORE the page budget does not buy projects back — refuted, don't retry it.** The theory was sound (the budget keeps 8 projects at 10 skills and 4 at 66, at a constant 2 pages, so the bloat is billed to the project list) but the measured paired delta on `n_projects` was **−0.5 [−3..+2]**, i.e. nothing. The shipped placement — after `preserve_keywords`, before `report_restore` — stands.

### What using the app found (2026-08-31) — and four measured dead ends

Phase 24's "next up" opened with **USE THE APP**. Two real tailors were run on the
real key, rendered, and read. Everything below came out of reading four pages;
none of it was visible to any metric the app records.

- **A skill could be drawn twice, and a duplicate bought a free cap slot.** 3 of 12
  real-key runs returned the same entry twice and every one shipped — `skill_blocks`
  hands the flat list straight to both renderers. `ResumeModel`'s union validator
  cannot see it (it dedupes what it ADDS from `skill_groups` and seeds `seen` FROM
  the flat list), and `shortlist_skills` counts the cap against a SET while emitting
  a LIST, so cap 30 shipped 31 and 32. `skills.dedupe_skills` fixes it — **not** in a
  `model_validator`, for the reason the multi-skill splitter documents one door
  over. **There are TWO doors, and the second was found by review after the first
  shipped**: `humanizer.py` validates its own raw HUMANIZE payload and
  `tailor_resume` ACCEPTS it after the first dedupe has already run. The humanizer
  is pointed straight at this list (`voice_audit` scans the joined skills for
  banned phrases), so it rewords entries routinely and two rewordings colliding on
  one string IS the duplicate. Patch `humanizer.get_llm_client` to drive it —
  patching the caller's binding is a no-op that reads as a pass.
- **THE CANDIDATE'S OWN WORDS LEAD THE SKILLS SECTION; THE AD'S FOLLOW.**
  `skills_shortlist.order_skills`, a stable partition applied last. **This replaces
  the old "the model's own order survives" rule**, whose premise — that the tailor
  "puts the JD-relevant entries first and does that well" — a rendered page
  falsifies: what it puts first is the ad's vocabulary. Measured on a real AI-
  engineering tailor, the first twelve chips were `workflow automation`, `LLM
  systems`, `retrieval`, `tool use`, `orchestration patterns`… — ten of thirty
  entries absent from the candidate's own 66 — with OpenAI, RAG, pgvector, MCP and
  FastAPI in the tail. **It is a PARTITION, never a re-sort**, and the model's
  ranking survives inside each group. **It is NOT free, and the claim that it was
  is the one this work got wrong** — caught in review, before deploy.
  `scorer._resume_text` joins skills with a SPACE and `_keyword_present` tries the
  verbatim phrase FIRST, so a multi-word JD keyword can match ACROSS the join
  between two adjacent entries, and Hebrew's ב/ל/ה/ו/מ/ש prefixes stop the token
  fallback rescuing it: measured, the same set reordered scores **100.0 then 50.0**
  against `פייתון מתקדם` — in the primary market. `_Chips._pack` also fills rows by
  WIDTH, so a reorder repacks the section and can change its rendered height after
  the page budget has signed the CV off. **`tailor_resume` therefore measures
  coverage and the page count either side of the reorder and keeps the old order
  unless the new one is free** — the guarantee is enforced, not argued, in the
  humanizer's acceptance-gate shape. Judged the only way a presentation change can be — three
  orderings of the identical set rendered and read side by side.
- **A changelog may not describe a document that does not exist.** That entry made
  three claims and two were false: "Cut the skills list to the 30 this job asks for"
  (the cap keeps the top N by relevance — the app's own `ats_scan` said 19 of those
  30 are not mentioned by the posting), and "Your master resume lists 75 skills"
  (75 is what the MODEL returned; the master lists 66). Its "stay in your master
  resume" sample was drawn from `dropped_noise`, which contains the model's own
  inventions, so it could promise `orchestration patterns` was in the master.

**Four dead ends, each measured, so they are not retried.**

- **The shortlist cannot be re-ranked into fixing the paraphrase problem.** Over 153
  recorded model outputs at cap 30: an own-wording FILL changes 8/153 outputs and
  buys nothing (this reproduces the earlier "byte-identical" finding and explains
  it — the fill is not where the paraphrase lives). Letting the cap EVICT covered
  entries that are the model's wording buys +3 own entries and +1 toolchain entry
  for **−8.5 median and −56.0 worst-job** coverage. Raising the cap is free on
  coverage (flat at every cap 20→45, confirming the earlier result) but buys only
  +1 toolchain entry per +6 chips. **The paraphrase is `covered` BECAUSE it is
  verbatim from the ad**, so any relevance ranking must rank it top — which is why
  the fix is ordering, not selection.
- **A deterministic minting screen tops out at 53% precision — a warning wrong half
  the time, so it is off the table as an advisory as well as a filter.** This is
  *The skills ceiling*'s earlier "checked rather than assumed" claim, now with a number. The
  best rule found (bounded matching, plural folding, stem comparison, compound-head
  so `vector` ⊂ `pgvector` clears) catches every invention CLAUDE.md names and
  clears every rewording it names — and still flags `Git`, `SQL`, `retrieval`,
  `observability` and `debugging`, all things the candidate genuinely does. Two
  traps worth keeping: the "master token inside the entry" direction is the
  dangerous one (`form` from "form submissions" clears **Terraform**; `gpt` clears
  **ChatGPT**), and a ≥4-character guard is the only reason `SQL` fails.
- **Naming a leak more precisely in the prompt did not help, and may backfire.** The
  `nomint2` arm (36 real runs, decision rule written first, kept at
  `tests/fixtures/ab/decision-nomint2.md`) targeted two classes the current rule
  does not name — regulatory marks (`CE`/`FCC`/`UL`) and requirement fragments
  (`modern programming language`, `open-source technologies`). REJECTED on 3 of 6
  criteria. `skills_unowned` was unmoved (1.39 → 1.22/run, inside noise) and one job
  lost 10.4 coverage points. **The result worth keeping is the backfire**: on class B
  the arm went BACKWARDS — `open-source technologies` shipped in 1/3 baseline runs
  and **3/3** nomint2 runs. Naming a string that is ALSO a verbatim JD keyword puts
  it in front of the model twice. The existing rule gets away with naming leaks
  because those strings are not in the ad being tailored against.
- **`CE`/`FCC`/`UL` is intermittent, and one rendered page is not a rate.** Three
  hardware-compliance marks shipped onto a Senior Quality Engineer CV — all verbatim
  `jd.hard_skills`, on a candidate who has never done compliance work. The chain:
  the model mints them, `shortlist_skills.relevance` ranks them `covered` (the JD
  names them, so they match themselves), a covered entry is never dropped, and
  `check_fabrication` does not read skills by design — **nothing in the pipeline can
  remove a JD-derived fabrication, and the ceiling actively protects it.** But six
  further runs of the same job across two arms produced **zero** occurrences, so at
  n=3 per arm there was no power to measure a change in it. Order it after the
  measurable work; the ordering partition at least puts it last on the page.

**Per-task model routing (PLAN 24 item 3) is REJECTED for `PLAN_CV` and blocked for
`FIT_SCORE`.** FIT_SCORE + PLAN_CV are **56.8% of prompt volume**, so the saving is
real (~$0.0021 of a $0.0051 tailor). But the latency was never measured per task,
and the 3.2× figure came from TAILOR alone: measured directly, **PLAN_CV is 4.22×
slower on gpt-5.6-luna** (2.55 s → 10.79 s) and FIT_SCORE 1.81×. Pool 1's wall time
is `max(FIT_SCORE, PLAN_CV)`, so routing both adds **+8.2 s to save $0.002**.
Routing FIT_SCORE alone costs +0.23 s and is plausible — but `metering` carries no
model dimension (`usage_log` folds everything into one `action="tokens"` row per
user per day), so a mixed run blends two price tiers with nothing recording the
split, and the saving would be unverifiable the moment it shipped. Add the
dimension first. Note also that one `OpenAIClient` per process means **one
`_unsupported` probe set**: two models through one instance would let a cheap
model's rejected `temperature` silently strip it from every TAILOR call.

### Skills are terms, not sentences

- **Splitting a multi-skill entry happens at ONE server-side door — `structure_resume` — and never in a `model_validator`.** A CV that writes "Python, SQL, Go" on one line arrives from the LLM as a SINGLE skill: one chip on the page, one keyword to the scorer, one fact to the x-ray. A validator runs on every construction, i.e. every READ of every stored master, tracker resume, saved kit and version snapshot, so it would rewrite all of them without any of them being a write — bypassing `resume_versions.snapshot` and breaking its byte-identical dedupe, so the first save after deploy burns an undo slot on a no-op. It would also fire between `original` and `tailored` inside `TailorResult`, orphaning the frontend's text-derived `@skills.<key>` anchors. Pinned three ways, because no one of them is enough: the flat-only form is asserted to DO resurrect, `app/models` is grepped, and a stored resume is PUT and read back verbatim — the grep cannot see an INLINE COPY of the splitter, and the round trip cannot tell a correct door from a validator that happens to agree with it.
- **The separator set is comma, semicolon, pipe, middot, bullet, newline and tab — and every omission is a guard that would fire on legitimate input.** `/` — the master holds `CI/CD`, `TCP/IP`, `A/B testing`, and splitting also drops `CI` under the x-ray's `_MIN_FACT = 3`, so BOTH halves vanish from coverage. `" and "` — `prompt and system design`, `evaluation and fallback handling`, `RTL and i18n` are three real entries, each ONE skill. Hebrew's vav is an inseparable prefix orthographically identical to a word-initial vav (the Python twin of check-mirrors 10), so that rule shreds `פיתוח ווב`, `עריכת וידאו`, `ולידציה`. The false-positive table sits in the SAME check as the positive, because "split multi-skill entries" is trivially satisfied by splitting on everything.
- **A separator inside brackets or quotes is not a separator.** `Cloud (AWS, GCP)` is one skill the user typed, and the splitter wrote `Cloud (AWS` and `GCP)` — unbalanced fragments nobody typed — into the master resume and the downloaded PDF, at the one door that parses the user's own CV. A depth counter over brackets and DOUBLE quotes fixes it. The apostrophe is deliberately NOT a delimiter: `Bachelor's` would open a run that never closes and suppress every separator after it in the same entry. Hebrew's geresh and gershayim are absent for the same reason — they sit INSIDE words (ד״ר, צה״ל).
- **There is NO length cap on a skill, in characters or in bytes.** A skill is the user's own text, so "never truncate the user's own document" applies verbatim: a separator-free entry passes through unchanged however long. `_Chips` wraps it and the review's `skills-sentence` check reports it — a skill written as a sentence, anchored at `@skills.<dkey>`, the role `ats_scan`'s twelfth check filled until Phase 28 deleted it; neither shortens it. The bytes-not-characters rule is scoped to PROMPT bounds where the quantity is tokens; for a DISPLAY limit the physical quantity is rendered width in POINTS and bytes are actively wrong — measured, the `split` rail holds 27 lowercase Latin characters, 16 capital M's and 28 Hebrew ones, so a byte cap would hand the primary market half the room it has earned.
- **A chip may not be wider than its column, and `_Chips` enforces it by reusing `_wrap_lines`.** `_pack` broke to a new row only when the row was already non-empty, so a lone over-wide item was admitted unconditionally and `wrap()` reported the column width regardless — reportlab believed it fit and nothing clipped. Measured on `split`: a 60-character skill drew 326pt past its column, straight across the main text, and because it overprinted the section heading at the same y, `'EXPERIENCE' in extract_text(...)` was **False** — one long skill deleted a standard section name from the file we tell the user is ATS-safe. The wrapped chip applies `_visual()` PER LINE after logical wrapping, and `split()` accumulates per-row heights. Pinned on GEOMETRY, not text: pdfplumber returns Hebrew already bidi-reordered, so a text-matching check passes by never firing in RTL.
