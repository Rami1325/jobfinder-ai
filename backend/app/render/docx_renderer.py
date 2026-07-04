"""Render a ResumeModel to an ATS-safe DOCX.

ATS rules honored: single column, standard headings, no tables/text-boxes/images,
no headers/footers, standard fonts, simple bullets, contact info in the body.

Hebrew resumes (detected via resume_language) get RTL paragraph direction
(w:bidi) + RTL runs (w:rtl) and Hebrew section headings; English resumes take
exactly the same code path as before — no RTL properties are written.
"""
from __future__ import annotations

import io

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor

from app.core.lang import resume_language
from app.models import ResumeModel

_FONT = "Calibri"
_DARK = RGBColor(0x22, 0x22, 0x22)

# Standard section names, English and Hebrew (standard names matter for ATS).
_LABELS = {
    "en": {
        "summary": "Summary",
        "skills": "Skills",
        "experience": "Experience",
        "projects": "Projects",
        "education": "Education",
        "military": "Military Service",
        "certifications": "Certifications",
        "languages": "Languages",
    },
    "he": {
        "summary": "תקציר",
        "skills": "כישורים",
        "experience": "ניסיון תעסוקתי",
        "projects": "פרויקטים",
        "education": "השכלה",
        "military": "שירות צבאי",
        "certifications": "הסמכות",
        "languages": "שפות",
    },
}


def _set_rtl(paragraph) -> None:
    """Mark one paragraph as right-to-left: w:bidi on the paragraph (direction +
    right alignment, since 'start' = right in a bidi paragraph) and w:rtl on
    every run (tells Word the runs hold RTL text)."""
    p_pr = paragraph._p.get_or_add_pPr()
    if p_pr.find(qn("w:bidi")) is None:
        p_pr.append(paragraph._p.makeelement(qn("w:bidi"), {}))
    for run in paragraph.runs:
        r_pr = run._r.get_or_add_rPr()
        if r_pr.find(qn("w:rtl")) is None:
            r_pr.append(run._r.makeelement(qn("w:rtl"), {}))


def render_docx(resume: ResumeModel) -> bytes:
    lang = resume_language(resume)
    labels = _LABELS["he" if lang == "he" else "en"]

    doc = Document()

    style = doc.styles["Normal"]
    style.font.name = _FONT
    style.font.size = Pt(10.5)
    style.font.color.rgb = _DARK

    for section in doc.sections:
        section.top_margin = section.bottom_margin = Pt(40)
        section.left_margin = section.right_margin = Pt(54)

    c = resume.contact
    name = c.name or "Name"
    name_p = doc.add_paragraph()
    name_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = name_p.add_run(name)
    run.bold = True
    run.font.size = Pt(20)

    contact_bits = [b for b in [c.email, c.phone, c.location, c.linkedin, c.website] if b]
    if contact_bits:
        cp = doc.add_paragraph()
        cp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        cp.add_run(" | ".join(contact_bits)).font.size = Pt(9.5)

    if resume.summary:
        _heading(doc, labels["summary"])
        doc.add_paragraph(resume.summary)

    if resume.skills:
        _heading(doc, labels["skills"])
        doc.add_paragraph(", ".join(resume.skills))

    if resume.experience:
        _heading(doc, labels["experience"])
        for exp in resume.experience:
            p = doc.add_paragraph()
            left = " — ".join(b for b in [exp.title, exp.company] if b)
            r = p.add_run(left)
            r.bold = True
            dates = " – ".join(b for b in [exp.start_date, exp.end_date] if b)
            meta = " | ".join(b for b in [exp.location, dates] if b)
            if meta:
                p.add_run(f"   ({meta})").italic = True
            for bullet in exp.bullets:
                bp = doc.add_paragraph(bullet, style="List Bullet")
                bp.paragraph_format.space_after = Pt(2)

    if resume.projects:
        _heading(doc, labels["projects"])
        for proj in resume.projects:
            p = doc.add_paragraph()
            p.add_run(proj.name).bold = True
            if proj.description:
                p.add_run(f" — {proj.description}")
            for bullet in proj.bullets:
                doc.add_paragraph(bullet, style="List Bullet")

    if resume.education:
        _heading(doc, labels["education"])
        for edu in resume.education:
            p = doc.add_paragraph()
            line = ", ".join(b for b in [edu.degree, edu.field] if b)
            p.add_run(line or edu.institution).bold = True
            tail = " | ".join(
                b for b in [edu.institution if line else "", " – ".join(d for d in [edu.start_date, edu.end_date] if d)] if b
            )
            if tail:
                p.add_run(f"   ({tail})").italic = True
            if edu.details:
                doc.add_paragraph(edu.details)

    if resume.military_service:
        _heading(doc, labels["military"])
        for ms in resume.military_service:
            p = doc.add_paragraph()
            left = " — ".join(b for b in [ms.role, ms.unit] if b)
            p.add_run(left or labels["military"]).bold = True
            dates = " – ".join(b for b in [ms.start_date, ms.end_date] if b)
            meta = " | ".join(b for b in [ms.rank, dates] if b)
            if meta:
                p.add_run(f"   ({meta})").italic = True
            for bullet in ms.bullets:
                bp = doc.add_paragraph(bullet, style="List Bullet")
                bp.paragraph_format.space_after = Pt(2)

    if resume.certifications:
        _heading(doc, labels["certifications"])
        for cert in resume.certifications:
            doc.add_paragraph(cert, style="List Bullet")

    if resume.languages:
        _heading(doc, labels["languages"])
        bits = [" – ".join(b for b in [ls.language, ls.level] if b) for ls in resume.languages]
        doc.add_paragraph(" | ".join(b for b in bits if b))

    if lang == "he":
        # One sweep over every paragraph written above (incl. bullets) so no
        # text path can miss the RTL properties.
        for paragraph in doc.paragraphs:
            _set_rtl(paragraph)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _heading(doc: Document, text: str) -> None:
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(10)
    p.paragraph_format.space_after = Pt(2)
    run = p.add_run(text.upper())
    run.bold = True
    run.font.size = Pt(11.5)
    run.font.color.rgb = RGBColor(0x1A, 0x3C, 0x6E)
