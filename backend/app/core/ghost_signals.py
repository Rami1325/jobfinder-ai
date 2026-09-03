"""Ghost postings — reasons to suspect a listing is not a live vacancy. 100% deterministic.

A "ghost" posting is one that costs the user a tailor, a cover letter and a
week of waiting for a role nobody is filling: a talent pool wearing a job
title, a listing that has been up since spring, a role the board relisted
under a new id, an application form that closed weeks ago. This module reads
the posting (plus what our own search history remembers about it) and returns
the EVIDENCE it found. It never returns a score.

Three things this module can never say, stated here so nobody widens it:

1. `None` means **nothing fired**. It never means the posting is real. Recall
   here is far worse than the geo classifier's: a ghost posting that says
   nothing unusual, has no board first-publish date and has never been seen by
   one of our searches is indistinguishable from a live one, and most of them
   are. Under-flagging is the safe direction and the copy must never imply the
   list is complete.
2. `closed` is the only CERTAIN signal, and only because the BOARD said so —
   `JobHit.closed` is evidence text the fetch seam observed ("No longer
   accepting applications", "HTTP 404"). Everything else is a suspicion with
   its sentence attached. There is deliberately **no `confidence` field**, for
   the reason `GeoRestriction`'s docstring gives: the module either matched or
   it did not, and a number would be a second clock nobody calibrated.
3. An empty or unfetchable description is not evidence. Abstain — the same
   contract `job_search._score_hit` keeps when a per-job problem occurs. A
   per-job problem is a VALUE here too: this function never raises.

Never the LLM and never the network (both source-pinned by the smoke test): it
runs on every scored hit of every search, and a model verdict at
temperature=0.3 is one sample — a boolean that hides a job has no error bar the
user can see. `raw` is the posting's own sentence, the way `SalaryInfo.raw` is
the posting's own figure: proof over promise.

**NOT gated on `origin_market`, and that is a deliberate difference from
`geo_restriction`.** Geo is gated because its rules only make sense for the
worldwide-remote pass — an Israeli-board posting is structurally out of its
reach. Ghost postings are a PRIMARY-MARKET problem: the Israeli agency ad that
has been up since March is exactly the thing this exists to catch. An agent
copying `geo_restriction` will copy the gate; do not.

--------------------------------------------------------------------------- #
THE THREE FALSE POSITIVES, each a real Israeli posting shape
--------------------------------------------------------------------------- #

(a) **PRIVACY BOILERPLATE.** `קורות החיים יישמרו במאגר החברה`, `המידע יישמר
    לצורך משרות עתידיות`, "your CV will be kept on file", "your data will be
    retained for future opportunities". This is a legal notice, and it ships on
    a large share of agency ads for perfectly live vacancies. Two consequences,
    both structural rather than a guard bolted on afterwards:
      - the "kept on file / future opportunities" BODY family is **not a rule
        at all**. There is no body pattern for it anywhere below.
      - `משרות עתידיות` and `future opportunities` are **TITLE markers only**.
        The title matcher reads `title`; the body matcher reads `jd_text`.
        A privacy paragraph therefore cannot reach the title matcher no matter
        what it says — that is the guarantee, and `_strip_boilerplate` (which
        already cuts at "privacy notice" / EEO headings) is defence in depth on
        top of it, not the reason this is safe.

(b) **A RECRUITER'S OWN JOB names the vocabulary as a DUTY.** "build and grow
    our talent pipeline", "responsible for maintaining the talent pool",
    `ניהול מאגר מועמדים`. The body half is handled structurally — that
    vocabulary is title-only. The TITLE half is real and needs a veto:
    `רכזת גיוס - ניהול מאגר מועמדים` is a Drushim title that contains the
    marker `מאגר מועמדים` verbatim. `_RECRUITER_DUTY` vetoes it, and it is
    applied ONLY to the "ownable" markers (a pool / community / network /
    pipeline is a thing a recruiter can be paid to run; "General Application"
    is not), so the unambiguous markers keep firing unconditionally.

(c) **`מאגר` meaning a database.** `ניהול מאגר לקוחות`, `מאגר מידע`,
    `מאגר נתונים`. Structural: the marker is the two-word phrase
    `מאגר מועמדים` and never a bare `מאגר`, so none of those can match.

Two more, less obvious, pinned beside their rules below: "we are always looking
for **ways to improve**" (the weak family needs a PERSON object), and a posting
with an empty `url` (which would make every sighting look like a repost).

--------------------------------------------------------------------------- #
NOT IN v1 — each with its reason, so nobody adds one casually
--------------------------------------------------------------------------- #

- **Applicant counts.** Not present in the guest markup we fetch. LinkedIn
  renders "Over 200 applicants" behind auth; parsing a number we cannot see is
  how a signal ships that silently never fires.
- **"Vague / short description".** Israeli postings are short by convention —
  a Drushim ad is routinely four lines. This would fire on the primary market
  as a matter of course, which is the exact shape of a guard that teaches
  users to ignore the ones that matter.
- **The anonymised-agency posting** (`לחברה מובילה בתחום`, "our client is a
  leading…"). A real Israeli time-sink, but it is a DIFFERENT claim — "the
  employer is not named", not "this is not a live vacancy" — and folding it in
  here would have one badge mean two things. Deferred to its own item until
  this phase's precision has been measured by hand.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime

# RAW_MAX is IMPORTED, never restated: `raw` renders inline on a 390px card and
# the cap is layout-load-bearing, so one number, one place. `_sentence_around`
# centres the quote on the MATCH rather than head-slicing it — read the comment
# at its definition: a head slice prints a quote, under the heading "Quoted
# from the posting", that does not contain the phrase we fired on.
# `_strip_boilerplate` cuts at the EEO / privacy-notice headings, which is
# defence in depth under false positive (a) above.
from app.core.geo_restriction import RAW_MAX, _sentence_around, _strip_boilerplate
from app.core.lang import HEBREW_RE
from app.models import GhostReport, GhostSignal

# TUNED, NOT MEASURED — recorded that way on the `_PREFIX_MIN = 5` precedent.
# 60 days is roughly two hiring cycles; 30 is one. Neither number has a study
# behind it, and PLAN 28.5 says explicitly: read three real searches by hand
# before moving either. A posting below 30 days produces NO signal at all,
# because "posted three weeks ago" is what a normal open role looks like.
LONG_OPEN_STRONG_DAYS = 60
LONG_OPEN_WEAK_DAYS = 30

# Ordering the report so `signals[0]` is always the strongest evidence. The
# card renders one line and picks the strongest; 28.2's pin reads a closed
# posting's evidence out of `ghost.signals[0].raw`. Emission order alone does
# NOT give this — `long_open` can be strong while `evergreen` is weak — so the
# list is stably sorted on this rank before it is returned.
_STRENGTH_RANK = {"certain": 0, "strong": 1, "weak": 2}


@dataclass(frozen=True)
class Sighting:
    """What our own search history remembers about one posting, for the CURRENT
    run (`db/sightings.py` has already applied the continuity reset, so a role
    relisted after a quiet quarter arrives here as a fresh run rather than as
    "open 200 days").

    `first_seen_at` is a LOWER bound and the UI copy must say so: we first saw
    the posting when one of our searches first ran over it, which is not when
    the employer published it. That is the whole reason `basis` exists — see
    `detect_ghost_signals`."""

    first_seen_at: datetime | None = None
    first_url: str = ""
    seen_count: int = 0
    relist_count: int = 0


# --------------------------------------------------------------------------- #
# Board dates — THE one parser
# --------------------------------------------------------------------------- #
def parse_board_date(value: str) -> datetime | None:
    """Lenient ISO parse of a board-stated date, tz dropped ("" / junk → None).

    THE one parser for board dates: `job_search._posted_datetime` delegates
    here, so the ghost age and the freshness tier can never disagree about the
    same string. It lives in THIS module and not in `job_search` because
    `job_search` imports this module — putting it there and importing it back
    is the circular import, and the delegation direction is what avoids it.

    Timezone is dropped rather than converted: Greenhouse sends
    `2026-06-02T03:17:15-04:00` while `now` arrives naive from the caller, and
    day granularity is all any consumer needs. `TypeError`/`AttributeError` are
    caught alongside `ValueError` because the value can come straight out of a
    provider's raw JSON payload, where `first_published` may be `null` or a
    number — a per-job problem is a VALUE, never an exception."""
    try:
        dt = datetime.fromisoformat(value.strip())
    except (ValueError, TypeError, AttributeError):
        return None
    return _naive(dt)


def _naive(dt: datetime) -> datetime:
    """Drop tzinfo. Subtracting an aware datetime from a naive one raises
    TypeError, and a row read back from Postgres is not guaranteed to match the
    caller's clock in awareness — that is a crash in the middle of a search."""
    return dt.replace(tzinfo=None) if dt.tzinfo is not None else dt


# --------------------------------------------------------------------------- #
# Phrase tables → patterns
# --------------------------------------------------------------------------- #
# Hebrew's inseparable prefixes (ב/ל/ה/ו/מ/ש) are word characters, so
# `re.search(r"\bמאגר מועמדים\b", "…במאגר מועמדים…")` is False while the bare
# substring test is True. The Latin half needs the OPPOSITE treatment: without
# `\b`, "evergreen" matches inside "Evergreensolutions Ltd" and "talent pool"
# would match a hypothetical "…talent pooling". This asymmetry is the single
# most repeated bug in this repo (geo's `_israel_tokens`, check-mirrors 10,
# `scorer._keyword_present`), so the split is DERIVED from `HEBREW_RE` rather
# than hand-maintained: a phrase added to a table below lands in the right half
# automatically.
def _phrase_pattern(phrases: tuple[str, ...]) -> re.Pattern[str]:
    latin = sorted((p for p in phrases if not HEBREW_RE.search(p)), key=len, reverse=True)
    hebrew = sorted((p for p in phrases if HEBREW_RE.search(p)), key=len, reverse=True)
    parts: list[str] = []
    if latin:
        parts.append(r"\b(?:" + "|".join(re.escape(p) for p in latin) + r")\b")
    if hebrew:
        # No \b, on purpose. See above.
        parts.append(r"(?:" + "|".join(re.escape(p) for p in hebrew) + r")")
    return re.compile("(?i)" + "|".join(parts))


# --------------------------------------------------------------------------- #
# EVERGREEN — the posting IS a general application rather than a vacancy
# --------------------------------------------------------------------------- #
# TITLE markers are the high-precision core, and their scoping to the title is
# what makes false positive (a) impossible rather than merely unlikely: the
# privacy paragraph that says "retained for future opportunities" lives in the
# body, and the body matcher does not know these phrases.
_EVERGREEN_TITLE_PHRASES: tuple[str, ...] = (
    "general application",
    "open application",
    "spontaneous application",
    "speculative application",
    "talent pool",
    "talent community",
    "talent network",
    "talent pipeline",
    "join our pipeline",
    "future opportunities",
    "evergreen",
    "מאגר מועמדים כללי",
    "מאגר מועמדים",
    "מועמדות כללית",
    "הגשת מועמדות יזומה",
    "משרות עתידיות",
)
_EVERGREEN_TITLE_RE = _phrase_pattern(_EVERGREEN_TITLE_PHRASES)

# The subset that names a THING A RECRUITER CAN BE PAID TO RUN. Only these are
# subject to the duty veto — "General Application" and `מועמדות כללית` are not
# job duties in any phrasing, so vetoing them could only ever lose a true
# positive.
_EVERGREEN_OWNABLE_PHRASES: tuple[str, ...] = (
    "talent pool",
    "talent community",
    "talent network",
    "talent pipeline",
    "join our pipeline",
    "מאגר מועמדים כללי",
    "מאגר מועמדים",
)
_EVERGREEN_OWNABLE_RE = _phrase_pattern(_EVERGREEN_OWNABLE_PHRASES)

# False positive (b), title half. `רכזת גיוס - ניהול מאגר מועמדים` is a real
# Drushim title and contains the marker verbatim.
#
# The Latin side is GERUNDS ONLY, and the omission is the guard: "Manager",
# "Lead" and "Owner" are how a talent pool names its AUDIENCE ("Talent Pool —
# Engineering Manager"), while "Managing"/"Maintaining"/"Building"/"Growing" in
# a title is describing the reader's future work. Vetoing on the role NOUN
# would delete a whole category of legitimate evergreen postings, which is the
# expensive direction. The Hebrew side carries the real weight here: `ניהול`
# (the gerund "management of") and `אחראי` ("responsible for") are how a duty
# is written in a Hebrew title, and both must stay bare substrings so the ל/ה/ו
# prefixes glue on (`לניהול`, `האחראי`).
_RECRUITER_DUTY = re.compile(
    r"(?i)\b(?:managing|maintaining|building|growing)\b|ניהול|אחראי"
)

# BODY sentences fire ONLY in the explicit "there is no specific opening"
# shapes. Nothing softer belongs here: every "we keep CVs on file" variant is
# false positive (a), and every "we are always growing" variant is marketing.
# Each pattern requires the noun (role|position|opening|vacancy) so "there is
# no specific dress code" cannot reach it.
_EVERGREEN_BODY_STRONG: tuple[re.Pattern[str], ...] = (
    # The PLURAL is not optional. "There are no specific openings at the moment"
    # is at least as common as the singular, and `\b` after a singular noun
    # refuses it (the "s" is a word character) — a rule that reads correctly and
    # silently covers half its cases.
    re.compile(
        r"(?i)\b(?:there(?:\s+is|\s+are|'s|’s)|we\s+have)\s+no\s+specific\s+"
        r"(?:roles?|positions?|openings?|vacanc(?:y|ies))\b"
    ),
    re.compile(r"(?i)\bno\s+specific\s+vacanc(?:y|ies)\b"),
    re.compile(r"(?i)\bnot\s+(?:currently\s+)?hiring\s+for\s+a\s+specific\b"),
    re.compile(r"(?i)\bthis\s+is\s+not\s+a\s+specific\s+(?:role|position)\b"),
    re.compile(r"(?i)\bwe\s+(?:do\s+not|don't|do’nt|don’t)\s+have\s+an\s+open\s+position\b"),
    # Hebrew: bare substrings, no \b. "לא מדובר במשרה ספציפית" glues ב onto משרה.
    re.compile(r"לא\s+מדובר\s+ב?משרה\s+ספציפית"),
    re.compile(r"אין\s+(?:לנו\s+)?(?:כרגע\s+)?משרה\s+פתוחה"),
)

# WEAK, not strong — this family lives in the about-us blurb of thousands of
# real postings, which is precisely why it may never make a posting `likely` on
# its own (one weak signal is not enough; see the derivation rule).
#
# The PERSON OBJECT is mandatory and it is the guard: "we are always looking
# for ways to improve our platform" and "always on the lookout for new
# technologies" are sentences about work, not about candidates, and a bare
# `always looking for` fires on both. The window is bounded to the sentence
# (`[^.\n]{0,40}`) so it cannot borrow a person word from the next one.
_EVERGREEN_WEAK: tuple[re.Pattern[str], ...] = (
    re.compile(
        r"(?i)\balways\s+(?:looking|on\s+the\s+lookout)\s+for\b[^.\n]{0,40}"
        r"\b(?:talent|talented|people|candidates|applicants|engineers|"
        r"developers|professionals|individuals)\b"
    ),
    re.compile(
        r"תמיד\s+מחפשים[^.\n]{0,40}"
        r"(?:אנשים|מועמדים|טאלנטים|כישרונות|עובדים|מתכנתים)"
    ),
)


# --------------------------------------------------------------------------- #
# The fast path
# --------------------------------------------------------------------------- #
# Every text rule above needs one of these stems, so a posting with none of
# them cannot match anything and the answer is already None. This is what keeps
# the per-row cost off the search hot path — a clean posting is otherwise the
# WORST case, because every pattern in every table runs to completion.
#
# KEEP THIS A STRICT SUPERSET OF THE RULE VOCABULARY. A stem missing here
# silently disables its rule, and that rule's own smoke check is the only
# alarm — exactly the arrangement `geo_restriction._MARKERS` documents.
#
# The stems are multi-word on purpose. A single word like "application" or
# "pipeline" appears in nearly every posting ever written, and a fast path that
# never bails is a fast path that costs more than it saves.
_MARKERS: tuple[str, ...] = (
    "general application",
    "open application",
    "spontaneous application",
    "speculative application",
    "talent pool",
    "talent community",
    "talent network",
    "talent pipeline",
    "join our pipeline",
    "future opportunities",
    "evergreen",
    "no specific",
    "not hiring",
    "not currently hiring",
    "specific role",
    "specific position",
    "specific vacancy",
    "open position",
    "always looking",
    "always on the lookout",
    "מאגר מועמדים",
    "מועמדות כללית",
    "מועמדות יזומה",
    "משרות עתידיות",
    "משרה ספציפית",
    "משרה פתוחה",
    "תמיד מחפשים",
)

_WS_RE = re.compile(r"\s+")


def _norm_raw(text: str) -> str:
    """Whitespace-normalised, capped. Used for evidence that is ALREADY a short
    string (`JobHit.closed`, a title) and therefore needs no sentence search."""
    return _WS_RE.sub(" ", text or "").strip()[:RAW_MAX]


def _report(signals: list[GhostSignal]) -> GhostReport | None:
    """The ONE derivation rule, pinned here and nowhere else.

    `closed` is any CERTAIN signal — the board itself said the posting is dead,
    so it is filtered before the scoring LLM call the way a Tier-1 geo
    restriction is. `likely` is >= 1 strong OR >= 2 weak; there is no third
    tier and no arithmetic. Note that a closed-only report is `likely=False`:
    "likely a ghost" is a suspicion, and closure is past it, so the two flags
    describe different things rather than nesting."""
    if not signals:
        return None
    strong = sum(1 for s in signals if s.strength == "strong")
    weak = sum(1 for s in signals if s.strength == "weak")
    signals.sort(key=lambda s: _STRENGTH_RANK.get(s.strength, 9))
    return GhostReport(
        closed=any(s.strength == "certain" for s in signals),
        likely=strong >= 1 or weak >= 2,
        signals=signals,
    )


def detect_ghost_signals(
    *,
    title: str,
    jd_text: str,
    posted_at: str = "",
    raw: dict | None = None,
    closed: str = "",
    sighting: Sighting | None = None,
    url: str = "",
    now: datetime,
) -> GhostReport | None:
    """The ghost evidence this posting carries, or None.

    None means nothing fired. It NEVER means the posting is real.

    Pure: no LLM, no network, no I/O, and no clock — `now` is injected, on the
    `providers.jobmaster.parse_hebrew_relative_date` precedent, so every check
    is deterministic. Never raises: a per-job problem is a VALUE (`_score_hit`'s
    contract), and a raise here would land in `score_errors` and blame the
    boards for a posting we merely could not classify.

    **`posted_at` is accepted and deliberately UNUSED by `long_open`.** Comeet
    (`time_updated`) and Greenhouse (`updated_at`) put an UPDATE time in it, so
    an evergreen posting that is touched weekly reads as permanently fresh —
    which is precisely the ghost failure mode this signal exists to catch.
    Measuring age from it would make the signal agree with the ghost instead of
    with the market. It stays on the signature because the caller holds it and
    a future signal (a board that states a real publish date) may want it; do
    not wire it into the age.
    """
    signals: list[GhostSignal] = []

    # ---- 1. closed (certain) ------------------------------------------------
    # The only signal the BOARD authored. `JobHit.closed` is evidence text set
    # at the fetch seam; "" means "not observed", which is NOT the same as
    # "open" — most boards can never say, and the cache branch of _build_match
    # skips the fetch entirely, so it cannot observe closure at all. That is a
    # known gap, recorded rather than papered over with a liveness fetch on the
    # branch whose whole point is not fetching.
    evidence = (closed or "").strip()
    if evidence:
        signals.append(
            GhostSignal(kind="closed", strength="certain", raw=_norm_raw(evidence))
        )

    # Body text is boilerplate-stripped BEFORE anything reads it. This is
    # defence in depth under false positive (a): the privacy / EEO block is cut
    # at its heading, so even a future body rule inherits the protection.
    body = _strip_boilerplate(jd_text or "")
    title_text = title or ""

    first_published = parse_board_date(str((raw or {}).get("first_published") or ""))

    # ---- fast path ----------------------------------------------------------
    # Bail only when NOTHING can fire: no rule vocabulary anywhere in the text,
    # no sighting row, no board first-publish date and no closure evidence. The
    # `closed` signal is already appended above, so an early return here still
    # reports it — `_report` is the single exit for that reason.
    hay_lower = "\n".join(x for x in (body, title_text) if x).lower()
    if (
        not any(marker in hay_lower for marker in _MARKERS)
        and sighting is None
        and first_published is None
        and not evidence
    ):
        return _report(signals)

    # ---- 2. evergreen (strong / weak) ---------------------------------------
    # Order is the algorithm: the title markers are the high-precision core and
    # run first, the explicit body shapes second, and the "always looking for"
    # family only when neither fired — it is weak, and a weak duplicate of a
    # strong finding is noise on a 390px card.
    evergreen: GhostSignal | None = None
    for m in _EVERGREEN_TITLE_RE.finditer(title_text):
        # False positive (b): the marker names the reader's DUTY, not the
        # posting's nature. Scoped to the "ownable" markers so a vetoed title
        # is only ever one a recruiter could be hired to run.
        if _EVERGREEN_OWNABLE_RE.search(m.group(0)) and _RECRUITER_DUTY.search(title_text):
            continue
        evergreen = GhostSignal(
            kind="evergreen",
            strength="strong",
            # The title IS the evidence here, and quoting it is honest: it came
            # from the posting. `_sentence_around` still centres the cap on the
            # match, which matters for the long "Talent Pool — <ten words>"
            # titles boards emit.
            raw=_sentence_around(title_text, m.start(), m.end()),
        )
        break
    if evergreen is None:
        for pattern in _EVERGREEN_BODY_STRONG:
            m = pattern.search(body)
            if m:
                evergreen = GhostSignal(
                    kind="evergreen",
                    strength="strong",
                    raw=_sentence_around(body, m.start(), m.end()),
                )
                break
    if evergreen is None:
        for pattern in _EVERGREEN_WEAK:
            m = pattern.search(body)
            if m:
                evergreen = GhostSignal(
                    kind="evergreen",
                    strength="weak",
                    raw=_sentence_around(body, m.start(), m.end()),
                )
                break
    if evergreen is not None:
        signals.append(evergreen)

    # ---- 3. long_open (strong / weak, or absent) ----------------------------
    # Two different truths, so two different `basis` strings and two different
    # sentences in the UI:
    #   first_published — the board's own publish date (Greenhouse sends it and
    #     it is already sitting unread in JobHit.raw). "Posted N days ago".
    #   first_seen      — the first time one of OUR searches ran over it. A
    #     LOWER bound, never a publish date. "Seen in searches for N days".
    # When both exist the EARLIER one wins and reports ITS basis, because the
    # question is how long the posting has been open and the earlier date is
    # the better answer to it. When neither exists the signal is simply ABSENT
    # — unknown is never zero, the `last_above_min` rule arriving again.
    candidates: list[tuple[datetime, str]] = []
    if first_published is not None:
        candidates.append((first_published, "first_published"))
    if sighting is not None and sighting.first_seen_at is not None:
        candidates.append((_naive(sighting.first_seen_at), "first_seen"))
    if candidates:
        since, basis = min(candidates, key=lambda c: c[0])
        days = (_naive(now) - since).days
        # A date in the future (a board clock ahead of ours, a mis-parsed
        # string) yields a negative day count and falls through to no signal,
        # which is the correct abstention rather than a 0-day "ghost".
        strength = ""
        if days >= LONG_OPEN_STRONG_DAYS:
            strength = "strong"
        elif days >= LONG_OPEN_WEAK_DAYS:
            strength = "weak"
        if strength:
            signals.append(
                GhostSignal(
                    kind="long_open",
                    strength=strength,
                    # No sentence to quote: nothing in the posting SAYS this,
                    # we computed it. The card's own copy carries the number,
                    # and inventing a quote here would be the module claiming
                    # the posting said something it did not.
                    raw="",
                    days=days,
                    since=since.date().isoformat(),
                    basis=basis,
                )
            )

    # ---- 4. reposted (weak) -------------------------------------------------
    # The board minted a NEW listing id for the same (source, content_key)
    # inside one continuous run — the classic relist that resets the "posted 2
    # days ago" line without any hiring having happened. `db/sightings.py` has
    # already applied the 21-day continuity reset, so a role genuinely relisted
    # after a quiet quarter arrives here as a fresh run and cannot fire.
    #
    # An EMPTY `url` abstains. Without that guard "" != first_url is true for
    # every posting whose url the caller did not pass, and the signal fires on
    # legitimate input across the board — a guard that fires on everything is
    # worse than no guard. The trailing slash is normalised away because that
    # is the same key `_interleave_and_dedupe` and the score cache use.
    if sighting is not None and url and sighting.first_url:
        if sighting.first_url.rstrip("/") != url.rstrip("/"):
            signals.append(GhostSignal(kind="reposted", strength="weak", raw=""))

    return _report(signals)
