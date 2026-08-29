"""Résumé template registry shared by both renderers (PLAN 6).

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
images / headers / footers, standard section names. The DOCX twin of a filled
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

Unknown/empty template names fall back to the default, so old clients that
never send `template` keep working.

Page size is A4 (the standard everywhere except the US/Canada, and this
product is Israel-first). It is a per-template field, so a US-letter template
is a one-line addition.
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
    pdf_family: str = "Lato"  # bundled family the PDF embeds (Latin)
    # The Hebrew face. `pdf_family` is NOT used in RTL — a Latin-only file has
    # no Hebrew glyphs — so the Hebrew half of a template is chosen here. It is
    # a separate axis on purpose: pairing a Latin serif with a Hebrew sans is a
    # normal, correct choice when no matching Hebrew serif is bundled.
    he_family: str = "NotoSansHebrew"
    docx_font: str = "Calibri"  # family name Word resolves locally (Latin)
    # The COMPLEX-SCRIPT face Word is asked for on a Hebrew résumé. Word formats
    # Hebrew through w:cs and ignores the plain font, so pinning a Latin-only
    # family here (Georgia, say) makes Word silently substitute something else
    # and the DOCX stops matching the PDF. Must be a family that actually has
    # Hebrew glyphs: Arial, David (serif), Narkisim, Gisha.
    docx_font_he: str = "Arial"
    body_size: float = 10.2
    heading_size: float = 9.5
    name_size: float = 22.0
    meta_size: float = 9.0

    # --- layout -----------------------------------------------------------
    name_centered: bool = True  # False = name sits at the text start (right in RTL)
    name_tracking: float = 1.0  # extra letter-spacing, pt
    heading_tracking: float = 1.0
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
    #   "inline" — comma-joined run of text (the original; it is also exactly
    #              what keyword parsers split on)
    #   "chips"  — bordered chips in a wrapping row. A visible separator is
    #              still drawn between them so the extracted text keeps a real
    #              delimiter and multi-word skills cannot run together.
    skills: str = "inline"

    # "entry": the title / employer / location / dates hierarchy of one role.
    #   "split" — title at the start, dates flush to the far margin (original).
    #             Leaves a wide empty gutter whenever the title is short.
    #   "stack" — title on its own line, then one meta line reading
    #             "Employer · Location · Dates". No gutter, tighter, and it is
    #             what every modern builder does.
    entry: str = "split"

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


# Eleven templates, and every one of them differs from the others in SHAPE —
# header treatment, heading treatment, entry grammar, column count — not just in
# hue. The previous set of five was one document in five colours, which is
# precisely why the downloads read as undesigned.
#
# The five original ids are kept and upgraded IN PLACE so that stored tracker
# rows, saved kits and any client that already sends `template=executive` keep
# working and simply start rendering better.
TEMPLATES: dict[str, TemplateSpec] = {

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


DEFAULT_TEMPLATE = "classic"


def get_template(name: str | None) -> TemplateSpec:
    return TEMPLATES.get((name or "").strip().lower(), TEMPLATES[DEFAULT_TEMPLATE])
