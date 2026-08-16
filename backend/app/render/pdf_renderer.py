"""Render a ResumeModel to an ATS-safe PDF (reportlab, pure Python).

One layout engine serves both directions. Every run of text is broken into
lines by our own greedy line-breaker and drawn with `drawString`, so the
Hebrew path (each line bidi-reordered logical->visual, laid out right-to-left)
and the English path share the same geometry, rhythm and page rules instead of
two code paths that drift apart. reportlab's own wrapping is direction-blind,
which is why the RTL side cannot use `Paragraph`.

ATS-safe by construction: single column, real selectable text (never images),
no tables, no text boxes, no headers/footers, standard section names.

Hebrew uses the bundled Noto Sans Hebrew (OFL, see fonts/OFL.txt); Latin uses
the bundled Lato / Spectral (OFL). If a font file is ever missing the renderer
degrades to the base-14 faces rather than failing the download.
"""
from __future__ import annotations

import io
from functools import lru_cache
from pathlib import Path

from bidi.algorithm import get_display
from reportlab.lib.colors import Color, HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.pdfmetrics import registerFontFamily, stringWidth
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import BaseDocTemplate, Flowable, Frame, KeepTogether, PageTemplate

from app.core.lang import resume_language
from app.core.section_order import section_order
from app.models import ResumeModel
from app.render.labels import labels_for
from app.render.templates import DEFAULT_TEMPLATE, TemplateSpec, get_template

# --------------------------------------------------------------------------- #
# Fonts
# --------------------------------------------------------------------------- #
_FONTS_DIR = Path(__file__).parent / "fonts"
_HE_FAMILY = "NotoSansHebrew"

_FAMILY_FILES: dict[str, tuple[str, str, str]] = {
    "Lato": ("Lato-Regular.ttf", "Lato-Bold.ttf", "Lato-Italic.ttf"),
    "Spectral": ("Spectral-Regular.ttf", "Spectral-Bold.ttf", "Spectral-Italic.ttf"),
    # Noto Sans Hebrew covers Hebrew + Latin; it has no italic, so the regular
    # face doubles as one (résumés never need italic Hebrew).
    _HE_FAMILY: ("NotoSansHebrew-Regular.ttf", "NotoSansHebrew-Bold.ttf", "NotoSansHebrew-Regular.ttf"),
}
_FALLBACKS: dict[str, tuple[str, str, str]] = {
    "Spectral": ("Times-Roman", "Times-Bold", "Times-Italic"),
}
_BASE14 = ("Helvetica", "Helvetica-Bold", "Helvetica-Oblique")


@lru_cache(maxsize=None)
def _fonts(family: str) -> tuple[str, str, str]:
    """(regular, bold, italic) PDF font names, registering the bundled TTFs
    once per process. A missing file degrades to a base-14 face so a bad
    deploy yields a plain PDF instead of a failed download."""
    files = _FAMILY_FILES.get(family)
    if not files:
        return _FALLBACKS.get(family, _BASE14)
    names = (family, f"{family}-Bold", f"{family}-Italic")
    try:
        registered = set(pdfmetrics.getRegisteredFontNames())
        for name, filename in zip(names, files):
            if name not in registered:
                pdfmetrics.registerFont(TTFont(name, str(_FONTS_DIR / filename)))
        registerFontFamily(family, normal=names[0], bold=names[1], italic=names[2], boldItalic=names[1])
        return names
    except Exception:  # pragma: no cover — missing/corrupt font file
        return _FALLBACKS.get(family, _BASE14)


# --------------------------------------------------------------------------- #
# Text measuring / breaking / drawing
# --------------------------------------------------------------------------- #
def _adv(text: str, font: str, size: float, tracking: float = 0.0) -> float:
    """Visual width of one drawn line. Tc (char spacing) adds a gap after every
    glyph, but the gap after the last one carries no glyph, so only n-1 of them
    are visible — measuring that way keeps right/centre alignment optical."""
    extra = tracking * (len(text) - 1) if tracking and len(text) > 1 else 0.0
    return stringWidth(text, font, size) + extra


# Line breaking is pure given (text, font, size, width, tracking) — font metrics
# never change once `_fonts` has registered a face, and a fallback registers
# under a different NAME, so the key can't go stale. Caching it matters because
# the page budget (app.core.length_budget) is allowed 60 real builds per tailor
# and every one of them re-wraps the same bullets at the same column width:
# measured 21.4 -> 11.9 ms per page_count() on a 30-project résumé, for 37
# entries. Bounded so a long-lived process can't accumulate.
@lru_cache(maxsize=4096)
def _wrap_cached(text: str, font: str, size: float, width: float, tracking: float) -> tuple[str, ...]:
    lines: list[str] = []
    cur = ""
    for word in text.split():
        trial = f"{cur} {word}" if cur else word
        if cur and _adv(trial, font, size, tracking) > width:
            lines.append(cur)
            cur = word
        else:
            cur = trial
        # A single token longer than the column (a long URL) is hard-broken.
        while len(cur) > 1 and _adv(cur, font, size, tracking) > width:
            cut = 1
            while cut < len(cur) and _adv(cur[: cut + 1], font, size, tracking) <= width:
                cut += 1
            lines.append(cur[:cut])
            cur = cur[cut:]
    if cur:
        lines.append(cur)
    return tuple(lines) or ("",)


def _wrap_lines(text: str, font: str, size: float, width: float, tracking: float = 0.0) -> list[str]:
    """Greedy line break on LOGICAL text (bidi reordering happens per line, at
    draw time — reordering the whole paragraph first would stack the lines
    bottom-up). Returns a fresh list each call: the cache holds a tuple, so a
    caller that ever mutates its lines can't corrupt the next render."""
    return list(_wrap_cached(text or "", font, size, width, tracking))


def _visual(text: str) -> str:
    """Reorder one logical Hebrew/mixed line into visual order. base_dir='R'
    anchors mixed Hebrew/English lines right-to-left."""
    return get_display(text or "", base_dir="R")


def _place(x0: float, x1: float, width: float, align: str, rtl: bool) -> float:
    """Left edge for a run of `width` inside [x0, x1]. "start"/"end" are
    direction-relative: start is the left edge in LTR, the right edge in RTL."""
    if align == "center":
        return (x0 + x1 - width) / 2
    return x0 if ((align == "start") != rtl) else x1 - width


def _draw_line(canv, text, x0, x1, y, font, size, color, *, tracking=0.0, align="start", rtl=False) -> None:
    if not text:
        return
    shown = _visual(text) if rtl else text
    x = _place(x0, x1, _adv(shown, font, size, tracking), align, rtl)
    # A text object, not canvas.drawString: letter-spacing (PDF's Tc) is only
    # reachable through one, and tracked headings are what stop the sections
    # from reading like a Word document.
    obj = canv.beginText(x, y)
    obj.setFont(font, size)
    obj.setFillColor(color)
    if tracking:
        obj.setCharSpace(tracking)
    obj.textOut(shown)
    canv.drawText(obj)


# --------------------------------------------------------------------------- #
# Flowables — all direction-aware, all real text
# --------------------------------------------------------------------------- #
class _Text(Flowable):
    """A wrapped run in one style, optionally with a hanging bullet glyph."""

    def __init__(self, text, *, font, size, color, leading, tracking=0.0, align="start",
                 rtl=False, glyph="", glyph_color=None, indent=0.0,
                 space_before=0.0, space_after=0.0):
        super().__init__()
        self.text, self.font, self.size, self.color = text, font, size, color
        self.leading, self.tracking, self.align, self.rtl = leading, tracking, align, rtl
        self.glyph, self.glyph_color, self.indent = glyph, glyph_color or color, indent
        self.space_before, self.space_after = space_before, space_after

    def wrap(self, avail_w, avail_h):
        self._lines = _wrap_lines(self.text, self.font, self.size, avail_w - self.indent, self.tracking)
        self.width = avail_w
        self.height = self.space_before + len(self._lines) * self.leading + self.space_after
        return self.width, self.height

    def draw(self):
        base = self.height - self.space_before - pdfmetrics.getAscent(self.font, self.size)
        x0 = self.indent if not self.rtl else 0.0
        x1 = self.width if not self.rtl else self.width - self.indent
        for i, line in enumerate(self._lines):
            _draw_line(self.canv, line, x0, x1, base - i * self.leading, self.font, self.size,
                       self.color, tracking=self.tracking, align=self.align, rtl=self.rtl)
        if self.glyph:
            _draw_line(self.canv, self.glyph, 0.0, self.width, base, self.font, self.size,
                       self.glyph_color, align="start", rtl=self.rtl)


class _Row(Flowable):
    """Primary text with a meta value pinned to the opposite edge — the
    role/date line. In RTL the two swap sides automatically."""

    def __init__(self, primary, meta, *, font, size, color, meta_font, meta_size, meta_color,
                 leading, rtl=False, space_before=0.0, space_after=0.0):
        super().__init__()
        self.primary, self.meta = primary, meta
        self.font, self.size, self.color = font, size, color
        self.meta_font, self.meta_size, self.meta_color = meta_font, meta_size, meta_color
        self.leading, self.rtl = leading, rtl
        self.space_before, self.space_after = space_before, space_after

    def wrap(self, avail_w, avail_h):
        shown_meta = _visual(self.meta) if self.rtl else self.meta
        self._meta_w = _adv(shown_meta, self.meta_font, self.meta_size) if self.meta else 0.0
        limit = avail_w - (self._meta_w + 12 if self._meta_w else 0.0)
        self._lines = _wrap_lines(self.primary, self.font, self.size, max(limit, avail_w * 0.35))
        self.width = avail_w
        self.height = self.space_before + len(self._lines) * self.leading + self.space_after
        return self.width, self.height

    def draw(self):
        base = self.height - self.space_before - pdfmetrics.getAscent(self.font, self.size)
        for i, line in enumerate(self._lines):
            _draw_line(self.canv, line, 0.0, self.width, base - i * self.leading, self.font,
                       self.size, self.color, align="start", rtl=self.rtl)
        if self.meta:
            _draw_line(self.canv, self.meta, 0.0, self.width, base, self.meta_font,
                       self.meta_size, self.meta_color, align="end", rtl=self.rtl)


class _Segments(Flowable):
    """A separated inline list where each item can carry its own colour and
    link — the contact line, the employer · location line, the languages line.

    In RTL the items are laid out in reverse visual order (each item is
    bidi-reordered on its own), which keeps per-item colour and link boxes
    correct instead of collapsing the line into one flat string.
    """

    def __init__(self, segments, *, sep, sep_color, leading, align="start", rtl=False,
                 space_before=0.0, space_after=0.0):
        super().__init__()
        # segments: list of (text, font, size, color, url)
        self.segments = [s for s in segments if s[0]]
        self.sep, self.sep_color = sep, sep_color
        self.leading, self.align, self.rtl = leading, align, rtl
        self.space_before, self.space_after = space_before, space_after

    def wrap(self, avail_w, avail_h):
        order = list(reversed(self.segments)) if self.rtl else list(self.segments)
        rows: list[tuple[list[tuple], float]] = []
        row: list[tuple] = []
        x = 0.0
        for text, font, size, color, url in order:
            shown = _visual(text) if self.rtl else text
            w = _adv(shown, font, size)
            if row:
                sep_w = _adv(self.sep, font, size)
                if x + sep_w + w > avail_w:
                    rows.append((row, x))
                    row, x = [], 0.0
                else:
                    row.append((self.sep, font, size, self.sep_color, "", x))
                    x += sep_w
            row.append((shown, font, size, color, url, x))
            x += w
        if row:
            rows.append((row, x))
        self._rows = rows
        self.width = avail_w
        self.height = self.space_before + max(len(rows), 1) * self.leading + self.space_after
        return self.width, self.height

    def draw(self):
        canv = self.canv
        for i, (row, row_w) in enumerate(self._rows):
            if not row:
                continue
            top_font, top_size = row[0][1], row[0][2]
            base = self.height - self.space_before - pdfmetrics.getAscent(top_font, top_size) - i * self.leading
            start = _place(0.0, self.width, row_w, self.align, self.rtl)
            for shown, font, size, color, url, off in row:
                canv.setFont(font, size)
                canv.setFillColor(color)
                canv.drawString(start + off, base, shown)
                if url:
                    w = _adv(shown, font, size)
                    canv.linkURL(url, (start + off, base - 2, start + off + w, base + size), relative=1)


class _Heading(Flowable):
    """Section heading: tracked, uppercased (a no-op in Hebrew), over a
    hairline that spans the column."""

    def __init__(self, text, *, font, size, color, rule_color, tracking, rtl,
                 rule=True, space_before=0.0, space_after=0.0):
        super().__init__()
        self.text, self.font, self.size, self.color = text, font, size, color
        self.rule_color, self.tracking, self.rtl, self.rule = rule_color, tracking, rtl, rule
        self.space_before, self.space_after = space_before, space_after

    def wrap(self, avail_w, avail_h):
        self.width = avail_w
        self.height = self.space_before + self.size * 1.15 + (4.5 if self.rule else 0.0) + self.space_after
        return self.width, self.height

    def draw(self):
        base = self.height - self.space_before - pdfmetrics.getAscent(self.font, self.size)
        _draw_line(self.canv, self.text, 0.0, self.width, base, self.font, self.size, self.color,
                   tracking=self.tracking, align="start", rtl=self.rtl)
        if self.rule:
            y = self.space_after + 1.5
            self.canv.setStrokeColor(self.rule_color)
            self.canv.setLineWidth(0.6)
            self.canv.line(0, y, self.width, y)


class _Rule(Flowable):
    def __init__(self, color, *, thickness=0.8, space_before=0.0, space_after=0.0):
        super().__init__()
        self.color, self.thickness = color, thickness
        self.space_before, self.space_after = space_before, space_after

    def wrap(self, avail_w, avail_h):
        self.width = avail_w
        self.height = self.space_before + self.thickness + self.space_after
        return self.width, self.height

    def draw(self):
        self.canv.setStrokeColor(self.color)
        self.canv.setLineWidth(self.thickness)
        y = self.space_after + self.thickness / 2
        self.canv.line(0, y, self.width, y)


# --------------------------------------------------------------------------- #
# Style sheet resolved from one template spec
# --------------------------------------------------------------------------- #
def _mix(a: Color, b: Color, t: float) -> Color:
    return Color(a.red + (b.red - a.red) * t, a.green + (b.green - a.green) * t,
                 a.blue + (b.blue - a.blue) * t)


class _Sheet:
    def __init__(self, spec: TemplateSpec, rtl: bool, squeeze: float = 1.0):
        self.spec, self.rtl, self.squeeze = spec, rtl, squeeze
        self.reg, self.bold, self.ital = _fonts(_HE_FAMILY if rtl else spec.pdf_family)
        self.ink = HexColor(f"#{spec.ink}")
        self.muted = HexColor(f"#{spec.muted}")
        self.accent = HexColor(f"#{spec.accent}")
        self.rule = HexColor(f"#{spec.rule}")
        # Inline separators sit between the hairline and the body grey so they
        # read as punctuation, not as content.
        self.sep = _mix(self.muted, self.rule, 0.55)
        self.body = spec.body_size
        self.meta = spec.meta_size
        self.lead = spec.body_size * (1.26 if spec.tight else 1.36) * squeeze
        self.tight = spec.tight
        # Hebrew is unicase and its letterforms are already open — half the
        # Latin tracking keeps headings airy without looking spaced-out.
        self.track_head = spec.heading_tracking * (0.5 if rtl else 1.0)
        self.track_name = spec.name_tracking * (0.5 if rtl else 1.0)

    # vertical rhythm ------------------------------------------------------
    @property
    def sec_before(self) -> float:
        return (8.0 if self.tight else 12.0) * self.squeeze

    @property
    def sec_after(self) -> float:
        return (3.5 if self.tight else 5.0) * self.squeeze

    @property
    def entry_before(self) -> float:
        return (4.5 if self.tight else 7.0) * self.squeeze

    @property
    def bullet_after(self) -> float:
        return (0.5 if self.tight else 1.2) * self.squeeze


def _url(bit: str) -> str:
    """Best-effort link target for a contact bit. A space rules a bit out (that
    is a name or a city), and an all-digits token is a phone number, so what is
    left that carries a dot is a site or a profile."""
    b = bit.strip()
    if not b or " " in b:
        return ""
    if "@" in b:
        return f"mailto:{b}"
    if b.lower().startswith(("http://", "https://")):
        return b
    digits = b.translate(str.maketrans("", "", "+-.()"))
    if digits.isdigit() or "." not in b.strip("."):
        return ""
    return f"https://{b}"


# --------------------------------------------------------------------------- #
# Build
# --------------------------------------------------------------------------- #
# A résumé that spills three lines onto a second page reads as sloppy, and one
# page is the Israeli convention. When the overflow is small enough to absorb,
# the vertical rhythm is compressed (never the type size) until it fits; below
# this floor the résumé is genuinely a two-pager and is left alone.
_MIN_SQUEEZE = 0.86


def _content_height(flow: list, width: float) -> float:
    """Total height of the built flow. KeepTogether reports a sentinel height,
    so its children are measured directly."""
    total = 0.0
    for f in flow:
        for item in (f._content if isinstance(f, KeepTogether) else [f]):
            total += item.wrap(width, 0)[1]
    return total


def fit_squeeze(resume: ResumeModel, spec: TemplateSpec, rtl: bool) -> float:
    """How far the vertical rhythm has to compress for this résumé to land on a
    single page: 1.0 when it already fits, and 1.0 again when it is a genuine
    two-pager that no reasonable squeeze would rescue.

    The DOCX renderer reuses this so both downloads make the same call about
    one page vs. two, even though Word does its own line breaking.
    """
    s = _Sheet(spec, rtl)
    flow = _flow(resume, s, labels_for("he" if rtl else "en"))
    capacity = spec.page_h_pt - 2 * spec.margin_tb_pt
    total = _content_height(flow, spec.page_w_pt - 2 * spec.margin_lr_pt)
    if total <= capacity or total > capacity / _MIN_SQUEEZE:
        return 1.0
    # 0.985 leaves room for the slack that keep-together groups leave at a page
    # foot, which the flat sum above cannot see.
    return max(_MIN_SQUEEZE, capacity / total * 0.985)


def _render(resume: ResumeModel, template: str) -> tuple[bytes, int]:
    """Build the PDF once and report both the bytes and the page count.

    `page_count` needs the same layout the download gets — same template, same
    squeeze, same keep-together grouping — so both callers share this build
    rather than one of them estimating.
    """
    spec = get_template(template)
    rtl = resume_language(resume) == "he"
    labels = labels_for("he" if rtl else "en")

    s = _Sheet(spec, rtl, squeeze=fit_squeeze(resume, spec, rtl))
    flow = _flow(resume, s, labels)

    buf = io.BytesIO()
    doc = BaseDocTemplate(
        buf,
        pagesize=(spec.page_w_pt, spec.page_h_pt),
        topMargin=spec.margin_tb_pt, bottomMargin=spec.margin_tb_pt,
        leftMargin=spec.margin_lr_pt, rightMargin=spec.margin_lr_pt,
        title=resume.contact.name or "Resume",
        author=resume.contact.name or "",
        subject="Resume",
    )
    # Zero frame padding: reportlab's default 6pt inset would silently eat the
    # margins the template asked for (and used to break the RTL line breaker,
    # which measured against the un-padded width).
    doc.addPageTemplates([
        PageTemplate(id="body", frames=[
            Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height,
                  leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0, id="body")
        ])
    ])

    doc.build(flow)
    # reportlab counts pages as it lays them out; `doc.page` is the last one.
    return buf.getvalue(), max(1, int(getattr(doc, "page", 1) or 1))


def render_pdf(resume: ResumeModel, template: str = DEFAULT_TEMPLATE) -> bytes:
    return _render(resume, template)[0]


def page_count(resume: ResumeModel, template: str = DEFAULT_TEMPLATE) -> int:
    """Pages this résumé actually renders to — measured, not estimated.

    The length budget (`app.core.length_budget`) trims against this, so it has
    to be the real pagination: a flat sum of content heights misses the slack
    keep-together groups leave at a page foot and would call a 3-pager a
    2-pager.
    """
    return _render(resume, template)[1]


def _flow(resume: ResumeModel, s: _Sheet, labels: dict[str, str]) -> list:
    spec = s.spec
    flow: list = []
    name_align = "center" if spec.name_centered else "start"

    # --- header -----------------------------------------------------------
    c = resume.contact
    flow.append(_Text(
        c.name or "Name", font=s.bold, size=spec.name_size,
        color=s.accent if spec.accent_name else s.ink,
        leading=spec.name_size * 1.18, tracking=s.track_name,
        align=name_align, rtl=s.rtl, space_after=1.0,
    ))
    if resume.headline:
        # Sits between the name and the contact line: the first thing a
        # recruiter reads after the name, and what the ATS matches on. Coloured
        # opposite the name so the two never flatten into one block.
        flow.append(_Text(
            resume.headline, font=s.reg, size=s.body + 0.8,
            color=s.ink if spec.accent_name else s.accent,
            leading=(s.body + 0.8) * 1.35, tracking=0.3 * (0.5 if s.rtl else 1.0),
            align=name_align, rtl=s.rtl, space_before=1.0, space_after=1.0,
        ))

    bits = [b for b in [c.email, c.phone, c.location, c.linkedin, c.website] if b]
    if bits:
        flow.append(_Segments(
            [(b, s.reg, spec.meta_size, s.muted, "" if s.rtl else _url(b)) for b in bits],
            sep=" · ", sep_color=s.sep, leading=spec.meta_size * 1.45,
            align=name_align, rtl=s.rtl,
            # Without a rule to separate it, the header needs the air itself.
            space_after=0.0 if spec.header_rule else 5.0,
        ))
    if spec.header_rule:
        flow.append(_Rule(s.rule, thickness=0.8, space_before=6.0, space_after=0.0))

    def heading(key: str):
        text = labels[key] if s.rtl else labels[key].upper()
        return _Heading(
            text, font=s.bold, size=spec.heading_size, color=s.accent, rule_color=s.rule,
            tracking=s.track_head, rtl=s.rtl, rule=spec.heading_rule,
            space_before=s.sec_before, space_after=s.sec_after,
        )

    def body(text: str, **kw):
        return _Text(text, font=s.reg, size=s.body, color=s.ink, leading=s.lead, rtl=s.rtl, **kw)

    def bullet(text: str, last: bool = False):
        return _Text(text, font=s.reg, size=s.body, color=s.ink, leading=s.lead, rtl=s.rtl,
                     glyph="•", glyph_color=s.muted, indent=s.body * 1.05,
                     space_after=0.0 if last else s.bullet_after)

    def entry(primary: str, meta: str, secondary: list[tuple], bullets: list[str], first: bool):
        """One role: the title/date row, the employer · location row, and the
        bullets. Returns (opening, trailing) as flat lists — `section` glues
        the opening together so a role never strands its head at the foot of a
        page, while the trailing bullets stay free to flow. Both lists stay
        flat: a KeepTogether nested inside another reports a sentinel height
        and would push every section onto its own page."""
        head: list = [_Row(
            primary, meta, font=s.bold, size=s.body, color=s.ink,
            meta_font=s.reg, meta_size=s.meta, meta_color=s.muted,
            leading=s.lead, rtl=s.rtl, space_before=0.0 if first else s.entry_before,
        )]
        if any(part[0] for part in secondary):
            head.append(_Segments(secondary, sep=" · ", sep_color=s.sep, leading=s.lead,
                                  align="start", rtl=s.rtl))
        live = [b for b in bullets if b]
        items = [bullet(b, last=(i == len(live) - 1)) for i, b in enumerate(live)]
        return head + items[:1], items[1:]

    def section(key: str, entries: list) -> None:
        """Heading + entries; the heading is glued to the first entry."""
        if not entries:
            return
        opening, trailing = entries[0]
        flow.append(KeepTogether([heading(key)] + opening))
        flow.extend(trailing)
        for opening, trailing in entries[1:]:
            flow.append(KeepTogether(opening))
            flow.extend(trailing)

    def seg(text: str, color, size: float | None = None) -> tuple:
        return (text, s.reg, size if size is not None else s.body, color, "")

    # One builder per section key; the ORDER comes from section_order(), which
    # puts Education above Experience for an early-career résumé.
    def build_summary() -> None:
        if resume.summary:
            flow.append(KeepTogether([heading("summary"), body(resume.summary)]))

    def build_skills() -> None:
        if resume.skills:
            # Comma-separated on purpose: it is what ATS keyword parsers split on.
            flow.append(KeepTogether([heading("skills"), body(", ".join(resume.skills))]))

    def build_experience() -> None:
        section("experience", [
            entry(
                exp.title or exp.company,
                " – ".join(b for b in [exp.start_date, exp.end_date] if b),
                [seg(exp.company if exp.title else "", s.accent), seg(exp.location, s.muted, s.meta)],
                exp.bullets, first=(i == 0),
            )
            for i, exp in enumerate(resume.experience)
        ])

    def build_projects() -> None:
        # A project description is PROSE, so it gets wrapping body text. It used
        # to ride in the `secondary` meta slot — the single non-wrapping row
        # sized for "Company · Location" — which silently ran anything longer
        # than one line off the right edge of the page and clipped it.
        def project(proj, first: bool):
            opening, trailing = entry(proj.name, "", [], proj.bullets, first=first)
            if proj.description:
                desc = _Text(proj.description, font=s.reg, size=s.body, color=s.muted,
                             leading=s.lead, rtl=s.rtl, space_after=s.bullet_after)
                opening = opening[:1] + [desc] + opening[1:]
            return opening, trailing

        section("projects", [project(p, i == 0) for i, p in enumerate(resume.projects)])

    def build_education() -> None:
        section("education", [
            entry(
                ", ".join(b for b in [edu.degree, edu.field] if b) or edu.institution,
                " – ".join(d for d in [edu.start_date, edu.end_date] if d),
                [seg(edu.institution if (edu.degree or edu.field) else "", s.accent)],
                [edu.details] if edu.details else [],
                first=(i == 0),
            )
            for i, edu in enumerate(resume.education)
        ])

    def build_military() -> None:
        section("military", [
            entry(
                " — ".join(b for b in [ms.role, ms.unit] if b) or labels["military"],
                " – ".join(b for b in [ms.start_date, ms.end_date] if b),
                [seg(ms.rank, s.muted, s.meta)],
                ms.bullets, first=(i == 0),
            )
            for i, ms in enumerate(resume.military_service)
        ])

    def build_certifications() -> None:
        live = [cert for cert in resume.certifications if cert]
        if not live:
            return
        items = [bullet(cert, last=(i == len(live) - 1)) for i, cert in enumerate(live)]
        flow.append(KeepTogether([heading("certifications"), items[0]]))
        flow.extend(items[1:])

    def build_languages() -> None:
        segs = [
            seg(" – ".join(b for b in [ls.language, ls.level] if b), s.ink)
            for ls in resume.languages
        ]
        if not any(x[0] for x in segs):
            return
        flow.append(KeepTogether([
            heading("languages"),
            _Segments(segs, sep=" · ", sep_color=s.sep, leading=s.lead, align="start", rtl=s.rtl),
        ]))

    builders = {
        "summary": build_summary, "skills": build_skills, "experience": build_experience,
        "projects": build_projects, "education": build_education, "military": build_military,
        "certifications": build_certifications, "languages": build_languages,
    }
    for key in section_order(resume):
        builders[key]()

    return flow
