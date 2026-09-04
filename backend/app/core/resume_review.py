"""The résumé review — one home for every check, each finding anchored to the
block it is about (PLAN 28.6).

This module NEVER calls the LLM, NEVER touches the network and NEVER reads the
clock. That is not a description of today's code, it is the contract that lets
`POST /tools/review` carry no `Depends` at all: the route is free and uncapped,
so it may be re-run on every keystroke the way `/tools/coverage` is, and the
only thing standing between "uncapped" and "a free door onto the model for
anyone past the access-code gate" is that nothing in here can reach one. The
smoke test pins it off the AST rather than by substring, precisely because this
docstring names `get_llm_client`, `urllib` and `datetime` in order to promise
it does not use them, and a grep cannot tell a promise from an import.

It supersedes `ats_scan.py` and `resume_health.py`, and the shape change is the
point. Those answered with a SCORE and a list of English sentences: a number
the user optimises instead of a document they fix, and prose no Hebrew reader
could read. A finding here carries a stable `id` — which IS the translation key
— and a `path`, which is where the problem lives on the paper. The panel can
therefore point at the block and say it in either language.

Three rules hold the whole thing together:

* **Every check always runs.** `passed ∪ skipped ∪ {ids in findings}` is the
  entire `CHECK_IDS` set on every call. There are no toggles, so an empty
  result can never mean "you turned that one off" — a tool that ships three of four
  checks OFF manufactures a clean-looking empty state that way.
* **Unknown is never clean.** A check that COULD NOT run (the gap check with
  fewer than two dated spans, the JD-gated check with no job) lands in
  `skipped`, never in `passed`. Folding the two together would have the panel
  assert a résumé is clean on a check that never looked at it — the rule the
  tracker's nullable `voice_score` and the alert bar's `last_above_min` follow.
* **A clean résumé produces zero findings.** No always-on advice, no
  reassurance rows. A panel that always has something in it teaches the user to
  ignore the panel, which costs more than the checks are worth.
"""
from __future__ import annotations

import re

from app.core import dates
from app.core.scorer import _keyword_present, _tokens
from app.models import (
    JDModel,
    ResumeModel,
    ReviewFinding,
    ReviewResult,
)

# --------------------------------------------------------------------------- #
# The two mirrored literals. check-mirrors 26 and 27 parse both out of this file
# as LINE grammars — one quoted entry per line, closed by `)` on its own line —
# so a reformat that packs two onto one line is a red build carrying an
# instruction rather than a silently short list that compares equal by accident.
# --------------------------------------------------------------------------- #

# Every block-path shape this module may emit. It is the same grammar
# `BLOCK_PATTERNS` declares in `lib/resumeBlocks.ts`, and check-mirrors 26
# asserts the two are set-equal, because the halves are written in different
# languages: Python EMITS a path and TypeScript RESOLVES it. A shape only this
# side knows is a review row that jumps nowhere — `ReviewPanel` renders an
# unresolvable finding as a plain row with no crosshair, so the user is told
# which bullet is too long and given no way to reach it, silently, on the one
# surface whose entire promise is that it points at the paper.
PATH_SHAPES: tuple[str, ...] = (
    "@contact.name",
    "@contact.*",
    "@contact",
    "@headline",
    "@summary",
    "@skills.*",
    "@cert.*",
    "@lang.*",
    "@exp.*",
    "@exp.*.b.*",
    "@proj.*",
    "@proj.*.b.*",
    "@edu.*",
    "@mil.*",
    "@mil.*.b.*",
)

# Every check, in the order `passed` and `skipped` come back in. An id here with
# no call site would sit in `passed` for ever, reporting a check that does not
# exist as clean, so the smoke test asserts each one is emitted or skipped by at
# least one fixture.
CHECK_IDS: tuple[str, ...] = (
    "contact-email",
    "contact-phone",
    "contact-linkedin",
    "headline",
    "summary-missing",
    "summary-long",
    "no-experience",
    "dates-missing",
    "dates-format",
    "gap",
    "weak-opener",
    "no-outcome",
    "bullet-long",
    "bullet-short",
    "repeated-verb",
    "duplicate-bullet",
    "buzzword",
    "pronoun",
    "acronym",
    "entry-empty",
    "edu-placeholder",
    "duplicate-entry",
    "skills-few",
    "skills-sentence",
    "skills-unasked",
    "length",
)

# The findings a model can usefully reword: they are all "this sentence is weak"
# rather than "this field is missing", and all of them are bullet-anchored, so
# `POST /tools/review/rewrites` can hand the model a real bullet and match its
# `before` back to a path. `review_rewrites` reads this; the frontend mirrors it
# to decide whether to offer the button at all.
REWRITABLE: frozenset[str] = frozenset({"weak-opener", "no-outcome", "bullet-long"})

# `raw` is a PREVIEW, not the anchor. Capped so one pathological bullet cannot
# push the findings that matter off the panel.
RAW_CAP = 240


def dkey(value: str) -> str:
    """The key half of a value-addressed block path (`@skills.<text>`).

    ONE definition per language and they are pinned against each other by
    check-mirrors 26, which reads the OPERATIONS out of both sources rather than
    the text: a keyed path is matched `dkey(value) == key`, so any drift makes
    every `@skills` / `@cert` / `@lang` finding resolve on one side and not the
    other — listed, unanchored, with no error anywhere.

    Deliberately `.lower()`, never `.casefold()`, mirroring TypeScript's
    `toLowerCase` over `toLocaleLowerCase`: a Turkish-locale dotted İ folds
    differently on the two sides and desyncs exactly those paths.
    """
    return " ".join((value or "").split()).lower()


# --------------------------------------------------------------------------- #
# Vocabulary. Every list is en + he or carries a stated reason it cannot be —
# Hebrew is the primary market, and a review that only reads Latin prose would
# be silent on the résumés it exists for.
# --------------------------------------------------------------------------- #

# Openers that bury the achievement. Matched at the START of a bullet only: the
# same words mid-sentence are ordinary English ("Built the service that helped
# the team ship") and flagging those would fire on legitimate input.
#
# The Hebrew entries are matched THROUGH the inseparable prefixes ו/ש/ה/ב/ל/מ,
# which glue onto the following word — `ואחראי על` is the same opener as
# `אחראי על` and a Latin-style word boundary would miss it. This is the Python
# twin of check-mirrors 10.
_WEAK_OPENERS: tuple[str, ...] = (
    "responsible for",
    "worked on",
    "helped",
    "assisted",
    "participated in",
    "involved in",
    "tasked with",
    "duties included",
    "in charge of",
    "אחראי על",
    "אחראית על",
    "עבדתי על",
    "השתתפתי",
    "סייעתי",
    "עזרתי",
)
_HE_PREFIX = "ושהבלמ"

# Filler that reads as AI or as a template. Boundary-aware regexes, NOT
# substrings: `resume_health` matched `dynamic` inside "dynamic programming" and
# `Dynamics 365`, flagging two real technical terms as buzzwords. The
# false-positive pair is pinned in the same smoke check as the positives,
# because "catch buzzwords" is trivially satisfied by flagging everything.
_BUZZWORDS: tuple[str, ...] = (
    "spearheaded",
    "leveraged",
    "leveraging",
    "utilized",
    "utilizing",
    "honed",
    "passionate",
    "results-driven",
    "detail-oriented",
    "seamless",
    "cutting-edge",
    "meticulous",
    "proven track record",
    "synergy",
    "fast-paced environment",
    "impactful",
    "empowered",
    "championed",
    "orchestrated",
    "harnessed",
    "fostered a culture",
    "actionable insights",
    "best-in-class",
    "world-class",
    "think outside the box",
    "go-getter",
    "self-starter",
    "team player",
    # The Israeli CV clichés. Every one of these is a phrase a recruiter here
    # reads past; they are the exact local equivalent of "results-driven".
    "יחסי אנוש מעולים",
    "ראש גדול",
    "תודעת שירות גבוהה",
    "מוטיבציה גבוהה",
    "יכולת עבודה תחת לחץ",
    "לומד מהר",
    "לומדת מהר",
    "יכולת עבודה בצוות",
)

# `dynamic` is deliberately ABSENT from _BUZZWORDS above and lives here instead:
# it is a real word in "dynamic programming" and a product name in
# "Dynamics 365", so it is only filler when it modifies a person.
_DYNAMIC = re.compile(r"(?<!\w)dynamic(?!\w)(?!\s+(?:programming|language|typing|analysis))", re.I)

_PRONOUNS = re.compile(r"(?<!\w)(i|i'm|i've|my|me|myself)(?!\w)|(?<![\w])(אני|שלי)(?![\w])", re.I)

# Acronym pairs an ATS searches for by ONE spelling. Reported when a résumé uses
# exactly one of the two forms — never when it uses both, and never when it uses
# neither.
#
# ONLY pairs where BOTH forms genuinely appear in job ads are listed — nobody
# writes "application programming interface", so API is not here, and neither
# are SQL, ETL, SLA or KPI. A pair whose long form no one writes fires on almost
# every real CV, which is a guard firing on legitimate input: it would put an
# always-on row in a panel whose entire value is that a clean résumé shows none.
_ACRONYMS: tuple[tuple[str, str], ...] = (
    ("CI/CD", "continuous integration"),
    ("ML", "machine learning"),
    ("AI", "artificial intelligence"),
    ("NLP", "natural language processing"),
    ("QA", "quality assurance"),
    ("SaaS", "software as a service"),
    ("AWS", "Amazon Web Services"),
    ("GCP", "Google Cloud Platform"),
    ("UX", "user experience"),
    ("UI", "user interface"),
    ("SEO", "search engine optimization"),
    ("CRM", "customer relationship management"),
    ("ERP", "enterprise resource planning"),
    ("R&D", "research and development"),
    ("IDF", "Israel Defense Forces"),
)

# Template text that ships as though it were a real institution. This is the
# defect that has been on every one of the owner's CVs since 2026-08-28:
# `resumeBlocks.ts` refuses these strings on a NEW insert and nothing ever
# warned about the ones already stored.
#
# Matched by WHOLE-FIELD equality after `dkey`, never as a substring — every
# real university keeps the word "University" in its name, so a substring test
# would flag "Tel Aviv University" as template text.
_EDU_PLACEHOLDERS: frozenset[str] = frozenset(
    {
        "school or university",
        "school / university",
        "school",
        "university",
        "institution",
        "college",
        "your school",
        "your university",
        "בית ספר או אוניברסיטה",
        "בית ספר",
        "אוניברסיטה",
        "מוסד לימודים",
    }
)

# A measured RESULT, not any digit. A bare `\d` scores a version number, a unit
# number, a tenure and a standard as outcomes — `Python 3`, `Vue 3`, `8200`,
# `2 years`, `ISO 27001` — which makes the check useless in exactly the way that
# teaches a user to ignore it. A result is a number attached to a unit or a
# delta.
_METRIC = re.compile(
    r"""
    (?<!\w)
    (?:
        \d+(?:[.,]\d+)?\s*%                     # 38%
      | [×x]\s*\d+(?:[.,]\d+)?                  # x3
      | \d+(?:[.,]\d+)?\s*[×x](?!\w)            # 3x
      | [₪$€£]\s*\d                             # ₪120k
      | \d+(?:[.,]\d+)?\s*(?:k|m|bn?)\b         # 1.2M
      | \d+(?:[.,]\d+)?\s*(?:ms|s|sec|seconds?|min|minutes?|hours?|hrs?)\b
      | \d+(?:[.,]\d+)?\s*(?:users?|customers?|clients?|requests?|rps|qps|tps
            |transactions?|records?|rows?|queries|tickets?|orders?|installs?
            |downloads?|engineers?|people|teams?|stores?|branches?)\b
      | \d+(?:[.,]\d+)?\s*(?:משתמשים|לקוחות|בקשות|עסקאות|שורות|אחוז|שעות|דקות|שניות)
    )
    """,
    re.IGNORECASE | re.VERBOSE,
)
# The other honest shape of a result: a stated movement between two values.
_DELTA = re.compile(
    r"(?<!\w)(?:from\s+\d[\d.,]*\s*\S*\s+to\s+\d|reduc\w+|cut|increas\w+|grew|grow\w+"
    r"|improv\w+|doubl\w+|tripl\w+|halv\w+|saved|sped\s+up|scaled)\b",
    re.IGNORECASE,
)

_LONG_BULLET_WORDS = 30  # ONE threshold; health said 30 and ats said 34
_SHORT_BULLET_WORDS = 4
_LONG_SUMMARY_WORDS = 80
_MIN_SKILLS = 5
_LONG_SKILL_WORDS = 6
_NO_OUTCOME_CAP = 5  # findings, not occurrences — args.total carries the truth
_REPEATED_VERB_MIN = 3
_DUPLICATE_JACCARD = 0.8
_GAP_MONTHS = 6
_UNASKED_RATIO = 0.5
_UNASKED_SAMPLE = 4
# An ongoing span reaches forever. That is clock-free, and it is what "still
# there" actually means for a gap: nothing after it can be unexplained.
_OPEN = 9999 * 12


def _clip(text: str) -> str:
    """`raw` is a preview. Ellipsised rather than hard-cut so a truncated quote
    never reads as the user's own text ending there."""
    text = (text or "").strip()
    return text if len(text) <= RAW_CAP else text[: RAW_CAP - 1] + "…"


def _words(text: str) -> list[str]:
    return [w for w in (text or "").split() if w]


def _has_term(text: str, term: str) -> bool:
    """Boundary-aware containment for the acronym pairing.

    The lookbehind is Latin-only and the lookahead is not, for the reason
    `scorer._keyword_present` records: Hebrew's ב/ל/ה/ו/מ/ש glue onto the
    following word, so a symmetric boundary silently deletes every Hebrew match.
    """
    return bool(re.search(rf"(?<![A-Za-z0-9]){re.escape(term)}(?!\w)", text or "", re.IGNORECASE))


def _starts_with_opener(bullet: str, opener: str) -> bool:
    """Whether a bullet OPENS with a weak phrase.

    Latin openers are matched at the start after stripping punctuation. Hebrew
    openers are additionally matched behind a single inseparable prefix, so
    `ואחראי על` trips the same rule as `אחראי על` — the prefixes are word
    characters, so a boundary-anchored match misses them entirely.
    """
    low = " ".join((bullet or "").split()).lower().lstrip("•-–—*·. ")
    if low.startswith(opener):
        return True
    if not opener or opener[0].isascii():
        # A Latin opener behind a Hebrew prefix is not a thing; only the Hebrew
        # entries need the prefix walk, and running it on Latin would match
        # "worked on" inside a word starting with one of those letters.
        return False
    return any(low.startswith(p + opener) for p in _HE_PREFIX)


def _first_word(bullet: str) -> str:
    parts = _words(bullet)
    return parts[0].strip(".,;:!?\"'()[]").lower() if parts else ""


# --------------------------------------------------------------------------- #
# The corpus. EVERY PRINTED SECTION, the coverage rule from 2026-09-02 — the
# review is the third reader of it, after `scorer._resume_text` and
# `ats_scan._resume_text`. A section both renderers draw but this walk omits is
# a section the review is structurally blind to: that is exactly how
# `resume_health` returned a hollow report for a discharged soldier, whose only
# bullets live in `military_service`.
# --------------------------------------------------------------------------- #


def _blocks(resume: ResumeModel) -> list[tuple[str, str]]:
    """Every (block path, text) the paper prints, bullets walked WITH indices.

    The path is what makes a finding tappable, so every index emitted here must
    be in range on the résumé it came from — an off-by-one anchor renders
    identically and scrolls nowhere.
    """
    out: list[tuple[str, str]] = []
    if resume.headline:
        out.append(("@headline", resume.headline))
    if resume.summary:
        out.append(("@summary", resume.summary))
    for i, exp in enumerate(resume.experience):
        for j, b in enumerate(exp.bullets or []):
            out.append((f"@exp.{i}.b.{j}", b))
    for i, proj in enumerate(resume.projects or []):
        if getattr(proj, "description", ""):
            out.append((f"@proj.{i}", proj.description))
        for j, b in enumerate(getattr(proj, "bullets", None) or []):
            out.append((f"@proj.{i}.b.{j}", b))
    for i, mil in enumerate(resume.military_service or []):
        for j, b in enumerate(getattr(mil, "bullets", None) or []):
            out.append((f"@mil.{i}.b.{j}", b))
    for s in resume.skills or []:
        out.append((f"@skills.{dkey(s)}", s))
    return out


def _bullet_blocks(resume: ResumeModel) -> list[tuple[str, str]]:
    """Just the prose bullets — what the sentence-shaped checks read.

    A project's DESCRIPTION is deliberately excluded: both renderers draw it as
    a paragraph rather than as a bullet, so measuring it against a bullet length
    threshold would report a defect the page does not have.
    """
    return [
        (path, text)
        for path, text in _blocks(resume)
        if ".b." in path
    ]


def _corpus(resume: ResumeModel) -> str:
    """The prose the document-level checks read. Every printed section, joined
    with newlines — the third reader of the section list, pinned by a sentinel
    per section so it cannot silently drift from `scorer`'s."""
    parts: list[str] = [resume.headline or "", resume.summary or ""]
    for exp in resume.experience:
        parts += [exp.title or "", exp.company or "", *(exp.bullets or [])]
    for proj in resume.projects or []:
        parts += [
            getattr(proj, "name", "") or "",
            getattr(proj, "description", "") or "",
            *(getattr(proj, "bullets", None) or []),
        ]
    for mil in resume.military_service or []:
        parts += [
            getattr(mil, "unit", "") or "",
            getattr(mil, "role", "") or "",
            *(getattr(mil, "bullets", None) or []),
        ]
    for edu in resume.education or []:
        parts += [getattr(edu, "degree", "") or "", getattr(edu, "institution", "") or ""]
    for cert in resume.certifications or []:
        parts.append(cert if isinstance(cert, str) else getattr(cert, "name", "") or "")
    for lang in resume.languages or []:
        parts.append(lang if isinstance(lang, str) else getattr(lang, "language", "") or "")
    parts += list(resume.skills or [])
    return "\n".join(p for p in parts if p)


def _dated_spans(resume: ResumeModel) -> list[tuple[int, int, str, str]]:
    """(start_month, end_month, path, label) for every span that carries dates.

    MILITARY SERVICE AND EDUCATION BOTH COUNT. On an Israeli résumé the two or
    three years after
    school are service, and a gap check that reads only `experience` reports
    them as unexplained absence — the single most common shape of CV in this
    app's primary market, told it has a three-year hole in it.

    A year-only END reads as December, so 2020 → Jan 2021 is a handoff and not a
    gap. A start defaults to January, which is `dates.parse_date`'s own rule.

    An ONGOING span reaches `_OPEN` rather than being dropped. Dropping it was
    the first attempt and it is wrong in a way that hides the commonest gap
    there is: a current role's START is what a preceding gap is measured
    against, so discarding the whole span made "2018 → present job starting
    2020" invisible. `_OPEN` also says the honest thing — nothing after a span
    you are still in can be unexplained — without reading the clock this module
    refuses.
    """
    spans: list[tuple[int, int, str, str]] = []

    def add(start: str, end: str, path: str, label: str) -> None:
        begin = dates.parse_date(start)
        if not begin:
            return
        if dates.is_current(end):
            spans.append((begin[0] * 12 + begin[1], _OPEN, path, label))
            return
        parsed_end = dates._parse(end)
        if not parsed_end:
            return
        year, month, month_stated = parsed_end
        if not month_stated:
            month = 12  # a year-only end is the END of that year
        spans.append((begin[0] * 12 + begin[1], year * 12 + month, path, label))

    for i, exp in enumerate(resume.experience):
        add(exp.start_date, exp.end_date, f"@exp.{i}", exp.title or exp.company or "")
    for i, mil in enumerate(resume.military_service or []):
        add(
            getattr(mil, "start_date", "") or "",
            getattr(mil, "end_date", "") or "",
            f"@mil.{i}",
            getattr(mil, "role", "") or getattr(mil, "unit", "") or "",
        )
    for i, edu in enumerate(resume.education or []):
        add(
            getattr(edu, "start_date", "") or "",
            getattr(edu, "end_date", "") or "",
            f"@edu.{i}",
            getattr(edu, "degree", "") or getattr(edu, "institution", "") or "",
        )
    spans.sort(key=lambda s: s[0])
    return spans


# --------------------------------------------------------------------------- #
# The checks. Each returns a list of findings, or None meaning SKIPPED — it
# could not run, which is unknown and is never reported as clean.
# --------------------------------------------------------------------------- #


def _f(cid: str, sev: str = "warn", path: str = "", raw: str = "", **args) -> ReviewFinding:
    return ReviewFinding(id=cid, severity=sev, path=path, raw=_clip(raw), args=args)


def _check_contact(resume: ResumeModel) -> dict[str, list[ReviewFinding]]:
    c = resume.contact
    out: dict[str, list[ReviewFinding]] = {}
    out["contact-email"] = (
        [] if (c.email or "").strip() else [_f("contact-email", "bad", "@contact.email")]
    )
    out["contact-phone"] = (
        [] if (c.phone or "").strip() else [_f("contact-phone", "warn", "@contact.phone")]
    )
    out["contact-linkedin"] = (
        [] if (c.linkedin or "").strip() else [_f("contact-linkedin", "warn", "@contact.linkedin")]
    )
    return out


def _check_headline(resume: ResumeModel) -> list[ReviewFinding]:
    return [] if (resume.headline or "").strip() else [_f("headline", "warn", "@headline")]


def _check_summary(resume: ResumeModel) -> dict[str, list[ReviewFinding] | None]:
    """One call, two ids — and the SKIP is the half that cannot be inferred.

    With no summary at all, `summary-missing` fires and `summary-long` is
    SKIPPED rather than passed: there is no text, so its question was never
    answered. Reporting "not too long" about a summary that does not exist is
    the "unknown shown as clean" defect in miniature.
    """
    text = (resume.summary or "").strip()
    if not text:
        return {"summary-missing": [_f("summary-missing", "warn", "@summary")], "summary-long": None}
    n = len(_words(text))
    return {
        "summary-missing": [],
        "summary-long": (
            [_f("summary-long", "warn", "@summary", text, words=n)]
            if n > _LONG_SUMMARY_WORDS
            else []
        ),
    }


def _check_experience(resume: ResumeModel) -> dict[str, list[ReviewFinding] | None]:
    """The three role-level checks, and the reason they SKIP together.

    With no experience section at all, `dates-missing`, `dates-format` and
    `entry-empty` are unanswerable — there are no roles to have dates or
    bullets. Reporting them clean would say "your roles are all correctly
    dated" about a CV with no roles.
    """
    if not resume.experience:
        return {
            "no-experience": [_f("no-experience", "bad", "")],
            "dates-missing": None,
            "dates-format": None,
            "entry-empty": None,
        }

    missing: list[ReviewFinding] = []
    fmt: list[ReviewFinding] = []
    empty: list[ReviewFinding] = []
    for i, exp in enumerate(resume.experience):
        path = f"@exp.{i}"
        label = " – ".join(x for x in (exp.title, exp.company) if x)
        raw_dates = " – ".join(x for x in (exp.start_date, exp.end_date) if x)
        if not (exp.start_date or "").strip() or not (exp.end_date or "").strip():
            missing.append(_f("dates-missing", "bad", path, label))
        else:
            for value in (exp.start_date, exp.end_date):
                if dates.is_current(value):
                    continue  # "Present" / "היום" / "כיום" are all valid end dates
                suggested = dates.ats_form(value)
                if not suggested:
                    # Unreadable: `bad`, and NO suggestion. Offering a rewrite we
                    # could not derive would be inventing the date.
                    missing.append(_f("dates-missing", "bad", path, raw_dates))
                    break
                if suggested.lower() != " ".join((value or "").split()).lower():
                    fmt.append(_f("dates-format", "warn", path, value, suggested=suggested))
        if not [b for b in (exp.bullets or []) if (b or "").strip()]:
            empty.append(_f("entry-empty", "warn", path, label))
    return {
        "no-experience": [],
        "dates-missing": missing,
        "dates-format": fmt,
        "entry-empty": empty,
    }


def _check_gap(resume: ResumeModel) -> list[ReviewFinding] | None:
    """Unexplained months between one span and the next.

    SKIPPED below two dated spans: one role is not a clean gap history, it is no
    gap history at all — `resume_health` reported `good` here, which is an
    assertion it had no evidence for. The finding anchors on the LATER span,
    because that is the entry the user would edit to explain the gap.
    """
    spans = _dated_spans(resume)
    if len(spans) < 2:
        return None
    out: list[ReviewFinding] = []
    reach = spans[0][1]
    prev_label = spans[0][3]
    for start, end, path, label in spans[1:]:
        if start - reach >= _GAP_MONTHS:
            out.append(
                _f("gap", "warn", path, label, months=start - reach, after=prev_label)
            )
        if end > reach:
            reach = end
            prev_label = label
    return out


def _check_bullets(resume: ResumeModel) -> dict[str, list[ReviewFinding] | None]:
    """Everything that reads one bullet at a time.

    SKIPPED as a group when the document has no bullets anywhere: a blank page
    has no weak openers, and saying so would be the clean-verdict-on-no-evidence
    defect again.
    """
    blocks = [(p, t) for p, t in _bullet_blocks(resume) if (t or "").strip()]
    if not blocks:
        return {
            k: None
            for k in (
                "weak-opener",
                "no-outcome",
                "bullet-long",
                "bullet-short",
                "repeated-verb",
                "duplicate-bullet",
            )
        }

    weak: list[ReviewFinding] = []
    long_b: list[ReviewFinding] = []
    short_b: list[ReviewFinding] = []
    no_out: list[ReviewFinding] = []
    for path, text in blocks:
        for opener in _WEAK_OPENERS:
            if _starts_with_opener(text, opener):
                weak.append(_f("weak-opener", "warn", path, text))
                break
        n = len(_words(text))
        if n > _LONG_BULLET_WORDS:
            long_b.append(_f("bullet-long", "warn", path, text, words=n))
        elif n < _SHORT_BULLET_WORDS:
            short_b.append(_f("bullet-short", "warn", path, text, words=n))
        if not (_METRIC.search(text) or _DELTA.search(text)):
            no_out.append(_f("no-outcome", "warn", path, text))

    # Capped at five findings, most recent role first (the walk is already in
    # document order), with the TRUE count carried in args. A cap that hid the
    # total would understate the problem; a list of forty rows would BE the
    # problem.
    total_no_out = len(no_out)
    no_out = no_out[:_NO_OUTCOME_CAP]
    for f in no_out:
        f.args["total"] = total_no_out

    # A repeated opening verb is ONE finding, anchored on its SECOND occurrence
    # with the count — not one row per bullet, which would flood the panel with
    # the same advice three times.
    seen: dict[str, list[tuple[str, str]]] = {}
    for path, text in blocks:
        verb = _first_word(text)
        if verb:
            seen.setdefault(verb, []).append((path, text))
    repeated = [
        _f("repeated-verb", "warn", hits[1][0], hits[1][1], verb=verb, count=len(hits))
        for verb, hits in seen.items()
        if len(hits) >= _REPEATED_VERB_MIN
    ]

    # A bullet copy-pasted BETWEEN employers. Two PARALLEL bullets inside ONE
    # role are not compared at all: the same work done for two customers is a
    # legitimate thing to write twice, and flagging it fires on real CVs.
    dupes: list[ReviewFinding] = []
    entries: dict[str, list[tuple[str, str]]] = {}
    for path, text in blocks:
        entries.setdefault(path.rsplit(".b.", 1)[0], []).append((path, text))
    keys = list(entries)
    for a in range(len(keys)):
        for b in range(a + 1, len(keys)):
            for _, t1 in entries[keys[a]]:
                for p2, t2 in entries[keys[b]]:
                    s1, s2 = _tokens(t1), _tokens(t2)
                    if not s1 or not s2:
                        continue
                    j = len(s1 & s2) / len(s1 | s2)
                    if j >= _DUPLICATE_JACCARD:
                        dupes.append(_f("duplicate-bullet", "warn", p2, t2))
    return {
        "weak-opener": weak,
        "no-outcome": no_out,
        "bullet-long": long_b,
        "bullet-short": short_b,
        "repeated-verb": repeated,
        "duplicate-bullet": dupes,
    }


def _check_prose(resume: ResumeModel) -> dict[str, list[ReviewFinding] | None]:
    """Buzzwords, pronouns and acronym pairing — read over every printed block."""
    blocks = [(p, t) for p, t in _blocks(resume) if (t or "").strip()]
    if not blocks:
        return {"buzzword": None, "pronoun": None, "acronym": None}

    # One finding per DISTINCT phrase, anchored to the block it is in — three
    # bullets carrying "leveraged" is one problem, not three rows.
    buzz: list[ReviewFinding] = []
    hit: set[str] = set()
    for path, text in blocks:
        for phrase in _BUZZWORDS:
            if phrase in hit:
                continue
            if re.search(rf"(?<!\w){re.escape(phrase)}(?!\w)", text, re.IGNORECASE):
                hit.add(phrase)
                buzz.append(_f("buzzword", "warn", path, text, phrase=phrase))
        if "dynamic" not in hit and _DYNAMIC.search(text):
            hit.add("dynamic")
            buzz.append(_f("buzzword", "warn", path, text, phrase="dynamic"))

    pron = [
        _f("pronoun", "warn", path, text)
        for path, text in blocks
        if _PRONOUNS.search(text)
    ]

    corpus = _corpus(resume)
    acro: list[ReviewFinding] = []
    for short, long in _ACRONYMS:
        has_short, has_long = _has_term(corpus, short), _has_term(corpus, long)
        if has_short == has_long:
            continue
        have, want = (short, long) if has_short else (long, short)
        # Anchored to the FIRST block that writes the form the résumé HAS —
        # pointing at a block that does not contain the term would scroll the
        # user somewhere with nothing to see.
        where = next((p for p, t in blocks if _has_term(t, have)), "")
        acro.append(_f("acronym", "warn", where, have, pair=f"{long} ({short})"))
    return {"buzzword": buzz, "pronoun": pron, "acronym": acro}


def _check_education(resume: ResumeModel) -> dict[str, list[ReviewFinding] | None]:
    """Template institution text, and a credential printed twice."""
    edu = resume.education or []
    certs = resume.certifications or []
    if not edu and not certs:
        return {"edu-placeholder": None, "duplicate-entry": None}

    place = [
        _f("edu-placeholder", "bad", f"@edu.{i}", getattr(e, "institution", "") or "")
        for i, e in enumerate(edu)
        if dkey(getattr(e, "institution", "") or "") in _EDU_PLACEHOLDERS
    ]

    # By token SET, so a reordering counts as the same credential. Two real AWS
    # certificates differ by their level word and a BSc and an MSc from one
    # university differ by their degree word, so neither collides — both are
    # pinned as must-not-fire.
    dupes: list[ReviewFinding] = []
    seen: list[tuple[frozenset[str], str]] = []
    for i, e in enumerate(edu):
        text = " ".join(
            x for x in (getattr(e, "degree", ""), getattr(e, "institution", "")) if x
        )
        key = frozenset(_tokens(text))
        if key and any(key == k for k, _ in seen):
            dupes.append(_f("duplicate-entry", "warn", f"@edu.{i}", text))
        elif key:
            seen.append((key, text))
    seen_certs: list[frozenset[str]] = []
    for c in certs:
        text = c if isinstance(c, str) else getattr(c, "name", "") or ""
        key = frozenset(_tokens(text))
        if key and key in seen_certs:
            dupes.append(_f("duplicate-entry", "warn", f"@cert.{dkey(text)}", text))
        elif key:
            seen_certs.append(key)
    return {"edu-placeholder": place, "duplicate-entry": dupes}


def _check_skills(resume: ResumeModel, jd: JDModel | None) -> dict[str, list[ReviewFinding] | None]:
    """The floor, the shape, and the one JD-gated verdict in the whole review."""
    skills = [s for s in (resume.skills or []) if (s or "").strip()]
    few = [] if len(skills) >= _MIN_SKILLS else [_f("skills-few", "warn", "", count=len(skills))]

    # A skill written as a sentence is REPORTED, never shortened. Nothing here
    # may rewrite the user's own text — the "never truncate the user's own
    # document" rule applies to a skill exactly as it does to a résumé.
    # SKIPPED with no skills at all: there is no entry to be a sentence, so the
    # question was never answered. Reporting "your skills read as terms" about a
    # résumé with no skills section is the unknown-shown-as-clean defect.
    sentence = (
        None
        if not skills
        else [
            _f("skills-sentence", "warn", f"@skills.{dkey(s)}", s, words=len(_words(s)))
            for s in skills
            if len(_words(s)) > _LONG_SKILL_WORDS
        ]
    )

    # SKIPPED with no job, never passed. A 66-skill master with no posting
    # attached is an INVENTORY, which is what a master is for — warning about it
    # would be a guard firing on legitimate input, and calling it clean would be
    # answering a question nobody asked.
    if not jd or not skills:
        unasked = None
    else:
        wanted = list(jd.hard_skills or []) + list(jd.keywords or [])
        if not wanted:
            unasked = None
        else:
            text = "\n".join(skills)
            toks = _tokens(text)
            asked = [
                s
                for s in skills
                if any(
                    _keyword_present(k, s, _tokens(s)) != "missing" for k in wanted
                )
            ]
            del text, toks
            miss = [s for s in skills if s not in asked]
            unasked = (
                [
                    _f(
                        "skills-unasked",
                        "warn",
                        "",
                        ", ".join(miss[:_UNASKED_SAMPLE]),
                        matched=len(asked),
                        total=len(skills),
                        sample=", ".join(miss[:_UNASKED_SAMPLE]),
                    )
                ]
                if len(asked) < len(skills) * _UNASKED_RATIO
                else []
            )
    return {"skills-few": few, "skills-sentence": sentence, "skills-unasked": unasked}


def _check_length(resume: ResumeModel, page_count_fn) -> list[ReviewFinding] | None:
    """The MEASURED page count against the years the résumé covers.

    This replaces BOTH word-count heuristics (`ats_scan`'s 650 words,
    `resume_health`'s own). A word count is a proxy for a thing we can simply
    measure: the same call `/tools/page-count` makes, deterministic and
    memoised.

    An unmeasurable count is SKIPPED, never swallowed as clean and never raised.
    This route is free and uncapped, so a renderer bug must not turn it into a
    500 — but reporting "your length is fine" because the measurement failed
    would be worse than saying nothing.
    """
    try:
        pages = int(page_count_fn(resume))
    except Exception:
        return None
    if pages <= 0:
        return None
    years = dates.years_of_experience(resume)
    # One page up to about ten years, two beyond that, three only for a senior
    # CV. `args.years` is a formatted STRING: a float fails `ReviewFinding`'s
    # `str | int` contract, and a validation error on an uncapped route is a 500.
    allowed = 1 if years < 10 else 2
    if pages > max(allowed, 2) or (pages > allowed and years < 5):
        return [
            _f("length", "warn", "", pages=pages, years=f"{years:.0f}")
        ]
    return []


def review_resume(
    resume: ResumeModel,
    jd: JDModel | None = None,
    page_count_fn=None,
) -> ReviewResult:
    """Run every check against the document as it stands.

    `jd` is an ANALYSED posting or None — never job-ad text, which is what keeps
    this route free of the model and therefore uncapped.

    `page_count_fn` is injected so the one measurement in here that costs
    milliseconds can be stubbed, and so this module never imports a renderer at
    module scope. The default is the renderer's own `page_count` — the same call
    `/tools/page-count` makes, so the review and the page-count tool can never
    disagree about the document in front of them.
    """
    if page_count_fn is None:
        from app.render.pdf_renderer import page_count as page_count_fn  # noqa: PLC0415

    results: dict[str, list[ReviewFinding] | None] = {}
    results.update(_check_contact(resume))
    results["headline"] = _check_headline(resume)
    results.update(_check_summary(resume))
    results.update(_check_experience(resume))
    results["gap"] = _check_gap(resume)
    results.update(_check_bullets(resume))
    results.update(_check_prose(resume))
    results.update(_check_education(resume))
    results.update(_check_skills(resume, jd))
    results["length"] = _check_length(resume, page_count_fn)

    findings: list[ReviewFinding] = []
    passed: list[str] = []
    skipped: list[str] = []
    # Walked in CHECK_IDS order, so `passed` and `skipped` come back in a stable
    # order and a check that was never wired up raises here rather than sitting
    # in `passed` for ever reporting a check that does not exist as clean.
    for cid in CHECK_IDS:
        if cid not in results:
            raise KeyError(f"resume_review: {cid} is in CHECK_IDS but no check produced it")
        got = results[cid]
        if got is None:
            skipped.append(cid)
        elif got:
            findings.extend(got)
        else:
            passed.append(cid)
    return ReviewResult(findings=findings, passed=passed, skipped=skipped)
