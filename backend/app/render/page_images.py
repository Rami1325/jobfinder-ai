"""The rendered PDF's pages as PNG images, for a phone (PLAN 31.2/4).

Phone browsers do not draw a `blob:` PDF inside the page, so on a phone the
document's "The real PDF" view could only say so and offer Open and Download:
the one view whose job is "this is really your file" showed nothing of it. These
are pictures OF that file, drawn from the same bytes `render_pdf` returns for the
download, by PDFium, which pdfplumber already ships (pypdfium2) with Pillow. No
new dependency, no model, no network: `POST /render/pages` is a deterministic
route, uncapped and uncharged like `/render`.

Measured 2026-09-23 on a one-page resume: 1000 px wide, 64-colour PNG, about
50 KB and 40 ms a page (full RGB was about 155 KB). 1000 px is the width a
390 px screen at 3x draws; the palette keeps text anti-aliasing and every
template's colours.

PDFium is not thread-safe, and FastAPI runs sync routes on a thread pool, so
every document opened here is opened and drawn under one lock.
"""

from __future__ import annotations

import io
import threading

import pypdfium2 as pdfium
from PIL import Image

PAGE_WIDTH_PX = 1000
PALETTE_COLORS = 64
# The page budget's hard ceiling is 3 pages; a master can run longer, and the
# pictures stop here. The caller says how many the file has, so the view can
# say that the rest are in the download instead of dropping them silently.
MAX_PAGES = 4

_LOCK = threading.Lock()


def pdf_page_pngs(pdf: bytes, *, width_px: int = PAGE_WIDTH_PX, max_pages: int = MAX_PAGES) -> tuple[list[bytes], int]:
    """PNG bytes for the first `max_pages` pages of `pdf`, and the file's page count."""
    with _LOCK:
        doc = pdfium.PdfDocument(pdf)
        try:
            total = len(doc)
            pages: list[bytes] = []
            for i in range(min(total, max_pages)):
                page = doc[i]
                try:
                    image = page.render(scale=width_px / page.get_width()).to_pil()
                finally:
                    page.close()
                image = image.convert("P", palette=Image.ADAPTIVE, colors=PALETTE_COLORS)
                buf = io.BytesIO()
                image.save(buf, format="PNG", optimize=True)
                pages.append(buf.getvalue())
            return pages, total
        finally:
            doc.close()
