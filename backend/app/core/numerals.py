"""Numbers as digits in tailored prose: "five years" -> "5 years" (spec 07 / R2).

Deterministic: no model, no network, no clock. The owner's request is that a
tailored resume reads the way recruiters skim — for digits — and a prompt
instruction about wording is a temperature sample, so this is code.

WHAT IT MAY TOUCH, AND THE FALSE POSITIVES THAT DECIDED EACH RULE:
  - English cardinals two..ninety-nine (hyphenated compounds included), and
    "one" only before a UNIT noun: "one of the", "one-on-one" and "no one" are
    ordinary English, and a digit there is a typo the user did not write.
  - Only when a NOUN-LIKE word follows. "two of the teams", "two or three",
    "more than five", "two-thirds" and "five hundred" keep their words — the
    first four are not quantities of a noun, and "5 hundred" is not a number
    anyone writes.
  - Never a proper noun: a capitalised number word MID-sentence ("the Seven
    Bridges project") or one followed by a capitalised non-acronym word ("Three
    Pillars"). "Five APIs" still converts — an acronym is not a name.
  - Never one half of a compound it cannot read whole: "twenty five years",
    "one or two engineers", "between two and five years" all stay as written,
    because converting half of them produces "one or 2 engineers".
  - Hebrew 2-10, both genders and construct forms, ONLY as a standalone word
    immediately followed by an allowlisted noun. שש and שבע are also ordinary
    words ("שבע רצון"), which is why the noun is required; a prefixed form
    ("בשלוש") is not standalone; and "חמש עשרה שנים" is fifteen, so a number
    word preceded by another number word is left alone. `שנתיים` is its own
    word and stays.

IDEMPOTENT by construction: a digit is never a number word, so a second pass
finds nothing.
"""
from __future__ import annotations

import re

from app.core.lang import detect_language
from app.models import ResumeModel

# --------------------------------------------------------------------------- #
# English
# --------------------------------------------------------------------------- #
_UNITS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9,
}
_TEENS = {
    "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
_TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}
_SIMPLE = {**_UNITS, **_TEENS, **_TENS}

_UNIT_ALT = "|".join(sorted((k for k in _UNITS if k != "one"), key=len, reverse=True) + ["one"])
_NUM_ALT = (
    "(?:" + "|".join(_TENS) + ")-(?:" + _UNIT_ALT + ")|"
    + "|".join(sorted(_SIMPLE, key=len, reverse=True))
)
# The next word is read by LOOKAHEAD, never consumed, so the scan can still look
# at it as a number word of its own ("one or two engineers").
_EN_RE = re.compile(
    r"(?<![\w\-’'])(" + _NUM_ALT + r")(\+?)(?=(-|\s+)([A-Za-z][A-Za-z’']*))",
    re.IGNORECASE,
)

# "one" converts only before these (singular or plural; `percent` included).
_ONE_UNITS = {
    "year", "month", "week", "day", "team", "engineer", "developer", "person",
    "people", "product", "project", "client", "customer", "country", "countries",
    "language", "office", "site", "market", "region", "release", "service",
    "system", "hire", "report", "direct", "member", "employee", "squad", "percent",
}
# A following word that means the number word is NOT a quantity of a noun.
_STOP_NEXT = {
    "of", "or", "and", "to", "the", "a", "an", "another", "more", "less", "than",
    "fewer", "times", "hundred", "hundreds", "thousand", "thousands", "million",
    "millions", "billion", "billions", "dozen", "dozens", "half", "halves",
    "third", "thirds", "quarter", "quarters", "fourth", "fourths", "fifth",
    "fifths", "sixth", "sixths", "seventh", "sevenths", "eighth", "eighths",
    "ninth", "ninths", "tenth", "tenths", "on", "in", "at", "by", "for", "with",
    "is", "are", "was", "were", "who", "which", "that",
}
_SENTENCE_START = set(".!?:;•·–—(\"“‘*>|\n")
_PREV_TOKENS_RE = re.compile(r"[A-Za-z]+|\d+")


def _is_number_word(word: str) -> bool:
    w = word.lower()
    if w in _SIMPLE:
        return True
    head, _, tail = w.partition("-")
    return head in _TENS and tail in _UNITS


def _value(word: str) -> int:
    w = word.lower()
    if w in _SIMPLE:
        return _SIMPLE[w]
    head, _, tail = w.partition("-")
    return _TENS[head] + _UNITS[tail]


def _singular(word: str) -> str:
    w = word.lower().rstrip("’'")
    if w in _ONE_UNITS:
        return w
    if w.endswith("ies") and w[:-3] + "y" in _ONE_UNITS:
        return w[:-3] + "y"
    if w.endswith("s") and w[:-1] in _ONE_UNITS:
        return w[:-1]
    return w


def _acronym(word: str) -> bool:
    return sum(c.isupper() for c in word) >= 2


def _convert_en(text: str) -> tuple[str, list[str]]:
    out: list[str] = []
    phrases: list[str] = []
    pos = 0
    for m in _EN_RE.finditer(text):
        word, plus, sep, nxt = m.group(1), m.group(2), m.group(3), m.group(4)
        nxt_l = nxt.lower().rstrip("’'")
        before = text[: m.start()]
        # A compound this scan cannot read whole: the word before is a number
        # (or a digit), or it is "or/to/and" with a number before THAT.
        prev = _PREV_TOKENS_RE.findall(before[-40:])
        if prev and (_is_number_word(prev[-1]) or prev[-1].isdigit()):
            continue
        if (
            len(prev) >= 2
            and prev[-1].lower() in {"or", "to", "and"}
            and (_is_number_word(prev[-2]) or prev[-2].isdigit())
        ):
            continue
        if nxt_l in _STOP_NEXT or _is_number_word(nxt_l):
            continue
        if _value(word) == 1 and _singular(nxt) not in _ONE_UNITS:
            continue
        stripped = before.rstrip()
        at_start = not stripped or stripped[-1] in _SENTENCE_START
        if word[0].isupper() and not at_start:
            continue  # "the Seven Bridges project"
        if nxt[0].isupper() and not _acronym(nxt):
            continue  # "Three Pillars"
        digits = str(_value(word))
        if nxt_l == "percent" and sep.strip() == "" and not plus:
            replacement = digits + "%"
            end = m.end() + len(sep) + len(nxt)
            phrase = replacement
        else:
            replacement = digits + plus
            end = m.end()
            phrase = f"{replacement}{sep if sep == '-' else ' '}{nxt}"
        out.append(text[pos: m.start()])
        out.append(replacement)
        phrases.append(phrase)
        pos = end
    if not phrases:
        return text, []
    out.append(text[pos:])
    return "".join(out), phrases


# --------------------------------------------------------------------------- #
# Hebrew
# --------------------------------------------------------------------------- #
_HE_NUMS = {
    "שני": 2, "שתי": 2, "שניים": 2, "שתיים": 2,
    "שלושה": 3, "שלוש": 3, "שלושת": 3,
    "ארבעה": 4, "ארבע": 4, "ארבעת": 4,
    "חמישה": 5, "חמש": 5, "חמשת": 5,
    "שישה": 6, "שש": 6, "ששת": 6,
    "שבעה": 7, "שבע": 7, "שבעת": 7,
    "שמונה": 8, "שמונת": 8,
    "תשעה": 9, "תשע": 9, "תשעת": 9,
    "עשרה": 10, "עשר": 10, "עשרת": 10,
}
_HE_NOUNS = (
    "שנים", "שנות", "חודשים", "חודשי", "שבועות", "צוותים", "עובדים", "מפתחים",
    "מהנדסים", "אנשים", "פרויקטים", "לקוחות", "מוצרים", "מדינות", "שפות",
    "חברות", "מערכות",
)
# Number words that make the NEXT number word part of a compound ("חמש עשרה").
_HE_COMPOUND_PREV = set(_HE_NUMS) | {
    "אחת", "אחד", "עשרים", "שלושים", "ארבעים", "חמישים", "שישים", "שבעים",
    "שמונים", "תשעים", "מאה", "מאות", "אלף", "אלפים",
}
_HE_RE = re.compile(
    r"(?<![\w\-־׳״'\"])("
    + "|".join(sorted(_HE_NUMS, key=len, reverse=True))
    + r")(?=\s+("
    + "|".join(sorted(_HE_NOUNS, key=len, reverse=True))
    + r")(?![\w]))"
)
_HE_PREV_RE = re.compile(r"[א-ת]+|\d+")


def _convert_he(text: str) -> tuple[str, list[str]]:
    out: list[str] = []
    phrases: list[str] = []
    pos = 0
    for m in _HE_RE.finditer(text):
        prev = _HE_PREV_RE.findall(text[max(0, m.start() - 24): m.start()])
        if prev and (prev[-1] in _HE_COMPOUND_PREV or prev[-1].isdigit()):
            continue
        digits = str(_HE_NUMS[m.group(1)])
        out.append(text[pos: m.start()])
        out.append(digits)
        phrases.append(f"{digits} {m.group(2)}")
        pos = m.end()
    if not phrases:
        return text, []
    out.append(text[pos:])
    return "".join(out), phrases


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #
def _convert(text: str, lang: str) -> tuple[str, list[str]]:
    if not text:
        return text, []
    phrases: list[str] = []
    if lang in ("en", ""):
        text, p = _convert_en(text)
        phrases += p
    if lang in ("he", ""):
        text, p = _convert_he(text)
        phrases += p
    return text, phrases


def digits_in_text(text: str, lang: str) -> tuple[str, int]:
    """(converted text, number of conversions). `lang` "en" / "he" runs one
    language's rules; anything else runs both (their vocabularies are disjoint)."""
    out, phrases = _convert(text, lang)
    return out, len(phrases)


def _prose_fields(resume: ResumeModel):
    """(section, getter, setter) for every PROSE field this may rewrite: the
    summary, the headline, experience bullets, project description + bullets,
    military bullets. Titles, company names, dates, skills and every other field
    are deliberately absent."""
    yield "summary", resume.summary, lambda r, v: setattr(r, "summary", v)
    yield "headline", resume.headline, lambda r, v: setattr(r, "headline", v)
    for i, exp in enumerate(resume.experience):
        for j, b in enumerate(exp.bullets):
            yield "experience", b, lambda r, v, i=i, j=j: r.experience[i].bullets.__setitem__(j, v)
    for i, proj in enumerate(resume.projects):
        yield "projects", proj.description, lambda r, v, i=i: setattr(r.projects[i], "description", v)
        for j, b in enumerate(proj.bullets):
            yield "projects", b, lambda r, v, i=i, j=j: r.projects[i].bullets.__setitem__(j, v)
    for i, ms in enumerate(resume.military_service):
        for j, b in enumerate(ms.bullets):
            yield "military_service", b, lambda r, v, i=i, j=j: r.military_service[i].bullets.__setitem__(j, v)


def digits_in_resume(resume: ResumeModel) -> tuple[ResumeModel, int, str]:
    """(resume, conversions, first section touched). Returns `resume` ITSELF when
    nothing converts — the identity convention every other tailor stage shares.
    Never mutates its input."""
    planned: list[tuple[str, object, str]] = []
    total = 0
    first = ""
    for section, text, setter in _prose_fields(resume):
        new, phrases = _convert(text, detect_language(text or ""))
        if phrases:
            planned.append((section, setter, new))
            total += len(phrases)
            first = first or section
    if not total:
        return resume, 0, ""
    out = resume.model_copy(deep=True)
    for _section, setter, new in planned:
        setter(out, new)  # type: ignore[operator]
    return out, total, first


def quantity_phrases(resume: ResumeModel) -> list[str]:
    """The quantities a resume states IN WORDS, as this module would write them
    in digits ("5 years"). Read from the ORIGINAL resume so the fabrication guard
    can tell a converted fact ("five years" -> "5 years") from a number the model
    invented in words ("fifteen engineers")."""
    phrases: list[str] = []
    for _section, text, _setter in _prose_fields(resume):
        phrases += _convert(text, detect_language(text or ""))[1]
    return phrases
