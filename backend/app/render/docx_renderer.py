"""Render a ResumeModel to an ATS-safe DOCX that matches the PDF design.

Same layout system as `pdf_renderer`: a tracked name over a hairline, tracked
uppercase section headings each with a hairline under them, role titles with
the dates flush to the far margin (a right tab stop, not a table), employers
in the accent colour, and muted meta.

ATS rules honored: single column, standard headings, no tables / text-boxes /
images, no headers/footers, standard fonts, real bulleted lists, contact info
in the body. Every effect here is paragraph or run formatting — a hairline is
a paragraph border and a flush-right date is a tab stop, so nothing an ATS
parser has to un-pick.

Hebrew resumes (detected via resume_language) get RTL paragraph direction
(w:bidi) + RTL runs (w:rtl) and Hebrew section headings; English resumes never
get an RTL property written.

ONE thing here is deliberately not a twin of the PDF: a `contact_icons`
template draws small vector marks on its contact row, and this file draws none.
There is no safe way to: `w:drawing` / `w:pict` / `graphicData` are exactly the
drawing objects the ATS rules forbid, and a unicode dingbat prints tofu in
Calibri *and* lands in the extracted contact line, right beside the email
address. So the Word file is the SAME DOCUMENT — same sections, same words,
same order — without the ornament. That is the only kind of difference allowed:
an icon carries no text, so its absence changes nothing the document says,
whereas a layout option that differed would.
"""
from __future__ import annotations

import io

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.shared import Pt, RGBColor

from app.core.lang import resume_language
from app.core.section_order import section_order
from app.core.skills import skill_blocks
from app.models import ResumeModel
from app.render.labels import labels_for
from app.render.pdf_renderer import fit_squeeze
from app.render.templates import DEFAULT_TEMPLATE, TemplateSpec, get_template

# Schema order for the children of <w:pPr> / <w:rPr>. Word tolerates
# out-of-order children; stricter XML readers (and some ATS) do not.
_PPR_ORDER = [qn(t) for t in (
    "w:pStyle", "w:keepNext", "w:keepLines", "w:pageBreakBefore", "w:framePr", "w:widowControl",
    "w:numPr", "w:suppressLineNumbers", "w:pBdr", "w:shd", "w:tabs", "w:suppressAutoHyphens",
    "w:kinsoku", "w:wordWrap", "w:overflowPunct", "w:topLinePunct", "w:autoSpaceDE",
    "w:autoSpaceDN", "w:bidi", "w:adjustRightInd", "w:snapToGrid", "w:spacing", "w:ind",
    "w:contextualSpacing", "w:mirrorIndents", "w:suppressOverlap", "w:jc", "w:textDirection",
    "w:textAlignment", "w:textboxTightWrap", "w:outlineLvl", "w:divId", "w:cnfStyle", "w:rPr",
    "w:sectPr", "w:pPrChange",
)]
_RPR_ORDER = [qn(t) for t in (
    "w:rStyle", "w:rFonts", "w:b", "w:bCs", "w:i", "w:iCs", "w:caps", "w:smallCaps", "w:strike",
    "w:dstrike", "w:outline", "w:shadow", "w:emboss", "w:imprint", "w:noProof", "w:snapToGrid",
    "w:vanish", "w:webHidden", "w:color", "w:spacing", "w:w", "w:kern", "w:position", "w:sz",
    "w:szCs", "w:highlight", "w:u", "w:effect", "w:bdr", "w:shd", "w:fitText", "w:vertAlign",
    "w:rtl", "w:cs", "w:em", "w:lang", "w:eastAsianLayout", "w:specVanish", "w:oMath",
)]

_SEP = " · "


def _xml_attr(value: str) -> str:
    """Escape a spec string that is about to be interpolated into an XML
    attribute. Template ids and font names are ours, but `bullet_glyph` is a
    single character a future template picks, and a '&' or a '<' in one would
    produce a document Word refuses to open rather than an ugly bullet."""
    return (value.replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _insert_ordered(parent, element, order: list[str]) -> None:
    """Insert `element` at its schema position among `parent`'s children."""
    if element.tag not in order:
        parent.append(element)
        return
    rank = order.index(element.tag)
    for child in parent:
        if child.tag in order and order.index(child.tag) > rank:
            child.addprevious(element)
            return
    parent.append(element)


def _tracking(run, points: float) -> None:
    """Letter-spacing, in twentieths of a point (w:spacing inside w:rPr)."""
    if not points:
        return
    r_pr = run._r.get_or_add_rPr()
    if r_pr.find(qn("w:spacing")) is not None:
        return
    el = OxmlElement("w:spacing")
    el.set(qn("w:val"), str(int(round(points * 20))))
    _insert_ordered(r_pr, el, _RPR_ORDER)


def _p_border(paragraph, edge: str, color: str, *, sz: int = 4, space_pt: int = 3) -> None:
    """One edge of a paragraph border. Every rule in this document is a
    paragraph border — never a table, never a drawn shape — so an ATS parser has
    nothing to un-pick. `sz` is in eighths of a point (4 = a 0.5pt hairline,
    18 = the ~2.25pt accent bar beside a section heading)."""
    p_pr = paragraph._p.get_or_add_pPr()
    border = p_pr.find(qn("w:pBdr"))
    if border is None:
        border = OxmlElement("w:pBdr")
        _insert_ordered(p_pr, border, _PPR_ORDER)
    if border.find(qn(f"w:{edge}")) is not None:
        return
    el = OxmlElement(f"w:{edge}")
    el.set(qn("w:val"), "single")
    el.set(qn("w:sz"), str(sz))
    el.set(qn("w:space"), str(space_pt))
    el.set(qn("w:color"), color)
    # <w:pBdr> children are schema-ordered: top, left, bottom, right.
    order = ["w:top", "w:left", "w:bottom", "w:right"]
    _insert_ordered(border, el, [qn(t) for t in order])


def _hairline(paragraph, color: str, space_pt: int = 3, sz: int = 4) -> None:
    """A hairline under one paragraph.

    `sz` is in eighths of a point and defaults to a 0.5pt hairline, so a caller
    that does not care keeps the old weight. It exists because every rule in the
    templates declares its own thickness (`header_rule_pt`, `heading_rule_pt`)
    and this file used to hard-code 0.5pt for all of them: `ledger`'s defining
    2.0pt near-black heading rule printed as a 0.5pt grey one, and the accent
    underline `modern` / `split` / `student` declare printed as a full-width
    grey hairline. Nine of the eleven templates disagreed with their own PDF.
    """
    _p_border(paragraph, "bottom", color, sz=sz, space_pt=space_pt)


def _shade(paragraph, fill: str) -> None:
    """Solid paragraph background — the DOCX twin of the PDF's filled header
    band. Paragraph shading, so still no table and no drawing object."""
    p_pr = paragraph._p.get_or_add_pPr()
    if p_pr.find(qn("w:shd")) is not None:
        return
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    _insert_ordered(p_pr, shd, _PPR_ORDER)


def _bleed(paragraph, points: float) -> None:
    """Negative side indents so a shaded paragraph runs past the text margins
    and reads as a full-width band rather than a highlighted line."""
    p_pr = paragraph._p.get_or_add_pPr()
    if p_pr.find(qn("w:ind")) is not None:
        return
    ind = OxmlElement("w:ind")
    twips = str(int(round(-points * 20)))
    ind.set(qn("w:left"), twips)
    ind.set(qn("w:right"), twips)
    _insert_ordered(p_pr, ind, _PPR_ORDER)


def _chip(run, border_color: str) -> None:
    """A bordered run — the DOCX twin of a PDF skill chip. `w:bdr` draws a box
    around the run itself, so no table and no shape is involved."""
    r_pr = run._r.get_or_add_rPr()
    if r_pr.find(qn("w:bdr")) is not None:
        return
    el = OxmlElement("w:bdr")
    el.set(qn("w:val"), "single")
    el.set(qn("w:sz"), "4")
    el.set(qn("w:space"), "0")
    el.set(qn("w:color"), border_color)
    _insert_ordered(r_pr, el, _RPR_ORDER)


def _bullet_numbering(doc, spec: TemplateSpec) -> int:
    """Define THIS template's bullet as a real Word list level; return its numId.

    `doc.add_paragraph(item, style="List Bullet")` borrows python-docx's stock
    numId 1, whose level text is a Symbol-font private-use codepoint. That made
    `bullet_glyph`, `bullet_scale` and `bullet_accent` unreachable: `executive`
    declares an em dash and `minimal` an en dash, both drawn correctly in the
    PDF, and both printed as Word's generic dot. It also puts a PUA character
    into the extracted text where a literal '•' / '—' / '–' extracts as itself.

    A real `w:abstractNum` + `w:num` keeps it a REAL WORD LIST — the promise in
    this module's docstring — rather than faking bullets with literal runs,
    which is what an ATS would then have to strip off the front of every line.

    Two properties on the level's `w:rPr` are load-bearing and easy to miss:
    `w:szCs` must be written HERE, because `_set_rtl`'s sweep walks
    `doc.paragraphs` and a numbering level is not a paragraph — without it a
    Hebrew résumé's bullets render at Word's default size while every other run
    is mirrored. And `w:cs` must name `docx_font_he` for the same reason the
    Normal style does: Word resolves a complex-script run through `w:cs` and
    substitutes its own face when the family named there has no Hebrew.
    """
    numbering = doc.part.numbering_part.element
    abstract_id = max((int(el.get(qn("w:abstractNumId")))
                       for el in numbering.findall(qn("w:abstractNum"))), default=-1) + 1
    num_id = max((int(el.get(qn("w:numId")))
                  for el in numbering.findall(qn("w:num"))), default=0) + 1
    half_pt = int(round(spec.body_size * spec.bullet_scale * 2))
    color = spec.accent if spec.bullet_accent else spec.muted
    abstract = parse_xml(
        f'<w:abstractNum {nsdecls("w")} w:abstractNumId="{abstract_id}">'
        f'<w:multiLevelType w:val="hybridMultilevel"/>'
        f'<w:lvl w:ilvl="0">'
        f'<w:start w:val="1"/>'
        f'<w:numFmt w:val="bullet"/>'
        f'<w:lvlText w:val="{_xml_attr(spec.bullet_glyph)}"/>'
        f'<w:lvlJc w:val="left"/>'
        f'<w:rPr>'
        f'<w:rFonts w:ascii="{_xml_attr(spec.docx_font)}" w:hAnsi="{_xml_attr(spec.docx_font)}"'
        f' w:cs="{_xml_attr(spec.docx_font_he)}"/>'
        f'<w:color w:val="{color}"/>'
        f'<w:sz w:val="{half_pt}"/><w:szCs w:val="{half_pt}"/>'
        f'</w:rPr>'
        f'</w:lvl>'
        f'</w:abstractNum>'
    )
    num = parse_xml(f'<w:num {nsdecls("w")} w:numId="{num_id}">'
                    f'<w:abstractNumId w:val="{abstract_id}"/></w:num>')
    # <w:numbering> is schema-ordered: every w:abstractNum precedes every w:num.
    first_num = numbering.find(qn("w:num"))
    if first_num is None:
        numbering.append(abstract)
    else:
        first_num.addprevious(abstract)
    numbering.append(num)
    return num_id


def _num_pr(paragraph, num_id: int) -> None:
    """Point one paragraph at a numbering definition (level 0)."""
    p_pr = paragraph._p.get_or_add_pPr()
    if p_pr.find(qn("w:numPr")) is not None:
        return
    el = parse_xml(f'<w:numPr {nsdecls("w")}><w:ilvl w:val="0"/>'
                   f'<w:numId w:val="{num_id}"/></w:numPr>')
    _insert_ordered(p_pr, el, _PPR_ORDER)


def _mirror_cs(r_pr, src_tag: str, cs_tag: str) -> None:
    """Copy a run property onto its complex-script twin. Word formats Hebrew
    through w:bCs / w:szCs and ignores plain w:b / w:sz there, so without this
    every Hebrew heading and job title renders un-bolded at the wrong size."""
    src = r_pr.find(qn(src_tag))
    if src is None or r_pr.find(qn(cs_tag)) is not None:
        return
    el = OxmlElement(cs_tag)
    val = src.get(qn("w:val"))
    if val is not None:
        el.set(qn("w:val"), val)
    _insert_ordered(r_pr, el, _RPR_ORDER)


def _set_rtl(paragraph) -> None:
    """Mark one paragraph right-to-left: w:bidi on the paragraph (direction +
    right alignment, since 'start' = right in a bidi paragraph) and w:rtl on
    every run (tells Word the runs hold RTL text)."""
    p_pr = paragraph._p.get_or_add_pPr()
    if p_pr.find(qn("w:bidi")) is None:
        _insert_ordered(p_pr, OxmlElement("w:bidi"), _PPR_ORDER)
    for run in paragraph.runs:
        r_pr = run._r.get_or_add_rPr()
        if r_pr.find(qn("w:rtl")) is None:
            _insert_ordered(r_pr, OxmlElement("w:rtl"), _RPR_ORDER)
        _mirror_cs(r_pr, "w:b", "w:bCs")
        _mirror_cs(r_pr, "w:sz", "w:szCs")


def _blend(a: RGBColor, b: RGBColor, t: float) -> RGBColor:
    return RGBColor(*(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3)))


class _Sheet:
    """Palette + rhythm resolved from one template spec (mirrors the PDF)."""

    def __init__(self, spec: TemplateSpec, squeeze: float = 1.0):
        self.spec, self.squeeze = spec, squeeze
        self.ink = RGBColor.from_string(spec.ink)
        self.muted = RGBColor.from_string(spec.muted)
        self.accent = RGBColor.from_string(spec.accent)
        # Inline separators sit between the hairline and the body grey so they
        # read as punctuation, not as content.
        self.sep = (RGBColor.from_string(spec.sep_color) if spec.sep_color
                    else _blend(self.muted, RGBColor.from_string(spec.rule), 0.55))
        # Mirrors pdf_renderer._Sheet: the name and the headline may each sit a
        # shade off the body text without dragging `ink` with them.
        self.name_ink = (RGBColor.from_string(spec.name_color) if spec.name_color
                         else self.ink)
        self.headline_ink = (RGBColor.from_string(spec.headline_color) if spec.headline_color
                             else self.accent)
        # Reversed-out palette for a filled header band.
        self.band_ink = RGBColor.from_string(spec.band_ink)
        self.band_sub = RGBColor.from_string(spec.band_sub)
        self.band_meta = RGBColor.from_string(spec.band_meta)
        # The timeline rail, mixed exactly as the PDF's `_Sheet` mixes it
        # (accent 55% over white) so one number defines the line in both files.
        self.rail = str(_blend(self.accent, RGBColor(0xFF, 0xFF, 0xFF), 0.45))
        self.tight = spec.tight
        self.column_pt = spec.page_w_pt - 2 * spec.margin_lr_pt

    # `spec.rhythm`, when a template states one, replaces these — the same
    # tuple, read at the same indices, as pdf_renderer._Sheet. The two renderers
    # must not be able to disagree about the page's density.
    def _rhythm(self, index: int, default: float) -> float:
        r = self.spec.rhythm
        return (r[index] if len(r) > index else default) * self.squeeze

    def _fixed(self, index: int, default: float) -> float:
        """A rhythm element the one-page squeeze does NOT scale."""
        r = self.spec.rhythm
        return r[index] if len(r) > index else default

    sec_before = property(lambda self: self._rhythm(0, 8.0 if self.tight else 12.0))
    sec_after = property(lambda self: self._rhythm(1, 2.0 if self.tight else 3.0))
    entry_before = property(lambda self: self._rhythm(2, 4.0 if self.tight else 6.5))
    bullet_after = property(lambda self: self._rhythm(3, 0.0 if self.tight else 1.2))
    head_rule_gap = property(lambda self: self._fixed(4, 3.0))
    header_after = property(lambda self: self._fixed(
        5, 5.0 if self.spec.header == "plain" else 0.0))

    @property
    def line_pt(self) -> float | None:
        """Exact line height.

        A template that STATES a `leading_ratio` states it here too, always: the
        whole point of the field is that this document's line is 1.167 of its
        type, and leaving Word on its own single spacing would set the Word file
        at a density the PDF is not.

        For every other template it is set only when the résumé has to be
        squeezed onto one page. At full size Word's own single spacing is left
        alone — forcing an exact height there would only make the file taller
        than the PDF."""
        if self.spec.leading_ratio:
            return self.spec.body_size * self.spec.leading_ratio * self.squeeze
        if self.squeeze >= 1.0:
            return None
        return max(self.spec.body_size * 1.24 * self.squeeze, self.spec.body_size * 1.12)


def render_docx(resume: ResumeModel, template: str = DEFAULT_TEMPLATE) -> bytes:
    spec = get_template(template)
    # A two-column template is PDF-only. Word cannot build a fixed sidebar
    # without a table, and a table is the one thing the ATS rules forbid — so
    # the Word download is the closest single-column sibling instead, and the
    # picker says so where the user chooses and where they download.
    if spec.docx_fallback:
        spec = get_template(spec.docx_fallback)
    rtl = resume_language(resume) == "he"
    labels = labels_for("he" if rtl else "en", spec.label_set)
    # Same one-page-or-two verdict as the PDF, measured once by the PDF layout
    # engine — Word re-breaks the lines itself, but in a narrower face than the
    # bundled one, so a fit that the estimate clears also clears in Word.
    s = _Sheet(spec, squeeze=fit_squeeze(resume, spec, rtl))

    doc = Document()
    doc.core_properties.title = resume.contact.name or "Resume"
    doc.core_properties.author = resume.contact.name or ""

    style = doc.styles["Normal"]
    style.font.name = spec.docx_font
    style.font.size = Pt(spec.body_size)
    style.font.color.rgb = s.ink
    style.paragraph_format.space_after = Pt(0)
    if rtl:
        # Pin the complex-script face too, or Word substitutes its own Hebrew
        # default and the document stops matching the PDF. It has to be a family
        # that HAS Hebrew glyphs — pinning the Latin `docx_font` here asked Word
        # for Georgia on a Hebrew `executive`, which it cannot render and
        # silently replaced.
        style.element.rPr.rFonts.set(qn("w:cs"), spec.docx_font_he)

    # One list definition per document, carrying this template's glyph, its
    # colour and its size. Created before any content so `bullets()` can point
    # every paragraph at it.
    bullet_num_id = _bullet_numbering(doc, spec)

    band = spec.header == "band"
    for section in doc.sections:
        section.page_width = Pt(spec.page_w_pt)
        section.page_height = Pt(spec.page_h_pt)
        # A band has to reach the top of the sheet the way the PDF's rectangle
        # does; with a top margin Word leaves a white strip above it. The air the
        # margin used to provide is re-added as space_before on the name.
        section.top_margin = Pt(0) if band else Pt(spec.margin_tb_pt)
        section.bottom_margin = Pt(spec.margin_tb_pt)
        section.left_margin = section.right_margin = Pt(spec.margin_lr_pt)

    def para(*, before: float = 0.0, after: float = 0.0, keep: bool = False, center: bool = False,
             lead: bool = True):
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(before)
        p.paragraph_format.space_after = Pt(after)
        p.paragraph_format.keep_with_next = keep
        if lead and s.line_pt:
            p.paragraph_format.line_spacing = Pt(s.line_pt)
        if center:
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        # else: no explicit alignment — the text sits at the paragraph start,
        # which the RTL sweep below turns into the right edge for Hebrew.
        return p

    def text(p, value: str, *, size: float, color: RGBColor, bold: bool = False,
             italic: bool = False, track: float = 0.0):
        if not value:
            return None
        run = p.add_run(value)
        run.bold = bold
        run.italic = italic
        run.font.size = Pt(size)
        run.font.color.rgb = color
        _tracking(run, track)
        return run

    # "" keeps each site's own default — see TemplateSpec.meta_sep.
    _sep = spec.meta_sep or "  ·  "

    def joined(p, parts: list[tuple[str, float, RGBColor]], *, sep: str = _SEP,
               sep_color: RGBColor | None = None, bold_first: bool = False) -> None:
        """Inline list with muted separators — contact, employer · location."""
        live = [x for x in parts if x[0]]
        for i, (value, size, color) in enumerate(live):
            if i:
                text(p, sep, size=size, color=sep_color or s.sep)
            text(p, value, size=size, color=color, bold=bold_first and i == 0)

    # --- header -----------------------------------------------------------
    c = resume.contact
    # A band anchors the name to the top-start corner; centring inside a filled
    # rectangle reads like a certificate.
    head_center = spec.name_centered and not band
    band_paras = []
    # lead=False: the name is far larger than the body, so an exact body line
    # height would clip it.
    name_p = para(before=spec.margin_tb_pt * 0.62 if band else 0.0,
                  center=head_center, lead=False)
    text(name_p, c.name or "Name", size=spec.name_size,
         color=s.band_ink if band else s.name_ink,
         bold=True, track=spec.name_tracking * (0.5 if rtl else 1.0))
    band_paras.append(name_p)

    if resume.headline:
        # Sits between the name and the contact line: the first thing a
        # recruiter reads after the name, and what the ATS matches on. Coloured
        # opposite the name so the two never flatten into one block.
        headline_p = para(before=1.0, after=1.0, center=head_center, lead=False)
        text(headline_p, resume.headline,
             size=spec.headline_size or (spec.body_size + (1.2 if band else 0.8)),
             color=s.band_sub if band else s.headline_ink,
             bold=spec.headline_bold,
             track=spec.headline_tracking * (0.5 if rtl else 1.0))
        band_paras.append(headline_p)

    # Order and separator both come from the spec — see TemplateSpec.contact_order.
    _contact = {"email": c.email, "phone": c.phone, "location": c.location,
                "linkedin": c.linkedin, "website": c.website}
    bits = [_contact[k] for k in
            (spec.contact_order or ("email", "phone", "location", "linkedin", "website"))
            if _contact.get(k)]
    contact_p = None
    if bits:
        # Without a rule to separate it, the header needs the air itself.
        contact_p = para(before=1.0,
                         after=(spec.margin_tb_pt * 0.55 if band else s.header_after),
                         center=head_center)
        joined(contact_p, [(b, spec.meta_size, s.band_meta if band else s.muted)
                           for b in bits], sep=spec.meta_sep or _SEP,
               sep_color=s.band_meta if band else None)
        band_paras.append(contact_p)
    if band:
        for p in band_paras:
            _shade(p, spec.band_fill)
            _bleed(p, spec.margin_lr_pt)
    elif spec.header == "rule":
        # `header` is authoritative here exactly as it is in the PDF. This used
        # to read `elif spec.header_rule:` — a bool no template set False — so
        # `ivy` and `minimal`, whose specs declare "plain", drew a hairline in
        # the Word file too. Weight and colour come from the spec as well: the
        # 2.0pt rust rule is the single loudest line on `ledger` and it printed
        # as a 0.5pt grey one.
        _hairline(contact_p or name_p,
                  spec.accent if spec.header_rule_accent else spec.rule,
                  space_pt=6, sz=int(round(spec.header_rule_pt * 8)))

    # --- section helpers --------------------------------------------------
    def heading(key: str) -> None:
        """The section heading, DERIVED from the spec rather than hard-coded.

        Every expression below is copied from `pdf_renderer`'s own `heading()`
        so the two cannot drift: the case, the ink-vs-accent split, and the rule
        predicate. Before this the DOCX used a different predicate for each —
        `executive` and `ivy` printed Title Case in the PDF and UPPERCASE in
        Word, `minimal` drew nine heading rules in Word and none in its PDF, and
        the heading word itself was accent in Word and ink in the PDF on four
        templates.
        """
        style = spec.heading
        bar = style == "bar"
        short = style == "short"
        p = para(before=s.sec_before + (3.0 if bar else 0.0),
                 # A short underline is its own paragraph (below), so the air
                 # after the section heading belongs to that one instead.
                 after=(1.0 if short else s.sec_after + (1.0 if bar else 0.0)),
                 keep=True, center=(style == "centered"))
        # pdf_renderer: `raw if rtl else (raw.title() if heading_case == "title"
        # else raw.upper())`. Hebrew is unicase, so both cases are no-ops there,
        # and .title() would mangle a mixed he/en label — hence the direction
        # branch first.
        label = labels[key] if rtl else (
            labels[key].title() if spec.heading_case == "title" else labels[key].upper())
        text(p, label, size=spec.heading_size + spec.heading_bump,
             # pdf_renderer: ink for the treatments that carry their own accent
             # mark (a bar, a coloured underline, a hang), accent where the word
             # itself is the only colour on the line.
             color=s.ink if style in ("bar", "short", "hung") else s.accent, bold=True,
             track=spec.heading_tracking * (0.5 if rtl else 1.0))
        if style == "hung":
            # An honest approximation, and the limit is Word's: it cannot put a
            # heading BESIDE the body without a text frame, which the ATS rules
            # forbid — so the heading hangs into the start margin on its own
            # line. `minimal`'s 84pt side margin is what makes a 58pt hang fit,
            # which is why that margin is documented as load-bearing. The
            # load-bearing half of "hung" — that it carries NO rule — comes from
            # the predicate below and is exact.
            p.paragraph_format.left_indent = Pt(-spec.heading_hang_pt)
        if bar:
            # The twin of the PDF's accent bar. In a bidi paragraph Word mirrors
            # the border with the text, so "left" lands on the right in Hebrew —
            # which is what the PDF does too.
            _p_border(p, "left", spec.accent, sz=int(round(spec.heading_bar_w * 8)), space_pt=6)
        elif short:
            # A SHORT accent underline cannot be a border on the heading
            # paragraph: a paragraph border spans the paragraph, so a 32pt rule
            # means a 32pt-wide PARAGRAPH — and "EXPERIENCE" at 11pt bold
            # measures ~70pt, so the heading would wrap to about one character
            # per line. The mark is therefore its own empty paragraph, indented
            # to leave exactly `heading_short_pt` and carrying the border on its
            # bottom: Word's standard horizontal-rule construct, still a
            # paragraph border, still no table, and an empty paragraph
            # contributes nothing at all to the extracted text. In a bidi
            # paragraph Word measures `w:right` from the right margin, so the
            # mark lands under the start of the heading in Hebrew for free —
            # the same mirroring the flush-right date already relies on.
            rule_p = para(after=s.sec_after, keep=True, lead=False)
            rule_p.paragraph_format.line_spacing = Pt(1.0)
            rule_p.paragraph_format.right_indent = Pt(s.column_pt - spec.heading_short_pt)
            _hairline(rule_p, spec.head_rule_fill, space_pt=1,
                      sz=int(round(spec.heading_rule_pt * 8)))
        elif style in ("rule", "centered"):
            # pdf_renderer draws a rule for exactly ("rule", "short", "centered")
            # — "plain" and "hung" get none. `head_rule_gap` is the PDF's own
            # air between the heading and its hairline, read from the same
            # rhythm tuple at the same index.
            _hairline(p, spec.head_rule_fill, space_pt=int(round(s.head_rule_gap)),
                      sz=int(round(spec.heading_rule_pt * 8)))

    def body(value: str, *, before: float = 0.0, after: float = 0.0) -> None:
        p = para(before=before, after=after)
        text(p, value, size=spec.body_size, color=s.ink)

    def rail_border(p) -> None:
        """The DOCX twin of the PDF's timeline rail: a left paragraph border
        tiled down every paragraph of one entry, so the segments join into one
        continuous line exactly as the PDF's per-flowable segments do. Same
        mechanism as the accent bar beside a heading — no table, nothing an ATS
        has to un-pick — and Word mirrors it to the right edge in a bidi
        paragraph, which is what the PDF does too. The per-role DOT has no
        honest twin and is a documented ornament carve-out (see
        `TemplateSpec.rail`)."""
        if spec.rail:
            _p_border(p, "left", s.rail, sz=6, space_pt=10)

    def bullets(items: list[str], rail: bool = False) -> None:
        for item in items:
            if not item:
                continue
            p = doc.add_paragraph(item, style="List Bullet")
            # Point at THIS template's bullet definition rather than
            # python-docx's stock numId 1, whose glyph is a Symbol-font PUA
            # codepoint. It stays a real Word list; see `_bullet_numbering`.
            _num_pr(p, bullet_num_id)
            p.paragraph_format.space_before = Pt(0)
            p.paragraph_format.space_after = Pt(s.bullet_after)
            if s.line_pt:
                p.paragraph_format.line_spacing = Pt(s.line_pt)
            p.paragraph_format.left_indent = Pt(spec.body_size * 1.35)
            p.paragraph_format.first_line_indent = Pt(-spec.body_size * 1.05)
            if rail:
                rail_border(p)

    def entry(primary: str, meta: str, secondary: list[tuple[str, float, RGBColor]],
              items: list[str], first: bool, *, detail: str = "", bump: float = 1.0) -> None:
        """Mirrors `pdf_renderer._flow.entry`, argument for argument — see there
        for what `detail` and `bump` mean and why only "run" reads them."""
        if spec.entry == "run":
            # ONE paragraph: the bold identity, the italic circumstance, then
            # the regular detail. Word breaks it between words exactly as
            # `_RichText` does, so the two files carry the same sentence.
            p = para(before=0.0 if first else s.entry_before, after=1.5, keep=bool(items))
            named = [x for x in secondary if x[0]]
            bold_bits = [primary] + [x[0] for x in named[:1]]
            tail_bits = [x[0] for x in named[1:]] + ([meta] if meta else [])
            text(p, _sep.join(b for b in bold_bits if b),
                 size=spec.body_size + bump, color=s.ink, bold=True)
            if tail_bits:
                text(p, "   " + _sep.join(tail_bits), size=spec.meta_size,
                     color=s.ink, italic=True)
            if detail:
                text(p, _sep + detail, size=spec.body_size, color=s.ink)
            bullets(items)
            return
        if detail:
            # Where the head cannot absorb it, the detail is the entry's last
            # bullet — byte for byte what `build_education` used to pass in.
            items = list(items) + [detail]
        if spec.entry == "stack":
            # Title on its own line, then "Employer · Location · Dates". The
            # split style below leaves the whole middle of the column empty
            # whenever the title is short, which is most of the time.
            p = para(before=0.0 if first else s.entry_before + 1.5, keep=True)
            text(p, primary, size=spec.body_size + 0.9, color=s.ink, bold=True)
            rail_border(p)
            parts = list(secondary)
            if meta:
                parts.append((meta, spec.meta_size, s.muted))
            if any(x[0] for x in parts):
                meta_p = para(keep=True)
                joined(meta_p, parts, sep=_sep, bold_first=True)
                rail_border(meta_p)
            # The rail runs down the ENTRY, so it follows the bullets too — the
            # PDF passes `rail=s.rail` to a stacked entry's bullets and None to
            # everything else (certifications keep their own list).
            bullets(items, rail=True)
            return
        p = para(before=0.0 if first else s.entry_before, keep=True)
        # Dates go to the far margin on a right tab stop. In a bidi paragraph
        # Word measures tab stops from the right margin, so the same stop puts
        # the dates at the left edge of a Hebrew résumé — which is correct.
        if meta:
            p.paragraph_format.tab_stops.add_tab_stop(Pt(s.column_pt), WD_TAB_ALIGNMENT.RIGHT)
        text(p, primary, size=spec.body_size, color=s.ink, bold=True)
        if meta:
            p.add_run("\t")
            text(p, meta, size=spec.meta_size, color=s.muted)
        if any(x[0] for x in secondary):
            joined(para(keep=True), secondary, sep=spec.meta_sep or _SEP)
        bullets(items)

    # --- content ----------------------------------------------------------
    # One builder per section key; the ORDER comes from section_order(), which
    # puts Education above Experience for an early-career résumé. Mirrors the
    # PDF exactly — the two must never disagree about layout.
    def build_summary() -> None:
        if resume.summary:
            heading("summary")
            body(resume.summary)

    def chips(items: list[str], before: float = 0.0) -> None:
        """Bordered runs in one wrapping paragraph — the DOCX twin of _Chips.
        A real comma stays between them so the extracted text keeps exactly the
        delimiter the comma-joined run would have given a keyword parser."""
        live = [i for i in items if i]
        if not live:
            return
        p = para(before=before, lead=False)
        p.paragraph_format.space_after = Pt(1.5)
        for i, item in enumerate(live):
            run = text(p, f" {item} ", size=spec.meta_size + 0.4, color=s.ink)
            _chip(run, spec.rule)
            if i < len(live) - 1:
                text(p, ", ", size=spec.meta_size + 0.4, color=s.sep)

    def build_skills() -> None:
        blocks = skill_blocks(resume)
        if not blocks:
            return
        heading("skills")
        for i, (label, items) in enumerate(blocks):
            if spec.skills == "labeled":
                # One paragraph: the label BOLD and inline, then its own
                # comma-joined items — the same text, the same commas and the
                # same order as the "inline" run, so a keyword parser splits it
                # identically. Mirrors `pdf_renderer`'s `labeled`.
                p = para(before=0.0 if i == 0 else s.bullet_after)
                if label:
                    text(p, f"{label}: ", size=spec.meta_size, color=s.ink, bold=True)
                text(p, ", ".join(items), size=spec.meta_size, color=s.ink)
                continue
            if label:
                # The group's label: small, bold, accent, glued to its own
                # items. Same shape as the PDF — `skill_blocks` is shared
                # precisely so the two downloads cannot describe the skills
                # section differently.
                p = para(before=s.bullet_after + 1.5, after=1.0, keep=True, lead=False)
                text(p, label, size=spec.meta_size + 0.2, color=s.accent, bold=True,
                     track=spec.heading_tracking * 0.5 * (0.5 if rtl else 1.0))
            # An unlabelled block after a labelled one is the leftover — skills
            # no group claimed. It needs the air, or it reads as one more row of
            # the group above it. Same rule as the PDF.
            before = 0.0 if (label or i == 0) else s.entry_before
            if spec.skills == "chips":
                chips(items, before=before)
            else:
                # Comma-separated on purpose: it is what ATS keyword parsers
                # split on.
                body(", ".join(items), before=before)

    def build_experience() -> None:
        if not resume.experience:
            return
        heading("experience")
        for i, exp in enumerate(resume.experience):
            entry(
                exp.title or exp.company,
                " – ".join(b for b in [exp.start_date, exp.end_date] if b),
                [(exp.company if exp.title else "", spec.body_size, s.accent),
                 (exp.location, spec.meta_size, s.muted)],
                exp.bullets, first=(i == 0),
            )

    def build_projects() -> None:
        if not resume.projects:
            return
        heading("projects")
        for i, proj in enumerate(resume.projects):
            if spec.entry == "run":
                # A "run" head is one line and cannot absorb prose, so the
                # description is its own paragraph under it — indented and sized
                # by the spec, exactly as `pdf_renderer` sets it. bump=0.5: a
                # project name is a step down from a role's title.
                entry(proj.name, "", [], [], first=(i == 0), bump=0.5)
                if proj.description:
                    dp = para(after=s.bullet_after if proj.bullets else 0.0)
                    dp.paragraph_format.left_indent = Pt(spec.desc_indent_pt)
                    text(dp, proj.description, size=spec.desc_size or spec.body_size,
                         color=s.muted)
                bullets(proj.bullets)
                continue
            entry(proj.name, "", [(proj.description, spec.body_size, s.muted)],
                  proj.bullets, first=(i == 0))

    def build_education() -> None:
        if not resume.education:
            return
        heading("education")
        for i, edu in enumerate(resume.education):
            # `detail=` rather than a one-item bullet list — see the PDF's
            # own `build_education`. bump=0.0: a degree is body weight beside a
            # role's title.
            entry(
                ", ".join(b for b in [edu.degree, edu.field] if b) or edu.institution,
                " – ".join(d for d in [edu.start_date, edu.end_date] if d),
                [(edu.institution if (edu.degree or edu.field) else "", spec.body_size, s.accent)],
                [], first=(i == 0), detail=edu.details, bump=0.0,
            )

    def build_military() -> None:
        if not resume.military_service:
            return
        heading("military")
        for i, ms in enumerate(resume.military_service):
            entry(
                " — ".join(b for b in [ms.role, ms.unit] if b) or labels["military"],
                " – ".join(b for b in [ms.start_date, ms.end_date] if b),
                [(ms.rank, spec.meta_size, s.muted)],
                ms.bullets, first=(i == 0),
            )

    def build_certifications() -> None:
        live = [cert for cert in resume.certifications if cert]
        if not live:
            return
        heading("certifications")
        cols = min(2, spec.list_cols)
        if cols > 1 and len(live) > 1:
            # Two per row, via the mechanism already blessed for the flush-right
            # date: a TAB STOP. Nine templates declare `list_cols=2`, the PDF
            # honours it, and one column here wasted the whole right half of the
            # page on a handful of short items.
            #
            # Never `w:cols` and never a table. A tab is a delimiter, so
            # extraction reads "item A\titem B" — the same shape the PDF's own
            # two-column extraction produces — whereas snaking section columns
            # are the two-column layout that made `split` and `panel` PDF-only
            # in the first place. In a bidi paragraph Word measures tab stops
            # from the right margin, so RTL falls out for free.
            #
            # This is the one bulleted list that is NOT a Word list: two items
            # in one paragraph cannot both be list items, so the glyph is a run.
            # It matches the PDF, whose `_Cols` also draws the glyph itself.
            for row in range(0, len(live), cols):
                p = para(after=s.bullet_after)
                for i in range(1, cols):
                    p.paragraph_format.tab_stops.add_tab_stop(
                        Pt(s.column_pt * i / cols), WD_TAB_ALIGNMENT.LEFT)
                for i, item in enumerate(live[row:row + cols]):
                    if i:
                        p.add_run("\t")
                    text(p, f"{spec.bullet_glyph} ",
                         size=spec.body_size * spec.bullet_scale,
                         color=s.accent if spec.bullet_accent else s.muted)
                    text(p, item, size=spec.body_size, color=s.ink)
            return
        bullets(live)

    def build_languages() -> None:
        if not resume.languages:
            return
        pairs = [" – ".join(b for b in [ls.language, ls.level] if b) for ls in resume.languages]
        pairs = [p for p in pairs if p]
        if not pairs:
            return
        heading("languages")
        if spec.skills == "chips":
            chips(pairs)
            return
        joined(para(), [(p, spec.body_size, s.ink) for p in pairs],
               sep=spec.meta_sep or _SEP)

    builders = {
        "summary": build_summary, "skills": build_skills, "experience": build_experience,
        "projects": build_projects, "education": build_education, "military": build_military,
        "certifications": build_certifications, "languages": build_languages,
    }
    for key in section_order(resume):
        builders[key]()

    if rtl:
        # One sweep over every paragraph written above (incl. bullets) so no
        # text path can miss the RTL properties.
        for paragraph in doc.paragraphs:
            _set_rtl(paragraph)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
