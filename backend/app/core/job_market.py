"""Is this job in Israel? Deterministic: no model, no network, no clock.

One consumer today: the opt-in "leave Arabic off tailored resumes for jobs in
Israel" preference (spec 07 / R1). The verdict decides whether a TRUE fact is
left off a document, so it has to be reproducible offline and explainable — the
same reasons `geo_restriction.py` refuses a model.

THREE ANSWERS, NEVER TWO. `True` (the posting or its location names Israel, or
the posting is written in Hebrew), `False` (it clearly names somewhere else and
never Israel), and `None` (it says nothing we can read). Folding `None` into
`False` would tell a user with the preference on that nothing needed doing on a
job we simply could not place — the tailor reports "we couldn't tell" instead,
so the owner can remove it by hand.

The token rules are the geo work's, applied from the other side:
  - LATIN tokens need word boundaries. `lod` (Lod) is a substring of "lodging",
    "exploded" and "melody"; one hit clears a posting outright there, and one hit
    would strip a language off a resume here.
  - HEBREW tokens match as bare substrings. ב/ל/ה/ו/מ/ש glue onto the noun and
    are word characters, so `\\bתל אביב\\b` misses "בתל אביב" — the commonest
    spelling of the commonest location in the primary market.
"""
from __future__ import annotations

import re

# Latin Israel tokens. Apostrophes are optional and may be curly, a two-word city
# may be spaced or hyphenated, because job boards spell every one of these
# several ways.
_A = "['’]?"
_S = r"[\s\-]*"
_IL_LATIN = [
    r"israel(?:i|is)?",
    rf"tel{_S}aviv(?:{_S}(?:-{_S})?yafo|{_S}jaffa)?",
    "jerusalem",
    "haifa",
    r"herzliy?a|herzlia",
    rf"ra{_A}anana",
    rf"peta(?:c)?h{_S}tik(?:v|w)a|petah{_S}tiqwa",
    rf"ramat{_S}gan",
    "givatayim",
    rf"rishon{_S}le{_S}zion|rishon{_S}lezion",
    "rehovot",
    rf"nes{_S}s?ziona|ness{_S}ziona",
    "netanya",
    rf"kfar{_S}saba",
    rf"hod{_S}ha{_S}sharon",
    rf"rosh{_S}ha{_S}{_A}?ayin",
    rf"airport{_S}city",
    rf"or{_S}yehuda",
    "holon",
    rf"bnei{_S}b(?:e)?rak",
    rf"modi{_A}in",
    rf"be{_A}?er{_S}sheva|beersheba",
    rf"yokne{_A}am",
    "caesarea",
    rf"kiryat{_S}gat",
    "ashdod",
    "nazareth",
    rf"migdal{_S}ha{_S}emek",
    "tefen",
    "lod",
]
_IL_LATIN_RE = re.compile(
    r"(?<![A-Za-z])(?:" + "|".join(_IL_LATIN) + r")(?![A-Za-z])", re.IGNORECASE
)

# Hebrew Israel tokens: substrings, never bounded (see the module docstring).
_IL_HEBREW = (
    "ישראל", "תל אביב", "תל-אביב", "ירושלים", "חיפה", "הרצליה", "רעננה",
    "פתח תקווה", "פתח תקוה", "רמת גן", "ראשון לציון", "רחובות", "נתניה",
    "כפר סבא", "הוד השרון", "ראש העין", "באר שבע", "יקנעם", "קיסריה", "אשדוד",
    "נצרת", "מודיעין",
)

# "Clearly names another country". Deliberately a short list of places job
# boards actually print, not a gazetteer: a miss here costs a "we couldn't tell"
# note, never a removal, so recall is cheap and precision is what matters.
_OTHER_LATIN = [
    r"united{_S}states", r"united{_S}kingdom", "england", "scotland", "ireland",
    "germany", "france", "spain", "portugal", "italy", "netherlands", "belgium",
    "switzerland", "austria", "poland", "romania", "ukraine", "sweden", "norway",
    "denmark", "finland", "canada", "mexico", "brazil", "argentina", "india",
    "singapore", "australia", r"new{_S}zealand", "japan", "china", "cyprus",
    "greece", "czechia", r"czech{_S}republic", "hungary", "bulgaria", "serbia",
    "estonia", "lithuania", "latvia",
    r"new{_S}york", r"san{_S}francisco", "london", "berlin", "paris", "amsterdam",
    "dublin", "madrid", "barcelona", "lisbon", "munich", "warsaw", "toronto",
    "vancouver", "bangalore", "bengaluru", "seattle", "boston", "austin", "chicago",
]
_OTHER_LATIN_RE = re.compile(
    r"(?<![A-Za-z])(?:" + "|".join(p.replace("{_S}", _S) for p in _OTHER_LATIN) + r")(?![A-Za-z])",
    re.IGNORECASE,
)
# Short country codes are CASE-SENSITIVE: "us" is a pronoun in every posting.
_OTHER_CODES_RE = re.compile(r"(?<![A-Za-z.])(?:US|USA|U\.S\.A?\.?|UK|U\.K\.)(?![A-Za-z])")


def _names_israel(text: str) -> bool:
    if not text:
        return False
    if _IL_LATIN_RE.search(text):
        return True
    return any(tok in text for tok in _IL_HEBREW)


def _names_elsewhere(text: str) -> bool:
    if not text:
        return False
    return bool(_OTHER_LATIN_RE.search(text) or _OTHER_CODES_RE.search(text))


def israel_market(jd_text: str, location: str = "", language: str = "") -> bool | None:
    """True / False / None — see the module docstring. An Israel token anywhere
    wins over another country ("offices in London and Tel Aviv" is a job an
    Israeli applies to from Israel)."""
    if language == "he":
        return True
    if _names_israel(location) or _names_israel(jd_text):
        return True
    if _names_elsewhere(location) or _names_elsewhere(jd_text):
        return False
    return None


# `JDModel.market` values. "" is UNKNOWN — every JD stored before this field
# existed reads as unknown, never as "not Israel".
MARKET_IL = "IL"
MARKET_OTHER = "other"


def market_code(verdict: bool | None) -> str:
    return MARKET_IL if verdict is True else MARKET_OTHER if verdict is False else ""


def stamp_market(jd, jd_text: str, location: str = ""):  # noqa: ANN001, ANN201 - JDModel, duck-typed
    """Re-stamp an ANALYSED JD's market with a location the analyzer never saw
    (a job board's location field). Mutates and returns `jd`.

    AFTER the analyze call, never inside it, and that is the point: both callers
    (`kits.process_next_kit` and `POST /jd/analyze`) reach `analyze_jd` through a
    one-argument injectable the smoke fakes call exactly that way, so the hint
    rides here instead of widening that shape.

    UPGRADE-ONLY. "IL" is never overwritten; a location naming Israel beats a
    text that named nowhere or elsewhere; and an unknown stamp takes whatever the
    location can say. A known "other" is not downgraded to unknown by a location
    that says nothing."""
    if jd.market == MARKET_IL:
        return jd
    verdict = israel_market(jd_text, location or "", jd.language)
    if verdict is True or not jd.market:
        jd.market = market_code(verdict)
    return jd
