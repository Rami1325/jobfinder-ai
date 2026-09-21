# Rendering — the two renderers, the templates, and the ATS x-ray

> **Handbook file.** Split out of `CLAUDE.md` on 2026-09-21, **verbatim** — `CLAUDE.md` keeps the index and the
> house rules, this file keeps the full record for one department. Section titles are the originals, so an older
> pointer such as "CLAUDE.md's *Phase 22* section" (PLAN.md, code comments) resolves here. Every bullet records a
> defect that shipped or a measurement that cost money: edit it the way you would edit code, and add new findings
> here, not back in `CLAUDE.md`.
>
> **Read before touching** anything under `backend/app/render/`, `core/ats_xray.py`, `core/skills.py`
> (`skill_blocks`, `regroup_skills`), `core/section_order.py`, `frontend/src/lib/templateSpecs.ts`,
> `components/XrayResult.tsx` or `components/TemplatePicker.tsx`. The on-screen third renderer of `TemplateSpec`
> is in `document-editor.md` (Phase 23.7); why a skill has no length cap and how `_Chips` wraps one is also told in
> `skills.md` (*Skills are terms, not sentences*).

### `app/render/` — the renderers

This was the `app/render/` entry of `CLAUDE.md`'s backend package layout; its sub-bullets are the engine notes.

- `app/render/` — `docx_renderer.py` (python-docx) and `pdf_renderer.py` (reportlab), both driving one shared design system out of `templates.py` (palette, type, rhythm, page size, **presentation**) and `labels.py` (section names, EN/HE, in two SETS chosen per template by `TemplateSpec.label_set`). ATS-safe: no tables/images/headers/footers, and single column everywhere except the two PDF-only sidebar templates.
  - **The PDF has its own layout engine.** Every run is line-broken by `_wrap_lines` and drawn with a text object, so Hebrew (bidi-reordered per line, right-to-left) and English share one set of flowables — `_Text`, `_Row` (title + flush-far-edge dates), `_Segments` (inline list with per-item colour/link/icon), `_Heading`, `_BarHeading`, `_Chips`, `_Cols`. reportlab's `Paragraph` is deliberately unused: its wrapping is direction-blind.
  - **The RTL contract — get this wrong and every Hebrew heading reverses.** `_draw_line` calls `_visual()` **itself**. A flowable drawing through it passes **logical** text (`_wrap_lines` returns logical lines on purpose); a flowable drawing with a raw `canv.drawString` applies `_visual()` itself (`_Chips` does). Pre-reordering before `_draw_line` double-reverses: תקציר renders as ריצקת while body text stays correct, so it is easy to miss.
  - **Every bare Flowable that can exceed a page needs `split()`.** reportlab cannot place one that doesn't and raises `LayoutError` — which reached production as a 500 from `POST /render` for any resume with a long summary. `_Text.split()` pins its already-computed line break onto each half (`_pinned`) because re-wrapping the re-joined text can break differently and drop a word; the head keeps the bullet glyph, the tail must not grow a second one. Smoke-pinned per template.
  - **Icons are drawn paths, never glyphs** (`_draw_icon`, `_ICONS`). No bundled face has an envelope or a map pin, so a glyph would print a tofu box *and* land in the extracted text — on the exact line an ATS parses as the email address. A path emits no text operators, which is the whole reason this is safe. Each icon is defined in a **unit box** and drawn through a scaled CTM (stroke weight included), so one definition serves every size. In RTL the icon leads its label from the **right** — it sits at the far end of the item's own box in `_Segments` — and a directional shape (`_ICON_MIRRORED`: the handset, the link) is mirrored with it.
  - **A two-column template's sidebar must be incapable of overflowing.** reportlab reacts to a full frame by advancing to the NEXT one — which is the main column — so sidebar overflow lands there, and the `FrameBreak` that follows then pushes the real main content onto page 2, *into page 2's side frame*. That shipped: a 138-skill resume rendered its Summary and Experience inside the 30%-wide rail. `_flow` now measures each sidebar section at the rail's width and DEMOTES any that will not fit into the main column, and page 2+ is a single full-width frame because the rail is a page-1 device like the header band. Both halves are needed; either alone still breaks. Smoke-pinned positionally — the old checks rendered every template but never asserted *where* content landed, which is exactly why the bug survived them.
  - **A chip may not be wider than its column — and that is `_Chips`' job, not the demotion pass's.** `_pack` broke to a new row only when the current one already held something, so a single item wider than the whole column was appended to an EMPTY row unconditionally; `wrap()` then reported `avail_w` regardless of what it had packed, and nothing clips. Measured on `split` (rail 148.58pt at [48.0, 196.6]): one 60-character skill packed a 253.00pt row and was drawn to x=301.0, 84pt past the gutter; a 147-character one packed 616.13pt. The damage is not cosmetic — the chip overprints the main column at the same y and pdfminer y-sorts, so extraction returned `"Designing and operating distributed backeEnXd PsyEstRemIEs NatC scEale"` and **`"EXPERIENCE" in extract_text(...)` was False**: one long skill deleted a standard section name from the file we tell the user is ATS-safe. An over-wide item now takes a row of its own and is line-broken by **`_wrap_lines`**, whose hard-break loop already survives a token longer than the column — which is why every `inline`-skills template was always clean; the correct behaviour existed in the file and `_Chips` did not use it. `_Chips` draws **LANGUAGES too**, so this was never skills-only. Three consequences: `_visual()` is applied **per LINE** after `_wrap_lines` has broken LOGICAL text (pre-reordering stacks the lines backwards); each line is positioned through `_place`, since a single-line chip only right-aligns in RTL by accident (its box width is derived from its own advance); and `split()` **accumulates per-row heights** instead of dividing by a fixed `chip_h + gap`, or a two-line row is counted as one and the head handed to the frame is taller than the room it was given. The sidebar demotion pass stays **height-only**: a wrapped chip is genuinely taller, so `_content_height` already demotes on it, and a width gate there would be a second classifier answering the same question from a different gate — the correction the geo-restriction work paid for once. An ordinary skills list renders **byte-identically** before and after (all templates × 2 languages, modulo reportlab's per-render `/ID` digest — the only non-deterministic bytes in a PDF), and that half is smoke-pinned beside the catch, because "make the long skill fit" is trivially satisfied by wrapping every chip.
  - **`KeepTogether` and `keepWithNext` both REFUSE to split**, and reportlab implements the latter *as* the former. So neither may wrap a run that can grow page-sized: it moves whole to the next frame and leaves the column it came from empty. `KeepTogether` is for gluing a heading to its FIRST item only. The skills block is the one section that can be page-sized, so it is emitted bare and `_Chips.split()` breaks it at a row boundary — verified by probe, since with either wrapper in place `split` is never called at all.
  - **Never nest `KeepTogether`.** It reports a sentinel height, so a nested one pushes every section onto its own page.
  - `_flow` returns **`(header, main, side)`**. `side` is non-empty only for a sidebar template; `header` is split out so a `header="band"` template can put it in its own frame *inside* the painted rectangle. A `_Band` spacer in the body frame does **not** work — it pushes the reversed-out white name below the band, where it renders white on white.
  - **Two-column is PDF-only, and that is a measured decision, not caution.** PDF text extraction y-sorts across the full page width, so a sidebar glues itself to the front of the main-column line at the same height (`"Python Go PostgreSQL Senior Backend Engineer"`). Individual bullets always survive intact — keyword matching is unaffected — but title/employer attribution is polluted. Ordering the content stream main-column-first does **not** help; pdfminer y-sorts regardless. So `split`/`panel` set `docx_fallback` and the Word file renders the named single-column sibling. Both facts are smoke-pinned.
  - **`pdf_family` is Latin-only.** RTL reads `he_family`; before that split every template resolved to the same Hebrew face and `executive` silently lost its serif in our primary market. In DOCX, Word formats Hebrew through `w:cs`, so `docx_font_he` must name a family that *has* Hebrew glyphs — pinning the Latin `docx_font` there asked Word for Georgia on a Hebrew resume and it substituted something else.
  - reportlab gotchas, both learned the hard way: **`FrameBreak` is not a class** in 4.2.5 (`isinstance` raises `TypeError` — track the header block by index), and a page template **repeats itself** unless you set `autoNextPageTemplate`, so without it page 2 of a band template paints the band again.
  - `fit_squeeze()` decides one page vs. two by measuring the built flow, and compresses the vertical rhythm (never the type size) when the resume overflows by a little. The DOCX renderer calls the same function so both downloads agree.
  - Hebrew DOCX must mirror `w:b`/`w:sz` onto `w:bCs`/`w:szCs` — Word formats Hebrew through the complex-script properties and ignores the plain ones.
  - Fonts are bundled under OFL (see `fonts/README.md`); a missing file degrades to base-14 rather than failing the download.
  - **`_wrap_lines` is memoized** (`_wrap_cached`, LRU 4096) because the page budget is allowed 60 real reportlab builds per tailor and every one re-wraps the same bullets. It must stay pure in `(text, font, size, width, tracking)`; it returns a fresh list of a cached tuple so a caller that mutates its lines can't poison the next render. Keying on the font NAME is what makes it safe — a missing-file fallback registers under a different name.

### Template shape, the ATS rules, and the x-ray

- **A template must differ from the others in SHAPE, not in hue.** The original five were one document in five colours, and that — not any single element — is what made the downloads read as undesigned. `TemplateSpec` therefore carries a presentation vocabulary (`header`, `heading`, `entry`, `skills`, `list_cols`, `rail`, `layout`, `page_bg`, `bullet_glyph`) and every option in it is reproducible in **both** renderers, so the two downloads can never disagree about what the document SAYS: a filled band is paragraph shading (`w:shd`) in DOCX, an accent bar is a left paragraph border (`w:pBdr`), a chip is a bordered run (`w:bdr`). None of them needs a table. A smoke check asserts the set stays structurally diverse, and another asserts no template ships a heading smaller than its own body text (the original five did — 9.5pt headings over 10.2pt body).
  **The one carve-out is `contact_icons` / `date_icon` (21.8), and it is a carve-out for ORNAMENT, never for layout.** The PDF draws small vector marks on the contact row; the DOCX draws none and renders the same document without them. There is no honest DOCX twin: `w:drawing`, `w:pict` and `graphicData` are the drawing objects the ATS rules forbid, and a unicode dingbat prints tofu in Calibri *and* lands in the extracted text right beside the email address. The omission is safe because an icon **carries no text and its absence changes no content** — the two files still say the same words in the same order, which is the property the rule above actually protects. A layout option that differed would change what the document says, and none of those may. Two smoke checks hold the line: the icon template's DOCX is **byte-identical** to an icons-off twin, and its PDF's extracted text is byte-identical to the same twin's.
- ATS rendering rules are enforced in both renderers: no tables, no text-boxes, no images, no Word header/footer, standard section names (`render/labels.py` — two sets, and `standard` prints the longer one at the owner's explicit request; the ATS note is recorded at that file). Everything that makes the download *look* designed is achieved without breaking those rules — hairlines are paragraph borders, flush-right dates are a tab stop (DOCX) or a drawn string (PDF), letter-spacing is small enough that extractors still read whole words, and the contact icons are drawn paths (a stroked vector is not an image, carries no text, and nothing has to un-pick it). The smoke test pins all of it.
- **The ATS X-ray shows rather than asserts** (`app/core/ats_xray.py`, `POST /tools/ats-xray`, `/tools/xray`). Every competitor *claims* its templates are ATS-safe; we own both the renderer and a parser, so the tool renders the file the user would actually send and re-reads it with `resume_parser.extract_text`, then marks every protected fact `clean` / `split` / `polluted` / `missing` and prints the parser's verbatim text. It is deterministic — no LLM, no network — which is why the route is uncapped.
  Two things keep it honest, and both are smoke-pinned. **The false-positive pin:** no single-column template may ever report pollution. A guard that fires on clean input teaches users to ignore it, and the naive version did exactly that — a headline reading "Senior Backend Engineer · Distributed Systems" contains the *skill* "Distributed Systems" because the candidate wrote it there. Pollution therefore has a required SHAPE (`_collision`): the sidebar value must sit at one END of the line, because extraction fuses columns end-to-end, and the header block is excluded outright since it spans both columns. **The true-positive pin** uses its own fixture: interleaving is content-dependent — it needs sidebar content at the same height as a main-column entry — and the shared `resume` fixture happens to produce none, so a check written against it would have passed by never firing.
- **The ATS x-ray must search the VISUAL form of a fact as well as the logical one.** `pdf_renderer._draw_line` draws bidi-reordered glyphs, so pdfminer returns visual text while a fact from `ResumeModel` is logical. Before `_candidates()` existed, a correctly rendered Hebrew PDF reported 14 of 16 facts `missing`. `ats_xray` imports the renderer's own `_visual` on purpose — if the renderer's `base_dir` changes, the x-ray follows it.

### The default template — a reproduction, not a design (2026-09-06)

- **`standard` is `DEFAULT_TEMPLATE`, and it is a COPY of a real document**: the CV
  the owner actually applies with. Every number in it was measured off that file
  and the render was checked back against it line for line — the summary, the four
  skills groups, both roles and every bullet break at the same word, with
  cumulative vertical drift under 4pt across page 1. It is the only entry in the
  registry that is a reproduction rather than a design of ours, so "tidying" a
  value in it is changing the document, not the code.
- **Three grammars exist FOR it, and each is declarative.** `entry="run"` (title |
  employer bold, then location | dates italic, on ONE wrapping line — and the one
  entry style that can absorb a `detail` inline, which is what education's course
  list is), `skills="labeled"` (the group label bold and inline ahead of its own
  comma-joined items — same text and the same commas as `"inline"`, so a keyword
  parser splits it identically), and `label_set` (the longer business wording).
  Sixteen new `TemplateSpec` fields carry the rest; every one defaults to today's
  behaviour, so the other eleven templates render byte-identically.
- **`_RichText` is the flowable that makes `entry="run"` possible**, and it is the
  third case neither existing one covers: `_Text` wraps between words but is ONE
  style; `_Segments` mixes styles but treats every item as ATOMIC, so an item
  longer than the column draws past the margin. It **preserves whitespace
  exactly** — "  |  " and the three spaces before the italic tail are part of the
  design, and a tokeniser that normalised runs of spaces would quietly redesign
  the line. It follows `_Segments`' RTL contract, not `_Text`'s: each drawn piece
  is `_visual()`-reordered here and the pieces are laid out in reverse, so it
  draws with a raw `drawString` and must never route through `_draw_line`. And it
  `split()`s, because a labelled skills block on a 66-skill master is exactly the
  page-sized run that made `_Segments` and `_Chips` each ship a `LayoutError`.
- **THE BULLET DID NOT SURVIVE EXTRACTION, and that is the most important thing
  here.** `standard` asks for base-14 Helvetica deliberately — Arial and
  Liberation Sans metrics to the unit, which is what makes the line breaks match a
  document set in Liberation Sans, and no OFL face we could bundle reproduces
  those letterforms. reportlab encodes U+2022 as byte **0x7F**, one of the several
  slots Adobe's WinAnsiEncoding fills with `bullet`: it RENDERS correctly and
  every extractor using the plain WinAnsi table hands back `(cid:127)`. Measured
  on the first render: nine bullets, nine `(cid:127)`, on the one product whose
  promise is that the file parses. `_explicit_encoding` declares the encoding
  against **StandardEncoding** — that base is the whole mechanism, since reportlab
  only writes a `/Differences` array for slots that differ from the base — so the
  file states which character that byte is. **MacRomanEncoding also fixes the
  bullet and was measured and REJECTED**: no €, ½, ¼ or ×, and an unencodable
  character does not fail loudly — `unicode2T1` substitutes reportlab's notdef
  character, so "½ day" prints a letter nobody typed.
- **The page footer is the ONE place the PDF and the DOCX deliberately disagree,
  and it is NOT a fourth ornament carve-out.** Those three pass a test this one
  fails: an icon, a page tint and a rail dot carry NO TEXT, so their absence
  changes nothing the document SAYS. A footer is a word. Word can only repeat a
  line per page through a real `w:ftr`, which the ATS rules forbid and the smoke
  test pins. **The divergence is a user-made decision (2026-09-06), not one this
  code granted itself**, and `DocumentPanel` says so under the document.
- **`label_set="full"` was chosen over the standard short names, over the stated
  ATS objection**, and `labels.py` records that rather than re-arguing it: "Core
  Expertise" is not a heading a keyword parser is written to look for. Two of the
  long names are deliberately NOT verbatim copies of the source — it headed its
  projects "SELECTED AI SOLUTIONS & PRODUCTS", and a template cannot know the
  candidate's field, so the set carries the domain-free "Selected Projects".
- **Skills keep the master's headings through tailoring — DETERMINISTICALLY, after
  the fact, never by asking the model.** `tailor.py`'s strip stays, so not one of
  the thirteen measured prompt findings in `skills.md` is re-litigated.
  `skills.regroup_skills` files the entries that actually SHIPPED under the
  master's own labels in the master's own order; everything the master has never
  heard of lands in the trailing unlabelled block that `skill_blocks` already
  draws. **That block is the point**: it holds exactly the wording the model
  minted from the ad, which is where `order_skills` was pushing it anyway — so the
  two run as a FORK and never both. Reordering the same list twice would leave one
  of the two changelog entries describing an order the document does not have.
  Both go through the same acceptance gate `order_skills` already used (coverage
  must not fall, the page count must not grow), for the reasons recorded there (`skills.md`).
- **`RenderRequest.template` defaulted to the literal `"classic"`** — the id that
  happened to be the default when it was written — so on the day `standard` took
  over, a client omitting the field kept downloading the old template while the
  preview beside it drew the new one. It is `""` now, like the six other request
  models that carry the field, and a smoke check reads the DEFAULT off every
  Pydantic model in `app.models` so a re-added literal cannot pass by equalling
  today's default.
- **Five page-budget checks went red, exactly as their own comment said they
  would.** Restoring 25 entries costs ~120pt under `skills="labeled"` and ~400pt
  under `skills="chips"`, so the fixtures stopped crossing the boundary they exist
  to cross. They are pinned to a NAMED template now (`_KG_TPL`) rather than
  retuned to a knife-edge the next change to the default would blunt again: the
  mechanism under test is the refit, which is template-independent.
- **Known and deliberately not reproduced**, each measured: the date range is an en
  dash where the source has a hyphen (the en dash is the correct range glyph and
  the app's convention across all twelve templates); a project's tech line has no
  field in `ResumeModel` to come from; and the entry, project and degree names are
  one size apart in the source (10 / 9.5 / 9) where `entry="run"` carries that
  hierarchy through a `bump` argument at the three call sites.
