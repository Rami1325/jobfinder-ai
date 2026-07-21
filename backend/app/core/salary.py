"""Salary intelligence v1 (PLAN 15.2) — 100% deterministic.

Brand rule: proof over promise. We surface a salary ONLY when a figure is
literally written in the posting text, attached to a currency marker — never
an LLM estimate. The verbatim snippet is kept (`raw`) so the UI can show
exactly what the posting says; min/max/currency/period are parsed for future
aggregation ("seen range per title").
"""
from __future__ import annotations

import re

from app.models import SalaryInfo

# An amount: 15,000 / 18000 / 15.5K / 22k
_AMOUNT = r"(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*[kK]?"
_SEP = r"(?:-|–|—|\bto\b|עד)"

# Currency marker BEFORE the amount ($120,000 - $150,000 / ₪18,000)
_CUR_FIRST = re.compile(
    rf"(?P<cur>[₪$€])\s*(?P<a>{_AMOUNT})(?:\s*{_SEP}\s*[₪$€]?\s*(?P<b>{_AMOUNT}))?"
)
# Currency marker AFTER the amount (15,000-18,000 ₪ / 18K ש"ח / 90000 NIS)
_CUR_LAST = re.compile(
    rf"(?P<a>{_AMOUNT})(?:\s*{_SEP}\s*(?P<b>{_AMOUNT}))?\s*"
    r"(?P<cur>₪|ש[\"״]ח|שקלים|NIS|ILS|USD|EUR|dollars?)",
    re.IGNORECASE,
)

_CURRENCY = {
    "₪": "ILS", "ש\"ח": "ILS", "ש״ח": "ILS", "שקלים": "ILS", "nis": "ILS", "ils": "ILS",
    "$": "USD", "usd": "USD", "dollar": "USD", "dollars": "USD",
    "€": "EUR", "eur": "EUR",
}

_PERIOD_PATTERNS = [
    ("hour", re.compile(r"per\s+hour|/\s*(?:hr|hour)|hourly|לשעה|שעתי", re.IGNORECASE)),
    ("month", re.compile(r"per\s+month|/\s*(?:mo|month)|monthly|לחודש|בחודש|חודשי|ברוטו|נטו", re.IGNORECASE)),
    ("year", re.compile(r"per\s+(?:year|annum)|/\s*(?:yr|year)|annual|yearly|לשנה|שנתי", re.IGNORECASE)),
]


def _to_number(token: str) -> float:
    token = token.strip()
    mult = 1000.0 if token[-1:].lower() == "k" else 1.0
    if mult != 1.0:
        token = token[:-1]
    return float(token.replace(",", "").strip()) * mult


def _period_near(text: str, start: int, end: int) -> str:
    window = text[max(0, start - 40) : min(len(text), end + 40)]
    for period, pattern in _PERIOD_PATTERNS:
        if pattern.search(window):
            return period
    return ""


def extract_salary(text: str) -> SalaryInfo | None:
    """First literal salary mention in `text`, or None. Pure — smoke-pinned.

    Guards against non-salary numbers: an amount only counts with an adjacent
    currency marker, and tiny figures are ignored unless the surrounding text
    marks them hourly (₪60/hour is a wage; "$5 credit" is not a salary)."""
    if not text:
        return None
    for pattern in (_CUR_FIRST, _CUR_LAST):
        for m in pattern.finditer(text):
            lo = _to_number(m.group("a"))
            hi = _to_number(m.group("b")) if m.group("b") else lo
            if hi < lo:
                lo, hi = hi, lo
            period = _period_near(text, m.start(), m.end())
            # Plausibility: hourly wages are small; anything else below 1,000
            # is a price/perk/number, not a salary.
            if period == "hour":
                if not (20 <= hi <= 2000):
                    continue
            elif hi < 1000:
                continue
            return SalaryInfo(
                min=lo,
                max=hi,
                currency=_CURRENCY.get(m.group("cur").lower(), ""),
                period=period,
                raw=" ".join(m.group(0).split()),
            )
    return None
