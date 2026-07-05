"""Render a ResumeModel to an ATS-safe PDF using reportlab (pure-Python).

Single-column flowing layout, standard fonts, real selectable text (not images),
so ATS parsers can read it.

Hebrew resumes: reportlab has no bidi/shaping, so we bundle Noto Sans Hebrew
(OFL, see fonts/OFL.txt), reorder every line logical->visual with python-bidi,
and lay paragraphs out right-aligned with RTL word wrap. English resumes take
exactly the same code path as before.
"""
from __future__ import annotations

import io
from pathlib import Path

from bidi.algorithm import get_display
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.pdfmetrics import registerFontFamily, stringWidth
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import ListFlowable, ListItem, Paragraph, SimpleDocTemplate, Spacer

from app.core.lang import resume_language
from app.models import ResumeModel
from app.render.templates import DEFAULT_TEMPLATE, TemplateSpec, get_template

_DARK = HexColor("#222222")

_FONTS_DIR = Path(__file__).parent / "fonts"
_HE_FONT = "NotoSansHebrew"
_HE_FONT_BOLD = "NotoSansHebrew-Bold"

# Hebrew section headings (standard names; the English path keeps its literals).
_HE_HEADINGS = {
    "summary": "תקציר",
    "skills": "כישורים",
    "experience": "ניסיון תעסוקתי",
    "projects": "פרויקטים",
    "education": "השכלה",
    "military": "שירות צבאי",
    "certifications": "הסמכות",
    "languages": "שפות",
}
_EN_MILITARY = "MILITARY SERVICE"
_EN_LANGUAGES = "LANGUAGES"


def _ensure_hebrew_fonts() -> None:
    """Register the bundled Noto Sans Hebrew TTFs once (covers Hebrew + Latin)."""
    if _HE_FONT in pdfmetrics.getRegisteredFontNames():
        return
    pdfmetrics.registerFont(TTFont(_HE_FONT, str(_FONTS_DIR / "NotoSansHebrew-Regular.ttf")))
    pdfmetrics.registerFont(TTFont(_HE_FONT_BOLD, str(_FONTS_DIR / "NotoSansHebrew-Bold.ttf")))
    registerFontFamily(_HE_FONT, normal=_HE_FONT, bold=_HE_FONT_BOLD, italic=_HE_FONT, boldItalic=_HE_FONT_BOLD)


def _visual(text: str) -> str:
    """Reorder one logical Hebrew/mixed line into visual order for reportlab.
    base_dir='R' keeps mixed Hebrew/English lines anchored right-to-left."""
    return get_display(text or "", base_dir="R")


def _rtl_markup(text: str, font_name: str, font_size: float, max_width: float) -> str:
    """Break LOGICAL text into lines that fit max_width, bidi-reorder each line
    to visual order, escape, and join with <br/>.

    reportlab can't do this itself: its wrapping is direction-blind, so a
    whole-paragraph get_display() wraps with the lines stacked bottom-up.
    Wrapping first (on logical text) and reordering per line keeps both the
    reading order of lines (top-down) and the in-line direction correct."""
    words = (text or "").split()
    lines: list[str] = []
    cur = ""
    for w in words:
        trial = f"{cur} {w}" if cur else w
        if cur and stringWidth(trial, font_name, font_size) > max_width:
            lines.append(cur)
            cur = w
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return "<br/>".join(_esc(_visual(line)) for line in lines)


def _styles(spec: TemplateSpec):
    base = getSampleStyleSheet()
    accent = HexColor(f"#{spec.accent}")
    name_align = TA_CENTER if spec.name_centered else TA_LEFT
    leading = spec.body_size + (2.5 if spec.tight else 3.5)
    return {
        "name": ParagraphStyle("Name", parent=base["Title"], fontSize=spec.name_size, alignment=name_align, textColor=_DARK, spaceAfter=2),
        "contact": ParagraphStyle("Contact", parent=base["Normal"], fontSize=9, alignment=name_align, textColor=_DARK, spaceAfter=8),
        "heading": ParagraphStyle("Heading", parent=base["Heading2"], fontSize=spec.heading_size, textColor=accent, spaceBefore=6 if spec.tight else 10, spaceAfter=2 if spec.tight else 3),
        "body": ParagraphStyle("Body", parent=base["Normal"], fontSize=spec.body_size, textColor=_DARK, leading=leading),
        "item": ParagraphStyle("ItemHead", parent=base["Normal"], fontSize=spec.body_size, textColor=_DARK, leading=leading, spaceBefore=2 if spec.tight else 4),
    }


def _he_styles(spec: TemplateSpec):
    """RTL twins of _styles: Hebrew font + right alignment. Text is pre-wrapped
    and bidi-reordered per line by _rtl_markup, so no wordWrap tricks here.
    A non-centered name sits at the text start — the right edge, in RTL."""
    base = getSampleStyleSheet()
    accent = HexColor(f"#{spec.accent}")
    name_align = TA_CENTER if spec.name_centered else TA_RIGHT
    leading = spec.body_size + (2.5 if spec.tight else 3.5)
    return {
        "name": ParagraphStyle("NameHe", parent=base["Title"], fontSize=spec.name_size, alignment=name_align, textColor=_DARK, spaceAfter=2, fontName=_HE_FONT),
        "contact": ParagraphStyle("ContactHe", parent=base["Normal"], fontSize=9, alignment=name_align, textColor=_DARK, spaceAfter=8, fontName=_HE_FONT),
        "heading": ParagraphStyle("HeadingHe", parent=base["Heading2"], fontSize=spec.heading_size, textColor=accent, spaceBefore=6 if spec.tight else 10, spaceAfter=2 if spec.tight else 3, alignment=TA_RIGHT, fontName=_HE_FONT_BOLD),
        "body": ParagraphStyle("BodyHe", parent=base["Normal"], fontSize=spec.body_size, textColor=_DARK, leading=leading, alignment=TA_RIGHT, fontName=_HE_FONT),
        "item": ParagraphStyle("ItemHeadHe", parent=base["Normal"], fontSize=spec.body_size, textColor=_DARK, leading=leading, spaceBefore=2 if spec.tight else 4, alignment=TA_RIGHT, fontName=_HE_FONT_BOLD),
    }


def _esc(text: str) -> str:
    return (text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def render_pdf(resume: ResumeModel, template: str = DEFAULT_TEMPLATE) -> bytes:
    spec = get_template(template)
    if resume_language(resume) == "he":
        return _render_pdf_hebrew(resume, spec)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=LETTER,
        topMargin=spec.margin_tb_pt, bottomMargin=spec.margin_tb_pt,
        leftMargin=spec.margin_lr_pt, rightMargin=spec.margin_lr_pt,
        title=resume.contact.name or "Resume",
    )
    s = _styles(spec)
    flow = []

    c = resume.contact
    flow.append(Paragraph(_esc(c.name or "Name"), s["name"]))
    bits = [b for b in [c.email, c.phone, c.location, c.linkedin, c.website] if b]
    if bits:
        flow.append(Paragraph(_esc(" | ".join(bits)), s["contact"]))

    def bullets(items: list[str]):
        return ListFlowable(
            [ListItem(Paragraph(_esc(b), s["body"]), leftIndent=12) for b in items if b],
            bulletType="bullet", start="•", leftIndent=14,
        )

    if resume.summary:
        flow += [Paragraph("SUMMARY", s["heading"]), Paragraph(_esc(resume.summary), s["body"])]

    if resume.skills:
        flow += [Paragraph("SKILLS", s["heading"]), Paragraph(_esc(", ".join(resume.skills)), s["body"])]

    if resume.experience:
        flow.append(Paragraph("EXPERIENCE", s["heading"]))
        for exp in resume.experience:
            left = " — ".join(b for b in [exp.title, exp.company] if b)
            dates = " – ".join(b for b in [exp.start_date, exp.end_date] if b)
            meta = " | ".join(b for b in [exp.location, dates] if b)
            head = f"<b>{_esc(left)}</b>"
            if meta:
                head += f"  <i>({_esc(meta)})</i>"
            flow.append(Paragraph(head, s["item"]))
            if exp.bullets:
                flow.append(bullets(exp.bullets))

    if resume.projects:
        flow.append(Paragraph("PROJECTS", s["heading"]))
        for proj in resume.projects:
            head = f"<b>{_esc(proj.name)}</b>"
            if proj.description:
                head += f" — {_esc(proj.description)}"
            flow.append(Paragraph(head, s["item"]))
            if proj.bullets:
                flow.append(bullets(proj.bullets))

    if resume.education:
        flow.append(Paragraph("EDUCATION", s["heading"]))
        for edu in resume.education:
            line = ", ".join(b for b in [edu.degree, edu.field] if b) or edu.institution
            dates = " – ".join(d for d in [edu.start_date, edu.end_date] if d)
            tail = " | ".join(b for b in [edu.institution if line != edu.institution else "", dates] if b)
            head = f"<b>{_esc(line)}</b>"
            if tail:
                head += f"  <i>({_esc(tail)})</i>"
            flow.append(Paragraph(head, s["item"]))
            if edu.details:
                flow.append(Paragraph(_esc(edu.details), s["body"]))

    if resume.military_service:
        flow.append(Paragraph(_EN_MILITARY, s["heading"]))
        for ms in resume.military_service:
            left = " — ".join(b for b in [ms.role, ms.unit] if b)
            dates = " – ".join(b for b in [ms.start_date, ms.end_date] if b)
            meta = " | ".join(b for b in [ms.rank, dates] if b)
            head = f"<b>{_esc(left or 'Military Service')}</b>"
            if meta:
                head += f"  <i>({_esc(meta)})</i>"
            flow.append(Paragraph(head, s["item"]))
            if ms.bullets:
                flow.append(bullets(ms.bullets))

    if resume.certifications:
        flow.append(Paragraph("CERTIFICATIONS", s["heading"]))
        flow.append(bullets(resume.certifications))

    if resume.languages:
        flow.append(Paragraph(_EN_LANGUAGES, s["heading"]))
        bits = [" – ".join(b for b in [ls.language, ls.level] if b) for ls in resume.languages]
        flow.append(Paragraph(_esc(" | ".join(b for b in bits if b)), s["body"]))

    doc.build(flow)
    return buf.getvalue()


def _render_pdf_hebrew(resume: ResumeModel, spec: TemplateSpec) -> bytes:
    """Hebrew build path: embedded Hebrew font, every line bidi-reordered
    logical->visual, right-aligned RTL paragraphs. Still ATS-safe: single
    column, no tables/images, real selectable text."""
    _ensure_hebrew_fonts()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=LETTER,
        topMargin=spec.margin_tb_pt, bottomMargin=spec.margin_tb_pt,
        leftMargin=spec.margin_lr_pt, rightMargin=spec.margin_lr_pt,
        title=resume.contact.name or "Resume",
    )
    s = _he_styles(spec)
    flow = []
    # Frame width available to paragraphs; wrap slightly inside it so our
    # measured lines can never trigger a second, direction-blind re-wrap.
    text_width = LETTER[0] - doc.leftMargin - doc.rightMargin - 2

    def para(text: str, style) -> Paragraph:
        # Wrap on the logical text, bidi per line, escape — markup (<br/>)
        # is added after bidi so it never gets reordered.
        return Paragraph(_rtl_markup(text, style.fontName, style.fontSize, text_width), style)

    def bullet_paras(items: list[str]) -> list[Paragraph]:
        # ListFlowable pins bullets to the left edge; for RTL we bake the
        # bullet into the line (logical start => visually rightmost).
        return [para(f"• {b}", s["body"]) for b in items if b]

    def heading(key: str) -> Paragraph:
        return para(_HE_HEADINGS[key], s["heading"])

    c = resume.contact
    flow.append(para(c.name or "Name", s["name"]))
    bits = [b for b in [c.email, c.phone, c.location, c.linkedin, c.website] if b]
    if bits:
        flow.append(para(" | ".join(bits), s["contact"]))

    if resume.summary:
        flow += [heading("summary"), para(resume.summary, s["body"])]

    if resume.skills:
        flow += [heading("skills"), para(", ".join(resume.skills), s["body"])]

    if resume.experience:
        flow.append(heading("experience"))
        for exp in resume.experience:
            head = " — ".join(b for b in [exp.title, exp.company] if b)
            dates = " – ".join(b for b in [exp.start_date, exp.end_date] if b)
            meta = " | ".join(b for b in [exp.location, dates] if b)
            flow.append(para(head, s["item"]))
            if meta:
                flow.append(para(meta, s["body"]))
            flow += bullet_paras(exp.bullets)

    if resume.projects:
        flow.append(heading("projects"))
        for proj in resume.projects:
            head = proj.name
            if proj.description:
                head += f" — {proj.description}"
            flow.append(para(head, s["item"]))
            flow += bullet_paras(proj.bullets)

    if resume.education:
        flow.append(heading("education"))
        for edu in resume.education:
            line = ", ".join(b for b in [edu.degree, edu.field] if b) or edu.institution
            dates = " – ".join(d for d in [edu.start_date, edu.end_date] if d)
            tail = " | ".join(b for b in [edu.institution if line != edu.institution else "", dates] if b)
            flow.append(para(line, s["item"]))
            if tail:
                flow.append(para(tail, s["body"]))
            if edu.details:
                flow.append(para(edu.details, s["body"]))

    if resume.military_service:
        flow.append(heading("military"))
        for ms in resume.military_service:
            head = " — ".join(b for b in [ms.role, ms.unit] if b) or _HE_HEADINGS["military"]
            dates = " – ".join(b for b in [ms.start_date, ms.end_date] if b)
            meta = " | ".join(b for b in [ms.rank, dates] if b)
            flow.append(para(head, s["item"]))
            if meta:
                flow.append(para(meta, s["body"]))
            flow += bullet_paras(ms.bullets)

    if resume.certifications:
        flow.append(heading("certifications"))
        flow += bullet_paras(resume.certifications)

    if resume.languages:
        flow.append(heading("languages"))
        bits = [" – ".join(b for b in [ls.language, ls.level] if b) for ls in resume.languages]
        flow.append(para(" | ".join(b for b in bits if b), s["body"]))

    doc.build(flow)
    return buf.getvalue()
