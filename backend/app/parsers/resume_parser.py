"""Extract raw text from an uploaded resume (DOCX or PDF).

Also handles LinkedIn's profile export ("Profile.pdf" via More → Save to PDF):
the export is two-column (narrow sidebar with Contact/Top Skills/Languages,
wide main column with Summary/Experience/Education), and naive line-based PDF
extraction interleaves the columns mid-line — sidebar skills bleed into the
summary. When a LinkedIn export is detected, the page is re-extracted per
column (measured from a real export: sidebar ends ~x=185/612, main starts
~x=220, so the split ratio hits the gutter's center), and
`clean_linkedin_profile_text` strips the per-page footers and UI labels.
Both steps are no-ops for anything that isn't a LinkedIn export.
"""
from __future__ import annotations

import io
import re

from app.config import get_settings

# "Page 1 of 3" footer LinkedIn stamps on every exported page.
_LI_PAGE_FOOTER_RE = re.compile(r"^\s*Page \d+ of \d+\s*$", re.MULTILINE)
# The "(LinkedIn)" suffix the export appends after the profile URL.
_LI_URL_LABEL_RE = re.compile(r"\(LinkedIn\)")


def is_linkedin_profile_export(text: str) -> bool:
    """True for text extracted from LinkedIn's 'Save to PDF' profile export:
    it always carries the profile URL plus per-page 'Page N of N' footers."""
    return "linkedin.com/in/" in text and bool(_LI_PAGE_FOOTER_RE.search(text))


def clean_linkedin_profile_text(text: str) -> str:
    """Strip LinkedIn-export noise (page footers, URL label); returns other
    text unchanged so it is safe to run on every upload."""
    if not is_linkedin_profile_export(text):
        return text
    cleaned = _LI_PAGE_FOOTER_RE.sub("", text)
    cleaned = _LI_URL_LABEL_RE.sub("", cleaned)
    # Collapse the blank runs the removals leave behind.
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


def extract_text(filename: str, data: bytes) -> str:
    name = (filename or "").lower()
    if name.endswith(".docx"):
        return _extract_docx(data)
    if name.endswith(".pdf"):
        text = _extract_pdf(data)
        if is_linkedin_profile_export(text):
            columns = _extract_pdf_linkedin_columns(data)
            # Guard against layout drift: the re-extraction must carry (almost)
            # all the same text, or we keep the naive interleaved version.
            if len(columns) >= 0.8 * len(text):
                text = columns
        return clean_linkedin_profile_text(text)
    if name.endswith(".txt"):
        return data.decode("utf-8", errors="ignore")
    raise ValueError("Unsupported file type. Upload a .docx, .pdf, or .txt resume.")


def _extract_docx(data: bytes) -> str:
    from docx import Document

    doc = Document(io.BytesIO(data))
    lines: list[str] = []
    for para in doc.paragraphs:
        if para.text.strip():
            lines.append(para.text)
    # Capture text in tables too (some resumes use them for layout).
    for table in doc.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            if cells:
                lines.append(" | ".join(cells))
    return "\n".join(lines)


def _assert_page_count(pdf) -> None:  # noqa: ANN001 - pdfplumber.PDF
    """Refuse absurd page counts before extracting.

    `pdf.pages` is lazy, so counting is cheap while extraction is not — this is
    the cheapest place to stop a crafted PDF from burning an instance's CPU on
    the no-access-code /public/scan route. The ceiling is deliberately far above
    any real résumé (a master CV runs ~30 rendered pages at the extreme).
    """
    limit = get_settings().max_pdf_pages
    if len(pdf.pages) > limit:
        raise ValueError(f"That PDF has too many pages ({len(pdf.pages)}); {limit} is the limit.")


def _extract_pdf(data: bytes) -> str:
    import pdfplumber

    parts: list[str] = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        _assert_page_count(pdf)
        for page in pdf.pages:
            text = page.extract_text() or ""
            if text.strip():
                parts.append(text)
    return "\n".join(parts)


# LinkedIn export pages are 612pt wide; the sidebar ends ~x=185 and the main
# column starts ~x=220, so 0.34 (~x=208) lands inside the gutter.
_LI_COLUMN_SPLIT_RATIO = 0.34


def _extract_pdf_linkedin_columns(data: bytes) -> str:
    """Re-extract a LinkedIn profile export column by column: all sidebar text
    (Contact, Top Skills, Languages, Certifications) first, then the main
    column (name, Summary, Experience, Education) — so neither stream bleeds
    into the other. Pages without sidebar text (page 2+) contribute only to
    the main stream."""
    import pdfplumber

    sidebar: list[str] = []
    main: list[str] = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for page in pdf.pages:
            split_x = page.width * _LI_COLUMN_SPLIT_RATIO
            left = page.crop((0, 0, split_x, page.height)).extract_text() or ""
            right = page.crop((split_x, 0, page.width, page.height)).extract_text() or ""
            if left.strip():
                sidebar.append(left)
            if right.strip():
                main.append(right)
    return "\n".join(sidebar + main)
