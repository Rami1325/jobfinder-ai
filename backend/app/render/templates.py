"""Résumé template registry shared by both renderers (PLAN 6).

Every template is ATS-safe BY CONSTRUCTION: a spec may only vary fonts, sizes,
the accent color, margins, name alignment, and vertical rhythm. The renderers
keep a single column, real selectable text, and zero tables / text boxes /
images / headers / footers no matter which template is chosen — so adding a
template here cannot break the ATS rules. The smoke test renders every
template in both formats and both languages and re-extracts the text to prove
the tagline: "every template passes our own ATS scan".

Unknown/empty template names fall back to the default, so old clients that
never send `template` keep getting today's exact output.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class TemplateSpec:
    id: str
    accent: str  # heading hex color, no leading "#"
    docx_font: str  # Latin font family for the DOCX path
    body_size: float  # pt
    heading_size: float
    name_size: float
    name_centered: bool  # False = name sits at the text start (right in RTL)
    margin_tb_pt: float  # top/bottom page margin
    margin_lr_pt: float  # left/right page margin
    tight: bool  # compact vertical rhythm (the Israeli one-pager convention)


TEMPLATES: dict[str, TemplateSpec] = {
    # The pre-templates output, byte-for-byte intent: safe default.
    "classic": TemplateSpec(
        id="classic", accent="1A3C6E", docx_font="Calibri",
        body_size=10.5, heading_size=11.5, name_size=20,
        name_centered=True, margin_tb_pt=40, margin_lr_pt=54, tight=False,
    ),
    # Roomier, teal accent, name anchored to the text start.
    "modern": TemplateSpec(
        id="modern", accent="0E7A5F", docx_font="Arial",
        body_size=10.5, heading_size=12.0, name_size=22,
        name_centered=False, margin_tb_pt=46, margin_lr_pt=58, tight=False,
    ),
    # Dense one-pager — the Israeli convention (see PLAN 3.4): smaller type,
    # tighter spacing, neutral headings.
    "compact": TemplateSpec(
        id="compact", accent="333333", docx_font="Calibri",
        body_size=10.0, heading_size=10.5, name_size=16,
        name_centered=True, margin_tb_pt=30, margin_lr_pt=44, tight=True,
    ),
}
DEFAULT_TEMPLATE = "classic"


def get_template(name: str | None) -> TemplateSpec:
    return TEMPLATES.get((name or "").strip().lower(), TEMPLATES[DEFAULT_TEMPLATE])
