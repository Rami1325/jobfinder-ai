"""Section headings shared by both renderers — and by the document on screen.

Standard names matter for ATS: parsers look for "Experience"/"Education" and
their Hebrew equivalents. Keeping the two renderers on one table means a Hebrew
heading can never drift between the DOCX and the PDF.

TWO SETS, chosen per template by `TemplateSpec.label_set`:

* **"short"** — the standard names, and what eleven of the twelve templates
  print. Every one of them is a heading an ATS parser is written to recognise.
* **"full"** — the longer business wording ("Professional Summary", "Core
  Expertise"), which `standard` prints. **Chosen explicitly by the owner on
  2026-09-06**, over exactly this objection: "Core Expertise" is not a name a
  keyword parser is written to look for, and a parser that sections a résumé by
  heading may not read the list under it as skills. It is recorded here rather
  than argued again, because the trade is real and someone will re-open it.

  Two of the long names are deliberately NOT verbatim copies of the source
  document. It headed its projects "SELECTED AI SOLUTIONS & PRODUCTS", and a
  template cannot know the candidate's field — printing "AI Solutions" over a
  marketing CV's projects would be worse than either name — so the set carries
  the domain-free "Selected Projects". `military` and `certifications` never
  appeared in the source at all and keep the standard names: inventing a longer
  form for a section nobody wrote is guessing, not reproducing.

A set may only ever RENAME. Adding or dropping a key would let one template
render a section another one hides, which is a layout decision and belongs in
`section_order`.
"""
from __future__ import annotations

SECTION_LABELS: dict[str, dict[str, dict[str, str]]] = {
    "short": {
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
    },
    "full": {
        "en": {
            "summary": "Professional Summary",
            "skills": "Core Expertise",
            "experience": "Professional Experience",
            "projects": "Selected Projects",
            "education": "Education",
            "military": "Military Service",
            "certifications": "Certifications",
            "languages": "Languages",
        },
        "he": {
            "summary": "תקציר מקצועי",
            "skills": "מומחיות ליבה",
            # Already the long form in Hebrew — "ניסיון" alone reads as
            # inexperience, so the short set spells it out too and the two sets
            # legitimately agree here.
            "experience": "ניסיון תעסוקתי",
            "projects": "פרויקטים נבחרים",
            "education": "השכלה",
            "military": "שירות צבאי",
            "certifications": "הסמכות",
            "languages": "שפות",
        },
    },
}

DEFAULT_LABEL_SET = "short"


def labels_for(lang: str, label_set: str = DEFAULT_LABEL_SET) -> dict[str, str]:
    """Section names for one language and one template's `label_set`.

    An unknown set falls back to "short" the way `get_template` falls back to
    the default template: a stored kit or an old client naming a set this build
    has never heard of renders standard headings rather than raw keys.
    """
    per_set = SECTION_LABELS.get(label_set) or SECTION_LABELS[DEFAULT_LABEL_SET]
    return per_set["he" if lang == "he" else "en"]
