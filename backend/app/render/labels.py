"""Section headings shared by both renderers.

Standard names matter for ATS — parsers look for "Experience"/"Education" and
their Hebrew equivalents. Keeping the two renderers on one table means a
Hebrew heading can never drift between the DOCX and the PDF.
"""
from __future__ import annotations

SECTION_LABELS: dict[str, dict[str, str]] = {
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


def labels_for(lang: str) -> dict[str, str]:
    return SECTION_LABELS["he" if lang == "he" else "en"]
