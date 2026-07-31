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
"""
from __future__ import annotations

import io

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor

from app.core.lang import resume_language
from app.core.section_order import section_order
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


def _hairline(paragraph, color: str, space_pt: int = 3) -> None:
    """A hairline under one paragraph — a paragraph border, never a table."""
    p_pr = paragraph._p.get_or_add_pPr()
    if p_pr.find(qn("w:pBdr")) is not None:
        return
    border = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "4")  # eighths of a point = 0.5pt
    bottom.set(qn("w:space"), str(space_pt))
    bottom.set(qn("w:color"), color)
    border.append(bottom)
    _insert_ordered(p_pr, border, _PPR_ORDER)


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
        self.sep = _blend(self.muted, RGBColor.from_string(spec.rule), 0.55)
        self.tight = spec.tight
        self.column_pt = spec.page_w_pt - 2 * spec.margin_lr_pt

    sec_before = property(lambda self: (8.0 if self.tight else 12.0) * self.squeeze)
    sec_after = property(lambda self: (2.0 if self.tight else 3.0) * self.squeeze)
    entry_before = property(lambda self: (4.0 if self.tight else 6.5) * self.squeeze)
    bullet_after = property(lambda self: (0.0 if self.tight else 1.2) * self.squeeze)

    @property
    def line_pt(self) -> float | None:
        """Exact line height, only when the résumé has to be squeezed onto one
        page. At full size Word's own single spacing is left alone — forcing an
        exact height there would only make the file taller than the PDF."""
        if self.squeeze >= 1.0:
            return None
        return max(self.spec.body_size * 1.24 * self.squeeze, self.spec.body_size * 1.12)


def render_docx(resume: ResumeModel, template: str = DEFAULT_TEMPLATE) -> bytes:
    spec = get_template(template)
    rtl = resume_language(resume) == "he"
    labels = labels_for("he" if rtl else "en")
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
        # default and the document stops matching the PDF.
        style.element.rPr.rFonts.set(qn("w:cs"), spec.docx_font)

    for section in doc.sections:
        section.page_width = Pt(spec.page_w_pt)
        section.page_height = Pt(spec.page_h_pt)
        section.top_margin = section.bottom_margin = Pt(spec.margin_tb_pt)
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

    def text(p, value: str, *, size: float, color: RGBColor, bold: bool = False, track: float = 0.0):
        if not value:
            return None
        run = p.add_run(value)
        run.bold = bold
        run.font.size = Pt(size)
        run.font.color.rgb = color
        _tracking(run, track)
        return run

    def joined(p, parts: list[tuple[str, float, RGBColor]]) -> None:
        """Inline list with muted separators — contact, employer · location."""
        live = [x for x in parts if x[0]]
        for i, (value, size, color) in enumerate(live):
            if i:
                text(p, _SEP, size=size, color=s.sep)
            text(p, value, size=size, color=color)

    # --- header -----------------------------------------------------------
    c = resume.contact
    # lead=False: the name is far larger than the body, so an exact body line
    # height would clip it.
    name_p = para(center=spec.name_centered, lead=False)
    text(name_p, c.name or "Name", size=spec.name_size, color=s.accent if spec.accent_name else s.ink,
         bold=True, track=spec.name_tracking * (0.5 if rtl else 1.0))

    if resume.headline:
        # Sits between the name and the contact line: the first thing a
        # recruiter reads after the name, and what the ATS matches on. Coloured
        # opposite the name so the two never flatten into one block.
        headline_p = para(before=1.0, after=1.0, center=spec.name_centered, lead=False)
        text(headline_p, resume.headline, size=spec.body_size + 0.8,
             color=s.ink if spec.accent_name else s.accent,
             track=0.3 * (0.5 if rtl else 1.0))

    bits = [b for b in [c.email, c.phone, c.location, c.linkedin, c.website] if b]
    contact_p = None
    if bits:
        # Without a rule to separate it, the header needs the air itself.
        contact_p = para(before=1.0, after=0.0 if spec.header_rule else 5.0,
                         center=spec.name_centered)
        joined(contact_p, [(b, spec.meta_size, s.muted) for b in bits])
    if spec.header_rule:
        _hairline(contact_p or name_p, spec.rule, space_pt=6)

    # --- section helpers --------------------------------------------------
    def heading(key: str) -> None:
        p = para(before=s.sec_before, after=s.sec_after, keep=True)
        label = labels[key] if rtl else labels[key].upper()
        text(p, label, size=spec.heading_size, color=s.accent, bold=True,
             track=spec.heading_tracking * (0.5 if rtl else 1.0))
        if spec.heading_rule:
            _hairline(p, spec.rule)

    def body(value: str, *, before: float = 0.0, after: float = 0.0) -> None:
        p = para(before=before, after=after)
        text(p, value, size=spec.body_size, color=s.ink)

    def bullets(items: list[str]) -> None:
        for item in items:
            if not item:
                continue
            p = doc.add_paragraph(item, style="List Bullet")
            p.paragraph_format.space_before = Pt(0)
            p.paragraph_format.space_after = Pt(s.bullet_after)
            if s.line_pt:
                p.paragraph_format.line_spacing = Pt(s.line_pt)
            p.paragraph_format.left_indent = Pt(spec.body_size * 1.35)
            p.paragraph_format.first_line_indent = Pt(-spec.body_size * 1.05)

    def entry(primary: str, meta: str, secondary: list[tuple[str, float, RGBColor]],
              items: list[str], first: bool) -> None:
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
            joined(para(keep=True), secondary)
        bullets(items)

    # --- content ----------------------------------------------------------
    # One builder per section key; the ORDER comes from section_order(), which
    # puts Education above Experience for an early-career résumé. Mirrors the
    # PDF exactly — the two must never disagree about layout.
    def build_summary() -> None:
        if resume.summary:
            heading("summary")
            body(resume.summary)

    def build_skills() -> None:
        if resume.skills:
            heading("skills")
            # Comma-separated on purpose: it is what ATS keyword parsers split on.
            body(", ".join(resume.skills))

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
            entry(proj.name, "", [(proj.description, spec.body_size, s.muted)],
                  proj.bullets, first=(i == 0))

    def build_education() -> None:
        if not resume.education:
            return
        heading("education")
        for i, edu in enumerate(resume.education):
            entry(
                ", ".join(b for b in [edu.degree, edu.field] if b) or edu.institution,
                " – ".join(d for d in [edu.start_date, edu.end_date] if d),
                [(edu.institution if (edu.degree or edu.field) else "", spec.body_size, s.accent)],
                [edu.details] if edu.details else [], first=(i == 0),
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
        if not resume.certifications:
            return
        heading("certifications")
        bullets(resume.certifications)

    def build_languages() -> None:
        if not resume.languages:
            return
        heading("languages")
        p = para()
        joined(p, [(" – ".join(b for b in [ls.language, ls.level] if b), spec.body_size, s.ink)
                   for ls in resume.languages])

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
