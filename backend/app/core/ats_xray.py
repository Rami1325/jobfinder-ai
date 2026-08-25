"""ATS X-ray: render the résumé, then read it back the way a parser does.

Every other résumé builder ASSERTS its templates are ATS-safe. We already own
both halves of the machinery — the renderer that makes the file and the parser
that reads one — so instead of asserting, this shows the user the actual text a
parser recovers from their own document and marks every protected fact as it
survived, split, got polluted by a neighbouring column, or vanished.

Deterministic end to end: no LLM, no network. That is why the route is uncapped,
like `/tools/ats-scan`.

The check that matters most is COLUMN POLLUTION. PDF text extraction sorts by
vertical position across the full page width, so a two-column layout hands the
parser the sidebar text glued to the front of the main-column line at the same
height — `"Python Go PostgreSQL Senior Backend Engineer"`. Individual bullets
always survive intact, so keyword matching is unaffected; what breaks is title
and employer attribution. Ordering the content stream differently does not help
(measured: pdfminer y-sorts regardless of draw order), which is exactly why
`split`/`panel` are PDF-only and are not the default.
"""
from __future__ import annotations

import re

from app.models import ATSXrayFact, ATSXrayResult, ResumeModel
from app.parsers.resume_parser import extract_text
from app.render.docx_renderer import render_docx
from app.render.pdf_renderer import page_count, render_pdf
from app.render.templates import get_template

_WS = re.compile(r"\s+")

# A fact shorter than this matches too much to be worth locating — a two-letter
# skill would "appear" inside half the words on the page.
_MIN_FACT = 3


def _norm(text: str) -> str:
    return _WS.sub(" ", (text or "").strip()).casefold()


def _find(needle: str, lines: list[str]) -> int:
    """Index of the line holding `needle` as WHOLE WORDS, or -1.

    Plain substring search is too loose here: "Backend Engineer" sits inside
    "Senior Backend Engineer", so a junior title would be located on the senior
    title's line and every judgement after that would be about the wrong row.
    """
    pattern = re.compile(rf"(?<!\w){re.escape(needle)}(?!\w)")
    for i, line in enumerate(lines):
        if pattern.search(line):
            return i
    return -1


def _collision(line: str, needle: str, side_vals: list[str]) -> str:
    """The sidebar value glued onto `line`, or "".

    Pollution has a SHAPE, and testing for it is what stops this from firing on
    innocent text. Extraction sorts by position, so a sidebar value arrives
    fused to one END of the main-column line — the left column first in LTR, the
    right column last in RTL. A sidebar word sitting in the MIDDLE of a line is
    not interleaving, it is the candidate legitimately using that word: a
    headline reading "Senior Backend Engineer · Distributed Systems" contains
    the skill "Distributed Systems" because the person wrote it there, and
    flagging that would teach users to ignore the warning.
    """
    for sv in side_vals:
        if not sv or sv in needle or sv not in line:
            continue
        if line.startswith(sv) or line.endswith(sv):
            return sv
    return ""


def _facts_of(resume: ResumeModel) -> list[tuple[str, str]]:
    """(kind, value) for everything a recruiter or an ATS has to recover.

    Kinds are stable ids the UI translates; do not rename them without updating
    the locale files.
    """
    out: list[tuple[str, str]] = []
    c = resume.contact
    for kind, value in (("name", c.name), ("email", c.email), ("phone", c.phone),
                        ("location", c.location), ("linkedin", c.linkedin)):
        if value:
            out.append((kind, value))
    if resume.headline:
        out.append(("headline", resume.headline))
    for exp in resume.experience:
        if exp.title:
            out.append(("title", exp.title))
        if exp.company:
            out.append(("employer", exp.company))
        span = " – ".join(b for b in [exp.start_date, exp.end_date] if b)
        if span:
            out.append(("dates", span))
        for bullet in exp.bullets:
            if bullet:
                out.append(("bullet", bullet))
    for edu in resume.education:
        if edu.institution:
            out.append(("institution", edu.institution))
        degree = ", ".join(b for b in [edu.degree, edu.field] if b)
        if degree:
            out.append(("degree", degree))
    for ms in resume.military_service:
        if ms.unit:
            out.append(("military", ms.unit))
    for cert in resume.certifications:
        if cert:
            out.append(("certification", cert))
    for skill in resume.skills:
        out.append(("skill", skill))
    for lang in resume.languages:
        if lang.language:
            out.append(("language", lang.language))
    return [(k, v) for k, v in out if len(v.strip()) >= _MIN_FACT]


def _sidebar_values(resume: ResumeModel, keys: tuple[str, ...]) -> list[str]:
    """The strings that live in the sidebar column, so a main-column line can be
    tested for having one glued onto it."""
    values: list[str] = []
    if "skills" in keys:
        values += list(resume.skills)
    if "education" in keys:
        values += [e.institution for e in resume.education if e.institution]
    if "certifications" in keys:
        values += [c for c in resume.certifications if c]
    if "languages" in keys:
        values += [x.language for x in resume.languages if x.language]
    return [v for v in values if len(v.strip()) >= _MIN_FACT]


def xray(resume: ResumeModel, template: str = "", fmt: str = "pdf") -> ATSXrayResult:
    fmt = (fmt or "pdf").lower()
    if fmt not in ("pdf", "docx"):
        raise ValueError("fmt must be 'pdf' or 'docx'.")
    spec = get_template(template)

    if fmt == "pdf":
        blob = render_pdf(resume, template=spec.id)
        pages = page_count(resume, template=spec.id)
        raw = extract_text("resume.pdf", blob)
    else:
        # A two-column template has no DOCX of its own — it falls back to the
        # single-column sibling — so the X-ray must report the template the user
        # would ACTUALLY receive, not the one they picked.
        effective = get_template(spec.docx_fallback) if spec.docx_fallback else spec
        blob = render_docx(resume, template=spec.id)
        pages = page_count(resume, template=effective.id)
        raw = extract_text("resume.docx", blob)

    lines = [ln for ln in (raw or "").splitlines() if ln.strip()]
    norm_lines = [_norm(ln) for ln in lines]
    flat = _norm(raw)

    # Only a genuinely two-column PDF can interleave. A DOCX never can (it has
    # no sidebar to interleave with), so pollution is not even tested there.
    two_col = spec.layout == "sidebar" and fmt == "pdf"
    side_vals = [_norm(v) for v in _sidebar_values(resume, spec.sidebar_keys)] if two_col else []

    # The header block spans the FULL page width above both columns, so nothing
    # in it can be interleaved. Everything from the first line after the contact
    # row onward is the two-column region. Without this the headline — which
    # legitimately contains skill words — reads as a collision on every run.
    body_from = 0
    if two_col:
        anchors = [v for v in (resume.contact.email, resume.contact.phone,
                               resume.contact.linkedin, resume.contact.website) if v]
        for a in anchors:
            i = _find(_norm(a), norm_lines)
            if i >= 0:
                body_from = max(body_from, i + 1)

    facts: list[ATSXrayFact] = []
    for kind, value in _facts_of(resume):
        needle = _norm(value)
        hit = _find(needle, norm_lines)

        if hit < 0:
            # Not on one line. If every word is somewhere in the document the
            # parser still has the information, it just wrapped — that is normal
            # and worth distinguishing from an outright loss.
            words = [w for w in needle.split() if len(w) > 2]
            split = bool(words) and all(w in flat for w in words)
            facts.append(ATSXrayFact(
                kind=kind, value=value,
                status="split" if split else "missing",
                line="",
            ))
            continue

        line = lines[hit]
        polluted = ""
        # Pollution only makes a claim about MAIN-column facts below the header.
        # A skill landing beside another skill is just the sidebar reading
        # normally, and the header spans both columns so it cannot interleave.
        if two_col and hit >= body_from and kind in ("title", "employer", "dates"):
            polluted = _collision(norm_lines[hit], needle, side_vals)
        facts.append(ATSXrayFact(
            kind=kind, value=value,
            status="polluted" if polluted else "clean",
            line=line.strip(),
            collided_with=polluted,
        ))

    return ATSXrayResult(
        template=spec.id,
        fmt=fmt,
        pages=pages,
        two_column=two_col,
        docx_fallback=spec.docx_fallback if fmt == "docx" else "",
        text=raw or "",
        facts=facts,
        clean=sum(1 for f in facts if f.status == "clean"),
        split=sum(1 for f in facts if f.status == "split"),
        polluted=sum(1 for f in facts if f.status == "polluted"),
        missing=sum(1 for f in facts if f.status == "missing"),
    )
