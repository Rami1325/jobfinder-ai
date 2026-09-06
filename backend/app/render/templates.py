"""Resume template registry shared by both renderers (PLAN 6).

A spec is DECLARATIVE: it varies page size, margins, fonts, type sizes, the
palette, the vertical rhythm, and — since Phase 21 — the presentation vocabulary
(`header`, `heading`, `entry`, `skills`, `list_cols`, `rail`, `layout`). It never
contains layout code. Every LAYOUT option is reproducible in BOTH renderers, so
the PDF and the DOCX can never disagree about what a template SAYS.

Three fields are ORNAMENT rather than layout and render in the PDF only:
`contact_icons` / `date_icon`, `page_bg`, and the per-role dot on `rail`. Each
passes the same test — it carries no text, and its absence changes nothing the
document SAYS — and each names, at its own field, why the DOCX alternative is
worse than the omission rather than merely harder. Nothing with a LAYOUT
consequence may join them: a heading shape, a bullet glyph, a column count or a
rule weight changes what the document says, so those are reproduced in both.

Everything here stays ATS-safe: real selectable text, zero tables / text boxes /
images, and no Word header or footer. Section names come from `render/labels.py`
in one of two sets — see `label_set`, and the ATS note in that file about the
longer one. The DOCX twin of a filled
band is paragraph shading, of an accent bar a left paragraph border, of a chip a
bordered run — none of which an ATS parser has to un-pick. The smoke test renders
every template in both formats and both languages and re-extracts the text to
prove the tagline: "every template passes our own ATS scan".

The one deliberate exception is `layout="sidebar"`: two columns render in the PDF
only, and the DOCX falls back to the single-column sibling named by
`docx_fallback`. See the `layout` field for the measured reason.

Templates must differ in SHAPE, not just hue. The pre-21 set of five was one
document in five colours, which is exactly why the downloads read as undesigned;
a smoke check now asserts the set stays structurally diverse.

`standard` (2026-09-06) is the one entry here that is a REPRODUCTION rather than
a design: every number in it was measured off a real document the owner applies
with, and it is the default. It is also the only template that draws a page
footer, which is the one place the PDF and the DOCX deliberately disagree — read
the note on `footer_name` before treating that as a bug or as a fourth ornament
carve-out.

Unknown/empty template names fall back to the default, so old clients that
never send `template` keep working.

Page size is a per-template field. Eleven templates are A4 (the standard
everywhere except the US/Canada, and this product is Israel-first); `standard`
is US Letter, because the document it reproduces is.
"""
from __future__ import annotations

from dataclasses import dataclass

A4_W, A4_H = 595.276, 841.890
LETTER_W, LETTER_H = 612.0, 792.0


@dataclass(frozen=True)
class TemplateSpec:
    id: str

    # --- palette (hex, no leading "#") ------------------------------------
    accent: str  # section headings + employer/institution names
    ink: str = "1A1A1A"  # primary text
    muted: str = "5C6470"  # dates, locations, contact line
    rule: str = "D5D9E0"  # hairlines under the header and section headings
    # A tint of the accent, for chip fills and the sidebar panel. "" = mixed
    # in `_Sheet` as accent @ 12% over white, so no template has to hand-pick
    # one and nothing existing changes.
    accent_soft: str = ""

    # --- type -------------------------------------------------------------
    # The bundled family the PDF embeds (Latin). "Helvetica" is the one legal
    # value that names no file: it resolves through `_fonts`' base-14 fallback
    # to reportlab's built-in Helvetica, whose metrics are Arial's and Liberation
    # Sans's to the unit. `standard` asks for it deliberately rather than as a
    # degradation — its source document is set in Liberation Sans, and no
    # OFL face we could bundle reproduces those letterforms. The cost is that
    # those glyphs are not EMBEDDED, so the viewer substitutes its own Helvetica
    # or Arial; every desktop and mobile PDF viewer has one, the text stream is
    # unchanged either way, and an ATS reads the stream. Bundling Liberation
    # Sans (also OFL) would embed the identical metrics and is the strict
    # improvement if the files are ever added.
    pdf_family: str = "Lato"
    # The Hebrew face. `pdf_family` is NOT used in RTL — a Latin-only file has
    # no Hebrew glyphs — so the Hebrew half of a template is chosen here. It is
    # a separate axis on purpose: pairing a Latin serif with a Hebrew sans is a
    # normal, correct choice when no matching Hebrew serif is bundled.
    he_family: str = "NotoSansHebrew"
    docx_font: str = "Calibri"  # family name Word resolves locally (Latin)
    # The COMPLEX-SCRIPT face Word is asked for on a Hebrew resume. Word formats
    # Hebrew through w:cs and ignores the plain font, so pinning a Latin-only
    # family here (Georgia, say) makes Word silently substitute something else
    # and the DOCX stops matching the PDF. Must be a family that actually has
    # Hebrew glyphs: Arial, David (serif), Narkisim, Gisha.
    docx_font_he: str = "Arial"
    body_size: float = 10.2
    heading_size: float = 9.5
    name_size: float = 22.0
    meta_size: float = 9.0
    # Body line height as a multiple of `body_size`. 0.0 = the tight/normal rule
    # both renderers already apply (1.26 when `tight`, else 1.36) — a real value
    # here replaces it. It is its own field rather than a third `tight` step
    # because leading is what sets a page's density: `standard` reproduces a
    # 10.5pt line on 9pt type (1.167), which neither existing step reaches, and
    # over forty body lines the difference is a third of a page.
    leading_ratio: float = 0.0

    # Which contact details the header line prints, in order. () = the built-in
    # email, phone, location, linkedin, website. It is a per-template field for
    # the same reason `label_set` is — `standard` reproduces a document that
    # leads with the city, and a user who switches template should see that
    # template's document, not their previous one's habits. A key the contact
    # has no value for is skipped, exactly as the built-in order skips it, so a
    # short tuple hides nothing: it only reorders what is already printed.
    contact_order: tuple[str, ...] = ()

    # --- layout -----------------------------------------------------------
    name_centered: bool = True  # False = name sits at the text start (right in RTL)
    name_tracking: float = 1.0  # extra letter-spacing, pt
    heading_tracking: float = 1.0
    # The name's own colour; "" = `ink`. A template whose name is set a shade
    # off the body text says so here rather than dragging every body word with
    # it — `ink` is read by nine other things on the page.
    name_color: str = ""
    # The target-title line under the name. `headline_size` of 0.0 keeps the
    # derived size both renderers already use (body + 1.2 on a band, + 0.8
    # otherwise); `headline_color` of "" keeps `accent` (or `band_sub` on a
    # band).
    headline_bold: bool = False
    headline_color: str = ""
    headline_size: float = 0.0
    # Letter-spacing on the headline, pt (halved in RTL, as every tracked run
    # here is). 0.3 is what both renderers hard-coded before this was a field,
    # so the eleven templates that say nothing are unchanged; `standard` sets 0
    # because its source document tracks nothing at all, and 0.3pt over an
    # 81-character headline is 24pt of width the original does not spend.
    headline_tracking: float = 0.3

    # Vertical rhythm, in points: (section-before, section-after, entry-before,
    # bullet-after, heading-to-its-rule, header-after). () = the constants both
    # renderers' `_Sheet` already applies, so a template that says nothing is
    # untouched; a SHORTER tuple states only its leading elements and defaults
    # the rest. One field rather than six because these are one decision — the
    # page's density — and a template that states one of them and not the others
    # is describing a rhythm nobody chose.
    #
    # Only the first four are scaled by the one-page `squeeze`. The last two are
    # not, because neither was before they became tunable and a squeeze that
    # started nudging the heading rule would be a silent change to eleven
    # templates that never asked for one.
    rhythm: tuple[float, ...] = ()
    # `accent_name`, `header_rule` and `heading_rule` used to live here. All
    # three were BOOLEANS standing beside a live enum (`header` / `heading`) that
    # already said the same thing, and that is exactly how the two renderers
    # drifted: nothing set `accent_name`, yet both renderers carried a branch for
    # it, and the hairlines keyed off the bools while the docstring below
    # described the enum. A dead flag next to a live one is not harmless — it is
    # the thing the next reader believes. Add a VALUE to the enum instead.
    margin_tb_pt: float = 46.0
    margin_lr_pt: float = 54.0
    page_w_pt: float = A4_W
    page_h_pt: float = A4_H
    tight: bool = False  # compact vertical rhythm (the Israeli one-pager convention)

    # --- presentation (PLAN 21) -------------------------------------------
    # Everything below is DECLARATIVE and defaults to the pre-21 look, so the
    # original five templates keep rendering exactly as they did until they opt
    # in. Each option is reproducible in BOTH renderers — the DOCX twin of a
    # filled band is paragraph shading (w:shd), of an accent bar a left
    # paragraph border (w:pBdr), and of a chip a shaded run — so no option here
    # can make the two downloads disagree, and none of them needs a table.
    #
    # "header": how the name/headline/contact block is presented. THIS FIELD IS
    # AUTHORITATIVE IN BOTH RENDERERS — it is the only thing either of them asks
    # about the hairline.
    #   "rule"  — name, headline, contact, hairline under (the original)
    #   "plain" — same, no hairline
    #   "band"  — reversed out of a filled rectangle that bleeds to the page
    #             edges. The single biggest visual upgrade available, and the
    #             one thing that stops the page reading as typed rather than
    #             designed.
    #
    # Until this was fixed both renderers read `header` only as `== "band"` and
    # keyed the hairline off a separate `header_rule: bool = True` that no
    # template ever set False — so `ivy` and `minimal`, whose specs say "plain",
    # drew one anyway (measured: ivy 0.8pt C9CED6, minimal 0.8pt E4E7EB) in BOTH
    # downloads. The picker thumbnails already drew none for either, so the
    # declaration, the docstring and the UI all agreed and only the renderers
    # disagreed. Moving the renderers to the declaration is what makes the field
    # mean something; rewriting this comment so "plain" was a synonym for "rule"
    # would have documented the bug and left the thumbnails wrong.
    header: str = "rule"
    band_bg: str = ""  # band fill; "" = use `accent`
    band_ink: str = "FFFFFF"  # the name, on the band
    band_sub: str = "D6E2EE"  # the headline, on the band
    band_meta: str = "A9BED2"  # the contact line, on the band

    # "heading": section-heading treatment. Each is a genuinely different
    #   SHAPE, not a different colour — five templates that differ only in hue
    #   is what made the old set feel undesigned.
    #   "rule"     — tracked caps over a full-width hairline (the original)
    #   "short"    — tracked caps over a SHORT thick accent underline
    #   "bar"      — a solid accent bar at the text start
    #   "plain"    — tracked caps, nothing else
    #   "hung"     — the heading sits out in the start margin, beside the body
    #   "centered" — centred, over a hairline (the academic convention)
    heading: str = "rule"
    heading_bar_w: float = 3.0
    heading_bump: float = 0.0  # added to heading_size
    heading_rule_pt: float = 0.6  # thickness of the heading rule
    heading_rule_color: str = ""  # "" = the `rule` hairline colour
    heading_short_pt: float = 32.0  # width of the "short" underline
    heading_hang_pt: float = 44.0  # how far "hung" headings sit out
    heading_case: str = "upper"  # "upper" | "title" (a no-op in Hebrew either way)

    # Which set of section names this template prints — see `render/labels.py`.
    # "short" is the standard one every template used before `standard` existed
    # ("Summary", "Skills", "Experience"); "full" is the longer business wording
    # ("Professional Summary", "Core Expertise"). It is a per-template field
    # because the wording is part of the design, and it lives in `labels.py`
    # rather than here so the two renderers and the on-screen document cannot
    # each carry their own copy.
    label_set: str = "short"

    # The inline separator between the parts of the contact line, an entry's
    # meta run and the languages line. "" = each site's own default, which is
    # not one string: the contact and languages lines use " · " and a stacked
    # entry's meta run uses a wider "  ·  ". A single value here overrides all
    # three, so a template that wants "  |  " everywhere says it once and the
    # ten templates that say nothing are untouched.
    meta_sep: str = ""
    # The separator's colour; "" = the mix of `muted` and `rule` both renderers
    # compute, which reads as punctuation rather than content. A template whose
    # separators are part of the text run (`standard` prints them inside the same
    # black sentence) names the text colour here instead.
    sep_color: str = ""

    # Header hairline weight/colour, once a template opts out of `header="rule"`.
    header_rule_pt: float = 0.8
    header_rule_accent: bool = False

    bullet_glyph: str = "•"
    bullet_scale: float = 1.0  # glyph size relative to body; <1 lightens the page

    # --- vector icons (PDF only — see the note below) ---------------------
    # A small drawn envelope / handset / map pin / link / globe before each
    # contact bit, and optionally a calendar before an entry's dates. They are
    # VECTOR PATHS on the canvas, never glyphs: no bundled face has these
    # characters, and a missing glyph would print a tofu box AND land in the
    # extracted text — on the exact line an ATS parses as the email address. A
    # drawn path emits no text at all, which is what makes this safe.
    #
    # THIS IS THE ONE PRESENTATION OPTION THAT DOES NOT REPRODUCE IN BOTH
    # RENDERERS. `w:drawing`, `w:pict` and `graphicData` are forbidden in the
    # DOCX (an ATS parser must not have to un-pick a drawing object) and a
    # unicode dingbat prints tofu in Calibri and pollutes the extracted contact
    # line. So the DOCX renders the SAME DOCUMENT WITHOUT ICONS — same sections,
    # same words, same order. That is safe precisely because an icon is
    # ornament: it carries no text, and its absence changes nothing the document
    # SAYS. A layout option that differed between the two would change what the
    # document says, and none of the options above is allowed to.
    #
    # A design axis, not a default: `minimal`, `ivy` and `executive` stay
    # austere on purpose.
    contact_icons: bool = False
    date_icon: bool = False  # a small calendar on the entry meta line

    # A full-bleed paper tint, e.g. the warm cream `executive` prints on.
    #
    # THE SECOND ORNAMENT CARVE-OUT (see `contact_icons` above): the PDF paints
    # it and the DOCX renders the same document on white. It passes the same test
    # the icons pass — a page tint carries no text, and its absence changes
    # nothing the document SAYS — and the alternative is worse than the omission
    # rather than merely harder. Word's only twin is `w:background` +
    # `w:displayBackgroundShape`, which Word shows on SCREEN but does not print
    # and does not carry into its own PDF export unless the reader turns the
    # option on. So implementing it would make the Word file disagree with its
    # own print-out — a divergence between one document and itself, which is a
    # new class of problem and strictly worse than the honest white page.
    page_bg: str = ""

    # --- two-column (PDF only) -------------------------------------------
    # A sidebar renders ONLY in the PDF. Text extraction y-sorts across the full
    # page width, so a two-column PDF hands a parser lines like
    # "Python Go PostgreSQL Senior Backend Engineer" — individual bullets stay
    # intact but employer/title attribution is polluted. Measured, not assumed.
    # The DOCX therefore falls back to `docx_fallback`, and the UI says so.
    layout: str = "single"  # "single" | "sidebar"
    sidebar_ratio: float = 0.32  # sidebar share of the text column
    sidebar_gutter: float = 20.0
    sidebar_panel: bool = False  # fill the sidebar with `accent_soft`
    sidebar_keys: tuple[str, ...] = ("skills", "education", "certifications", "languages")
    docx_fallback: str = ""  # id the DOCX renders instead; "" = render as-is

    # A vertical hairline down the entries, with a dot per role in the PDF.
    #
    # The LINE reproduces in both renderers — it is a left `w:pBdr` tiled down
    # the paragraphs of one entry, the same mechanism the accent bar beside a
    # heading already uses, so no table and nothing an ATS has to un-pick.
    #
    # THE DOT IS THE THIRD ORNAMENT CARVE-OUT (see `contact_icons` and
    # `page_bg`). Word has no way to put a filled circle on a paragraph border:
    # every candidate — `w:drawing`, `w:pict`, a VML shape — is one of the
    # drawing objects the ATS rules forbid, and a unicode dingbat would print at
    # whatever the reader's font substitutes AND land in the extracted text at
    # the head of the job title. It passes the carve-out's own test: the dot
    # carries no text, and its absence changes nothing the document says — the
    # rail still reads as one continuous line down the roles.
    rail: bool = False

    @property
    def pdf_only(self) -> bool:
        return self.layout != "single"

    # "skills": how the skills section is set.
    #   "inline"  — comma-joined run of text (the original; it is also exactly
    #               what keyword parsers split on). A group's label sits on its
    #               OWN line above its items.
    #   "chips"   — bordered chips in a wrapping row. A visible separator is
    #               still drawn between them so the extracted text keeps a real
    #               delimiter and multi-word skills cannot run together.
    #   "labeled" — one wrapping paragraph per group, the label BOLD and INLINE
    #               ahead of its own comma-joined items ("GenAI & LLMs: OpenAI,
    #               Anthropic Claude, …"). Same text and the same commas as
    #               "inline" — only the label's position differs — so a keyword
    #               parser splits it identically. An ungrouped resume renders
    #               exactly what "inline" renders, there being no label to place.
    skills: str = "inline"

    # "entry": the title / employer / location / dates hierarchy of one role.
    #   "split" — title at the start, dates flush to the far margin (original).
    #             Leaves a wide empty gutter whenever the title is short.
    #   "stack" — title on its own line, then one meta line reading
    #             "Employer · Location · Dates". No gutter, tighter, and it is
    #             what every modern builder does.
    #   "run"   — ONE wrapping line: "Title | Employer" bold, then
    #             "Location | Dates" in italic, immediately after it. The dates
    #             are not flush right and not on a second line, so a short title
    #             costs no vertical space at all and the whole entry head is one
    #             sentence. It is also the one entry style that can absorb a
    #             `detail` inline (education's course list), rather than making
    #             a bullet of a sentence that is not a bullet.
    entry: str = "split"

    # A project's description paragraph. `desc_size` of 0.0 = `body_size`;
    # `desc_indent_pt` of 0.0 = flush with the column. `standard` sets both,
    # which is what makes its Projects section read as a tighter block under
    # each name instead of a second run of body copy.
    desc_size: float = 0.0
    desc_indent_pt: float = 0.0

    # --- the page footer (PDF ONLY, and NOT an ornament carve-out) ---------
    # The candidate's name, centred at the foot of every page: what a two-page
    # CV needs so page 2 can be identified if the pages are separated.
    #
    # IT IS NOT ONE OF THE THREE ORNAMENT CARVE-OUTS ABOVE, and it must not be
    # read as a fourth. Those pass a test this one fails: an icon, a page tint
    # and a rail dot carry NO TEXT, so their absence changes nothing the
    # document SAYS. A footer is a word. So the PDF and the DOCX genuinely
    # disagree here — the PDF prints the name at the foot of each page and the
    # Word file does not — and that divergence is a DELIBERATE, USER-MADE
    # CHOICE (2026-09-06), not a carve-out this file is entitled to grant.
    #
    # The alternative was worse: Word can only repeat a line per page through a
    # real `w:ftr`, which is one of the headers/footers the ATS rules forbid and
    # which `tests/smoke_test.py` pins ("still no table, text box, image, header
    # or footer"). Weakening that pin — the check the product's whole ATS claim
    # rests on — to reproduce a duplicate of the name already at the top of page
    # 1 is not a trade this file may make on its own.
    footer_name: bool = False
    footer_size: float = 7.5
    footer_color: str = "787878"

    # Certifications / languages in N columns. Those sections are a handful of
    # short items and at 1 column they waste the whole right half of the page.
    # Capped at 2: wider grids interleave badly on text extraction.
    list_cols: int = 1

    bullet_accent: bool = False  # draw the bullet glyph in the accent colour

    @property
    def band_fill(self) -> str:
        return self.band_bg or self.accent

    @property
    def head_rule_fill(self) -> str:
        return self.heading_rule_color or (self.accent if self.heading == "short" else self.rule)


# Twelve templates, and every one of them differs from the others in SHAPE —
# header treatment, heading treatment, entry grammar, column count — not just in
# hue. The previous set of five was one document in five colours, which is
# precisely why the downloads read as undesigned.
#
# The five original ids are kept and upgraded IN PLACE so that stored tracker
# rows, saved kits and any client that already sends `template=executive` keep
# working and simply start rendering better.
TEMPLATES: dict[str, TemplateSpec] = {

    # ------------------------------------------------------------- standard --
    # THE DEFAULT (2026-09-06). A reproduction, measured element by element, of
    # the document the owner actually applies with — centred name over a centred
    # headline and a centred contact line, no header rule, all-caps headings on
    # a 0.75pt grey hairline, and one dense monochrome column on US Letter.
    #
    # It is the only template in the set that is a COPY of a real document
    # rather than a design of ours, so every number below came off that file
    # rather than out of a palette: 19/10.5/8.5 in the header, 10pt headings on
    # #A8A8A8, 9pt body on a 10.5pt line, 8.5pt skills and project prose, a
    # 7.5pt #787878 footer, 40.3pt side margins on a 612×792 page. The greys are
    # its greys too — #191919 for the name, #414141 for the headline, #232323
    # for the headings, black for everything else.
    #
    # Three of its properties are load-bearing and easy to undo by tidying:
    #   * `entry="run"` and `skills="labeled"` exist FOR this template. Both put
    #     a second run inline on a line the other ten give its own — that run-on
    #     grammar is most of why the page is this dense.
    #   * `meta_sep="  |  "` and `sep_color="000000"` are what make those runs
    #     read as one sentence rather than a metadata line. The pipe is inside
    #     the same black text run in the source; a grey "·" is a different
    #     document.
    #   * `label_set="full"` prints "PROFESSIONAL SUMMARY" / "CORE EXPERTISE" /
    #     "PROFESSIONAL EXPERIENCE" / "SELECTED PROJECTS". Chosen explicitly by
    #     the owner over the standard short names, which every other template
    #     still prints — see `render/labels.py` for the ATS note that goes with
    #     that choice.
    "standard": TemplateSpec(
        id="standard", accent="232323", ink="000000", muted="000000",
        rule="A8A8A8", accent_soft="F0F0F0",
        # Base-14 Helvetica: Arial/Liberation Sans metrics, no file — see the
        # note on `pdf_family`. Word is asked for Arial directly, and for Arial
        # on the Hebrew side too, because it is one of the few families that has
        # both Latin and Hebrew glyphs.
        pdf_family="Helvetica", docx_font="Arial", docx_font_he="Arial",
        body_size=9.0, heading_size=10.0, name_size=19.0, meta_size=8.5,
        leading_ratio=1.167,
        name_centered=True, name_tracking=0.0, heading_tracking=0.0,
        name_color="191919",
        headline_bold=True, headline_color="414141", headline_size=10.5,
        headline_tracking=0.0,
        rhythm=(6.3, 5.9, 4.3, 1.7, 0.0, 0.0),
        header="plain",
        heading="rule", heading_rule_pt=0.75, heading_rule_color="A8A8A8",
        label_set="full", meta_sep="  |  ", sep_color="000000",
        contact_order=("location", "phone", "email", "linkedin", "website"),
        entry="run", skills="labeled", list_cols=1,
        bullet_glyph="•", bullet_scale=1.0,
        desc_size=8.5, desc_indent_pt=8.65,
        footer_name=True, footer_size=7.5, footer_color="787878",
        page_w_pt=LETTER_W, page_h_pt=LETTER_H,
        margin_tb_pt=36.0, margin_lr_pt=40.3,
    ),

    # -------------------------------------------------------------- classic --
    # Tinted header card, full-width heading rules. The safe default: nothing
    # here is unusual to an Israeli recruiter or to a parser.
    "classic": TemplateSpec(
        id="classic", accent="1F3A5F", ink="111827", muted="5C6470",
        rule="DFE3E9", accent_soft="E9EEF4",
        pdf_family="Lato", docx_font="Calibri", docx_font_he="Arial",
        body_size=10.4, heading_size=11.0, name_size=27.0, meta_size=8.8,
        name_centered=False, name_tracking=-0.3, heading_tracking=0.8,
        header="band", band_bg="EDF1F6", band_ink="14243A", band_sub="1F3A5F",
        band_meta="4A5A72",
        heading="rule", heading_rule_pt=0.5,
        # Chips, not a comma run: the on-screen preview has always drawn skills
        # as chips, so the default template downloading a comma sentence made the
        # file strictly worse than what the app showed. Chips still emit a comma
        # between them in the extracted text, so keyword parsers split the same.
        entry="stack", skills="chips", list_cols=2,
        bullet_scale=0.62, bullet_accent=True,
        contact_icons=True, date_icon=True,
        margin_tb_pt=46, margin_lr_pt=58,
    ),

    # --------------------------------------------------------------- modern --
    # Full-bleed dark colour band + a short thick accent underline per heading.
    # The loudest of the safe templates.
    "modern": TemplateSpec(
        id="modern", accent="0E7A5F", ink="14181F", muted="59616E",
        rule="D9E2DE", accent_soft="E4F1EC",
        pdf_family="Lato", docx_font="Calibri", docx_font_he="Arial",
        body_size=10.4, heading_size=11.0, name_size=28.0, meta_size=8.8,
        name_centered=False, name_tracking=-0.4, heading_tracking=0.8,
        header="band", band_bg="0B5344", band_ink="FFFFFF", band_sub="BFDDD2",
        band_meta="9CC6B9",
        heading="short", heading_rule_pt=1.4, heading_rule_color="0E7A5F",
        heading_short_pt=32.0,
        entry="stack", skills="chips", list_cols=2,
        bullet_scale=0.62, bullet_accent=True,
        contact_icons=True, date_icon=True,
        margin_tb_pt=46, margin_lr_pt=58,
    ),

    # ---------------------------------------------------------------- split --
    # PDF ONLY. Career story in a wide column, credentials in a rail beside it.
    # The DOCX renders `classic` instead — see TemplateSpec.layout for the
    # measured reason a two-column PDF cannot be the Word file too.
    "split": TemplateSpec(
        id="split", accent="15476B", ink="111827", muted="59616E",
        rule="DCE2E8", accent_soft="E7EEF4",
        pdf_family="Lato", docx_font="Calibri", docx_font_he="Arial",
        body_size=10.1, heading_size=10.8, name_size=27.0, meta_size=8.6,
        name_centered=False, name_tracking=-0.3, heading_tracking=0.7,
        header="band", band_bg="EBF0F5", band_ink="10283D", band_sub="15476B",
        band_meta="4C5F73",
        heading="short", heading_rule_pt=1.3, heading_rule_color="15476B",
        heading_short_pt=26.0,
        entry="stack", skills="chips", list_cols=1,
        bullet_scale=0.60, bullet_accent=True,
        contact_icons=True,
        layout="sidebar", sidebar_ratio=0.31, sidebar_gutter=20.0,
        docx_fallback="classic",
        margin_tb_pt=44, margin_lr_pt=48,
    ),

    # ---------------------------------------------------------------- panel --
    # PDF ONLY. Same split, but the rail is a filled colour panel.
    "panel": TemplateSpec(
        id="panel", accent="15476B", ink="111827", muted="59616E",
        rule="C3D4E1", accent_soft="DCE8F1",
        pdf_family="Lato", docx_font="Calibri", docx_font_he="Arial",
        body_size=10.1, heading_size=10.6, name_size=27.0, meta_size=8.6,
        name_centered=False, name_tracking=-0.3, heading_tracking=0.7,
        header="band", band_bg="123C5C", band_ink="FFFFFF", band_sub="BBD3E4",
        band_meta="94B2C9",
        heading="bar", heading_bump=0.6, heading_bar_w=2.6,
        entry="stack", skills="chips", list_cols=1,
        bullet_scale=0.60, bullet_accent=True,
        contact_icons=True,
        layout="sidebar", sidebar_ratio=0.30, sidebar_gutter=22.0,
        sidebar_panel=True, docx_fallback="modern",
        margin_tb_pt=44, margin_lr_pt=48,
    ),

    # ------------------------------------------------------------- timeline --
    # A vertical rail with a dot per role: the progression reads before the
    # words do. No heading rules — the rail is the only line on the page.
    "timeline": TemplateSpec(
        id="timeline", accent="2A5D7C", ink="121821", muted="5A626E",
        rule="D9E0E6", accent_soft="E8EFF4",
        pdf_family="Lato", docx_font="Calibri", docx_font_he="Arial",
        body_size=10.3, heading_size=11.0, name_size=27.0, meta_size=8.6,
        name_centered=False, name_tracking=-0.3, heading_tracking=0.9,
        header="rule", header_rule_pt=1.6, header_rule_accent=True,
        heading="plain",
        entry="stack", rail=True, skills="inline", list_cols=2,
        bullet_scale=0.60, bullet_accent=True,
        margin_tb_pt=46, margin_lr_pt=56,
    ),

    # ------------------------------------------------------------ executive --
    # Serif, cream paper, centred name, no heading rules. Reads formal.
    "executive": TemplateSpec(
        id="executive", accent="16304B", ink="1B1B18", muted="5A5F6A",
        rule="D8D0C2", accent_soft="EFE9DE",
        pdf_family="Spectral", docx_font="Georgia", docx_font_he="David",
        body_size=10.4, heading_size=11.4, name_size=29.0, meta_size=8.8,
        name_centered=True, name_tracking=-0.2, heading_tracking=0.4,
        header="rule", header_rule_pt=1.5,
        heading="plain", heading_case="title",
        entry="split", skills="inline", list_cols=2,
        bullet_glyph="—", bullet_scale=0.58,
        page_bg="FDFBF4",
        margin_tb_pt=54, margin_lr_pt=70,
    ),

    # ------------------------------------------------------------------ ivy --
    # Centred serif name, centred title-case headings over a hairline. The
    # layout hiring committees in law, consulting and academia already know.
    "ivy": TemplateSpec(
        id="ivy", accent="1B2430", ink="121820", muted="6A717B",
        rule="C9CED6", accent_soft="ECEEF1",
        pdf_family="Spectral", docx_font="Georgia", docx_font_he="David",
        body_size=10.3, heading_size=11.6, name_size=26.0, meta_size=8.8,
        name_centered=True, name_tracking=-0.2, heading_tracking=0.3,
        header="plain",
        heading="centered", heading_case="title", heading_rule_pt=0.6,
        entry="split", skills="inline", list_cols=2,
        bullet_scale=0.58,
        margin_tb_pt=50, margin_lr_pt=64,
    ),

    # --------------------------------------------------------------- ledger --
    # Heavy black rules, rust accent, dense. Assertive.
    "ledger": TemplateSpec(
        id="ledger", accent="B4451F", ink="151515", muted="6A6A6A",
        rule="D8D8D8", accent_soft="F6E9E2",
        pdf_family="Lato", docx_font="Calibri", docx_font_he="Arial",
        body_size=10.0, heading_size=11.2, name_size=26.0, meta_size=8.6,
        name_centered=False, name_tracking=-0.2, heading_tracking=0.6,
        header="rule", header_rule_pt=2.0, header_rule_accent=True,
        heading="rule", heading_rule_pt=2.0, heading_rule_color="1A1A1A",
        entry="stack", skills="chips", list_cols=2,
        bullet_scale=0.55, bullet_accent=True,
        margin_tb_pt=42, margin_lr_pt=50,
    ),

    # -------------------------------------------------------------- student --
    # Soft green header card. Built for a first or second job, where army
    # service and projects carry the weight — so education stays in the main
    # column (see the early-career guard in pdf_renderer._flow).
    "student": TemplateSpec(
        id="student", accent="2E6B4F", ink="121A16", muted="5B6560",
        rule="D9E4DD", accent_soft="E8F1EC",
        pdf_family="Lato", docx_font="Calibri", docx_font_he="Arial",
        body_size=10.6, heading_size=11.2, name_size=27.0, meta_size=8.8,
        name_centered=False, name_tracking=-0.3, heading_tracking=0.8,
        header="band", band_bg="E8F1EC", band_ink="14301F", band_sub="2E6B4F",
        band_meta="47604F",
        heading="short", heading_rule_pt=1.4, heading_rule_color="2E6B4F",
        heading_short_pt=30.0,
        entry="stack", skills="chips", list_cols=2,
        bullet_scale=0.62, bullet_accent=True,
        contact_icons=True, date_icon=True,
        margin_tb_pt=50, margin_lr_pt=62,
    ),

    # -------------------------------------------------------------- compact --
    # The Israeli one-pager convention: dense rhythm, a 2pt accent bar beside
    # each heading, type never shrunk past readable.
    "compact": TemplateSpec(
        id="compact", accent="27405C", ink="141922", muted="5A626E",
        rule="DCE0E6", accent_soft="E7ECF2",
        pdf_family="Lato", docx_font="Calibri", docx_font_he="Arial",
        body_size=9.9, heading_size=10.4, name_size=22.0, meta_size=8.4,
        name_centered=False, name_tracking=-0.2, heading_tracking=0.6,
        header="rule", header_rule_pt=1.6, header_rule_accent=True,
        heading="bar", heading_bar_w=2.4,
        entry="stack", skills="inline", list_cols=2,
        bullet_scale=0.58, bullet_accent=True,
        tight=True, margin_tb_pt=34, margin_lr_pt=46,
    ),

    # -------------------------------------------------------------- minimal --
    # No colour at all. Headings hang out in the start margin; bullets are
    # en dashes. Nothing between the reader and what you did.
    "minimal": TemplateSpec(
        id="minimal", accent="374151", ink="111827", muted="6B7280",
        rule="E4E7EB", accent_soft="EDEFF2",
        pdf_family="Lato", docx_font="Calibri", docx_font_he="Arial",
        body_size=10.6, heading_size=10.6, name_size=30.0, meta_size=8.8,
        name_centered=False, name_tracking=-0.5, heading_tracking=1.0,
        header="plain",
        heading="hung", heading_hang_pt=58.0,
        entry="stack", skills="inline", list_cols=2,
        bullet_glyph="–", bullet_scale=0.80,
        # The wide side margin is not decoration: it is the gutter the hung
        # headings live in. Narrow it and they collide with the body.
        margin_tb_pt=54, margin_lr_pt=84,
    ),
}


# `standard` since 2026-09-06, at the owner's request: it reproduces the
# document they actually apply with, and it is what every tailor, preview,
# download and page-count measurement uses unless the picker says otherwise. The
# other eleven are unchanged and still selectable — an id already stored on a
# tracker row or a saved kit keeps resolving to the template it was rendered in.
DEFAULT_TEMPLATE = "standard"


def get_template(name: str | None) -> TemplateSpec:
    return TEMPLATES.get((name or "").strip().lower(), TEMPLATES[DEFAULT_TEMPLATE])
