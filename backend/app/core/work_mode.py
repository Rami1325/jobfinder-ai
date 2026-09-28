"""What does a job posting SAY about where the work happens?
Deterministic: no model, no network, no clock.

WHY THIS EXISTS. The Jobs page's Work mode filter used to be LinkedIn's `f_WT`
parameter and nothing else, and LinkedIn's logged-out search ignores it. Measured
on 2026-09-22: "Remote", "Hybrid", "On-site" and no filter returned the SAME ten
postings, on a United States query and a Tel Aviv one alike, through the search
API, the public search page and a `geoId` search, and neither the cards nor the
guest job page carry a workplace type at all. The other four boards were never
sent the filter. So a user who picked "Remote" got every job, and the worldwide
pass, which asks LinkedIn for REMOTE jobs abroad through the same parameter, got
on-site jobs in Seattle and Beavercreek that nobody in Israel can take.

So the posting's own words decide, and a board's own field where it has one:
  - Comeet states `workplace_type` ("Hybrid", "Remote", "On-site") per position,
    and it WINS over the text. Its `location.is_remote` does NOT mean remote:
    Kaltura's hybrid Bnei Brak office carries `is_remote: true` in the fixture,
    so it is never read.
  - The boards added 2026-09-28 hand theirs over the same way (`JobHit.work_mode`;
    Lever's `workplaceType` "hybrid" / "onsite" / "remote"). A value this module
    does not know ("unspecified") reads as nothing, and the words decide.
  - Everything else is read from the title, the card's location and the
    description, in English and Hebrew.

THE ANSWER IS A SET, and an empty set means the posting does not say. A caller
hides a posting only when the set is NON-EMPTY and shares nothing with what the
user picked. That shapes every rule below:
  - A phrase that could mean two modes yields BOTH. "Work from home" is a full
    remote job in one posting and two days a week in the next, so it reads
    {remote, hybrid} and can hide a posting only from someone who wants on-site.
  - A false positive ADDS a mode, and a bigger set hides less, so the costly
    error is a false positive that is the ONLY thing a posting says. Hence the
    guards: "hybrid" is also a cloud, a model architecture and a satellite
    system, "remote" is also sensing, access and debugging. Every such trap is
    pinned in the smoke test beside the phrase it must still catch, and the
    traps were taken from real postings (the 2026-09-22 ghost-run corpus), not
    imagined.
  - Unknown is never a mode. A posting that says nothing is KEPT by the local
    filter; only the worldwide pass, whose whole promise is "remote jobs
    abroad", asks a posting to say remote (`job_search`).

HEBREW. ב/ל/ה/ו/מ/ש glue onto the noun, so every Hebrew phrase is matched as a
bare substring and never behind `\\b` (the house rule, and check-mirrors 10's
lesson). "היברידית" alone is not enough: "טכנולוגיה היברידית ומערכות לוויין" is
a posting about satellite systems. Hebrew hybrid needs a work word before it or
a field of its own ("אזור השרון | היברידי").

One importer, `core/job_search.py`, pinned over the AST like `pay_market`.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

REMOTE = "remote"
HYBRID = "hybrid"
ONSITE = "onsite"
MODES = frozenset({REMOTE, HYBRID, ONSITE})

_EITHER_HOME = frozenset({REMOTE, HYBRID})  # "work from home": all week, or some of it
_EITHER_OFFICE = frozenset({ONSITE, HYBRID})  # "not a remote role": in the office, or some of it


@dataclass(frozen=True)
class WorkModeReading:
    """`modes` is what the posting states, empty when it says nothing; `evidence`
    is the words that said it, so the page can quote them, "" when nothing."""

    modes: frozenset
    evidence: str = ""


NOTHING = WorkModeReading(frozenset())

# --- Comeet's own field --------------------------------------------------------------

_BOARD_VALUES = {
    "remote": REMOTE,
    "fullyremote": REMOTE,
    "hybrid": HYBRID,
    "onsite": ONSITE,
    "office": ONSITE,
    "inoffice": ONSITE,
}


def _board_mode(value: str) -> str:
    return _BOARD_VALUES.get(re.sub(r"[^a-z]", "", (value or "").lower()), "")


# --- the words -----------------------------------------------------------------------
#
# Each rule maps a match to a set of modes. Latin words carry boundaries; Hebrew
# never does (see the module docstring). Horizontal whitespace only (`[ \t]`), so a
# rule never reads across a line break into the next field.

_S = r"[ \t]+"  # at least one space
_O = r"[ \t]*"  # optional space
_ONSITE_WORDS = r"\b(?:on-?site|in[- ]office|office[- ]based|in[- ]person)"
# What follows "remote" or "hybrid" when the word is about something other than
# where the job is done. Taken from real postings, then widened to their obvious
# neighbours. A lookahead, so "hybrid cloud" never matches while "hybrid" in
# "hybrid work" still does.
_NOT_WORK = (
    r"(?![ \t-]*(?:cloud|multi-?cloud|model|models|architecture|architectures|system|systems|app|apps|"
    r"application|applications|mobile|vehicle|vehicles|car|cars|engine|engines|energy|battery|batteries|"
    r"powertrain|integration|integrations|infrastructure|infrastructures|environment|environments|"
    r"approach|approaches|solution|solutions|network|networks|search|storage|sensing|sensor|sensors|"
    r"control|controls|controlled|access|debugging|monitoring|management|device|devices|server|servers|"
    r"desktop|desktops|operations|diagnostics|support|patient|patients|team|teams|colleagues|stakeholders|"
    r"customers|clients|users|learning|education|training|sales)\b)"
)

_RULES: list[tuple[re.Pattern, frozenset]] = [
    # LinkedIn's own recruiter hashtags, written by the employer into the text.
    (re.compile(r"#LI-Remote\b", re.I), frozenset({REMOTE})),
    (re.compile(r"#LI-Hybrid\b", re.I), frozenset({HYBRID})),
    (re.compile(r"#LI-On-?site\b", re.I), frozenset({ONSITE})),
    # A labelled field: "Work Model: On-site", "Location: Remote", "Workplace type - Hybrid".
    (
        re.compile(
            r"\b(?:work(?:place)?" + _O + r"(?:model|mode|type|arrangement|setting|style|location|policy)"
            r"|workplace|location" + _O + r"type|location|job" + _O + r"type|arrangement)"
            + _O + r"[:\-–—|]" + _O + r"(?:fully" + _S + r"|100%" + _O + r")?remote\b" + _NOT_WORK,
            re.I,
        ),
        frozenset({REMOTE}),
    ),
    (
        re.compile(
            r"\b(?:work(?:place)?" + _O + r"(?:model|mode|type|arrangement|setting|style|location|policy)"
            r"|workplace|location" + _O + r"type|location|job" + _O + r"type|arrangement)"
            + _O + r"[:\-–—|]" + _O + r"hybrid\b" + _NOT_WORK,
            re.I,
        ),
        frozenset({HYBRID}),
    ),
    (
        re.compile(
            r"\b(?:work(?:place)?" + _O + r"(?:model|mode|type|arrangement|setting|style|location|policy)"
            r"|workplace|location" + _O + r"type|location|job" + _O + r"type|arrangement)"
            + _O + r"[:\-–—|]" + _O + r"(?:fully" + _S + r"|100%" + _O + r")?" + _ONSITE_WORDS + r"\b",
            re.I,
        ),
        frozenset({ONSITE}),
    ),
    # A mode as the whole value of a field or a line, in any language:
    # "Flexibles Arbeiten: Remote mit Dienstreisen", "| Hybrid", a line reading "Remote".
    # Only when the word is followed by the end of the value, so "Skills: remote
    # sensing" never reads as a remote job.
    (
        re.compile(
            r"(?:^|[:|•])" + _O + r"(?:[-*·]" + _O + r")?remote(?=" + _O
            + r"(?:$|[.,;()/|\-–]|with\b|mit\b|or\b|and\b|avec\b|con\b))",
            re.I | re.M,
        ),
        frozenset({REMOTE}),
    ),
    (
        re.compile(
            r"(?:^|[:|•])" + _O + r"(?:[-*·]" + _O + r")?hybrid(?=" + _O
            + r"(?:$|[.,;()/|\-–]|with\b|mit\b|or\b|and\b|avec\b|con\b))",
            re.I | re.M,
        ),
        frozenset({HYBRID}),
    ),
    (
        re.compile(
            r"(?:^|[:|•])" + _O + r"(?:[-*·]" + _O + r")?" + _ONSITE_WORDS
            + r"(?=" + _O + r"(?:$|[.,;()/|\-–]))",
            re.I | re.M,
        ),
        frozenset({ONSITE}),
    ),
    # A mode in parentheses: "Backend Engineer (Remote)", "Tel Aviv (Hybrid)".
    (re.compile(r"\(" + _O + r"(?:fully" + _S + r")?remote" + _O + r"\)", re.I), frozenset({REMOTE})),
    (re.compile(r"\(" + _O + r"hybrid" + _O + r"\)", re.I), frozenset({HYBRID})),
    (re.compile(r"\(" + _O + _ONSITE_WORDS + _O + r"\)", re.I), frozenset({ONSITE})),
    # "This role is on-site.", "The position will be fully remote".
    (
        re.compile(
            r"\b(?:this|the|our)" + _S + r"(?:role|position|job|opportunity)" + _S + r"(?:is|will" + _S + r"be)"
            + _S + r"(?:a" + _S + r")?(?:fully" + _S + r"|100%" + _O + r"|primarily" + _S + r"|entirely"
            + _S + r"|completely" + _S + r")?remote\b" + _NOT_WORK,
            re.I,
        ),
        frozenset({REMOTE}),
    ),
    (
        re.compile(
            r"\b(?:this|the|our)" + _S + r"(?:role|position|job|opportunity)" + _S + r"(?:is|will" + _S + r"be)"
            + _S + r"(?:a" + _S + r")?hybrid\b" + _NOT_WORK,
            re.I,
        ),
        frozenset({HYBRID}),
    ),
    (
        re.compile(
            r"\b(?:this|the|our)" + _S + r"(?:role|position|job|opportunity)" + _S + r"(?:is|will" + _S + r"be)"
            + _S + r"(?:a" + _S + r")?(?:fully" + _S + r"|100%" + _O + r"|entirely" + _S + r"|completely"
            + _S + r")?" + _ONSITE_WORDS + r"\b",
            re.I,
        ),
        frozenset({ONSITE}),
    ),
    # "fully remote", "100% remote", "100% onsite", "fully in-person".
    (
        re.compile(r"(?:\bfully|\bentirely|\bcompletely|100%)" + _O + r"remote\b" + _NOT_WORK, re.I),
        frozenset({REMOTE}),
    ),
    (
        re.compile(r"(?:\bfully|\bentirely|\bcompletely|100%)" + _O + _ONSITE_WORDS + r"\b", re.I),
        frozenset({ONSITE}),
    ),
    # A mode naming the job itself: "remote position", "hybrid work schedule",
    # "hybrid working", "on-site role". "Hybrid model" alone is an ML term, so the
    # arrangement nouns need "work" in front of them.
    (
        re.compile(
            r"\bremote(?:-first)?" + _S + r"(?:role|position|job|opportunity|contract|employee|employees)\b",
            re.I,
        ),
        frozenset({REMOTE}),
    ),
    (re.compile(r"\bremote-first\b", re.I), frozenset({REMOTE})),
    # "Remote work" also turns up in hybrid postings ("remote work days"), which
    # only makes the set bigger; a negated one never gets here (_NEGATED_REMOTE).
    (
        re.compile(r"\bremote" + _S + r"work(?:ing)?\b(?!" + _S + r"(?:tools|experience|skills))", re.I),
        frozenset({REMOTE}),
    ),
    (
        re.compile(r"\bhybrid" + _S + r"(?:role|position|job|opportunity|schedule|arrangement)\b", re.I),
        frozenset({HYBRID}),
    ),
    (
        re.compile(
            r"\bhybrid" + _S + r"work(?:ing)?\b(?:" + _S
            + r"(?:model|schedule|arrangement|policy|environment|setup|set-up|pattern))?",
            re.I,
        ),
        frozenset({HYBRID}),
    ),
    (
        re.compile(
            _ONSITE_WORDS + _S + r"(?:role|position|job|opportunity|work|presence|schedule)\b", re.I
        ),
        frozenset({ONSITE}),
    ),
    # Days in the office, or at home: "3 days in-office", "two days a week from home".
    # Five days in the office is on-site.
    (
        re.compile(
            r"\b(?:[1-4]|one|two|three|four)" + _O + r"(?:\+" + _O + r")?(?:days?|x)" + _O
            + r"(?:a|per|/|each|every)?" + _O + r"(?:week|wk)?" + _O + r"(?:in|at|from)[ \t-]+"
            + r"(?:the" + _S + r"|our" + _S + r"|an?" + _S + r")?(?:office|home|hq|site|on-?site)\b",
            re.I,
        ),
        frozenset({HYBRID}),
    ),
    (
        re.compile(
            r"\b(?:5|five)" + _O + r"days" + _O + r"(?:a|per|/|each|every)?" + _O + r"(?:week|wk)?" + _O
            + r"(?:in|at)[ \t-]+(?:the" + _S + r"|our" + _S + r")?(?:office|hq|site|on-?site)\b",
            re.I,
        ),
        frozenset({ONSITE}),
    ),
    # Home and anywhere.
    (re.compile(r"\bwork(?:ing)?" + _S + r"from" + _S + r"anywhere\b", re.I), frozenset({REMOTE})),
    (re.compile(r"\btelecommut(?:e|ing)\b", re.I), frozenset({REMOTE})),
    (
        re.compile(r"\bwork(?:ing)?" + _S + r"(?:from" + _S + r"home|remotely)\b|\bwfh\b", re.I),
        _EITHER_HOME,
    ),
    # --- Hebrew: bare substrings, never behind \b ---
    (re.compile(r"עבודה" + _O + r"מרחוק|משרה" + _O + r"מרחוק|מרחוק" + _O + r"באופן" + _O + r"מלא"), frozenset({REMOTE})),
    (
        re.compile(r"100%" + _O + r"מהבית|מהבית" + _O + r"100%|מהבית" + _O + r"באופן" + _O + r"מלא|משרה" + _O + r"מהבית"),
        frozenset({REMOTE}),
    ),
    (re.compile(r"עבודה" + _O + r"מהבית"), _EITHER_HOME),
    # Hybrid needs a work word before it, or a field of its own.
    (
        re.compile(r"(?:עבודה|מודל|משרה|תפקיד|אופן)" + _O + r"(?:\S+" + _O + r")?היבריד(?:י|ית|יות|ים)?"),
        frozenset({HYBRID}),
    ),
    (
        re.compile(r"(?:^|[|:•\-–])" + _O + r"היבריד(?:י|ית)?" + _O + r"(?=$|[|,.;()\-–])", re.M),
        frozenset({HYBRID}),
    ),
    (
        re.compile(
            r"(?:[1-4]|יום|יומיים|שלושה|ארבעה)" + _O + r"(?:ימים|ימי" + _O + r"עבודה)?" + _O
            + r"(?:בשבוע" + _O + r")?(?:מהבית|מהמשרד|במשרד)"
        ),
        frozenset({HYBRID}),
    ),
    (
        re.compile(r"(?:5|חמישה)" + _O + r"ימים" + _O + r"(?:בשבוע" + _O + r")?(?:מהמשרד|במשרד)"),
        frozenset({ONSITE}),
    ),
    (re.compile(r"עבודה" + _O + r"מהמשרד"), frozenset({ONSITE})),
]

# "Not a remote role", "no remote work", "non-remote", "remote is not an option".
# Removed from the text BEFORE the rules run, so the remote inside it is never read
# as remote, and read as what it states instead: in the office, all week or some of it.
_NEGATED_REMOTE = re.compile(
    r"\b(?:not|no|non-?)" + _S + r"(?:a" + _S + r"|an" + _S + r")?(?:fully" + _S + r"|100%" + _O + r")?remote\b"
    r"(?:" + _S + r"(?:role|position|job|work|option|opportunity))?"
    r"|\bnon-remote\b"
    r"|\bremote" + _S + r"(?:work" + _S + r")?(?:is" + _S + r"not|isn't)" + _S
    + r"(?:possible|available|an" + _S + r"option|offered|supported)\b",
    re.I,
)

# A title or a location is short and says little else, so a bare mode word there
# is a statement about the job ("Remote - US", "Hybrid, Tel Aviv"), guarded by the
# same lookahead as the text rules ("Hybrid Cloud Engineer" says nothing).
_SHORT_FIELD = [
    (re.compile(r"\bremote\b" + _NOT_WORK, re.I), frozenset({REMOTE})),
    (re.compile(r"^\s*anywhere\b", re.I), frozenset({REMOTE})),
    (re.compile(r"\bhybrid\b" + _NOT_WORK, re.I), frozenset({HYBRID})),
    (re.compile(r"\b" + _ONSITE_WORDS + r"\b", re.I), frozenset({ONSITE})),
]


def _hebrew_short(field: str) -> frozenset:
    """Hebrew in a title or a location: a field that says היברידי is hybrid, one
    that says מרחוק is remote, and one that says מהבית is at home all week or some
    of it."""
    found: set = set()
    if "היבריד" in field:
        found.add(HYBRID)
    if "מרחוק" in field:
        found.add(REMOTE)
    if "מהבית" in field:
        found |= _EITHER_HOME
    return frozenset(found)


def _evidence(text: str, start: int, end: int) -> str:
    """The matched words with a little of the line around them, at most ~100
    characters, whitespace collapsed."""
    line_start = text.rfind("\n", 0, start) + 1
    line_end = text.find("\n", end)
    line_end = len(text) if line_end == -1 else line_end
    lo = max(line_start, start - 40)
    hi = min(line_end, end + 50)
    snippet = re.sub(r"\s+", " ", text[lo:hi]).strip()
    return snippet


def _read_text(text: str) -> tuple[set, str]:
    modes: set = set()
    evidence = ""
    for m in _NEGATED_REMOTE.finditer(text):
        modes |= _EITHER_OFFICE
        evidence = evidence or _evidence(text, m.start(), m.end())
    # Blank the negations out (same length, so offsets and evidence still line up).
    cleaned = _NEGATED_REMOTE.sub(lambda m: " " * len(m.group(0)), text)
    for pattern, rule_modes in _RULES:
        m = pattern.search(cleaned)
        if m:
            modes |= rule_modes
            evidence = evidence or _evidence(cleaned, m.start(), m.end())
    return modes, evidence


def _read_short(field: str) -> tuple[set, str]:
    modes: set = set()
    for pattern, rule_modes in _SHORT_FIELD:
        if pattern.search(field):
            modes |= rule_modes
    modes |= _hebrew_short(field)
    text_modes, _ = _read_text(field)
    modes |= text_modes
    return modes, (field.strip() if modes else "")


def read_work_mode(
    *, title: str = "", location: str = "", text: str = "", board_value: str = ""
) -> WorkModeReading:
    """What the posting states about where the work happens.

    `board_value` is a board's own structured field (Comeet's `workplace_type`); a
    value this module recognises wins outright and the words are not read. Then the
    title and the card's location, then the description: the union of what all
    three say, with the first evidence found (title and location before the text,
    because they are the posting's own summary of itself)."""
    board = _board_mode(board_value)
    if board:
        return WorkModeReading(frozenset({board}), board_value.strip())
    modes: set = set()
    evidence = ""
    for field in (title or "", location or ""):
        found, said = _read_short(field)
        modes |= found
        evidence = evidence or said
    found, said = _read_text(text or "")
    modes |= found
    evidence = evidence or said
    if not modes:
        return NOTHING
    return WorkModeReading(frozenset(modes), evidence)
