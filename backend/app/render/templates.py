"""Résumé template registry shared by both renderers (PLAN 6).

Every template is ATS-safe BY CONSTRUCTION: a spec may only vary the page
size, margins, fonts, type sizes, the palette, and the vertical rhythm /
hairline treatment. The renderers keep a single column, real selectable text,
and zero tables / text boxes / images / headers / footers no matter which
template is chosen — so adding a template here cannot break the ATS rules.
The smoke test renders every template in both formats and both languages and
re-extracts the text to prove the tagline: "every template passes our own ATS
scan".

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

    # --- type -------------------------------------------------------------
    pdf_family: str = "Lato"  # bundled family the PDF embeds
    docx_font: str = "Calibri"  # family name Word resolves locally
    body_size: float = 10.2
    heading_size: float = 9.5
    name_size: float = 22.0
    meta_size: float = 9.0

    # --- layout -----------------------------------------------------------
    name_centered: bool = True  # False = name sits at the text start (right in RTL)
    accent_name: bool = False  # print the name in the accent colour
    name_tracking: float = 1.0  # extra letter-spacing, pt
    heading_tracking: float = 1.0
    header_rule: bool = True  # hairline under the contact block
    heading_rule: bool = True  # hairline under every section heading
    margin_tb_pt: float = 46.0
    margin_lr_pt: float = 54.0
    page_w_pt: float = A4_W
    page_h_pt: float = A4_H
    tight: bool = False  # compact vertical rhythm (the Israeli one-pager convention)


TEMPLATES: dict[str, TemplateSpec] = {
    # Navy + centred name. The safe default.
    "classic": TemplateSpec(
        id="classic", accent="1F3A5F", ink="1A1A1A", muted="5C6470", rule="D5D9E0",
        pdf_family="Lato", docx_font="Calibri",
        body_size=10.2, heading_size=9.5, name_size=22.0, meta_size=9.0,
        name_centered=True, name_tracking=1.1, heading_tracking=1.1,
        margin_tb_pt=46, margin_lr_pt=54, tight=False,
    ),
    # Teal, name anchored to the text start and set in the accent colour.
    "modern": TemplateSpec(
        id="modern", accent="0E7A5F", ink="14181F", muted="59616E", rule="D9E2DE",
        pdf_family="Lato", docx_font="Calibri",
        body_size=10.2, heading_size=9.5, name_size=25.0, meta_size=9.0,
        name_centered=False, accent_name=True, name_tracking=0.3, heading_tracking=1.2,
        margin_tb_pt=48, margin_lr_pt=56, tight=False,
    ),
    # Dense one-pager — the Israeli convention (PLAN 3.4): smaller type,
    # tighter spacing, neutral headings.
    "compact": TemplateSpec(
        id="compact", accent="333A44", ink="1A1A1A", muted="5C6470", rule="D8DBE0",
        pdf_family="Lato", docx_font="Calibri",
        body_size=9.7, heading_size=9.0, name_size=18.0, meta_size=8.6,
        name_centered=True, name_tracking=1.0, heading_tracking=0.9,
        margin_tb_pt=34, margin_lr_pt=44, tight=True,
    ),
    # Serif, roomy, deep navy — reads senior. Georgia is the Word twin of the
    # bundled Spectral.
    "executive": TemplateSpec(
        id="executive", accent="16304B", ink="1B1B1B", muted="5A5F6A", rule="D6D9DE",
        pdf_family="Spectral", docx_font="Georgia",
        body_size=10.0, heading_size=9.8, name_size=23.0, meta_size=9.0,
        name_centered=True, name_tracking=1.5, heading_tracking=1.3,
        margin_tb_pt=52, margin_lr_pt=62, tight=False,
    ),
    # No colour at all: graphite headings, wide tracking, generous whitespace.
    "minimal": TemplateSpec(
        id="minimal", accent="374151", ink="111827", muted="6B7280", rule="E4E7EB",
        pdf_family="Lato", docx_font="Calibri",
        body_size=10.2, heading_size=9.0, name_size=24.0, meta_size=9.0,
        name_centered=False, name_tracking=0.2, heading_tracking=1.8,
        header_rule=False, margin_tb_pt=54, margin_lr_pt=64, tight=False,
    ),
}
DEFAULT_TEMPLATE = "classic"


def get_template(name: str | None) -> TemplateSpec:
    return TEMPLATES.get((name or "").strip().lower(), TEMPLATES[DEFAULT_TEMPLATE])
