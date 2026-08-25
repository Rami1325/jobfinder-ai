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
from reportlab.platypus import (BaseDocTemplate, Flowable, Frame, FrameBreak, KeepTogether,
                                PageTemplate)

from app.core.lang import resume_language
from app.core.section_order import section_order
from app.core.skills import skill_blocks
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
# Vector icons
# --------------------------------------------------------------------------- #
# Small marks on the contact row (and, optionally, a calendar on an entry's
# dates). They are DRAWN PATHS, never glyphs — that is the whole point:
#
#   * No bundled face (Lato, Spectral, Noto Sans Hebrew) has an envelope or a
#     map pin. Asking for one prints a tofu box.
#   * A unicode dingbat that DID render would also land in the extracted text —
#     on the exact line an ATS parses as the email address. "✉ me@example.com"
#     is a worse contact line than no icon at all.
#   * A path emits no text operators, so extraction sees precisely what it saw
#     before the icons existed. The smoke test pins that byte-for-byte.
#
# Each icon is defined inside a UNIT BOX (0..1 in x and y) and drawn through a
# scaled CTM, so one definition serves every size. Line width is in unit space
# too (0.09 => 0.09 * size pt), which keeps the stroke weight proportional
# instead of turning into a blob at 5pt.
_ICON_SCALE = 0.62  # icon size relative to the type size it sits on
_ICON_GAP = 0.34  # gap between icon and text, relative to the type size
_ICON_LW = 0.10  # stroke weight, in unit-box terms

# Icons whose shape carries a direction. In RTL the icon leads its label from
# the right, so a directional mark has to face the other way too — the mirror is
# applied to the unit box, so any future asymmetric icon gets it for free. The
# envelope, the pin, the globe and the calendar are symmetric about their
# vertical axis, so mirroring them is a deliberate no-op rather than an omission.
_ICON_MIRRORED = ("phone", "link")


def _icon_mail(c) -> None:
    c.roundRect(0.03, 0.18, 0.94, 0.62, 0.10, stroke=1, fill=0)
    p = c.beginPath()
    p.moveTo(0.09, 0.74)
    p.lineTo(0.50, 0.44)
    p.lineTo(0.91, 0.74)
    c.drawPath(p)


def _icon_phone(c) -> None:
    # A handset: the curved body, plus the earpiece and mouthpiece as short
    # strokes across each end.
    body = c.beginPath()
    body.moveTo(0.17, 0.83)
    body.curveTo(0.22, 0.45, 0.45, 0.22, 0.83, 0.17)
    c.drawPath(body)
    for x0, y0, x1, y1 in ((0.02, 0.70, 0.32, 0.98), (0.70, 0.02, 0.98, 0.32)):
        p = c.beginPath()
        p.moveTo(x0, y0)
        p.lineTo(x1, y1)
        c.drawPath(p)


def _icon_pin(c) -> None:
    c.circle(0.50, 0.66, 0.30, stroke=1, fill=0)
    p = c.beginPath()
    p.moveTo(0.26, 0.48)
    p.lineTo(0.50, 0.02)
    p.lineTo(0.74, 0.48)
    c.drawPath(p)
    c.circle(0.50, 0.66, 0.085, stroke=0, fill=1)


def _icon_link(c) -> None:
    # Two overlapping capsules on a 45° diagonal — a chain link.
    c.saveState()
    c.translate(0.50, 0.50)
    c.rotate(45)
    c.roundRect(-0.44, -0.16, 0.48, 0.32, 0.16, stroke=1, fill=0)
    c.roundRect(-0.04, -0.16, 0.48, 0.32, 0.16, stroke=1, fill=0)
    c.restoreState()


def _icon_globe(c) -> None:
    c.circle(0.50, 0.50, 0.46, stroke=1, fill=0)
    c.ellipse(0.30, 0.04, 0.70, 0.96, stroke=1, fill=0)  # meridian
    p = c.beginPath()
    p.moveTo(0.05, 0.50)
    p.lineTo(0.95, 0.50)
    c.drawPath(p)


def _icon_calendar(c) -> None:
    c.roundRect(0.05, 0.02, 0.90, 0.80, 0.10, stroke=1, fill=0)
    p = c.beginPath()
    p.moveTo(0.05, 0.60)
    p.lineTo(0.95, 0.60)
    c.drawPath(p)
    for x in (0.30, 0.70):
        q = c.beginPath()
        q.moveTo(x, 0.70)
        q.lineTo(x, 0.98)
        c.drawPath(q)


_ICONS = {
    "mail": _icon_mail,
    "phone": _icon_phone,
    "pin": _icon_pin,
    "link": _icon_link,
    "globe": _icon_globe,
    "calendar": _icon_calendar,
}

# Which contact field gets which mark.
CONTACT_ICONS = {
    "email": "mail", "phone": "phone", "location": "pin",
    "linkedin": "link", "website": "globe",
}


def _icon_w(name: str, size: float) -> float:
    """Horizontal space one icon claims on a line of `size` type, gap included."""
    return (size * (_ICON_SCALE + _ICON_GAP)) if name in _ICONS else 0.0


def _draw_icon(canv, name: str, x: float, y: float, size: float, color, rtl: bool = False) -> None:
    """Draw `name` in the box [x, x+size] × [y, y+size], tinted `color`.

    `color` is the colour of the text the icon belongs to, on purpose: an icon
    louder than its own label out-shouts the thing it is labelling.
    """
    draw = _ICONS.get(name)
    if not draw:
        return
    canv.saveState()
    if rtl and name in _ICON_MIRRORED:
        canv.translate(x + size, y)
        canv.scale(-size, size)
    else:
        canv.translate(x, y)
        canv.scale(size, size)
    canv.setStrokeColor(color)
    canv.setFillColor(color)
    canv.setLineWidth(_ICON_LW)
    canv.setLineCap(1)
    canv.setLineJoin(1)
    draw(canv)
    canv.restoreState()


# --------------------------------------------------------------------------- #
# Flowables — all direction-aware, all real text
# --------------------------------------------------------------------------- #
class _Text(Flowable):
    """A wrapped run in one style, optionally with a hanging bullet glyph."""

    def __init__(self, text, *, font, size, color, leading, tracking=0.0, align="start",
                 rtl=False, glyph="", glyph_color=None, glyph_size=None, indent=0.0,
                 space_before=0.0, space_after=0.0, rail=None, rail_dot=False):
        super().__init__()
        self.text, self.font, self.size, self.color = text, font, size, color
        self.leading, self.tracking, self.align, self.rtl = leading, tracking, align, rtl
        self.glyph, self.glyph_color, self.indent = glyph, glyph_color or color, indent
        # A full-size dot per bullet carries real ink weight and merges the
        # glyph column into the text column; a smaller one lightens the page.
        self.glyph_size = glyph_size or size
        self.space_before, self.space_after = space_before, space_after
        # The timeline rail. Drawn in the MARGIN gutter (a negative offset
        # from the text start) so it needs no indent and cannot collide with
        # the copy. Consecutive flowables are contiguous in the frame, so the
        # per-flowable segments tile into one continuous line.
        self.rail, self.rail_dot = rail, rail_dot

    _pinned: list[str] | None = None

    def wrap(self, avail_w, avail_h):
        # A half produced by split() carries its lines already broken; re-wrapping
        # the re-joined text could break differently and drop or repeat a word.
        self._lines = self._pinned if self._pinned is not None else _wrap_lines(
            self.text, self.font, self.size, avail_w - self.indent, self.tracking)
        self.width = avail_w
        self.height = self.space_before + len(self._lines) * self.leading + self.space_after
        return self.width, self.height

    def split(self, avail_w, avail_h):
        """Break across a page boundary.

        Without this, reportlab cannot place a run taller than one frame and
        raises `LayoutError`, which surfaced as a 500 from `POST /render` for
        any résumé whose summary (or a single very long bullet) exceeded a
        page. It is a real crash, not a layout nicety: a bare Flowable that
        does not implement `split` is all-or-nothing.

        The head keeps `space_before` and the hanging glyph; the tail keeps
        `space_after` and is indented to the text column so a continued bullet
        does not grow a second dot.
        """
        self.wrap(avail_w, avail_h)
        room = avail_h - self.space_before
        fit = int(room // self.leading) if self.leading > 0 else 0
        # A single orphan line at a page foot reads worse than moving the whole
        # run, and a one-line widow at the top of the next page is no better.
        if fit < 2 or len(self._lines) - fit < 2:
            return []

        def clone(lines, *, glyph, before, after):
            part = _Text(" ".join(lines), font=self.font, size=self.size, color=self.color,
                         leading=self.leading, tracking=self.tracking, align=self.align,
                         rtl=self.rtl, glyph=glyph, glyph_color=self.glyph_color,
                         glyph_size=self.glyph_size, rail=self.rail,
                         indent=self.indent, space_before=before, space_after=after)
            # Pin the break we already computed: re-wrapping " ".join(lines)
            # can land differently and lose or duplicate a word.
            part._pinned = list(lines)
            return part

        return [
            clone(self._lines[:fit], glyph=self.glyph, before=self.space_before, after=0.0),
            clone(self._lines[fit:], glyph="", before=0.0, after=self.space_after),
        ]

    def _draw_rail(self):
        if not self.rail:
            return
        color, off, dot_r = self.rail
        x = (self.width + off) if self.rtl else -off
        c = self.canv
        c.setStrokeColor(color)
        c.setLineWidth(0.7)
        c.line(x, 0, x, self.height)
        if self.rail_dot:
            c.setFillColor(color)
            c.circle(x, self.height - self.space_before - self.size * 0.62, dot_r,
                     stroke=0, fill=1)

    def draw(self):
        self._draw_rail()
        base = self.height - self.space_before - pdfmetrics.getAscent(self.font, self.size)
        x0 = self.indent if not self.rtl else 0.0
        x1 = self.width if not self.rtl else self.width - self.indent
        for i, line in enumerate(self._lines):
            _draw_line(self.canv, line, x0, x1, base - i * self.leading, self.font, self.size,
                       self.color, tracking=self.tracking, align=self.align, rtl=self.rtl)
        if self.glyph:
            _draw_line(self.canv, self.glyph, 0.0, self.width,
                       base + (self.size - self.glyph_size) * 0.32, self.font,
                       self.glyph_size, self.glyph_color, align="start", rtl=self.rtl)


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

    An item may carry a VECTOR ICON, which sits before it in READING order — to
    its left in English, to its right in Hebrew. The icon is drawn, never typed,
    so it costs the extracted text nothing (see `_draw_icon`).
    """

    def __init__(self, segments, *, sep, sep_color, leading, align="start", rtl=False, rail=None,
                 space_before=0.0, space_after=0.0):
        super().__init__()
        # segments: (text, font, size, color, url) — with an optional 6th
        # element naming an icon. Padded here so every call site that predates
        # icons keeps working untouched.
        self.segments = [tuple(s) + ("",) * (6 - len(s)) for s in segments if s[0]]
        self.sep, self.sep_color = sep, sep_color
        self.leading, self.align, self.rtl = leading, align, rtl
        self.space_before, self.space_after = space_before, space_after
        self.rail = rail

    def wrap(self, avail_w, avail_h):
        order = list(reversed(self.segments)) if self.rtl else list(self.segments)
        rows: list[tuple[list[tuple], float]] = []
        row: list[tuple] = []
        x = 0.0
        for text, font, size, color, url, icon in order:
            shown = _visual(text) if self.rtl else text
            w = _adv(shown, font, size) + _icon_w(icon, size)
            if row:
                sep_w = _adv(self.sep, font, size)
                if x + sep_w + w > avail_w:
                    rows.append((row, x))
                    row, x = [], 0.0
                else:
                    row.append((self.sep, font, size, self.sep_color, "", "", x))
                    x += sep_w
            row.append((shown, font, size, color, url, icon, x))
            x += w
        if row:
            rows.append((row, x))
        self._rows = rows
        self.width = avail_w
        self.height = self.space_before + max(len(rows), 1) * self.leading + self.space_after
        return self.width, self.height

    def draw(self):
        if self.rail:
            color, off, _r = self.rail
            x = (self.width + off) if self.rtl else -off
            self.canv.setStrokeColor(color)
            self.canv.setLineWidth(0.7)
            self.canv.line(x, 0, x, self.height)
        canv = self.canv
        for i, (row, row_w) in enumerate(self._rows):
            if not row:
                continue
            top_font, top_size = row[0][1], row[0][2]
            base = self.height - self.space_before - pdfmetrics.getAscent(top_font, top_size) - i * self.leading
            start = _place(0.0, self.width, row_w, self.align, self.rtl)
            for shown, font, size, color, url, icon, off in row:
                x = start + off
                w = _adv(shown, font, size)
                if _icon_w(icon, size):
                    side = size * _ICON_SCALE
                    if self.rtl:
                        # Reading right-to-left, the icon LEADS its label — so
                        # it sits at the right-hand end of the item's own box.
                        _draw_icon(canv, icon, x + w + size * _ICON_GAP,
                                   base + size * 0.34 - side / 2, side, color, rtl=True)
                    else:
                        _draw_icon(canv, icon, x, base + size * 0.34 - side / 2,
                                   side, color, rtl=False)
                        x += size * (_ICON_SCALE + _ICON_GAP)
                canv.setFont(font, size)
                canv.setFillColor(color)
                canv.drawString(x, base, shown)
                if url:
                    canv.linkURL(url, (x, base - 2, x + w, base + size), relative=1)


class _Heading(Flowable):
    """Section heading: tracked, uppercased (a no-op in Hebrew), over a
    hairline that spans the column."""

    def __init__(self, text, *, font, size, color, rule_color, tracking, rtl,
                 rule=True, space_before=0.0, space_after=0.0,
                 rule_pt=0.6, short_pt=0.0, hang_pt=0.0, align="start"):
        super().__init__()
        self.text, self.font, self.size, self.color = text, font, size, color
        self.rule_color, self.tracking, self.rtl, self.rule = rule_color, tracking, rtl, rule
        self.space_before, self.space_after = space_before, space_after
        # short_pt > 0 draws a SHORT accent underline instead of a full-width
        # hairline. Six full-measure grey stripes down a page read as ruled
        # paper; one short accent mark per section reads as a design.
        self.rule_pt, self.short_pt, self.hang_pt = rule_pt, short_pt, hang_pt
        self.align = align

    def wrap(self, avail_w, avail_h):
        self.width = avail_w
        gap = (self.rule_pt + 4.0) if self.rule else 0.0
        # A hung heading sits out in the margin BESIDE the body, so it costs the
        # flow nothing but its own leading.
        self.height = self.space_before + self.size * 1.15 + gap + self.space_after
        return self.width, self.height

    def draw(self):
        base = self.height - self.space_before - pdfmetrics.getAscent(self.font, self.size)
        x0, x1 = 0.0, self.width
        align = self.align
        if self.hang_pt:
            # Pull the heading out into the start margin, and align it to the
            # INNER edge of that gutter so long labels grow away from the text
            # column. Aligning to the outer edge let "EXPERIENCE" run back over
            # the body and the headings stopped looking hung at all.
            gap = 8.0
            if self.rtl:
                x0, x1 = self.width + gap, self.width + gap + self.hang_pt
                align = "start"
            else:
                x0, x1 = -(self.hang_pt + gap), -gap
                align = "end"
        _draw_line(self.canv, self.text, x0, x1, base, self.font, self.size, self.color,
                   tracking=self.tracking, align=align, rtl=self.rtl)
        if self.rule:
            y = self.space_after + 1.5
            self.canv.setStrokeColor(self.rule_color)
            self.canv.setLineWidth(self.rule_pt)
            if self.short_pt:
                sx = (self.width - self.short_pt) if self.rtl else 0.0
                self.canv.line(sx, y, sx + self.short_pt, y)
            else:
                self.canv.line(0, y, self.width, y)


class _BarHeading(Flowable):
    """Section heading with a solid accent bar at the text start.

    Reads far stronger than 9.5pt caps over a hairline, and the bar mirrors to
    the right edge in RTL for free. The DOCX twin is a `w:pBdr` left border.

    RTL CONTRACT: pass LOGICAL text. `_draw_line` runs `_visual()` itself, so
    pre-reordering here double-reverses every Hebrew heading (תקציר → ריצקת).
    Only flowables that draw with a raw `canv.drawString` (see `_Chips`) apply
    `_visual()` themselves.
    """

    def __init__(self, text, *, font, size, color, bar_color, rule_color, tracking,
                 rtl, rule=False, bar_w=3.0, bar_gap=7.0, space_before=0.0, space_after=0.0):
        super().__init__()
        self.text, self.font, self.size, self.color = text, font, size, color
        self.bar_color, self.rule_color = bar_color, rule_color
        self.tracking, self.rtl, self.rule = tracking, rtl, rule
        self.bar_w, self.bar_gap = bar_w, bar_gap
        self.space_before, self.space_after = space_before, space_after

    def wrap(self, avail_w, avail_h):
        self.width = avail_w
        self.height = (self.space_before + self.size * 1.34
                       + (4.5 if self.rule else 0.0) + self.space_after)
        return self.width, self.height

    def draw(self):
        canv = self.canv
        h = self.size * 1.34
        y = self.space_after + (4.5 if self.rule else 0.0)
        bx = (self.width - self.bar_w) if self.rtl else 0.0
        canv.setFillColor(self.bar_color)
        canv.rect(bx, y + h * 0.14, self.bar_w, h * 0.70, stroke=0, fill=1)
        pad = self.bar_w + self.bar_gap
        x0 = 0.0 if self.rtl else pad
        x1 = (self.width - pad) if self.rtl else self.width
        _draw_line(canv, self.text, x0, x1, y + h * 0.28, self.font, self.size,
                   self.color, tracking=self.tracking, align="start", rtl=self.rtl)
        if self.rule:
            canv.setStrokeColor(self.rule_color)
            canv.setLineWidth(0.6)
            canv.line(0, self.space_after + 1.5, self.width, self.space_after + 1.5)


class _Chips(Flowable):
    """A wrapping row of bordered chips — the replacement for comma-soup skills.

    Extraction: each chip is drawn as its own string, and `sep` is drawn between
    chips in the separator colour, so a parser still reads a real delimiter.
    Without it two multi-word skills would run together ("Machine Learning Deep
    Learning") — the comma-joined run this replaces was chosen precisely because
    keyword parsers split on it, and that property has to survive.

    RTL CONTRACT: this draws with a raw `canv.drawString`, so it MUST apply
    `_visual()` itself (the opposite of `_BarHeading`, which goes via
    `_draw_line`).
    """

    def __init__(self, items, *, font, size, ink, border, rtl=False, fill=None,
                 pad=5.2, gap=4.6, radius=2.6, sep=",", sep_color=None,
                 space_before=0.0, space_after=0.0):
        super().__init__()
        self.items = [i for i in items if i]
        self.font, self.size = font, size
        self.ink, self.border, self.fill = ink, border, fill
        self.rtl = rtl
        self.pad, self.gap, self.radius = pad, gap, radius
        self.sep, self.sep_color = sep, sep_color or border
        self.space_before, self.space_after = space_before, space_after
        self.chip_h = size * 1.72
        self.rows: list = []

    def _pack(self, avail_w):
        rows, cur, cw = [], [], 0.0
        for item in self.items:
            w = _adv(item, self.font, self.size) + 2 * self.pad
            if cur and cw + self.gap + w > avail_w:
                rows.append(cur)
                cur, cw = [], 0.0
            cur.append((item, w))
            cw += (self.gap if cw else 0.0) + w
        if cur:
            rows.append(cur)
        return rows

    def split(self, avail_w, avail_h):
        """Break a long chip block at a ROW boundary.

        Same rule as `_Text.split`: any flowable that can outgrow a frame needs
        one. A 138-skill block is taller than a page, and without this reportlab
        cannot place it at all — it jumps whole to the next frame and leaves the
        column it came from empty. That is exactly what a two-column render of a
        dense résumé looked like: a page-1 main column holding only the summary.
        """
        self.wrap(avail_w, avail_h)
        room = avail_h - self.space_before
        step = self.chip_h + self.gap
        fit = int((room + self.gap) // step) if step > 0 else 0
        # A single stranded row reads worse than moving the whole block, and a
        # one-row widow on the next frame is no better.
        if fit < 1 or len(self.rows) - fit < 1:
            return []
        head_items = [label for row in self.rows[:fit] for label, _w in row]
        tail_items = [label for row in self.rows[fit:] for label, _w in row]

        def clone(items, *, before, after):
            return _Chips(items, font=self.font, size=self.size, ink=self.ink,
                          border=self.border, rtl=self.rtl, fill=self.fill,
                          pad=self.pad, gap=self.gap, radius=self.radius,
                          sep=self.sep, sep_color=self.sep_color,
                          space_before=before, space_after=after)

        return [clone(head_items, before=self.space_before, after=0.0),
                clone(tail_items, before=0.0, after=self.space_after)]

    def wrap(self, avail_w, avail_h):
        self.width = avail_w
        self.rows = self._pack(avail_w)
        body = len(self.rows) * (self.chip_h + self.gap) - self.gap if self.rows else 0.0
        self.height = body + self.space_before + self.space_after
        return self.width, self.height

    def draw(self):
        if not self.rows:
            return
        canv = self.canv
        y = self.space_after + len(self.rows) * (self.chip_h + self.gap) - self.gap - self.chip_h
        for row in self.rows:
            row_w = sum(w for _, w in row) + self.gap * (len(row) - 1)
            x = (self.width - row_w) if self.rtl else 0.0
            for i, (label, w) in enumerate(row):
                if self.fill is not None:
                    canv.setFillColor(self.fill)
                canv.setStrokeColor(self.border)
                canv.setLineWidth(0.6)
                canv.roundRect(x, y, w, self.chip_h, self.radius,
                               stroke=1, fill=1 if self.fill is not None else 0)
                canv.setFont(self.font, self.size)
                canv.setFillColor(self.ink)
                canv.drawString(x + self.pad, y + self.chip_h * 0.31,
                                _visual(label) if self.rtl else label)
                x += w
                if self.sep and i < len(row) - 1:
                    canv.setFillColor(self.sep_color)
                    canv.drawString(x + self.gap * 0.2, y + self.chip_h * 0.31, self.sep)
                x += self.gap
            y -= self.chip_h + self.gap


class _Cols(Flowable):
    """A bulleted list laid out in N columns — for certifications and languages,
    which are a handful of short items that otherwise waste half the page width.

    Capped at 2 columns by the caller: text extraction y-sorts across the full
    page, so anything wider starts gluing unrelated items together on one line.
    Two short items per row stays legible either way.

    RTL CONTRACT: draws via `_draw_line`, so the lines stay LOGICAL — they come
    straight from `_wrap_lines`, which breaks logical text on purpose.
    """

    def __init__(self, items, *, font, size, color, glyph_color, leading, rtl=False,
                 cols=2, gap=16.0, glyph="•", space_before=0.0, space_after=0.0):
        super().__init__()
        self.items = [i for i in items if i]
        self.font, self.size, self.color = font, size, color
        self.glyph, self.glyph_color = glyph, glyph_color
        self.leading, self.rtl = leading, rtl
        self.cols, self.gap = max(1, cols), gap
        self.space_before, self.space_after = space_before, space_after

    def wrap(self, avail_w, avail_h):
        self.width = avail_w
        self.col_w = (avail_w - self.gap * (self.cols - 1)) / self.cols
        self.indent = self.size * 1.05
        self.cells = [_wrap_lines(i, self.font, self.size, self.col_w - self.indent)
                      for i in self.items]
        self.row_lines = [max(len(c) for c in self.cells[r:r + self.cols])
                          for r in range(0, len(self.cells), self.cols)]
        self.height = (sum(self.row_lines) * self.leading
                       + self.space_before + self.space_after)
        return self.width, self.height

    def draw(self):
        canv = self.canv
        y = self.space_after + sum(self.row_lines) * self.leading
        for ri, r in enumerate(range(0, len(self.cells), self.cols)):
            for ci, lines in enumerate(self.cells[r:r + self.cols]):
                slot = (self.cols - 1 - ci) if self.rtl else ci
                x = slot * (self.col_w + self.gap)
                yy = y - self.leading
                gx = (x + self.col_w - self.indent * 0.75) if self.rtl else x
                canv.setFont(self.font, self.size)
                canv.setFillColor(self.glyph_color)
                canv.drawString(gx, yy + self.leading * 0.24, self.glyph)
                tx0 = x if self.rtl else x + self.indent
                tx1 = (x + self.col_w - self.indent) if self.rtl else x + self.col_w
                for ln in lines:
                    _draw_line(canv, ln, tx0, tx1, yy + self.leading * 0.24,
                               self.font, self.size, self.color, align="start", rtl=self.rtl)
                    yy -= self.leading
            y -= self.row_lines[ri] * self.leading


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
        # `pdf_family` is Latin-only, so RTL reads its own axis (`he_family`).
        # Before this, every template resolved to the same Hebrew face and
        # `executive` silently lost its serif in the primary market.
        self.reg, self.bold, self.ital = _fonts(spec.he_family if rtl else spec.pdf_family)
        self.ink = HexColor(f"#{spec.ink}")
        self.muted = HexColor(f"#{spec.muted}")
        self.accent = HexColor(f"#{spec.accent}")
        self.rule = HexColor(f"#{spec.rule}")
        # Inline separators sit between the hairline and the body grey so they
        # read as punctuation, not as content.
        self.sep = _mix(self.muted, self.rule, 0.55)
        # Reversed-out palette for a filled header band.
        self.band = HexColor(f"#{spec.band_fill}")
        self.band_ink = HexColor(f"#{spec.band_ink}")
        self.band_sub = HexColor(f"#{spec.band_sub}")
        self.band_meta = HexColor(f"#{spec.band_meta}")
        self.accent_soft = (HexColor(f"#{spec.accent_soft}") if spec.accent_soft
                            else _mix(Color(1, 1, 1), self.accent, 0.12))
        # (colour, gutter offset, dot radius) or None. Lives in the margin, so
        # it costs the text column no width.
        self.rail = (_mix(self.accent, Color(1, 1, 1), 0.45), 13.0, 2.1) if spec.rail else None
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


def _band_metrics(header: list, spec: TemplateSpec) -> tuple[float, float, float]:
    """(header height, top pad, bottom pad) for a filled header band, measured
    from the header flowables so the rectangle is exactly as tall as its
    contents. Returns zeros when the template has no band."""
    if spec.header != "band" or not header:
        return 0.0, 0.0, 0.0
    width = spec.page_w_pt - 2 * spec.margin_lr_pt
    head_h = sum(f.wrap(width, 0)[1] for f in header)
    return head_h, spec.margin_tb_pt * 0.72, spec.margin_tb_pt * 0.62


def _column_widths(spec: TemplateSpec) -> tuple[float, float]:
    """(sidebar width, main width) inside the text column."""
    text_w = spec.page_w_pt - 2 * spec.margin_lr_pt
    side_w = (text_w - spec.sidebar_gutter) * spec.sidebar_ratio
    return side_w, text_w - spec.sidebar_gutter - side_w


def fit_squeeze(resume: ResumeModel, spec: TemplateSpec, rtl: bool) -> float:
    """How far the vertical rhythm has to compress for this résumé to land on a
    single page: 1.0 when it already fits, and 1.0 again when it is a genuine
    two-pager that no reasonable squeeze would rescue.

    The DOCX renderer reuses this so both downloads make the same call about
    one page vs. two, even though Word does its own line breaking.
    """
    s = _Sheet(spec, rtl)
    header, main, side = _flow(resume, s, labels_for("he" if rtl else "en"))
    head_h, pad_t, pad_b = _band_metrics(header, spec)
    capacity = spec.page_h_pt - 2 * spec.margin_tb_pt
    text_w = spec.page_w_pt - 2 * spec.margin_lr_pt
    if head_h:
        # A band is taller than the plain header it replaces (it carries its own
        # padding and bleeds to the page top), and its content sits in a
        # separate frame. Charge the body frame for the difference, or the
        # squeeze believes there is more room on page 1 than there is.
        capacity -= (head_h + pad_t + pad_b) - spec.margin_tb_pt + 4.0
        body = main
    else:
        body = header + main
    if side:
        # Two columns: the page is full when the TALLER column fills it, and the
        # narrower rail wraps more, so it must be measured at its own width.
        side_w, main_w = _column_widths(spec)
        total = max(_content_height(body, main_w), _content_height(side, side_w))
    else:
        total = _content_height(body, text_w)
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
    header, main, side = _flow(resume, s, labels)

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
    W, H = spec.page_w_pt, spec.page_h_pt
    side_w, main_w = _column_widths(spec)
    # In RTL the sidebar belongs on the RIGHT — "start" is the right edge — so
    # the two columns swap x positions and nothing else changes.
    if rtl:
        side_x, main_x = doc.leftMargin + main_w + spec.sidebar_gutter, doc.leftMargin
    else:
        side_x, main_x = doc.leftMargin, doc.leftMargin + side_w + spec.sidebar_gutter

    def frame(x: float, y: float, w: float, h: float, fid: str) -> Frame:
        return Frame(x, y, w, h, leftPadding=0, rightPadding=0,
                     topPadding=0, bottomPadding=0, id=fid)

    head_h, pad_t, pad_b = _band_metrics(header, spec)
    band_h = (head_h + pad_t + pad_b) if head_h else 0.0
    body_top = (H - band_h - 4.0) if band_h else (H - doc.topMargin)
    body_h = body_top - doc.bottomMargin

    painters = []
    if spec.page_bg:
        bg = HexColor(f"#{spec.page_bg}")
        painters.append(lambda c, _d: (c.setFillColor(bg), c.rect(0, 0, W, H, stroke=0, fill=1)))
    if band_h:
        painters.append(lambda c, _d: (c.setFillColor(s.band),
                                       c.rect(0, H - band_h, W, band_h, stroke=0, fill=1)))
    if side and spec.sidebar_panel:
        painters.append(lambda c, _d: (c.setFillColor(s.accent_soft),
                                       c.rect(side_x - 10.0, 0, side_w + 20.0, H - band_h,
                                              stroke=0, fill=1)))

    def paint_first(canv, _doc):
        # Painted from the page template, not a flowable: the band and the panel
        # must bleed past their frames to the page edges, and a spacer inside the
        # body frame would push the reversed-out name below the rectangle, where
        # it renders white on white.
        canv.saveState()
        for fn in painters:
            fn(canv, _doc)
        canv.restoreState()

    def paint_rest(canv, _doc):
        canv.saveState()
        if spec.page_bg:
            canv.setFillColor(HexColor(f"#{spec.page_bg}"))
            canv.rect(0, 0, W, H, stroke=0, fill=1)
        # No panel here: page 2+ is a single full-width frame, so painting the
        # rail would leave a coloured stripe with nothing in it.
        canv.restoreState()

    if side:
        first = [frame(side_x, doc.bottomMargin, side_w, body_h, "side"),
                 frame(main_x, doc.bottomMargin, main_w, body_h, "main")]
        # Page 2+ is ONE FULL-WIDTH frame, and the rail is not painted there.
        # The sidebar is a page-1 device, exactly like the header band. Keeping
        # a two-frame page 2 meant main-column overflow landed in page 2's SIDE
        # frame — which is how Experience ended up rendering inside the rail.
        # Continuing the rail down page 2 would need two independent flows on
        # one page, which reportlab cannot do in a single build.
        rest = [frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, "rest")]
        if band_h:
            first.insert(0, frame(doc.leftMargin, H - band_h + pad_b, doc.width, head_h, "hdr"))
        # Order: [header] -> sidebar -> main. FrameBreak advances one frame.
        content = ((header + [FrameBreak()]) if band_h else []) + side + [FrameBreak()] + \
                  ((main if band_h else header + main))
        doc.addPageTemplates([
            PageTemplate(id="first", onPage=paint_first, frames=first,
                         autoNextPageTemplate="rest"),
            PageTemplate(id="rest", onPage=paint_rest, frames=rest),
        ])
    elif band_h:
        doc.addPageTemplates([
            PageTemplate(id="first", onPage=paint_first, autoNextPageTemplate="rest", frames=[
                frame(doc.leftMargin, H - band_h + pad_b, doc.width, head_h, "hdr"),
                frame(doc.leftMargin, doc.bottomMargin, doc.width, body_h, "body"),
            ]),
            # Page 2+ carries no band: the name is already established, and a
            # second rectangle would read as a new document.
            PageTemplate(id="rest", onPage=paint_rest,
                         frames=[frame(doc.leftMargin, doc.bottomMargin, doc.width,
                                       doc.height, "rest")]),
        ])
        content = header + [FrameBreak()] + main
    else:
        # No band to suppress on page 2, so one repeating template is correct.
        doc.addPageTemplates([
            PageTemplate(id="body", onPage=paint_first,
                         frames=[frame(doc.leftMargin, doc.bottomMargin, doc.width,
                                       doc.height, "body")]),
        ])
        content = header + main

    doc.build(content)
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


def _flow(resume: ResumeModel, s: _Sheet, labels: dict[str, str]) -> tuple[list, int]:
    """Build the document flow.

    Returns `(header, main, side)`.

    `header` is the name/headline/contact block. For a `header="band"` template
    it goes in its own frame so it can sit INSIDE the painted rectangle; for
    every other template `_render` simply prepends it to `main`, which keeps the
    document one linear flow exactly as before.

    `side` is non-empty only for a `layout="sidebar"` template, and only in the
    PDF — see `TemplateSpec.layout` for why a sidebar never reaches the DOCX.
    """
    spec = s.spec
    header: list = []
    flow: list = header
    band = spec.header == "band"
    # A band anchors the name hard to the top-start corner; centring inside it
    # reads like a certificate.
    name_align = "start" if band else ("center" if spec.name_centered else "start")

    # --- header -----------------------------------------------------------
    c = resume.contact
    flow.append(_Text(
        c.name or "Name", font=s.bold, size=spec.name_size,
        color=s.band_ink if band else (s.accent if spec.accent_name else s.ink),
        leading=spec.name_size * 1.18, tracking=s.track_name,
        align=name_align, rtl=s.rtl, space_after=1.0,
    ))
    if resume.headline:
        # Sits between the name and the contact line: the first thing a
        # recruiter reads after the name, and what the ATS matches on. Coloured
        # opposite the name so the two never flatten into one block.
        flow.append(_Text(
            resume.headline, font=s.reg, size=s.body + (1.2 if band else 0.8),
            color=s.band_sub if band else (s.ink if spec.accent_name else s.accent),
            leading=(s.body + 0.8) * 1.35, tracking=0.3 * (0.5 if s.rtl else 1.0),
            align=name_align, rtl=s.rtl, space_before=1.0, space_after=1.0,
        ))

    bits = [(k, v) for k, v in (("email", c.email), ("phone", c.phone), ("location", c.location),
                                ("linkedin", c.linkedin), ("website", c.website)) if v]
    if bits:
        flow.append(_Segments(
            # No link annotations on a band: a blue underline would fight the
            # reversed-out text, and the rectangle already carries the emphasis.
            # The icon is the 6th element: a drawn envelope / handset / pin /
            # link / globe, tinted the same grey as the bit it labels. It emits
            # no text, so the line an ATS reads as the email address is exactly
            # what it was before.
            [(v, s.reg, spec.meta_size, s.band_meta if band else s.muted,
              "" if (s.rtl or band) else _url(v),
              CONTACT_ICONS[k] if spec.contact_icons else "") for k, v in bits],
            sep=" · ", sep_color=s.band_meta if band else s.sep,
            leading=spec.meta_size * (1.5 if band else 1.45),
            align=name_align, rtl=s.rtl,
            # Without a rule to separate it, the header needs the air itself.
            space_after=0.0 if (spec.header_rule and not band) else (0.0 if band else 5.0),
        ))
    if spec.header_rule and not band:
        flow.append(_Rule(s.accent if spec.header_rule_accent else s.rule,
                          thickness=spec.header_rule_pt, space_before=6.0, space_after=0.0))

    def heading(key: str):
        raw = labels[key]
        # Hebrew is unicase, so both cases are no-ops there — but calling
        # .upper() on Hebrew is still wasted work and .title() would mangle a
        # mixed he/en label, so branch on direction first.
        text = raw if s.rtl else (raw.title() if spec.heading_case == "title" else raw.upper())
        size = spec.heading_size + spec.heading_bump
        if spec.heading == "bar":
            return _BarHeading(
                text, font=s.bold, size=size,
                color=s.ink, bar_color=s.accent, rule_color=s.rule,
                tracking=s.track_head, rtl=s.rtl, rule=False, bar_w=spec.heading_bar_w,
                space_before=s.sec_before + 3.0, space_after=s.sec_after + 1.0,
            )
        style = spec.heading
        return _Heading(
            text, font=s.bold, size=size,
            color=s.ink if style in ("short", "hung") else s.accent,
            rule_color=HexColor(f"#{spec.head_rule_fill}"),
            tracking=s.track_head, rtl=s.rtl,
            rule=style in ("rule", "short", "centered"),
            rule_pt=spec.heading_rule_pt,
            short_pt=spec.heading_short_pt if style == "short" else 0.0,
            hang_pt=spec.heading_hang_pt if style == "hung" else 0.0,
            align="center" if style == "centered" else "start",
            space_before=s.sec_before, space_after=s.sec_after,
        )

    def body(text: str, **kw):
        return _Text(text, font=s.reg, size=s.body, color=s.ink, leading=s.lead, rtl=s.rtl, **kw)

    def bullet(text: str, last: bool = False, rail=None):
        return _Text(text, font=s.reg, size=s.body, color=s.ink, leading=s.lead, rtl=s.rtl,
                     glyph=spec.bullet_glyph,
                     glyph_color=s.accent if spec.bullet_accent else s.muted,
                     glyph_size=s.body * spec.bullet_scale,
                     indent=s.body * 1.05, rail=rail,
                     space_after=0.0 if last else s.bullet_after)

    def entry(primary: str, meta: str, secondary: list[tuple], bullets: list[str], first: bool):
        """One role: the title/date row, the employer · location row, and the
        bullets. Returns (opening, trailing) as flat lists — `section` glues
        the opening together so a role never strands its head at the foot of a
        page, while the trailing bullets stay free to flow. Both lists stay
        flat: a KeepTogether nested inside another reports a sentinel height
        and would push every section onto its own page.

        entry="split" keeps the original two-tier row with the dates flush to
        the far margin. entry="stack" drops the dates into the meta line
        instead — a short title used to leave most of the column empty between
        itself and the date, which is the widest piece of dead space on the
        page."""
        head: list = []
        if spec.entry == "stack":
            head.append(_Text(
                primary, font=s.bold, size=s.body + 0.9, color=s.ink,
                leading=(s.body + 0.9) * 1.3, rtl=s.rtl,
                space_before=0.0 if first else s.entry_before + 1.5,
                rail=s.rail, rail_dot=bool(s.rail),
            ))
            parts = list(secondary)
            # The employer carries the weight on a stacked entry — it is the
            # only accent-coloured word on the line and the thing a recruiter
            # scans for, so it is set bold rather than sharing the meta weight.
            for i, part in enumerate(parts):
                if part[0]:
                    # Keep the tail intact — a segment may carry an icon after
                    # the url, and re-packing only the first five fields would
                    # silently drop it.
                    parts[i] = (part[0], s.bold) + tuple(part[2:])
                    break
            if meta:
                # A drawn calendar before the dates, when the template asks for
                # it: the dates are the one item on this line that is not a
                # proper noun, so a mark tells the eye what it is looking at
                # without a word of label.
                parts.append((meta, s.reg, s.meta, s.muted, "",
                              "calendar" if spec.date_icon else ""))
            if any(part[0] for part in parts):
                head.append(_Segments(parts, sep="  ·  ", sep_color=s.sep, leading=s.lead,
                                      align="start", rtl=s.rtl, space_after=1.5,
                                      rail=s.rail))
        else:
            head.append(_Row(
                primary, meta, font=s.bold, size=s.body, color=s.ink,
                meta_font=s.reg, meta_size=s.meta, meta_color=s.muted,
                leading=s.lead, rtl=s.rtl, space_before=0.0 if first else s.entry_before,
            ))
            if any(part[0] for part in secondary):
                head.append(_Segments(secondary, sep=" · ", sep_color=s.sep, leading=s.lead,
                                      align="start", rtl=s.rtl))
        live = [b for b in bullets if b]
        items = [bullet(b, last=(i == len(live) - 1), rail=s.rail if spec.entry == "stack" else None)
                 for i, b in enumerate(live)]
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
        blocks = skill_blocks(resume)
        if not blocks:
            return

        def label_of(text: str) -> _Text:
            """A group's label: small, bold, accent — the same weight a real CV
            gives 'AI & LLMs' over its row of tools."""
            return _Text(text, font=s.bold, size=spec.meta_size + 0.2, color=s.accent,
                         leading=(spec.meta_size + 0.2) * 1.35, tracking=s.track_head * 0.5,
                         rtl=s.rtl, space_before=s.bullet_after + 1.5, space_after=1.0)

        def items_of(items: list[str], before: float = 0.0):
            if spec.skills == "chips":
                # Chips still draw a comma between them, so the extracted text
                # keeps the delimiter the inline run below relies on.
                return _Chips(items, font=s.reg, size=spec.meta_size + 0.4, ink=s.ink,
                              border=s.rule, rtl=s.rtl, sep_color=s.sep, space_before=before)
            # Comma-separated on purpose: it is what ATS keyword parsers split on.
            return body(", ".join(items), space_before=before)

        def block(label: str, items: list[str], first: bool) -> list:
            if label:
                return [label_of(label), items_of(items)]
            # An UNLABELLED block after a labelled one is the leftover — skills
            # the groups never claimed. Without the extra air it reads as one
            # more row of the group above it, i.e. as a claim the résumé does
            # not make. First block unlabelled = the ungrouped résumé, which
            # gets exactly the flowables this section produced before groups
            # existed.
            return [items_of(items, 0.0 if first else s.entry_before)]

        # KeepTogether is for gluing a heading to its FIRST item, never for
        # holding a page-sized run: it refuses to split, so a 138-skill block
        # moved whole to the next frame and left the column it came from empty
        # — which is exactly what a dense two-column render looked like.
        # `keepWithNext` gives the same no-stranded-heading guarantee while
        # letting `_Chips.split()` break at a row boundary.
        # NEITHER KeepTogether NOR keepWithNext around a chip run. Both refuse
        # to split — reportlab implements `keepWithNext` by building a
        # KeepTogether — so a 138-skill block moved whole to the next frame and
        # left the column it came from empty. Verified by probe: with either
        # wrapper in place `_Chips.split` is never called at all.
        #
        # A skills block is the one section that can be page-sized, so it is
        # emitted bare and `_Chips.split()` breaks it at a row boundary. The
        # cost is that its heading can strand at a page foot; that is a far
        # smaller defect than half an empty column, and every other section
        # keeps its KeepTogether because none of them can grow that large.
        def emit(parts: list) -> None:
            for f in parts:
                flow.append(f)

        emit([heading("skills")] + block(*blocks[0], first=True))
        for label, items in blocks[1:]:
            emit(block(label, items, first=False))

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
        if spec.list_cols > 1 and len(live) > 1:
            flow.append(KeepTogether([heading("certifications"), _Cols(
                live, font=s.reg, size=s.body, color=s.ink,
                glyph_color=s.accent if spec.bullet_accent else s.muted,
                leading=s.lead, rtl=s.rtl, cols=min(2, spec.list_cols),
            )]))
            return
        items = [bullet(cert, last=(i == len(live) - 1)) for i, cert in enumerate(live)]
        flow.append(KeepTogether([heading("certifications"), items[0]]))
        flow.extend(items[1:])

    def build_languages() -> None:
        pairs = [" – ".join(b for b in [ls.language, ls.level] if b) for ls in resume.languages]
        pairs = [p for p in pairs if p]
        if not pairs:
            return
        if spec.skills == "chips":
            # Languages ride the skills treatment: a row of "Hebrew – Native"
            # chips, rather than one long `·`-joined line.
            flow.append(KeepTogether([heading("languages"), _Chips(
                pairs, font=s.reg, size=spec.meta_size + 0.4, ink=s.ink,
                border=s.rule, rtl=s.rtl, sep_color=s.sep,
            )]))
            return
        flow.append(KeepTogether([
            heading("languages"),
            _Segments([seg(p, s.ink) for p in pairs], sep=" · ", sep_color=s.sep,
                      leading=s.lead, align="start", rtl=s.rtl),
        ]))

    builders = {
        "summary": build_summary, "skills": build_skills, "experience": build_experience,
        "projects": build_projects, "education": build_education, "military": build_military,
        "certifications": build_certifications, "languages": build_languages,
    }
    order = section_order(resume)
    side_keys: set[str] = set()
    if spec.layout == "sidebar":
        side_keys = set(spec.sidebar_keys)
        # PLAN 17.5 puts Education ABOVE Experience for an early-career résumé,
        # because for a student the degree is the headline fact. Exiling it to a
        # narrow rail would silently undo that, so when the ordering says
        # early-career, education stays in the main column.
        if "education" in order and "experience" in order:
            if order.index("education") < order.index("experience"):
                side_keys.discard("education")

    main: list = []
    side: list = []

    # The sidebar MUST NOT be able to overflow its frame. reportlab reacts to a
    # full frame by advancing to the next one — which here is the MAIN column —
    # so sidebar overflow silently lands in the main column, and the explicit
    # FrameBreak that follows then pushes the real main content onto page 2,
    # where it starts in page 2's SIDE frame. That shipped: a résumé with 138
    # skills rendered its Summary and Experience inside the 30%-wide rail.
    #
    # So each sidebar section is measured at the RAIL's width before it is
    # placed, and any section that would not fit is demoted to the main column
    # at its natural position in `section_order`. A section is the unit because
    # splitting one across the two columns is worse than moving it.
    side_cap = 0.0
    side_w = 0.0
    if side_keys:
        side_w, _ = _column_widths(spec)
        head_h, pad_t, pad_b = _band_metrics(header, spec)
        band_h = (head_h + pad_t + pad_b) if head_h else 0.0
        top = (spec.page_h_pt - band_h - 4.0) if band_h else (spec.page_h_pt - spec.margin_tb_pt)
        side_cap = top - spec.margin_tb_pt
    side_used = 0.0

    for key in order:
        # Rebinding `flow` re-points the builders' closure, so each section is
        # appended to whichever column owns it.
        if key in side_keys:
            buf: list = []
            flow = buf
            builders[key]()
            # `_content_height` measures KeepTogether's children; calling
            # .wrap() on a KeepTogether directly raises (it has no `.canv`).
            need = _content_height(buf, side_w)
            if side_used + need <= side_cap:
                side.extend(buf)
                side_used += need
            else:
                main.extend(buf)
        else:
            flow = main
            builders[key]()

    return header, main, side
