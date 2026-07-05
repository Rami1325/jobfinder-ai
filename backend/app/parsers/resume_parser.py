"""Extract raw text from an uploaded resume (DOCX or PDF).

Also handles LinkedIn's profile export ("Profile.pdf" via More → Save to PDF):
`clean_linkedin_profile_text` strips the per-page footers and UI labels the
export sprinkles through the text, so the structurer sees clean content. It's
a no-op for anything that isn't a LinkedIn export (pure, smoke-pinned).
"""
from __future__ import annotations

import io
import re

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
        return clean_linkedin_profile_text(_extract_pdf(data))
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


def _extract_pdf(data: bytes) -> str:
    import pdfplumber

    parts: list[str] = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            if text.strip():
                parts.append(text)
    return "\n".join(parts)
