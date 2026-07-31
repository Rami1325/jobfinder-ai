"""Résumé date parsing, shared by the ATS scanner and the section-order rule.

Résumé dates arrive as whatever the candidate typed. ATS parsers are far more
reliable on `Mar 2020` / `03/2020` / `2020` than on "summer of 2019", and a
date it cannot read is a role it may date wrong or drop. So this module does
two jobs: read a date well enough to do arithmetic with it, and say what the
ATS-safe way to write it would have been.

Nothing here mutates a résumé — the scanner reports the suggestion and the
user decides. Hebrew résumés are first-class: Hebrew month names and the
"still there" words are recognised alongside the English ones.
"""
from __future__ import annotations

import re
from datetime import date

# "I still work here" — a valid end date, not an unparseable one.
CURRENT_WORDS = (
    "present", "current", "currently", "now", "today", "ongoing", "date",
    "היום", "כיום", "הווה", "עכשיו",
)

_MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "oct": 10,
    "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
    "ינואר": 1, "פברואר": 2, "מרץ": 3, "מרס": 3, "אפריל": 4, "מאי": 5,
    "יוני": 6, "יולי": 7, "אוגוסט": 8, "ספטמבר": 9, "אוקטובר": 10,
    "נובמבר": 11, "דצמבר": 12,
}
_MONTH_NAMES = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

_YEAR = re.compile(r"(?<!\d)(19\d{2}|20\d{2})(?!\d)")
# 03/2020, 3-2020, 03.2020 — and the reversed 2020/03.
_NUMERIC = re.compile(r"(?<!\d)(\d{1,2})\s*[/.\-]\s*((?:19|20)\d{2})(?!\d)")
_NUMERIC_REV = re.compile(r"(?<!\d)((?:19|20)\d{2})\s*[/.\-]\s*(\d{1,2})(?!\d)")


def is_current(value: str) -> bool:
    low = (value or "").strip().lower()
    return bool(low) and any(w in low for w in CURRENT_WORDS)


def _parse(value: str) -> tuple[int, int, bool] | None:
    """(year, month, month_was_stated). Whether the month was actually found —
    rather than defaulted — is the difference between suggesting a date and
    inventing one, so it is carried out of the parse instead of re-guessed
    from the raw text later."""
    text = (value or "").strip()
    if not text or is_current(text):
        return None

    m = _NUMERIC.search(text)
    if m and 1 <= int(m.group(1)) <= 12:
        return int(m.group(2)), int(m.group(1)), True
    m = _NUMERIC_REV.search(text)
    if m and 1 <= int(m.group(2)) <= 12:
        return int(m.group(1)), int(m.group(2)), True

    year = _YEAR.search(text)
    if not year:
        return None
    lowered = text.lower()
    for name, num in _MONTHS.items():
        if re.search(rf"(?<!\w){re.escape(name)}", lowered):
            return int(year.group(1)), num, True
    return int(year.group(1)), 1, False


def parse_date(value: str) -> tuple[int, int] | None:
    """(year, month) for a résumé date, or None when it cannot be read. Month
    defaults to 1 when only a year is given — good enough for the duration
    arithmetic this module exists to support."""
    parsed = _parse(value)
    return (parsed[0], parsed[1]) if parsed else None


def ats_form(value: str) -> str:
    """How this date should be written for an ATS: "Mar 2020", or "2020" when
    no month was stated. "" when the value cannot be read at all.

    A bare year stays a bare year — printing "Jan" for a date that never said
    January would hand the candidate a fabricated fact to defend."""
    if is_current(value):
        return "Present"
    parsed = _parse(value)
    if not parsed:
        return ""
    year, month, month_stated = parsed
    return f"{_MONTH_NAMES[month - 1]} {year}" if month_stated else str(year)


def months_between(start: str, end: str, today: date | None = None) -> int:
    """Length of one role in months. An unreadable start yields 0; an
    unreadable-but-current end counts up to today."""
    begin = parse_date(start)
    if not begin:
        return 0
    finish = parse_date(end)
    if not finish:
        if not end or is_current(end):
            now = today or date.today()
            finish = (now.year, now.month)
        else:
            return 0
    span = (finish[0] - begin[0]) * 12 + (finish[1] - begin[1])
    return max(span, 0)


def years_of_experience(resume, today: date | None = None) -> float:
    """Total professional experience in years, measured over the UNION of the
    roles' month spans so overlapping or concurrent jobs are not double
    counted. Military service is deliberately excluded — it is its own
    section and its own kind of credential."""
    spans: list[tuple[int, int]] = []
    for exp in resume.experience:
        begin = parse_date(exp.start_date)
        if not begin:
            continue
        end = parse_date(exp.end_date)
        if not end:
            if exp.end_date and not is_current(exp.end_date):
                continue
            now = today or date.today()
            end = (now.year, now.month)
        lo, hi = begin[0] * 12 + begin[1], end[0] * 12 + end[1]
        if hi > lo:
            spans.append((lo, hi))
    if not spans:
        return 0.0
    spans.sort()
    total, cur_lo, cur_hi = 0, *spans[0]
    for lo, hi in spans[1:]:
        if lo > cur_hi:
            total += cur_hi - cur_lo
            cur_lo, cur_hi = lo, hi
        else:
            cur_hi = max(cur_hi, hi)
    total += cur_hi - cur_lo
    return round(total / 12, 1)
