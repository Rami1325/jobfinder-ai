"""What a proposal may not invent: a rate, a timeline or the freelancer's availability.

The PROPOSAL prompt (`app/llm/prompts.py`) asks the model to leave a marked
placeholder ("[your rate]") wherever a gig asks for one of these and the user
typed nothing, and to use a typed rate verbatim. Asked is not guaranteed
(`docs/handbook/tailoring.md`), so this module is the floor under the prompt,
run on every proposal before it is returned (`core/proposal.py`):

- a money amount the user did not type is REPLACED by the rate placeholder. An
  amount with a time tail ("$45/hour", "250 לשעה") is a rate and only the rate
  box can clear it; one without ("saved $200K") may also be a past result, so
  the resume clears it when it carries the same words;
- a duration ("2 weeks", "תוך שבועיים", "within a month") is replaced by the
  timeline placeholder unless the resume carries the same words (a past
  result, "shipped it in 3 weeks") or the rate box its number;
- a start or hours commitment ("available immediately", "40 hours a week",
  "זמין מיד") is replaced by the availability placeholder;
- a placeholder the model left for the rate is filled with the typed rate,
  verbatim, when there is one.

Every replacement is reported (`Guarded.replaced`), and so is every placeholder
the text still holds and every other number the resume, the gig and the rate
do not carry (`unverified`, a claim for the user to check).

WHAT IT CAN SAY, and what it cannot. It can say that no amount, duration or
availability phrase these patterns know is left in the proposal that neither
the rate box nor the resume carries. It can never say that none was invented:
a commitment in words the patterns do not know ("whenever suits you") passes,
and the `unverified` numbers are compared by containment (a number the resume
holds anywhere clears an invented one that shares it, the fabrication guard's
own weakness). The UI says what it found, never "verified" (the house rule).

Deterministic: no model, no network, no clock. The smoke test pins its imports
by the AST (exactly `__future__`, `re` and `dataclasses`) and its one importer,
`core/proposal.py`. Hebrew words are matched as bare substrings where a prefix
letter can be glued on (the house rule for Hebrew), Latin ones on a boundary.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

KINDS = ("rate", "timeline", "availability")
# The placeholders, one per kind and language. The prompt names these exact
# strings, the page tells the user to fill anything in [brackets], and a typed
# rate replaces the rate one.
PLACEHOLDERS: dict[str, dict[str, str]] = {
    "en": {"rate": "[your rate]", "timeline": "[your timeline]", "availability": "[your availability]"},
    "he": {"rate": "[התעריף שלך]", "timeline": "[לוח הזמנים שלך]", "availability": "[הזמינות שלך]"},
}

_NUM = r"\d[\d,]*(?:\.\d+)?(?:\s?[kK]\b)?"
_RANGE = rf"{_NUM}(?:\s?(?:-|–|to|עד)\s?[$₪€£]?\s?{_NUM})?"
_CUR_SYM = r"[$₪€£]"
_CUR_WORD = (
    r"(?:(?:usd|eur|gbp|ils|nis|dollars?|euros?|pounds?|shekels?)\b"
    r"|ש\"ח|ש״ח|ש''ח|שקלים|שקל|דולרים|דולר|יורו|אירו)"
)
# A time tail makes an amount a RATE: per hour, a day, monthly, לשעה.
_PER = (
    r"(?:\s?/\s?(?:hour|hr|h|day|month|mo|week|wk|project)\b"
    r"|\s(?:per|an|a)\s(?:hour|day|month|week|project)\b"
    r"|\s?(?:hourly|daily|monthly)\b"
    r"|\s?(?:לשעת עבודה|לשעה|ליום עבודה|ליום|לחודש|לפרויקט|לפרוייקט))"
)
# A number with no currency is a rate only with an HOURLY tail ("250 per hour",
# "250 לשעה"): "5 daily standups" and "3 a day" are not prices.
_PER_HOUR = r"(?:\s?/\s?(?:hour|hr|h)\b|\s(?:per|an|a)\s(?:hour)\b|\s?(?:לשעת עבודה|לשעה))"
_MONEY = re.compile(
    rf"(?:{_CUR_SYM}\s?{_RANGE}(?:\s?{_CUR_SYM})?|{_RANGE}\s?(?:{_CUR_SYM}|{_CUR_WORD})"
    rf"|(?:usd|eur|gbp|ils|nis)\s?{_RANGE})(?P<per>{_PER})?"
    rf"|{_RANGE}(?P<per2>{_PER_HOUR})",
    re.IGNORECASE,
)
_UNIT_EN = r"(?:hours?|hrs?|days?|weeks?|wks?|months?)"
_WORDNUM_EN = r"(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|a couple of|a few|several)"
_UNIT_HE = r"(?:ימי עבודה|ימים|יום|שבועות|שבוע|חודשים|חודש|שעות|שעה)"
# No כמה / מספר ("a few", "several"): "כמה שעות בשבוע אתם צריכים?" is the
# client's question, not a commitment.
_WORDNUM_HE = r"(?:שניים|שלושה|ארבעה|חמישה|שישה|שבעה|שמונה|תשעה|עשרה|שלוש|ארבע|חמש|שש|שבע|תשע|עשר)"
_DAYS_EN = r"(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)"
_TIMELINE = re.compile(
    rf"\b{_RANGE}[\s-]+(?:(?:business|working|work)[\s-]+)?{_UNIT_EN}\b"
    rf"|\b{_WORDNUM_EN}[\s-]+(?:(?:business|working|work)[\s-]+)?{_UNIT_EN}\b"
    rf"|\b(?:in|within|by)\s+(?:a|an|one)\s+(?:day|week|month)\b"
    rf"|\b(?:by|before|until)\s+(?:{_DAYS_EN}|tomorrow|next\s+week|the\s+end\s+of\s+(?:the\s+)?(?:day|week|month))\b"
    rf"|{_RANGE}\s?{_UNIT_HE}(?![א-ת])"
    rf"|{_WORDNUM_HE}\s{_UNIT_HE}(?![א-ת])"
    rf"|(?:יומיים|שבועיים|חודשיים|שעתיים)(?![א-ת])"
    rf"|(?:תוך|בתוך|עד)\s(?:יום|שבוע|חודש)(?![א-ת])",
    re.IGNORECASE,
)
# A commitment to WHEN or HOW MUCH: the verb stays, the time goes.
_AVAIL_WHEN = re.compile(
    r"(?P<lead>\b(?:available|availability|start|starting|begin|join)\s+)"
    rf"(?P<when>immediately|right away|right now|now|today|tomorrow|this week|next week|asap"
    rf"|on\s+{_DAYS_EN}|from\s+(?:{_DAYS_EN}|tomorrow|next\s+week)|full[- ]time|part[- ]time)\b"
    r"|(?P<lead_he>(?:זמין|זמינה|זמינים|זמינות|להתחיל|אתחיל|להצטרף)\s+)"
    r"(?P<when_he>מיידית|מידית|מיד|מחר|היום|השבוע|בשבוע הבא|מעכשיו|כבר מחר|כבר השבוע|כבר היום|בהקדם"
    r"|באופן מיידי|במשרה מלאה|במשרה חלקית)(?![א-ת])",
    re.IGNORECASE,
)
_AVAIL_HOURS = re.compile(
    rf"\b{_RANGE}\s?(?:hours?|hrs?)\s?(?:a|per|/|each)\s?(?:week|day|month)\b"
    rf"|{_RANGE}\s?שעות\s?(?:בשבוע|ביום|בחודש)(?![א-ת])",
    re.IGNORECASE,
)
_DIGITS = re.compile(r"\d[\d,]*(?:\.\d+)?")
# A number as written, with what makes it a claim ("40%", "3x", "5+").
_CLAIM_NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?(?:\s?%|x\b|\+)?")
_PLACEHOLDER = re.compile(r"\[[^\[\]\n]{2,40}\]")


@dataclass(frozen=True)
class Guarded:
    """A proposal after the floor ran over it: its text, what was taken out
    (verbatim), the placeholders it holds, and the numbers none of the user's
    sources carry."""

    text: str
    replaced: tuple[str, ...] = ()
    placeholders: tuple[str, ...] = ()
    unverified: tuple[str, ...] = ()


def numbers_in(text: str) -> set[str]:
    """Every number in `text`, commas dropped ("1,500" and "1500" are one)."""
    return {m.group(0).replace(",", "") for m in _DIGITS.finditer(text or "")}


def _cleared(found: str, *, rate: str, resume_text: str, rate_only: bool) -> bool:
    """Whether a matched amount, duration or phrase is the user's own.

    The rate box clears anything it holds verbatim, or whose numbers it holds.
    The resume clears the SAME WORDS it carries ("saved $200K", "in 3 weeks": a
    past result), never a bare shared number, so "5 days" is not cleared by "5
    engineers"; and never a RATE (`rate_only`), which only the user can state."""
    words = " ".join(found.lower().split())
    if words and words in " ".join((rate or "").lower().split()):
        return True
    digits = numbers_in(found)
    if digits and digits <= numbers_in(rate):
        return True
    return not rate_only and bool(words) and words in " ".join((resume_text or "").lower().split())


def guard(text: str, *, language: str, rate: str = "", resume_text: str = "", gig_text: str = "") -> Guarded:
    """The proposal with every rate, timeline and availability the user did not
    give replaced by its placeholder (see the module docstring). `language` picks
    the placeholders ("he", else English); the patterns run in both scripts,
    since a Hebrew proposal can quote a dollar amount."""
    ph = PLACEHOLDERS["he" if language == "he" else "en"]
    replaced: list[str] = []

    def swap(kind: str, found: str, lead: str = "", *, rate_only: bool = False) -> str:
        if _cleared(found, rate=rate, resume_text=resume_text, rate_only=rate_only):
            return lead + found
        replaced.append(found.strip())
        return lead + ph[kind]

    def when(m: re.Match[str]) -> str:
        lead = m.group("lead") or m.group("lead_he") or ""
        return swap("availability", m.group("when") or m.group("when_he") or "", lead)

    out = _AVAIL_HOURS.sub(lambda m: swap("availability", m.group(0)), text or "")
    out = _AVAIL_WHEN.sub(when, out)
    out = _MONEY.sub(
        lambda m: swap("rate", m.group(0), rate_only=bool(m.group("per") or m.group("per2"))), out
    )
    out = _TIMELINE.sub(lambda m: swap("timeline", m.group(0)), out)
    typed = (rate or "").strip()
    if typed:
        for table in PLACEHOLDERS.values():
            out = out.replace(table["rate"], typed)
    placeholders = tuple(dict.fromkeys(m.group(0) for m in _PLACEHOLDER.finditer(out)))
    known = numbers_in(resume_text) | numbers_in(gig_text) | numbers_in(rate)
    unverified = tuple(
        dict.fromkeys(
            m.group(0).strip()
            for m in _CLAIM_NUMBER.finditer(_PLACEHOLDER.sub(" ", out))
            if not numbers_in(m.group(0)) <= known
        )
    )
    return Guarded(text=out, replaced=tuple(replaced), placeholders=placeholders, unverified=unverified)
