"""Geographic hiring restrictions stated in a job posting — 100% deterministic.

The worldwide-remote opt-in (`SearchContext.include_worldwide`) queries LinkedIn
for remote roles in the US / UK / EU. Many of those are remote *within that
country only* — "must be authorized to work in the United States", "open to
candidates residing in the UK" — which an Israeli cannot work. They burn a
result slot, an LLM scoring call, and the user's attention. This module reads
the posting and says whether it STATES such a restriction.

Three things this module can never say, stated here so nobody widens it:

1. It can say a posting **states** a restriction. It can never say the user
   cannot work the role. Greenhouse/Ashby/Lever put the sponsorship question in
   the application FORM, not the body; an Israeli with a second EU passport
   reads "EU work permit required" as a green light. The verdict is a label on
   the TEXT, and the UI quotes the sentence so the user adjudicates.
2. An empty or unfetchable description is not evidence. Abstain — the same
   contract `job_search._score_hit` keeps when a per-job problem occurs.
3. This is a high-precision, LOW-RECALL labeller, not a filter that catches
   everything: roughly a third to a half of unworkable postings say so in the
   body at all. Under-flagging is the safe direction and the copy must never
   imply the list is complete.

Never the LLM and never the network (both source-pinned by the smoke test): it
runs on every gated hit of every search, and a model verdict at temperature=0.3
is one sample — a boolean that removes a job has no error bar the user can see.
`raw` is the posting's own sentence, the way `salary.SalaryInfo.raw` is the
posting's own figure: proof over promise.

Two facts elsewhere in the codebase hold this module's Hebrew shortcut up, and
both are one refactor from false — `job_search.WORLDWIDE_BOARD == "linkedin"`
and `LinkedInProvider` stamping `language="en"`. Any Hebrew in the text clears
the posting, because on the only path that reaches this module a Hebrew posting
is an Israeli one. Register a second global board and R1 could suppress a real
restriction.
"""
from __future__ import annotations

import re

from app.core.lang import HEBREW_RE
from app.core.salary import extract_salary
from app.models import GeoRestriction

# Tier 1: an explicitly stated authorization / citizenship / clearance /
# residency requirement naming a place. These are filtered BEFORE the scoring
# LLM call and returned in `JobSearchResult.filtered` so the removal is visible.
# Everything else is a badge and is never filtered. Exported so the smoke test
# imports the tier set rather than restating it (the RELEVANT_MIN convention).
BLOCKING_KINDS: frozenset[str] = frozenset(
    {"work_auth", "citizenship", "clearance", "residency", "title_tag"}
)

RAW_MAX = 240  # `raw` renders inline on a 390px card — layout-load-bearing, so pinned here


# --------------------------------------------------------------------------- #
# Step 0 — boilerplate truncation
# --------------------------------------------------------------------------- #
# The US EEO block ships on ~100% of US postings and contains "citizenship
# status" and "national origin"; the pay-transparency block names Colorado and
# California with the OPPOSITE polarity to a state exclusion. Cutting at the
# first of these headings is the highest-yield preprocessing step in the module.
# Guarded in BOTH directions: the same restriction sentence ABOVE the heading
# must still fire, or "suppress the EEO block" is satisfied by truncating
# everything.
_BOILERPLATE_RE = re.compile(
    r"(?i)(equal opportunity|equal employment opportunity|eeo is the law|"
    r"pay transparency|privacy notice|applicants have rights|e-verify|ccpa|"
    r"affirmative action|vevraa)|(המשרה פונה לנשים וגברים)"
)


def _strip_boilerplate(text: str) -> str:
    m = _BOILERPLATE_RE.search(text)
    return text[: m.start()] if m else text


# --------------------------------------------------------------------------- #
# The place vocabulary
# --------------------------------------------------------------------------- #
# Compiled WITHOUT re.IGNORECASE — case-sensitivity is load-bearing. Lowercase
# "us" is one of the commonest English words in a job ad ("contact us", "join
# us"), so an IGNORECASE \bUS\b fires on nearly every posting. Scoped (?i:…)
# groups keep the multi-word names case-insensitive.
# "IL" is NEVER an Israel token — Greenhouse and Lever emit "Chicago, IL".
_PLACE = (
    r"(?:the\s+)?(?:US|U\.S\.|USA|U\.S\.A\.|UK|U\.K\.|EU|EEA|"
    r"(?i:United States|United Kingdom|Great Britain|Britain|America|Canada|"
    r"Australia|New Zealand|European Union|European Economic Area|Schengen|"
    r"Ireland|Germany|Netherlands|Switzerland|Singapore))"
)

_SCOPE_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("us", re.compile(r"U\.S\.A?\.|\b(?:US|USA)\b|(?i:United States|America)")),
    ("uk", re.compile(r"U\.K\.|\bUK\b|(?i:United Kingdom|Great Britain|Britain)")),
    ("eu", re.compile(r"\b(?:EU|EEA)\b|(?i:European Union|European Economic Area|Schengen)")),
]

# Named legal regimes that ARE a scope even with no country word in the
# sentence. Without these, "we cannot offer Skilled Worker sponsorship" (a UK
# visa route) would inherit whatever country the posting happened to mention
# elsewhere, and the card could read "Likely US-only" above a quote that says
# nothing of the kind — a card contradicting its own evidence.
_REGIME_SCOPE: list[tuple[str, re.Pattern[str]]] = [
    (
        "us",
        re.compile(
            r"(?i)\bITAR\b|\bEAR\b|U\.?S\.? person|green card|H-?1B|"
            r"lawful permanent resident|federal contract|TS/SCI|\bDoD\b"
        ),
    ),
    (
        "uk",
        re.compile(
            r"(?i)skilled worker|\bBPSS\b|\bSC cleared\b|\bDV cleared\b|"
            r"right to work in the UK"
        ),
    ),
]


def _scope_of(fragment: str) -> str:
    for scope, pattern in _SCOPE_PATTERNS:
        if pattern.search(fragment):
            return scope
    for scope, pattern in _REGIME_SCOPE:
        if pattern.search(fragment):
            return scope
    return "other"


def _scope_near(hay: str, fragment: str, start: int, end: int) -> str:
    """The fragment's own scope, else one named in the SAME SENTENCE.

    An 80-character window was still a whole neighbouring sentence in either
    direction, and it also reached the `location`/`title` strings joined onto
    the haystack — so on any worldwide-pass hit the origin market was always in
    range. "We are a London fintech. Our customers are in the United States.
    Unfortunately we cannot offer visa sponsorship." stamped "Likely US-only"
    onto a sentence naming no country at all, which is the self-contradicting
    card this function exists to prevent. Bounded by sentence terminators, the
    scope can only come from the sentence the user is shown."""
    scope = _scope_of(fragment)
    if scope != "other":
        return scope
    left = max(hay.rfind(".", 0, start), hay.rfind("\n", 0, start)) + 1
    right = min(
        (i for i in (hay.find(".", end), hay.find("\n", end)) if i != -1),
        default=len(hay),
    )
    return _scope_of(hay[max(0, left) : right])


def _place_in(fragment: str) -> str:
    m = re.search(_PLACE, fragment)
    return m.group(0).strip() if m else ""


# --------------------------------------------------------------------------- #
# R0 — Israel named inside an exclusion clause
# --------------------------------------------------------------------------- #
# Runs BEFORE the Israel-open shortcut, or "we hire across EMEA, excluding
# Israel" reads as openness. Requires an exclusion verb/preposition within 60
# characters: a bare "Israel" in an office or entity list falls through to R1
# and clears the posting. The sanctions-list preamble ("we cannot hire in
# Russia, Belarus, Iran, North Korea") never matches — Israel is not in it.
_ISRAEL_EXCLUDED = [
    re.compile(r"(?i)(?:excluding|excl\.?|except|not including|other than)[^.\n]{0,60}israel"),
    re.compile(
        r"(?i)(?:cannot|can't|unable to|do not|don't|not able to)\s+"
        r"(?:currently\s+)?(?:hire|employ)[^.\n]{0,60}israel"
    ),
]

# The mirror image, and the costliest inversion in the module: "we are unable to
# employ candidates OUTSIDE of Israel" is an Israel-ONLY posting — the single
# most desirable category for this user — and it satisfies R0's negated-hiring
# rule word for word. The module already guards this shape in Hebrew (אזרחות
# ישראלית is an inclusion signal wearing exclusion grammar); it must guard it in
# English too. Checked BEFORE R0, because R1 runs after R0 and cannot rescue it.
_ISRAEL_ONLY = [
    re.compile(r"(?i)outside\s+(?:of\s+)?israel"),
    re.compile(r"(?i)not\s+(?:physically\s+)?(?:located|based|residing|resident)\s+in\s+israel"),
    re.compile(r"(?i)israel[- ]based\s+(?:candidates|applicants|employees|only)"),
    re.compile(r"(?i)(?:must|only)[^.\n]{0,40}\b(?:reside|be\s+(?:based|located))\s+in\s+israel"),
    re.compile(r"(?i)israel\s+only\b"),
]

# --------------------------------------------------------------------------- #
# R1 — Israel-open shortcut
# --------------------------------------------------------------------------- #
# Israel tokens are matched as BARE SUBSTRINGS, never with \b. Hebrew's
# inseparable prefixes (ב/ל/ה/ו/מ/ש) are word characters, so
# re.search(r"\bישראל\b", "מותר לעבוד בישראל בלבד") is False while the
# substring test is True — the Python twin of the frontend's check-10 defect.
#
# The vocabulary is READ FROM `app.core.providers.geo`, not copied — a second
# city list would drift. The import is DEFERRED into the function because
# reaching that module initialises the `providers` PACKAGE, whose __init__
# imports every provider, and `comeet` imports `job_match`, which imports this
# module: at module level that is an import cycle. Cached after the first call.
#
# The Hebrew half must stay a bare substring; the LATIN half must not. "lod"
# (Lod, from HE_CITY_ALIASES) is a substring of "lodging", "exploded" and
# "melody", and one occurrence clears the posting outright — so a US-only ad
# whose benefits mention lodging was silently unclassifiable. Latin aliases get
# a word boundary; Hebrew keeps the substring test that the inseparable
# prefixes (ב/ל/ה/ו/מ/ש) require.
_israel_tokens_cache: tuple[tuple[str, ...], re.Pattern[str] | None] | None = None


def _israel_tokens() -> tuple[tuple[str, ...], re.Pattern[str] | None]:
    """(substring tokens, word-boundary pattern). Hebrew in the first, Latin in
    the second."""
    global _israel_tokens_cache
    if _israel_tokens_cache is None:
        from app.core.providers.geo import HE_CITY_ALIASES, ISRAEL_TOKENS

        every = (
            {t.lower() for t in ISRAEL_TOKENS}
            | {k.lower() for k in HE_CITY_ALIASES}
            | {v.lower() for v in HE_CITY_ALIASES.values()}
        )
        substrings = sorted({t for t in every if HEBREW_RE.search(t)} | {".co.il"})
        latin = sorted(t for t in every if not HEBREW_RE.search(t))
        pattern = (
            re.compile(r"\b(?:" + "|".join(re.escape(t) for t in latin) + r")\b")
            if latin
            else None
        )
        _israel_tokens_cache = (tuple(substrings), pattern)
    return _israel_tokens_cache

# The trailing-qualifier trap is the whole rule here: "work from anywhere" is
# an allow signal, "work from anywhere IN THE US" is the single highest-
# confidence restriction in the catalogue, and it differs only after the phrase.
# "we hire in any country where we have a legal entity" is deliberately ABSENT:
# it is conditional and points at an undisclosed country list (Tier 2 payroll).
_GLOBAL_OPEN = [
    re.compile(r"(?i)work from anywhere(?!\s+(?:in|within)\b)"),
    re.compile(r"(?i)anywhere in the world"),
    re.compile(r"(?i)remote\s*[-–—(,]\s*(?:worldwide|global)\b"),
    re.compile(r"(?i)we hire (?:globally|worldwide)"),
    re.compile(r"(?i)(?:open to candidates|hiring) anywhere\b"),
]

# --------------------------------------------------------------------------- #
# Suppressors — polarity guards. The negation carries the meaning, never the
# noun phrase: a substring matcher on "visa sponsorship" gets these backwards.
# --------------------------------------------------------------------------- #
_SPONSOR_SUPPRESSORS = [
    re.compile(r"(?i)sponsorship\s+(?:is\s+)?(?:available|offered|provided)"),
    re.compile(r"(?i)(?:happy|able|willing|glad|open)\s+to\s+sponsor"),
    re.compile(r"(?i)we\s+(?:can|do|will|are able to)\s+sponsor"),
    # The tautologies: they look like hard restrictions and exclude nobody.
    # _PLACE cannot match "the country", so T1.1 already excludes them
    # structurally; listed for belt and braces.
    re.compile(r"(?i)authorized to work in (?:the\s+)?(?:country|jurisdiction)\b"),
    re.compile(r"(?i)right to work in your country of residence"),
]

# Relocation is about MOVING an already-eligible person, not about eligibility,
# so it may only cancel the Tier-2 onsite rule. Suppressing work_auth with it
# let a benefits paragraph erase a real sponsorship refusal.
_RELOCATION_SUPPRESSOR = re.compile(
    r"(?i)relocation\s+(?:package|assistance|support)\s+(?:is\s+)?(?:offered|provided|available)"
)

# --------------------------------------------------------------------------- #
# TIER 1 — blocking. Every rule needs an OBLIGATION word AND a scope word AND a
# named place. Never a bare place: "office in New York", "headquartered in the
# United States" and "reporting to the VP in London" carry no obligation stem.
# --------------------------------------------------------------------------- #
_TIER1: list[tuple[str, re.Pattern[str]]] = [
    # T1.1 work authorisation. "prior experience working with US-based clients"
    # has no obligation+authorization stem and cannot reach this.
    (
        "work_auth",
        re.compile(
            r"(?i)(?:must|should|need to|required to|have to)\s+(?:be\s+)?"
            r"(?:legally\s+|lawfully\s+|currently\s+)*"
            r"(?:authoriz|authoris|eligible|entitled)\w*\s+to\s+work\s+(?:in|for)\s+" + _PLACE
        ),
    ),
    # T1.2 refusal to sponsor. The suppressor block runs first, so "we are happy
    # to sponsor" cannot reach here. This family has no mandatory place — it
    # leans on the origin_market gate and on R1, stated as a dependency rather
    # than an oversight.
    (
        "work_auth",
        re.compile(
            r"(?i)(?:will not|cannot|can't|unable to|not able to|does not|do not|don't)\s+"
            r"(?:currently\s+|be able to\s+)?(?:offer|provide|consider)?\s*"
            r"(?:visa\s+|employment\s+|immigration\s+|skilled worker\s+)?sponsor"
        ),
    ),
    ("work_auth", re.compile(r"(?i)sponsorship\s+(?:is\s+)?not\s+(?:available|offered|provided)")),
    # Modifiers routinely sit between the two words — "no employment-based visa
    # sponsorship", "no immigration sponsorship" — and a bare `no\s+sponsorship`
    # missed every one of them.
    ("work_auth", re.compile(r"(?i)\bno\s+(?:[\w-]+\s+){0,3}sponsorship\b")),
    (
        "work_auth",
        re.compile(
            r"(?i)(?:must|will)\s+not\s+(?:now or in the future\s+)?require\s+"
            r"(?:visa\s+)?sponsorship"
        ),
    ),
    (
        "work_auth",
        re.compile(r"(?i)without\s+(?:the\s+need\s+for\s+)?(?:visa\s+)?sponsorship"),
    ),
    # T1.3 citizenship. "citizenship STATUS" (EEO) never matches: the pattern
    # requires `citizens` followed by only/required, and the EEO block is cut at
    # step 0 anyway — two independent guards. Hebrew אזרחות ישראלית is cleared
    # at R1 before this is reached; it is an INCLUSION signal in exclusion
    # grammar and must never fire.
    ("citizenship", re.compile(_PLACE + r"\s+(?i:citizens?)\s*(?i:only|is required|required)")),
    ("citizenship", re.compile(r"(?i)must\s+be\s+an?\s+" + _PLACE + r"\s+(?i:citizen)")),
    (
        "citizenship",
        re.compile(
            r"(?i)(?:must be|only)[^.\n]{0,40}"
            r"(?:lawful permanent resident|green card holder|permanent resident)"
        ),
    ),
    # T1.4 clearance / export control. A bare "clearance" does not fire — one of
    # these named regimes is required. Hebrew סיווג ביטחוני is cleared at R1.
    ("clearance", re.compile(r"\b(?:ITAR|EAR)\b|(?i:export[- ]controlled)")),
    ("clearance", re.compile(r"(?i)must (?:be|qualify as) an? U\.?S\.? person")),
    # Every clearance term here must be a REQUIREMENT, not a mention. Three
    # things were wrong before and each hid real jobs:
    #   - no polarity guard, so "a security clearance is NOT required" — the
    #     exact sentence that welcomes international candidates — blocked;
    #   - "public trust", "top secret" and "federal contract" are ordinary
    #     English ("strengthen public trust in the financial system",
    #     "federal contract experience preferred"), and matched bare;
    #   - no obligation stem, so any passing mention was enough.
    # `federal contract` is gone entirely: it describes experience, never
    # eligibility. The rest now need a clearance noun AND a requirement verb,
    # and `_clearance_negated` vetoes the negated form.
    (
        "clearance",
        re.compile(
            r"(?i)(?:\b(?:active|current|existing)\s+)?"
            r"\b(?:security clearance|TS/SCI|top secret clearance|secret clearance|"
            r"public trust clearance|SC cleared|DV cleared|BPSS|AGSVA|DoD clearance)\b"
            r"[^.\n]{0,40}\b(?:required|mandatory|must|needed|is a must)\b"
            r"|\b(?:must|required to)\b[^.\n]{0,40}"
            r"\b(?:security clearance|TS/SCI|top secret clearance|secret clearance|"
            r"public trust clearance|SC cleared|DV cleared|BPSS|AGSVA|DoD clearance)\b"
        ),
    ),
    # T1.5 residency. The biggest guard in the table lives here: "US-based
    # TEAM", "our US-based engineering org", "a US-based company" must NOT fire.
    # The restriction form always carries a PERSON word (candidates /
    # applicants / employees) or "only"; a bare "-based" + noun is describing
    # colleagues, and firing on it hides half the worldwide inventory.
    (
        "residency",
        re.compile(
            r"(?i)(?:must|only)\s+(?:currently\s+)?(?:reside|be\s+(?:based|located|resident))"
            r"\s+(?:in|within)\s+" + _PLACE
        ),
    ),
    (
        "residency",
        re.compile(
            r"(?i)(?:open\s+)?only\s+to\s+candidates\s+(?:based|located|residing)\s+in\s+" + _PLACE
        ),
    ),
    # "employees" is DELIBERATELY absent from the person words, and its absence
    # is the guard. `<PLACE>-based employees` is how a global-remote employer
    # opens a BENEFITS clause — "US-based employees are eligible for our 401(k);
    # employees elsewhere receive a local equivalent" — which is proof the
    # company hires worldwide, and it was filtering exactly the postings this
    # feature exists to surface. `candidates` and `applicants` address the
    # reader; `employees` describes colleagues.
    (
        "residency",
        re.compile(_PLACE + r"[- ](?i:based)\s+(?i:candidates|applicants)"),
    ),
    ("residency", re.compile(r"(?i)remote\s+(?:only\s+)?within\s+" + _PLACE)),
    # "registered to employ in" needs its limiting quantifier. Bare, it matches
    # "through our employer-of-record we are registered to employ in 60+
    # countries" — the strongest single signal that an Israeli CAN be hired.
    (
        "residency",
        re.compile(
            r"(?i)must reside in one of the following states"
            r"|(?:only\s+)?registered to employ in\s+(?:the\s+)?following"
            r"|registered to employ only in\b"
        ),
    ),
    # The other half of the trailing-qualifier trap. R1's negative lookahead
    # stops "work from anywhere in the US" from CLEARING the posting; this is
    # what makes it fire. Both halves must be pinned together — a matcher that
    # stops at the phrase boundary inverts the highest-confidence positive in
    # the catalogue, and fixing only one half leaves it merely unclassified.
    (
        "residency",
        re.compile(
            r"(?i)(?:work|working|based|hire|hiring|located)\s+(?:from\s+)?anywhere\s+"
            r"(?:in|within)\s+" + _PLACE
        ),
    ),
]

# T1.6 title/location tag. Both the bracket AND the adjacent word "remote" are
# required: "US Sales Manager" is a sales territory, not a hiring restriction.
# JobHit.location is in the haystack and the worldwide pass fills it with a
# foreign country BY CONSTRUCTION — but a plain LinkedIn location string ("New
# York, NY", "London, England, United Kingdom") has no bracket, so this cannot
# fire on the stamp. Pinned as a false positive.
_TITLE_TAG = [
    re.compile(r"[\(\[]\s*(?i:remote)\s*[-–—,]?\s*" + _PLACE + r"\s*[\)\]]"),
    re.compile(r"[\(\[]\s*" + _PLACE + r"\s*[-–—,]?\s*(?i:remote)\s*[\)\]]"),
]

# --------------------------------------------------------------------------- #
# TIER 2 — badge only, never filtered. Its evidence is weak in both directions.
# --------------------------------------------------------------------------- #
# Region acronyms that are ALSO employers, chips and places. Checked before the
# region rule so "ANZ Bank" and "Nordic Semiconductor" cannot reach it.
_REGION_COLLOCATIONS = re.compile(
    r"(?i)ANZ Bank|Nordic Semiconductor|Nordic APIs|Gulf of Mexico|Gulfstream|"
    r"Gulf Coast|EMEA Recruitment|Iberia Airlines"
)

# Regions that CONTAIN Israel never appear here, each for a stated reason:
#   EMEA / EMEIA / CEMEA / SEMEA / META — Israel sits in EMEA on essentially
#     every corporate org chart, and the rest are vendor subdivisions of it.
#   Middle East — unambiguously contains Israel; firing inverts the verdict.
#   MENA — contains Israel geographically; ambiguous, so abstain.
#   Asia — Israel is in Western Asia; only APAC excludes in practice.
# "EU or associated country" (Horizon Europe — Israel IS an associated country)
# is checked as a suppressor below, BEFORE any bare EU pattern.
# GCC is absent: in a software job ad those three letters are overwhelmingly the
# GNU Compiler Collection, and "systems based on GCC, CMake and Bazel" tripped
# the rule below. A guard that fires on a toolchain line is what teaches users
# to ignore the ones that matter.
_REGION_TOKENS = (
    r"APAC|JAPAC|ANZ|DACH|Nordics?|Benelux|LATAM|North America|NAMER|NORAM|"
    r"Americas|AMER|UKI|Iberia"
)
# The verb binding is the feature, not an enhancement: the same token means
# opposite things. Only HIRING verbs qualify — "serving clients across EMEA",
# "you'll own the APAC market" and "our LATAM customers" are business prose.
# Bare "based" is NOT a hiring verb ("systems based on GCC", "the team is based
# in the Americas"); only "based in" paired with a hiring subject is, and that
# is already covered by "hiring|hire|employ|open to candidates".
_REGION_RE = re.compile(
    r"(?i)(?:hiring|hire|employ|eligible to work|open to candidates)"
    r"[^.\n]{0,40}\b(?:" + _REGION_TOKENS + r")\b"
)
_HORIZON_EUROPE = re.compile(r"(?i)(?:EU|European Union)\s+or\s+(?:an?\s+)?associated countr")

_TIER2: list[tuple[str, re.Pattern[str]]] = [
    # T2.2 payroll / entity. An EOR mention ALONE is not a restriction — "we use
    # Deel / Remote.com / Oyster" proves capability, and all of them support
    # Israel. Only the entity-LIMITED phrasing fires.
    (
        "payroll",
        re.compile(
            r"(?i)we can only (?:employ|hire|pay)[^.\n]{0,40}(?:through our|via our)"
            r"[^.\n]{0,20}entity"
        ),
    ),
    ("payroll", re.compile(r"(?i)employment is through our[^.\n]{0,30}entity")),
    (
        "payroll",
        re.compile(r"(?i)only hire in countries where we have (?:an? )?(?:established )?legal entit"),
    ),
    (
        "payroll",
        re.compile(
            r"(?i)must be able to be (?:payrolled|employed on our[^.\n]{0,20}payroll)\s+in\s+"
            + _PLACE
        ),
    ),
    # T2.3 onsite / relocation. "relocation package offered" is a suppressor —
    # the employer paying to move you is the opposite of a geographic exclusion.
    ("onsite", re.compile(r"(?i)\d+\s*days?\s*(?:per|a)\s*week\s+in\s+(?:the|our)[^.\n]{0,25}office")),
    (
        "onsite",
        re.compile(r"(?i)(?:must be willing to relocate|relocation (?:is )?required|requires relocation)"),
    ),
    ("onsite", re.compile(r"(?i)(?:must|required to) work onsite in\b")),
    # T2.4 US state exclusions. The pay-transparency paragraph is cut at step 0;
    # it names the same states with inverted polarity.
    (
        "residency_state",
        re.compile(
            r"(?i)(?:this role is )?not (?:available|open) (?:to candidates )?in\s+"
            r"(?i:Colorado|California|New York|Washington|Hawaii|Alaska|Quebec)"
        ),
    ),
]

# A suppressor is only a suppressor when nothing negates it. "No visa
# sponsorship is available" contains "sponsorship is available" verbatim, so a
# bare suppressor match reads the sentence exactly backwards and silently
# clears the commonest US-only phrasing there is. The negation carries the
# meaning, and it can sit several words to the left ("visa" intervenes), so a
# fixed-length lookbehind cannot see it — the window can.
_NEGATOR = re.compile(r"(?i)\b(?:no|not|never|cannot|can't|unable|without|isn't|aren't)\b")

# 24 characters was too tight: "There is no employment-based visa sponsorship
# available" puts the "no" 25 characters left of "sponsorship", so the negator
# was missed and a real refusal read as an offer. Bounded by the sentence start
# so it cannot borrow a negation from the previous sentence.
_NEG_WINDOW = 48


def _negated_at(hay: str, start: int) -> bool:
    left = hay.rfind(".", 0, start) + 1
    left = max(left, hay.rfind("\n", 0, start) + 1, start - _NEG_WINDOW, 0)
    return bool(_NEGATOR.search(hay[left:start]))


def _suppressed(hay: str) -> bool:
    """True when the posting OFFERS what a Tier-1 work_auth rule would refuse.

    Only the sponsorship suppressors count here. Relocation assistance is NOT
    one: a US employer routinely pays to move an already-authorized candidate
    between states while still refusing visas, so letting the benefits
    paragraph cancel the eligibility paragraph hid real restrictions.
    Relocation suppresses only the Tier-2 `onsite` rule, via _suppressed_onsite.
    """
    for pattern in _SPONSOR_SUPPRESSORS:
        for m in pattern.finditer(hay):
            if not _negated_at(hay, m.start()):
                return True
    return False


_CLEARANCE_NEGATED_RE = re.compile(
    r"(?i)\b(?:not|no|never|isn't|is not|does not|doesn't|without)\b[^.\n]{0,40}"
    r"(?:required|require|needed|necessary|mandatory)"
    r"|(?i:not required|not needed|not necessary|but not required|"
    r"preferred but not|nice to have|is a plus|we will (?:help|sponsor))"
)


def _clearance_negated(hay: str, start: int, end: int) -> bool:
    """"A security clearance is NOT required" is the sentence a commercial team
    writes to tell international candidates they are welcome. Without this the
    clearance rule read it as the opposite and deleted the job."""
    sentence = hay[max(0, hay.rfind(".", 0, start) + 1) : end + 60]
    return bool(_CLEARANCE_NEGATED_RE.search(sentence))


# Every rule's mandatory vocabulary, lowercased. The fast path bails when none
# of these appears, which is the common case on a clean posting and is what
# makes the classifier affordable per-row. Keep this a SUPERSET of the rule
# table: a stem missing here silently disables its rule, and the smoke checks
# for that rule are what catch it.
_MARKERS: tuple[str, ...] = (
    "authoriz", "authoris", "eligible", "entitled", "sponsor", "citizen",
    "permanent resident", "green card", "clearance", "cleared", "itar", "ear",
    "export", "u.s. person", "us person", "reside", "resident", "based",
    "located", "remote", "relocat", "employ", "hiring", "hire", "payroll",
    "entity", "israel", "onsite", "on-site", "office", "anywhere", "worldwide",
    "global", "not available", "not open", "bpss", "agsva", "ts/sci",
)

_SENTENCE_END = re.compile(r"[.!?\n]")
_WS = re.compile(r"\s+")


def _sentence_around(text: str, start: int, end: int) -> str:
    """The posting's own sentence containing [start:end), whitespace-normalised
    and capped. `raw` is the text, not a claim about it — the SalaryInfo.raw
    shape."""
    left = 0
    for m in _SENTENCE_END.finditer(text, 0, start):
        left = m.end()
    m = _SENTENCE_END.search(text, end)
    right = m.start() if m else len(text)
    sentence = _WS.sub(" ", text[left:right]).strip()
    if not sentence:
        sentence = _WS.sub(" ", text[start:end]).strip()
    if len(sentence) <= RAW_MAX:
        return sentence
    # Centre the cap on the MATCH, never a head slice. A head slice drops the
    # evidence whenever the match sits past character 240 of its own sentence —
    # a run-on, or a scraped body with no terminator at all — and the UI then
    # prints a quote, under the heading "Quoted from the posting", that does not
    # contain the phrase we fired on. That is the module's core contract failing
    # silently on exactly the postings a user would want to appeal.
    matched = _WS.sub(" ", text[start:end]).strip()
    at = sentence.find(matched)
    if at < 0:
        return matched[:RAW_MAX]
    pad = (RAW_MAX - min(len(matched), RAW_MAX)) // 2
    lo = max(0, at - pad)
    out = sentence[lo : lo + RAW_MAX]
    return ("…" + out[1:]) if lo > 0 else out


def _israel_open(hay_lower: str, hay: str, body: str) -> bool:
    if HEBREW_RE.search(hay):
        return True
    if "+972" in hay:
        return True
    substrings, latin = _israel_tokens()
    if any(token in hay_lower for token in substrings):
        return True
    if latin is not None and latin.search(hay_lower):
        return True
    salary = extract_salary(body)
    if salary is not None and salary.currency == "ILS":
        return True
    return any(p.search(hay) for p in _GLOBAL_OPEN)


def detect_geo_restriction(
    jd_text: str, location: str = "", title: str = ""
) -> GeoRestriction | None:
    """The geographic hiring restriction this posting STATES, or None.

    `location` and `title` default to empty because `job_match.match_jobs`
    supplies neither — missing input must degrade to abstention, never to a
    guess. Pure: no LLM, no network, no I/O. Order is the algorithm; the rules
    run top to bottom and the first match wins.
    """
    body = _strip_boilerplate(jd_text or "")
    hay = "\n".join(x for x in (body, location or "", title or "") if x)
    if not hay.strip():
        return None
    hay_lower = hay.lower()
    # Fast path: every rule below needs one of these stems, so a posting with
    # none of them cannot match anything and the answer is already None. This
    # is what keeps the per-row cost off list routes and off the search hot
    # path — a clean posting is otherwise the WORST case, because every rule in
    # the table runs to completion. If a rule ever needs vocabulary outside this
    # set, its own smoke check goes red, which is the intended alarm.
    if not any(marker in hay_lower for marker in _MARKERS):
        return None

    # R0 — Israel named inside an exclusion clause. Before R1, or
    # "hiring across EMEA, excluding Israel" would read as openness. But an
    # Israel-ONLY posting satisfies the same grammar ("unable to employ
    # candidates OUTSIDE of Israel"), and it is the best posting this user can
    # get, so it is checked first and clears outright.
    if not any(p.search(hay) for p in _ISRAEL_ONLY):
        for pattern in _ISRAEL_EXCLUDED:
            m = pattern.search(hay)
            if m:
                return GeoRestriction(
                    kind="residency",
                    scope="il_excluded",
                    place="Israel",
                    blocking=True,
                    raw=_sentence_around(hay, m.start(), m.end()),
                )

    # R1 — anything that marks the posting Israel-open clears it outright.
    if _israel_open(hay_lower, hay, body):
        return None

    suppressed = _suppressed(hay) or bool(_HORIZON_EUROPE.search(hay))

    for kind, pattern in _TIER1:
        if suppressed and kind == "work_auth":
            continue
        m = pattern.search(hay)
        if m and kind == "clearance" and _clearance_negated(hay, m.start(), m.end()):
            continue
        if m:
            fragment = m.group(0)
            return GeoRestriction(
                kind=kind,
                scope=_scope_near(hay, fragment, m.start(), m.end()),
                place=_place_in(fragment),
                blocking=True,
                raw=_sentence_around(hay, m.start(), m.end()),
            )

    tag_hay = "\n".join(x for x in (title or "", location or "") if x)
    for pattern in _TITLE_TAG:
        m = pattern.search(tag_hay)
        if m:
            fragment = m.group(0)
            return GeoRestriction(
                kind="title_tag",
                scope=_scope_of(fragment),
                place=_place_in(fragment),
                blocking=True,
                raw=_sentence_around(tag_hay, m.start(), m.end()),
            )

    if not _REGION_COLLOCATIONS.search(hay) and not _HORIZON_EUROPE.search(hay):
        m = _REGION_RE.search(hay)
        if m:
            return GeoRestriction(
                kind="region",
                scope="other",
                place="",
                blocking=False,
                raw=_sentence_around(hay, m.start(), m.end()),
            )

    relocation_offered = bool(_RELOCATION_SUPPRESSOR.search(hay))
    for kind, pattern in _TIER2:
        if kind == "onsite" and relocation_offered:
            continue  # the employer paying to move you is not a geographic exclusion
        m = pattern.search(hay)
        if m:
            fragment = m.group(0)
            return GeoRestriction(
                kind=kind,
                scope=_scope_near(hay, fragment, m.start(), m.end()),
                place=_place_in(fragment),
                blocking=False,
                raw=_sentence_around(hay, m.start(), m.end()),
            )

    return None
