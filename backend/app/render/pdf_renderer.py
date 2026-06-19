"""Render a ResumeModel to an ATS-safe PDF using reportlab (pure-Python).

Single-column flowing layout, standard fonts, real selectable text (not images),
so ATS parsers can read it.
"""
from __future__ import annotations

import io

from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import ListFlowable, ListItem, Paragraph, SimpleDocTemplate, Spacer

from app.models import ResumeModel

_ACCENT = HexColor("#1A3C6E")
_DARK = HexColor("#222222")


def _styles():
    base = getSampleStyleSheet()
    return {
        "name": ParagraphStyle("Name", parent=base["Title"], fontSize=20, alignment=TA_CENTER, textColor=_DARK, spaceAfter=2),
        "contact": ParagraphStyle("Contact", parent=base["Normal"], fontSize=9, alignment=TA_CENTER, textColor=_DARK, spaceAfter=8),
        "heading": ParagraphStyle("Heading", parent=base["Heading2"], fontSize=11.5, textColor=_ACCENT, spaceBefore=10, spaceAfter=3),
        "body": ParagraphStyle("Body", parent=base["Normal"], fontSize=10.5, textColor=_DARK, leading=14),
        "item": ParagraphStyle("ItemHead", parent=base["Normal"], fontSize=10.5, textColor=_DARK, leading=14, spaceBefore=4),
    }


def _esc(text: str) -> str:
    return (text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def render_pdf(resume: ResumeModel) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=LETTER,
        topMargin=0.55 * inch, bottomMargin=0.55 * inch,
        leftMargin=0.75 * inch, rightMargin=0.75 * inch,
        title=resume.contact.name or "Resume",
    )
    s = _styles()
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

    if resume.certifications:
        flow.append(Paragraph("CERTIFICATIONS", s["heading"]))
        flow.append(bullets(resume.certifications))

    doc.build(flow)
    return buf.getvalue()
