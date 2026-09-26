"""Multi-source job search: fan out to job-board providers, rank by resume fit.

Search context (what title, where) is derived from the resume automatically via
the SEARCH_CONTEXT LLM task, with a deterministic fallback; the user can override
any field, including which boards to search (`SearchContext.sources`, validated
against the provider registry). Each board lives in `app.core.providers`; one
broken/blocked board degrades the search (reported via `source_errors`) instead
of sinking it — the search only fails when every selected board fails.
"""
from __future__ import annotations

import copy
import hashlib
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable

# Re-exported for the smoke test and any older callers: the LinkedIn card parser
# and URL builder are pure functions pinned by tests/smoke_test.py.
from app.core.providers import DEFAULT_SOURCES, PROVIDERS, JobHit, NoResultsError
from app.core.providers.linkedin import (  # noqa: F401 - re-exports
    _build_search_url,
    parse_search_results,
)
from app.core.geo_restriction import detect_geo_restriction
from app.core.ghost_signals import (
    Sighting,
    board_date_is_day,
    detect_ghost_signals,
    earliest_board_date,
    parse_board_date,
)
# The module, not the function: `_low_pay` calls `pay_market.high_pay_market`
# through it, so a spy on the module attribute sees the real call path.
from app.core import hidden_jobs, pay_market
from app.core.relevance import RELEVANT_MIN, title_relevance
from app.core.salary import extract_salary
from app.core.scorer import analyze_and_score, top_matched_and_gaps
from app.core.work_mode import REMOTE, WorkModeReading, read_work_mode
from app.llm import prompts
from app.llm.client import get_llm_client
from app.models import (
    AlsoOn,
    FilteredJob,
    GeoRestriction,
    GhostReport,
    HiddenJobs,
    JobMatch,
    JobSearchResult,
    ResumeModel,
    WORK_MODES,
    SearchContext,
    work_modes,
)

# Progress events emitted during a search (consumed by the SSE endpoint, PLAN 9.2 + 12.2).
# Boards and jobs run in PARALLEL, so events fire on COMPLETION and `index` is a
# completed-count, not a position — order across sources/jobs is not deterministic:
#   {"stage": "boards",  "source": <name>, "index": <completed>, "total": n}  per board finished
#   {"stage": "scoring", "index": <completed>, "total": n, "title": ..., "company": ...}  per job scored
#   {"stage": "match",   "index": <completed>, "total": n, "match": <JobMatch.model_dump()>}
#     — right after a job scores successfully (skipped jobs emit no match event)
# The callback may be invoked from worker threads; consumers must be thread-safe
# (the SSE endpoint funnels events through a queue.Queue).
ProgressFn = Callable[[dict], None]

MAX_JOBS = 25
MAX_TITLES = 5  # keywords searched separately per board; capped to keep total board queries sane
MAX_AGE_DAYS_CAP = 365
FETCH_DELAY_S = 0.5  # pause between per-job network fetches to stay under the radar
SCORE_WORKERS = 5  # concurrent scoring workers; same-board detail fetches stay serialized

# Worldwide-remote opt-in (SearchContext.include_worldwide + "remote" among the work
# modes, or "any"): extra locations queried on the board(s) with global reach,
# targeting remote roles. A posting they return is kept only when it SAYS it is
# remote (`_work_mode_gate`), because LinkedIn's remote filter is ignored by its
# logged-out search and the query alone returns on-site jobs abroad. "European Union" is a real LinkedIn location, and it
# returns postings in EVERY member state, Bulgaria and Romania included, not only
# the high-paying ones: `pay_market` hides a posting whose location names a
# low-pay country before selection (see `_low_pay`). It stays one query rather
# than a list of the rich member states because every entry here multiplies the
# per-board query count by len(job_titles), run serially against a board that 429s.
WORLDWIDE_REMOTE_LOCATIONS: list[str] = ["United States", "United Kingdom", "European Union"]
WORLDWIDE_BOARD = "linkedin"  # the only registered board with worldwide inventory


def resume_hash(resume: ResumeModel) -> str:
    """Content identity of a resume: sha256 hex of its canonical JSON. History
    rows stamp it so a later search can tell "same resume, reuse the scores"
    from "different resume, rescore" (PLAN 12.4)."""
    return hashlib.sha256(resume.model_dump_json().encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class CachedScore:
    """One fresh history row, ready for reuse in `search_jobs` (PLAN 12.4).

    Built by `app.db.history.load_score_cache`, which owns the freshness (TTL)
    and non-empty-jd_text filters — core just trusts what it's given. When
    `is_full_match` is True the row was scored against the CURRENT resume, so
    the whole match (scores + keywords + jd_text) can be rebuilt with zero LLM
    calls and zero network fetch; otherwise only `jd_text` is reusable (skips
    the fetch and its politeness throttle, still one LLM scoring call).
    """

    jd_text: str
    overall: float
    keyword_coverage: float
    fit_score: float
    top_matched: tuple[str, ...]
    top_gaps: tuple[str, ...]
    # Fallbacks for board cards that omit these; the FRESH hit's values win.
    title: str
    company: str
    location: str
    posted_at: str
    logo_url: str
    is_full_match: bool


# What our own search history remembers about the postings in THIS run, looked
# up by (source, content_key) — see `_ghost_for` and the load site in
# `search_jobs`. Injected as a CALLABLE, never imported: this module has always
# been DB-free (the caller owns the Session and hands `cache` in already
# loaded), and `app.db.sightings` imports `app.models` + SQLAlchemy, which the
# pure classifier chain must stay clear of. The callable also keeps the pool
# workers away from a Session — SQLAlchemy's is not thread-safe, and a worker
# starts from an empty context regardless.
SightingsFn = Callable[[list[tuple[str, str]]], dict[tuple[str, str], Sighting]]


def _clean_titles(titles: list[str]) -> list[str]:
    """Strip, drop blanks, dedupe case-insensitively (order kept), cap at MAX_TITLES."""
    seen: set[str] = set()
    out: list[str] = []
    for raw in titles:
        title = raw.strip()
        if title and title.lower() not in seen:
            seen.add(title.lower())
            out.append(title)
    return out[:MAX_TITLES]


def _fallback_context(resume: ResumeModel) -> SearchContext:
    """Deterministic context when the LLM is unavailable or returns blanks."""
    title = ""
    if resume.experience:
        title = resume.experience[0].title.strip()
    if not title and resume.skills:
        title = resume.skills[0].strip()
    location = resume.contact.location.strip()
    if not location and resume.experience:
        location = resume.experience[0].location.strip()
    return SearchContext(job_title=title, location=location)


def derive_search_context(resume: ResumeModel) -> SearchContext:
    fallback = _fallback_context(resume)
    try:
        data = get_llm_client().complete_json(
            prompts.SEARCH_CONTEXT_SYSTEM, prompts.search_context_user(resume.model_dump_json())
        )
    except Exception:  # noqa: BLE001 - the deterministic fallback is always usable
        return fallback
    title = str(data.get("job_title") or "").strip()
    location = str(data.get("location") or "").strip()
    return SearchContext(
        job_title=title or fallback.job_title,
        location=location or fallback.location,
    )


def _resolve_context(resume: ResumeModel, customize: SearchContext | None) -> SearchContext:
    # derive_search_context is an LLM round-trip whose only job is picking a
    # title + location — skip it when the customize payload already names a
    # title. The deterministic fallback supplies the location default, and the
    # non-blank customize location still overrides it below.
    has_custom_title = customize is not None and bool(
        _clean_titles(customize.job_titles) or customize.job_title.strip()
    )
    ctx = _fallback_context(resume) if has_custom_title else derive_search_context(resume)
    if customize is not None:
        titles = _clean_titles(customize.job_titles)
        if titles:
            ctx.job_titles = titles
        elif customize.job_title.strip():
            ctx.job_title = customize.job_title.strip()
        if customize.location.strip():
            ctx.location = customize.location.strip()
        # Already canonical: SearchContext's validator reads every value, junk
        # included, as "any" or a comma list in WORK_MODES order.
        ctx.work_mode = customize.work_mode
        ctx.limit = customize.limit
        ctx.sources = customize.sources
        ctx.max_age_days = customize.max_age_days
        ctx.include_worldwide = customize.include_worldwide
    # Unknown board names are ignored; an empty (or all-unknown) selection falls
    # back to every registered provider so old clients keep working unchanged.
    ctx.sources = [s for s in ctx.sources if s in PROVIDERS] or list(DEFAULT_SOURCES)
    ctx.limit = max(1, min(MAX_JOBS, ctx.limit))
    ctx.max_age_days = max(0, min(MAX_AGE_DAYS_CAP, ctx.max_age_days))
    # job_titles is the canonical keyword list from here on; job_title mirrors
    # its first entry so history rows, alerts, and old clients stay coherent.
    ctx.job_titles = _clean_titles(ctx.job_titles) or ([ctx.job_title] if ctx.job_title else [])
    if ctx.job_titles:
        ctx.job_title = ctx.job_titles[0]
    return ctx


def utc_now() -> datetime:
    """The one clock for every age in this module.

    `datetime.now()` is naive LOCAL time. `record_sightings` writes
    `first_seen_at` as naive UTC and `parse_board_date` returns naive UTC, so
    measuring an age against a local clock inflated every `long_open` by the
    machine's offset — +3h in the primary market, which reported a share of
    postings a full day older than they were, always in the "older" direction,
    in the daily email where the user cannot check it against anything.

    It lives HERE and not in `ghost_signals`: that module is source-pinned to
    read no clock at all, which is what makes `detect_ghost_signals`
    deterministic given its `now` parameter. Putting the wall clock there to
    share it would have deleted that guarantee to fix a bug about clocks.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _posted_datetime(posted_at: str) -> datetime | None:
    """Lenient parse of a JobHit.posted_at ISO string ('' / junk → None),
    delegated to `parse_board_date`, which converts an offset to UTC before
    dropping it. A date-only string comes back as that day's midnight but
    names a WHOLE day; its window test lives in `posted_within`, never here.

    MOVED to `app.core.ghost_signals.parse_board_date` (Phase 28); this name
    stays as a delegating alias because the tiering above, the smoke test and
    older callers import it from here.

    It moved rather than being copied for the reason this repo keeps relearning:
    ONE parser, ONE answer. The ghost classifier measures how long a posting has
    been open from the SAME strings the freshness tier reads, and a second
    lenient-ISO parser is a second opinion — one that would render on the same
    card as the first. A string the tier parses and the age check does not is an
    "Older" badge over a "Posted 3 days ago" line, both ours, disagreeing about
    one posting; a string they parse to different instants is worse, because
    nothing on the page says which clock it came from.
    """
    return parse_board_date(posted_at)


def posted_within(posted_at: str, max_age_days: int, now: datetime) -> bool:
    """THE window comparison, read by the tiering, `freshest_first` and the
    relabel in `_build_match` alike — one rule, so selection and the "Older"
    label can never disagree about the same string.

    A date-only board string ("2026-09-20", LinkedIn's card date) names a
    whole DAY, so it is inside the window when any moment of that day is: its
    day is on or after the cutoff's day. Compared as a midnight it was stale
    at 06:43 the next morning, and a 1-day alert called every posting LinkedIn
    had just returned for the last 24 hours "older posting — yesterday".
    A timestamp still compares to the minute; an explicit `T00:00` is an
    instant (detection is by grammar, `ghost_signals.board_date_is_day`).
    Undated or unreadable is kept, never hidden, and 0 means any age."""
    if max_age_days <= 0:
        return True
    dt = _posted_datetime(posted_at)
    if dt is None:
        return True  # unknown is kept, never hidden
    cutoff = now - timedelta(days=max_age_days)
    if board_date_is_day(posted_at):
        return dt.date() >= cutoff.date()  # the day overlaps the window
    return dt >= cutoff  # an instant: to the minute, as before


def freshest_first(hits: list[JobHit], max_age_days: int, now: datetime | None = None) -> list[JobHit]:
    """Drop hits posted before the cutoff and order the rest newest-first, so
    the per-hit fetch/scoring budget is spent on fresh postings. Hits with no
    parseable date are kept (missing data shouldn't hide a job) but sort last.
    The window test is `posted_within`, the same one the tiering reads.
    Pure given `now`; pinned by the smoke test."""
    if max_age_days > 0:
        now = now or utc_now()
        hits = [h for h in hits if posted_within(h.posted_at, max_age_days, now)]
    # ISO strings order lexicographically; "" (unknown) is smallest, so with
    # reverse=True the undated hits land at the end, newest first before them.
    return sorted(hits, key=lambda h: h.posted_at, reverse=True)


# Cross-board duplicate detection (PLAN 15.1). Legal suffixes stripped from
# company names so "Acme Ltd" (Drushim) matches "Acme" (LinkedIn); anything
# fancier (similarity scoring) risks merging genuinely different roles, so the
# fingerprint is exact title + company after normalization, or nothing.
_CONTENT_NORM_RE = re.compile(r"\W+", re.UNICODE)
# Hebrew acronyms write their quote INSIDE the word (בע"מ, ע"ר) — strip those
# marks before word-splitting so the acronym survives as one token.
_ACRONYM_MARKS_RE = re.compile(r"[\"'׳״]")
_COMPANY_LEGAL = {"ltd", "limited", "inc", "llc", "corp", "gmbh", "בעמ"}


def content_key(title: str, company: str) -> str:
    """Fingerprint for 'same posting on another board': normalized title +
    company. Returns "" (never merge) when either half is empty — merging on
    title alone would collapse different companies' identical roles. Pure;
    pinned by the smoke test."""
    t_words = _CONTENT_NORM_RE.sub(" ", _ACRONYM_MARKS_RE.sub("", title.lower())).split()
    c_words = [
        w
        for w in _CONTENT_NORM_RE.sub(" ", _ACRONYM_MARKS_RE.sub("", company.lower())).split()
        if w not in _COMPANY_LEGAL
    ]
    if not t_words or not c_words:
        return ""
    return " ".join(t_words) + "|" + " ".join(c_words)


def _interleave_into(
    merged: list[JobHit],
    seen: set[str],
    by_content: dict[str, JobHit],
    hits_by_source: dict[str, list[JobHit]],
    limit: int,
) -> None:
    """Core of `_interleave_and_dedupe`, with the dedupe state external so
    `select_hits` can run several tiers through it in priority order — a hit
    already picked in an earlier tier turns its later-tier duplicates into
    `also_on` links instead of extra rows."""
    queues = [list(hits) for hits in hits_by_source.values() if hits]
    i = 0
    while queues and len(merged) < limit:
        queue = queues[i % len(queues)]
        hit = queue.pop(0)
        if not queue:
            queues.remove(queue)
        else:
            i += 1
        # Don't strip query strings here: JobMaster's job key lives in the
        # query (checknum.asp?key=N), so stripping collapsed every JobMaster
        # hit into one. Boards with tracking queries (LinkedIn) already strip
        # them in their own parsers, where board knowledge belongs.
        key = hit.url.rstrip("/")
        if key in seen:
            continue
        seen.add(key)
        ck = content_key(hit.title, hit.company)
        prior = by_content.get(ck) if ck else None
        if prior is not None:
            if hit.url and all(a.get("url") != hit.url for a in prior.also_on):
                prior.also_on.append({"source": hit.source, "url": hit.url})
            # A twin on the SAME board is another listing of this role there (a
            # relist beside its original): keep its card date, which is a date
            # that board stated for the role. Another board's date is not.
            if hit.source == prior.source and hit.posted_at:
                prior.twin_posted.append(hit.posted_at)
            continue
        if ck:
            by_content[ck] = hit
        merged.append(hit)


def _interleave_and_dedupe(hits_by_source: dict[str, list[JobHit]], limit: int) -> list[JobHit]:
    """Round-robin merge across sources (so one board can't crowd out the
    others), deduped by URL, capped at `limit`. Source order follows the
    context's `sources` order; within a source hits arrive newest-first.
    The same posting found on several boards (PLAN 15.1: matching content_key)
    becomes ONE hit carrying the other boards' links in `also_on` — it's
    fetched and scored once, and duplicates don't eat into `limit`."""
    merged: list[JobHit] = []
    _interleave_into(merged, set(), {}, hits_by_source, limit)
    return merged


def tiered_by_source(
    hits_by_source: dict[str, list[JobHit]],
    query_titles: list[str],
    max_age_days: int,
    now: datetime | None = None,
) -> list[dict[str, list[JobHit]]]:
    """Split each board's raw hits into selection tiers (PLAN 15.6), so the
    fetch/scoring budget goes to postings that match the SEARCH, not merely
    the newest ones:

      0. fresh + title-relevant — what the user actually searched for
      1. stale + title-relevant — older than max_age_days but on-target;
         backfill when tier 0 runs short, marked `stale` for the UI/email
      2. fresh + loosely-matched — keyword matched only in the description;
         filler for whatever budget remains

    Stale + irrelevant hits are dropped, as the age filter always did; with
    max_age_days == 0 nothing is stale. Hits with no parseable date count as
    fresh (missing data shouldn't hide a job) but sort last within their tier.
    Fresh is `posted_within`, so a date-only card counts its WHOLE day: a card
    dated on the cutoff's day is fresh.
    Pure given `now`; pinned by the smoke test."""
    tiers: list[dict[str, list[JobHit]]] = [{}, {}, {}]
    now = now or utc_now()
    for name, hits in hits_by_source.items():
        # Same lexicographic newest-first trick as freshest_first: "" (unknown
        # date) is smallest, so reverse=True puts undated hits last.
        for hit in sorted(hits, key=lambda h: h.posted_at, reverse=True):
            relevant = title_relevance(hit.title, query_titles) >= RELEVANT_MIN
            fresh = posted_within(hit.posted_at, max_age_days, now)
            if fresh:
                tier = 0 if relevant else 2
            elif relevant:
                tier = 1
                hit.stale = True
            else:
                continue
            tiers[tier].setdefault(name, []).append(hit)
    return tiers


def select_hits(tiers: list[dict[str, list[JobHit]]], limit: int) -> list[JobHit]:
    """Fill `limit` slots tier by tier (see `tiered_by_source`), each tier
    round-robin-interleaved across boards with dedupe/also_on state shared
    across tiers. Pure; pinned by the smoke test."""
    merged: list[JobHit] = []
    seen: set[str] = set()
    by_content: dict[str, JobHit] = {}
    for tier in tiers:
        _interleave_into(merged, seen, by_content, tier, limit)
    return merged


def _low_pay(hit: JobHit) -> bool:
    """The pay-market gate: True ONLY for a worldwide-origin posting whose card
    location names a country where pay is well below Israel's.

    Gated on `origin_market` exactly as `_geo_for` is, and for the same reason:
    with `include_worldwide` off this returns False without reading a
    character, and a posting the user's OWN location query also returned has
    already had its stamp cleared by `_search_board`'s local-wins pass, so it is
    never hidden. `pay_market.high_pay_market` answers True / False / None and
    only False hides: an unplaceable location ("European Union", "Remote", "")
    is KEPT, because an unfamiliar format must never silently delete a real job.

    It reads no `jd_text`, which is what lets it run BEFORE selection where the
    geo gate cannot: the card's own location is the whole input."""
    if not hit.origin_market:
        return False
    return pay_market.high_pay_market(hit.location) is False


def _split_low_pay(
    tiers: list[dict[str, list[JobHit]]],
) -> tuple[list[dict[str, list[JobHit]]], list[JobHit]]:
    """(kept_tiers, low_pay): every tier's per-board lists with the `_low_pay`
    hits moved out, board order and within-board order unchanged, so
    `select_hits` interleaves the kept pool exactly as it would have."""
    kept_tiers: list[dict[str, list[JobHit]]] = []
    low_pay: list[JobHit] = []
    for tier in tiers:
        kept: dict[str, list[JobHit]] = {}
        for name, tier_hits in tier.items():
            for hit in tier_hits:
                if _low_pay(hit):
                    low_pay.append(hit)
                else:
                    kept.setdefault(name, []).append(hit)
        kept_tiers.append(kept)
    return kept_tiers, low_pay


def _displaced_low_pay(
    tiers: list[dict[str, list[JobHit]]], low_pay: list[JobHit], limit: int
) -> list[JobHit]:
    """The low-pay hits an UNFILTERED selection would have given a slot, in that
    selection's order: what the filter actually took off the page, never the
    whole pool it read (up to 5 titles × 4 locations × 30 cards on LinkedIn:
    three pages of ten, `providers/linkedin._MAX_PAGES`).

    The unfiltered selection runs on COPIES. `_interleave_into` appends to
    `prior.also_on` when it meets a content twin, so on the real objects it
    would hand a kept card an "Also on" link to a posting the user is told is
    hidden. `JobHit` is a dataclass, hence `copy.deepcopy`. Each copy is traced
    back to its original by identity, so the rows describe exactly the hits
    `_split_low_pay` moved out. Nothing is copied when nothing was hidden.
    `search_jobs` then drops any whose content twin made the page anyway: that
    role was not taken off it."""
    if not low_pay:
        return []
    hidden = {id(hit) for hit in low_pay}
    original: dict[int, JobHit] = {}
    twin_tiers: list[dict[str, list[JobHit]]] = []
    for tier in tiers:
        twin_tier: dict[str, list[JobHit]] = {}
        for name, tier_hits in tier.items():
            twins: list[JobHit] = []
            for hit in tier_hits:
                twin = copy.deepcopy(hit)
                original[id(twin)] = hit
                twins.append(twin)
            twin_tier[name] = twins
        twin_tiers.append(twin_tier)
    return [
        original[id(twin)]
        for twin in select_hits(twin_tiers, limit)
        if id(original[id(twin)]) in hidden
    ]


def _remote_ok(ctx: SearchContext) -> bool:
    """Can this search include remote jobs? True for "any" and for any pick with
    "remote" in it: the gate on the worldwide pass, which exists for remote jobs."""
    modes = work_modes(ctx.work_mode)
    return not modes or REMOTE in modes


def _work_mode_gate(hit: JobHit, text: str, work_mode: str) -> tuple[str, WorkModeReading] | None:
    """Does this posting go, for its work mode? (reason, reading) when it does,
    None when it stays. Pure; the ONE rule, read before selection on what the card
    carries and again after the fetch on the full text.

    A WORLDWIDE-origin posting stays only when it SAYS it is remote ("not_remote"
    otherwise). That is the whole promise of the worldwide pass, and nothing else
    keeps it: LinkedIn ignores the remote filter the query sends (measured
    2026-09-22), and five abroad postings in the ghost-run corpus included an
    in-person Seattle job and a "100% onsite" one in Ohio.

    A LOCAL posting goes only when it states work modes and none of them is one
    the user picked ("work_mode"). One that says nothing stays: unknown is never a
    mode, and most Israeli postings do not say (18 of the corpus's 28).

    The origin stamp is `pay_market`'s and `_geo_for`'s gate, so with the
    worldwide pass off a posting is never asked to say remote, and a posting the
    user's own location query also returned has had its stamp cleared."""
    reading = read_work_mode(
        title=hit.title, location=hit.location, text=text, board_value=hit.work_mode
    )
    if hit.origin_market:
        return None if REMOTE in reading.modes else ("not_remote", reading)
    picked = set(work_modes(work_mode))
    if picked and reading.modes and not (reading.modes & picked):
        return "work_mode", reading
    return None


def _split_work_mode(
    tiers: list[dict[str, list[JobHit]]], work_mode: str
) -> list[dict[str, list[JobHit]]]:
    """Every tier with the postings whose CARD already states only other modes
    taken out, board order and within-board order unchanged, so the freed slots
    refill from the kept pool in the same single round (`pay_market`'s position).

    What the card carries is the board's own field (Comeet), the title, the
    location, and the description on the boards that send it inline (Drushim,
    Comeet). A card that says nothing is never taken out here, worldwide or not:
    its text is read after the fetch, where "not_remote" can fire.

    SILENT, on purpose, where the rows after the fetch are reported: this is the
    board-side filter the user asked for and LinkedIn would have applied, and a
    posting it removes never took a slot. The ones removed after the fetch did
    take one, so the page has to say where they went."""
    kept_tiers: list[dict[str, list[JobHit]]] = []
    for tier in tiers:
        kept: dict[str, list[JobHit]] = {}
        for name, tier_hits in tier.items():
            for hit in tier_hits:
                verdict = _work_mode_gate(hit, hit.description, work_mode)
                # Before the fetch, "says nothing yet" is not "not_remote".
                if verdict is None or (verdict[0] == "not_remote" and not verdict[1].modes):
                    kept.setdefault(name, []).append(hit)
        kept_tiers.append(kept)
    return kept_tiers


def _split_hidden(
    tiers: list[dict[str, list[JobHit]]], hidden: HiddenJobs | None
) -> tuple[list[dict[str, list[JobHit]]], int]:
    """Every tier without the postings the user said "Not for me" to (PLAN
    31.5/4), and how many went. `_split_work_mode`'s position and shape: before
    selection, so a hidden posting takes no slot and costs no fetch or model
    call, and the freed slot refills in the same single round. NOT silent: the
    count rides the result as `hidden`, and the page says it with the list."""
    if hidden_jobs.is_empty(hidden):
        return tiers, 0
    removed = 0
    kept_tiers: list[dict[str, list[JobHit]]] = []
    for tier in tiers:
        kept: dict[str, list[JobHit]] = {}
        for name, tier_hits in tier.items():
            for hit in tier_hits:
                if hidden_jobs.hidden_reason(hidden, url=hit.url, company=hit.company, title=hit.title):
                    removed += 1
                else:
                    kept.setdefault(name, []).append(hit)
        kept_tiers.append(kept)
    return kept_tiers, removed


def _stated_modes(hit: JobHit, text: str) -> list[str]:
    """The modes a KEPT posting states, in WORK_MODES order, for its card; [] when
    it says nothing, which the card leaves blank (unknown, never "on-site"). The
    same reader the gate uses, on the same text, so the card never says a mode the
    filter did not read. A kept job used to show none, so a "Remote" search that
    kept a posting saying nothing looked like a filter that missed."""
    reading = read_work_mode(title=hit.title, location=hit.location, text=text, board_value=hit.work_mode)
    return [m for m in WORK_MODES if m in reading.modes]


def _stated(mode: tuple[str, WorkModeReading] | None) -> list[str]:
    """The modes a removed posting states, in WORK_MODES order, for its row."""
    if mode is None:
        return []
    return [m for m in WORK_MODES if m in mode[1].modes]


def _board_queries(name: str, ctx: SearchContext) -> list[tuple[str, str, str, str]]:
    """(job_title, location, work_mode, origin_market) tuples one board will be
    queried with — normally every keyword against the context's own location
    and work mode.
    The worldwide-remote opt-in ("remote" among the work modes, or "any", plus
    include_worldwide) adds each location in WORLDWIDE_REMOTE_LOCATIONS, but ONLY on the board
    with global inventory — the local Israeli boards never see those
    locations. Those locations say where we LOOK, not what a posting pays: the
    "European Union" query returns every member state, and `_low_pay` hides the
    postings in low-pay countries before selection. Worldwide queries ask for
    remote only, even when the context's work mode is "any": abroad, only remote
    roles are workable, while the local location keeps the user's modes. LinkedIn
    ignores that ask, so `_work_mode_gate` keeps a worldwide posting only when it
    says it is remote.
    A board the user unchecked in `sources` is never queried AT ALL — not even
    by the worldwide pass (PLAN 15.9: the checkboxes are authoritative; the pass
    riding an unchecked LinkedIn read as a bug to the actual user). Pure; pinned
    by the smoke test.

    The fourth element is the ORIGIN MARKET — "" for the context's own location,
    the market name for each worldwide entry — and it is carried here rather
    than inferred downstream on purpose. With multiple `job_titles` the local
    location recurs at index 0, len(locations), 2*len(locations)…, so a
    positional test is wrong; and a `location != ctx.location` test misfires the
    moment a user literally types "United States" as their location. This
    function already knows which pass produced each query, so it says so."""
    if name not in ctx.sources:
        return []
    locations = [(ctx.location, ctx.work_mode, "")]
    if name == WORLDWIDE_BOARD and _remote_ok(ctx) and ctx.include_worldwide:
        locations = locations + [(loc, "remote", loc) for loc in WORLDWIDE_REMOTE_LOCATIONS]
    return [
        (t, loc, mode, origin)
        for t in ctx.job_titles
        for loc, mode, origin in (locations or [(ctx.location, ctx.work_mode, "")])
    ]


def _search_board(name: str, ctx: SearchContext) -> tuple[list[JobHit], list[str], list[str]]:
    """All queries for one board (keywords × locations), serially (politeness
    is per-board). Never raises: a query that fails or matches nothing must
    not hide the other queries' hits, so per-query outcomes are collected and
    only a board where EVERY query came up empty/broken lands in
    source_empty/source_errors (classified by the caller)."""
    board_hits: list[JobHit] = []
    board_errors: list[str] = []
    board_empty: list[str] = []
    for query_i, (title, location, work_mode, origin) in enumerate(_board_queries(name, ctx)):
        if query_i:
            time.sleep(FETCH_DELAY_S)  # polite gap between queries to the same board
        query_ctx = ctx.model_copy(
            update={"job_title": title, "location": location, "work_mode": work_mode}
        )
        try:
            found = PROVIDERS[name].search(query_ctx)
        except NoResultsError as e:  # board worked, this query just matched nothing
            board_empty.append(str(e))
        except ValueError as e:  # board-level failure, user-facing message
            board_errors.append(str(e))
        except Exception:  # noqa: BLE001 - a buggy provider must not sink the rest
            board_errors.append(f"Searching {name} failed unexpectedly. Try again shortly.")
        else:
            for hit in found:
                hit.origin_market = origin  # the fan-out stamps it; providers never do
            board_hits.extend(found)
    # Local wins: a posting the user's OWN location query also returned is
    # visible from Israel by construction, so it must not be gated into the
    # geo classifier just because a worldwide query found it too. Removes no
    # hits and changes no counts — it only clears the stamp.
    #
    # Keyed by URL *and* by content, because `_interleave_into` dedupes by BOTH
    # and the one it keeps is whichever sorted first (newest `posted_at`). A
    # company that posts the same role twice — Tel Aviv and US-remote, different
    # URLs, identical title+company — would otherwise have the worldwide twin
    # win the merge, keep its stamp, get filtered, and take the Tel Aviv URL
    # with it: `FilteredJob` carries no `also_on`, so the local posting the
    # user's own query returned vanished from the response entirely.
    local_urls = {h.url.rstrip("/") for h in board_hits if not h.origin_market and h.url}
    local_content = {
        content_key(h.title, h.company)
        for h in board_hits
        if not h.origin_market and content_key(h.title, h.company)
    }
    for hit in board_hits:
        if not hit.origin_market:
            continue
        if hit.url.rstrip("/") in local_urls or content_key(hit.title, hit.company) in local_content:
            hit.origin_market = ""
    return board_hits, board_errors, board_empty


def _geo_for(hit: JobHit, jd_text: str, location: str) -> GeoRestriction | None:
    """The geo gate: classify ONLY postings the worldwide pass produced.

    `origin_market` is stamped by `_search_board` and is "" for everything the
    user's own location query returned — so with `include_worldwide` off this
    returns None without reading a character, and an Israeli-board posting is
    structurally out of the classifier's reach rather than merely unlikely to
    trip it. Pinned end to end by the smoke test."""
    if not hit.origin_market:
        return None
    return detect_geo_restriction(jd_text, location, hit.title)


def _ghost_for(
    hit: JobHit, jd_text: str, sighting: Sighting | None, now: datetime
) -> GhostReport | None:
    """The ghost check: classify EVERY posting. The contrast with `_geo_for`
    directly above is the whole comment.

    `_geo_for` is GATED on `origin_market` because its rules only make sense for
    the worldwide pass: "must be authorized to work in the United States" is a
    sentence about the reader's passport, and it is meaningless — worse,
    actively wrong — read against a Tel Aviv listing, so an Israeli-board
    posting is put structurally out of the classifier's reach rather than merely
    made unlikely to trip it.

    This one is deliberately UNGATED, because a ghost posting is a
    PRIMARY-MARKET problem. The evergreen מאגר מועמדים, the agency listing that
    has been open since spring, the LinkedIn card whose posting closed a month
    ago are exactly what a user searching Israel from Israel loses an afternoon
    to — that is the complaint this feature came from. Gating it on the same
    stamp would disable it for every user who never turns the worldwide opt-in
    on, i.e. for the default search: a detector that ships green because it can
    never fire.

    Nothing is inferred here that the caller does not already hold. `title` and
    `jd_text` carry the wording rules; `posted_at` and `raw` carry the stated
    age (Greenhouse's `first_published` has been riding in `raw` unread since
    the provider was written); `hit.closed` is what the BOARD said, never a
    guess of ours; the sighting is what our own past searches remember. `now` is
    a PARAMETER and never `datetime.now()` inside — the
    `providers.jobmaster.parse_hebrew_relative_date` precedent — so the whole
    chain stays pure and pinnable, and every hit in one run ages against one
    instant instead of drifting across a threshold mid-search.

    None means nothing fired. It NEVER means the posting is real.
    """
    return detect_ghost_signals(
        title=hit.title,
        jd_text=jd_text,
        posted_at=hit.posted_at,
        raw=hit.raw,
        closed=hit.closed,
        sighting=sighting,
        url=hit.url,
        now=now,
    )


def search_jobs(
    resume: ResumeModel,
    customize: SearchContext | None = None,
    progress: ProgressFn | None = None,
    cache: dict[str, CachedScore] | None = None,
    sightings_fn: SightingsFn | None = None,
    hidden: HiddenJobs | None = None,
) -> JobSearchResult:
    """`hidden` is the user's "Not for me" set (PLAN 31.5/4), canonical, taken
    out before selection (`_split_hidden`) and counted on the result.

    `cache` maps URL-dedupe keys (`url.rstrip("/")` — same key as
    `_interleave_and_dedupe`) to fresh history rows; see CachedScore for the
    two reuse tiers. None/{} means every hit takes the full fetch+score path.

    `sightings_fn` is the market memory (Phase 28): the caller passes
    `partial(app.db.sightings.load_sightings, db)` and records the run AFTERWARDS,
    beside `record_search_hits`. None means every posting classifies without a
    sighting, which the ghost rules treat as "unknown" — never as "new"."""
    notify = progress or (lambda event: None)
    ctx = _resolve_context(resume, customize)
    if not ctx.job_title:
        raise ValueError(
            "Couldn't derive a job title from your resume. "
            "Check 'Customize search' and enter one."
        )

    # Boards stage: one worker per board — there's no reason LinkedIn should
    # wait for Drushim; within a board queries stay serial (see _search_board).
    # Results are classified in fan-out order so _interleave_and_dedupe's
    # round-robin order stays stable regardless of which board finishes first.
    # The fan-out is EXACTLY the checked boards (PLAN 15.9): the worldwide
    # pass extends the global board's queries in _board_queries, but never
    # adds a board the user unchecked.
    fanout = list(ctx.sources)
    hits_by_source: dict[str, list[JobHit]] = {}
    source_errors: dict[str, str] = {}
    source_empty: dict[str, str] = {}
    progress_lock = threading.Lock()  # serializes counter bumps AND their notify()
    boards_done = 0

    def _run_board(name: str) -> tuple[list[JobHit], list[str], list[str]]:
        nonlocal boards_done
        out = _search_board(name, ctx)
        with progress_lock:  # emitted on COMPLETION — parallel boards have no "starting board i"
            boards_done += 1
            notify({"stage": "boards", "source": name, "index": boards_done, "total": len(fanout)})
        return out

    with ThreadPoolExecutor(max_workers=len(fanout)) as pool:
        board_futures = {name: pool.submit(_run_board, name) for name in fanout}
    for name in fanout:
        board_hits, board_errors, board_empty = board_futures[name].result()
        if board_hits:
            hits_by_source[name] = board_hits
        elif board_errors:
            source_errors[name] = board_errors[0]
        elif board_empty:
            source_empty[name] = board_empty[0]
    if not hits_by_source:
        if source_errors:
            raise ValueError(
                "All job boards failed: "
                + " · ".join(
                    f"{name}: {msg}"
                    for name, msg in {**source_errors, **source_empty}.items()
                )
            )
        where = f" in '{ctx.location}'" if ctx.location.strip() else ""
        what = "', '".join(ctx.job_titles)
        raise NoResultsError(
            f"No jobs found on any board for '{what}'{where}. "
            "Check 'Customize search' and adjust the keywords, location, or 'Posted within'."
        )

    # One instant for the whole run: the tiering, the "Older" relabel in
    # `_build_match` and the ghost age all read it, so a posting cannot be fresh
    # to selection and stale to its label, and hits scored a minute apart must
    # not land on opposite sides of the 60-day threshold and disagree about the
    # same market.
    now = utc_now()

    # Relevance-first selection (PLAN 15.6): budget goes to title-relevant
    # postings first, then old-but-relevant backfill (marked stale), then
    # description-only matches. Old + irrelevant stays dropped.
    tiers = tiered_by_source(hits_by_source, ctx.job_titles, ctx.max_age_days, now=now)
    # The work-mode filter on what each CARD says, first: the pay-market rows
    # below describe only postings the user's own filter would have shown.
    tiered_count = sum(len(v) for tier in tiers for v in tier.values())
    tiers = _split_work_mode(tiers, ctx.work_mode)
    mode_removed = tiered_count - sum(len(v) for tier in tiers for v in tier.values())
    # The user's own "Not for me" (PLAN 31.5/4), before the pay-market rows too:
    # those describe postings the user would otherwise have been shown.
    tiers, hidden_count = _split_hidden(tiers, hidden)
    # The pay-market filter (Phase 30 J) runs HERE, BEFORE selection, and the
    # position is the design. LinkedIn's "European Union" location returns
    # postings in every member state, and `_low_pay` needs only the card's
    # location, so a hidden posting takes no slot, is never fetched and costs no
    # model call, and the freed slot refills from the kept pool in this same
    # single round. That is not the two-round backfill the geo filter refused:
    # `fetch_locks`, `matches_by_hit`, `geo_by_hit`, `ghost_by_hit`, the
    # sightings keys and the SSE `total` below are all built from the final
    # `hits`. The displaced rows are computed FIRST, from copies of the untouched
    # tiers, because the kept selection appends to its own cards' `also_on`.
    kept_tiers, low_pay = _split_low_pay(tiers)
    displaced = _displaced_low_pay(tiers, low_pay, ctx.limit)
    hits = select_hits(kept_tiers, ctx.limit)
    # A displaced posting whose ROLE made the page anyway is not reported. Its
    # content twin (same title and company, another URL, a kept location) folded
    # into it as "Also on" while the hidden copy held the slot, and takes the slot
    # itself once that copy is hidden: a "1 job hidden" row would call a job
    # hidden while its identical card is ranked on the same page. Only a twin
    # that made the page counts. One the freed slot never reached leaves the role
    # off the page, so that row stays.
    on_page = {content_key(hit.title, hit.company) for hit in hits} - {""}
    market_rows = [
        FilteredJob(
            title=hit.title,
            company=hit.company,
            location=hit.location,
            url=hit.url,
            source=hit.source,
            posted_at=hit.posted_at,
            logo_url=hit.logo_url,
            reason="market",
        )
        for hit in displaced
        if content_key(hit.title, hit.company) not in on_page
    ]
    if not hits and market_rows:
        # Every posting that survived tiering was in a low-pay country. "None
        # posted in the last N days" would be false, and raising would destroy
        # the list: this is the all-filtered 200 the restriction and closed
        # filters already return, reached before scoring instead of after it.
        # Nothing was selected, so nothing was skipped.
        return JobSearchResult(
            context=ctx,
            matches=[],
            skipped=0,
            filtered=market_rows,
            source_errors=source_errors,
            source_empty=source_empty,
            hidden=hidden_count,
        )
    if not hits and hidden_count:
        # Everything left was hidden by the user's own choices. "None posted in
        # the last N days" would be false, and the page must be able to say how
        # many it hid and offer them back, so this is a 200, like the rows above.
        return JobSearchResult(
            context=ctx,
            matches=[],
            skipped=0,
            source_errors=source_errors,
            source_empty=source_empty,
            hidden=hidden_count,
        )
    if not hits and mode_removed:
        # Every posting left after the date and keyword tiers states a work mode the
        # user did not pick. "None posted in the last N days" would be false.
        raise NoResultsError(
            "Found jobs, but every one of them says it's a work mode you didn't pick. "
            "Add work modes under 'Customize search' and try again."
        )
    if not hits:  # boards answered, but only with old postings that don't match the keywords
        raise NoResultsError(
            f"Found jobs, but none posted in the last {ctx.max_age_days} days — and the "
            "older ones don't match your keywords. Loosen 'Posted within' or adjust the "
            "keywords under 'Customize search' and try again."
        )

    # The market memory, read ONCE, here, on the main thread — after the hits
    # are chosen (so it is one query for exactly the postings we will classify)
    # and BEFORE the scoring pool.
    #
    # THE ORDER IS THE WHOLE TRAP. The caller writes this run's sightings AFTER
    # the search returns, beside `record_search_hits`. Recording before reading
    # would stamp every posting `first_seen_at = now` and then hand it its own
    # stamp back, so every posting in every search would be "first seen today",
    # `long_open` could never fire, and the feature would ship green and inert —
    # the 21.7 failure mode, a check that passes by never firing. Read, then
    # classify, then write.
    #
    # ONE call rather than one per hit: `load_sightings` is a single query in
    # the caller, and a pool worker must never touch the Session.
    #
    # A hit whose `content_key` is "" is deliberately NOT looked up. That ""
    # means "never merge this" (the title or the company is missing), so using
    # it as a memory key would fuse every title-less posting on a board into ONE
    # row and then report an unrelated posting's age as this one's. An absent
    # sighting makes the classifier abstain, which is the safe direction; a
    # shared one makes it confidently wrong.
    #
    # LABEL ONLY, NEVER SELECTION: the sighting's `first_posted_at` can mark a
    # selected posting "older" (see `_build_match`), but it is read here, after
    # `select_hits`, so it can never move a posting between tiers. Its precision
    # is unmeasured — two concurrent openings with one title at one company
    # share a content_key — and a soft signal only badges, never demotes.
    sightings: dict[tuple[str, str], Sighting] = {}
    if sightings_fn is not None:
        keys = sorted({(h.source, ck) for h in hits if (ck := content_key(h.title, h.company))})
        try:
            sightings = sightings_fn(keys) if keys else {}
        except Exception:  # noqa: BLE001 - see below
            # The sighting is bookkeeping feeding an ADVISORY signal, and the
            # rule `usage.record_tokens` and `users.touch_last_seen` already
            # follow applies: bookkeeping may never turn a served request into
            # an error. A cold Neon connection must not turn a working search
            # into a 502 over a badge. Note the cost honestly: if this table is
            # permanently unreachable, `long_open` and `reposted` silently never
            # fire and nothing on the page says so.
            sightings = {}

    # Scoring stage: fetch + score concurrently — each job is ONE merged JD_FIT
    # LLM call (analyze_and_score) instead of the old analyze_jd + fit_score
    # pair. Detail fetches to the SAME board stay serialized and throttled via
    # a per-source lock; boards that inline the description never fetch at all.
    matches_by_hit: list[JobMatch | None] = [None] * len(hits)
    # Index-addressed like matches_by_hit, and for the same reason: a shared
    # list append would need progress_lock, which already holds an SSE queue put.
    geo_by_hit: list[GeoRestriction | None] = [None] * len(hits)
    # Same shape, same reason. Kept as its OWN list rather than folded into
    # geo_by_hit: the two answer different questions about the posting ("can
    # this reader work it" vs "is it a live vacancy at all"), a posting can
    # carry either, both or neither, and `filtered` has to be able to say which.
    ghost_by_hit: list[GhostReport | None] = [None] * len(hits)
    # Same shape, same reason: (reason, reading) for a posting the work-mode gate
    # removed after its text arrived, None for every other.
    mode_by_hit: list[tuple[str, WorkModeReading] | None] = [None] * len(hits)
    fetch_locks: dict[str, threading.Lock] = {h.source: threading.Lock() for h in hits}
    last_fetch: dict[str, float] = {}
    scored_done = 0
    score_errors: list[str] = []  # why individual jobs were skipped (see _score_hit)

    def _fetch_throttled(hit: JobHit) -> str:
        with fetch_locks[hit.source]:
            wait = FETCH_DELAY_S - (time.monotonic() - last_fetch.get(hit.source, float("-inf")))
            if wait > 0:
                time.sleep(wait)  # polite gap between fetches to the same board
            try:
                return PROVIDERS[hit.source].fetch_description(hit)
            finally:
                last_fetch[hit.source] = time.monotonic()

    def _score_hit(hit_i: int, hit: JobHit) -> None:
        """Score one posting. Never raises for a per-job problem.

        A search runs up to 25 concurrent LLM calls, so hitting one transient
        failure — a 500 the SDK's two retries didn't cover, JSON mangled enough
        to fail JDModel validation, a board that hangs mid-fetch — is not a rare
        event. Letting it propagate discarded every OTHER job that had already
        scored fine and returned a 502 for the whole search. It's now recorded
        and the job is left out, which is exactly the `skipped` case the result
        already reports. The reasons are kept so an ALL-failed search can say
        what actually went wrong instead of blaming the boards for throttling.
        """
        nonlocal scored_done
        geo: GeoRestriction | None = None
        ghost: GhostReport | None = None
        mode: tuple[str, WorkModeReading] | None = None
        try:
            match, geo, ghost, mode = _build_match(hit)
        except Exception as e:  # noqa: BLE001 - one bad posting must not sink the search
            match = None
            with progress_lock:
                score_errors.append(f"{hit.title or hit.url}: {e}")
        geo_by_hit[hit_i] = geo
        ghost_by_hit[hit_i] = ghost
        mode_by_hit[hit_i] = mode
        if match is not None:
            matches_by_hit[hit_i] = match
        with progress_lock:
            scored_done += 1
            notify(
                {
                    "stage": "scoring",
                    "index": scored_done,
                    "total": len(hits),
                    "title": hit.title,
                    "company": hit.company,
                }
            )
            if match is not None:  # incremental result (PLAN 12.2) — the SSE
                # endpoint forwards this as its own `match` frame
                notify(
                    {
                        "stage": "match",
                        "index": scored_done,
                        "total": len(hits),
                        "match": match.model_dump(),
                    }
                )

    def _build_match(
        hit: JobHit,
    ) -> tuple[
        JobMatch | None, GeoRestriction | None, GhostReport | None, tuple[str, WorkModeReading] | None
    ]:
        """(match, geo_restriction, ghost, work_mode). A blocking restriction
        returns (None, geo, …), a CLOSED posting (None, …, ghost, None), and a
        posting whose words fail the work-mode gate (None, …, (reason, reading)) —
        a VALUE,
        never an exception: `_score_hit`'s contract turns a raise into
        `score_errors`, which surfaces as "couldn't score any of them" and would
        blame the boards for a posting we deliberately dropped. Both reports are
        returned even when the match is not, because `filtered` has to show the
        user WHAT we fired on."""
        cached = (cache or {}).get(hit.url.rstrip("/"))
        sighting = sightings.get((hit.source, content_key(hit.title, hit.company)))
        match: JobMatch | None = None
        geo: GeoRestriction | None = None
        ghost: GhostReport | None = None
        mode: tuple[str, WorkModeReading] | None = None
        # THE "OLDER" LABEL, computed ONCE, above both branches, because the
        # cache branch is the one that gets forgotten (it does no work, so
        # nothing in it looks like it needs a date).
        #
        # `first_posted_at` is the earliest date a BOARD stated for this role:
        # this card, Greenhouse's `first_published`, or an earlier listing of
        # the same source + title|company in the current sighting run — never
        # `first_seen_at`, our own lower bound. A relisted role keeps its
        # original date, so the email says "older posting — 2026-09-07" rather
        # than the relist's "2026-09-20".
        #
        # `hit.stale or …` is monotone: the relabel can only ADD the flag the
        # tiering set, never clear it, and it runs after selection, so it moves
        # nothing between tiers. With max_age_days=0 `posted_within` is always
        # True, and an undated role (`""`) is never labelled older.
        full_hit = cached is not None and cached.is_full_match
        card_date = hit.posted_at or (cached.posted_at if full_hit else "")
        first_posted_at = earliest_board_date(card_date, hit.raw, sighting, twins=tuple(hit.twin_posted))
        stale = hit.stale or not posted_within(first_posted_at, ctx.max_age_days, now)
        if cached is not None and cached.is_full_match:
            # Tier 1 (PLAN 12.4): this exact posting was scored against this
            # exact resume within the TTL — rebuild the match from the history
            # row with zero LLM calls and zero network fetch. The FRESH hit's
            # card fields win where the board provided them (the board is
            # authoritative for title/company/location/posted_at/logo_url);
            # scores/keywords/jd_text come from the row.
            #
            # This branch skips the fetch AND the LLM, so nothing in it looks
            # like work — which is exactly why the classifier has to run here
            # too. Without it a posting scored last week launders straight
            # through unclassified.
            geo = _geo_for(hit, cached.jd_text, hit.location or cached.location)
            if geo is not None and geo.blocking:
                return None, geo, ghost, mode
            # The ghost classifier is here for the identical reason, and it is
            # the branch that gets forgotten precisely because it does no work.
            # The wording rules and the sighting-based age read fine off cached
            # text: an evergreen "talent pool" posting was evergreen last week
            # too, and `long_open` gets STRONGER with age, never weaker.
            #
            # THE HONEST GAP: this branch cannot observe CLOSURE. `hit.closed`
            # is set by `fetch_description`, which is exactly what this branch
            # skips, so a posting that died since it was last scored still ranks
            # here with no closed signal. That is a known gap, and it is
            # deliberately NOT fixed by adding a liveness fetch: this branch's
            # whole purpose is not fetching (PLAN 12.4 — zero LLM calls, zero
            # network), and a HEAD request per cached hit would spend the exact
            # budget the cache exists to save, on every search, to catch the
            # minority of postings that closed inside the TTL. The cache TTL is
            # the bound on how stale this can be.
            ghost = _ghost_for(hit, cached.jd_text, sighting, now)
            # The work-mode gate is here for the same reason as both classifiers
            # above: a posting scored last week says "hybrid" this week too, and
            # a cached hit must not launder past the user's own filter.
            mode = _work_mode_gate(hit, cached.jd_text, ctx.work_mode)
            if mode is not None:
                return None, geo, ghost, mode
            match = JobMatch(
                title=hit.title or cached.title,
                company=hit.company or cached.company,
                overall=cached.overall,
                keyword_coverage=cached.keyword_coverage,
                fit_score=cached.fit_score,
                top_matched=list(cached.top_matched),
                top_gaps=list(cached.top_gaps),
                jd_text=cached.jd_text,
                url=hit.url,
                location=hit.location or cached.location,
                posted_at=card_date,
                first_posted_at=first_posted_at,
                twin_posted_at=list(hit.twin_posted),
                work_modes=_stated_modes(hit, cached.jd_text),
                source=hit.source,
                logo_url=hit.logo_url or cached.logo_url,
                also_on=[AlsoOn(**a) for a in hit.also_on],
                salary=extract_salary(cached.jd_text),
                geo_restriction=geo,
                ghost=ghost,
                stale=stale,
            )
        else:
            # Tier 2: a fresh row for a DIFFERENT resume still spares the
            # description fetch (and its politeness throttle) — the posting's
            # text hasn't changed; only the scoring must rerun.
            jd_text = hit.description or (cached.jd_text if cached else "") or _fetch_throttled(hit)
            if jd_text:
                # Before analyze_and_score, never after: this is the only seam
                # where every code path has the text in hand and no model call
                # has been made, so a blocking posting costs zero tokens.
                geo = _geo_for(hit, jd_text, hit.location)
                if geo is not None and geo.blocking:
                    return None, geo, ghost, mode
                # Ghost second, and the closure gate BEFORE analyze_and_score
                # for the same reason the geo gate sits above it: this is the
                # only seam where every code path holds the text and no model
                # call has been made, so a posting the board itself says is
                # dead costs zero tokens. `hit.closed` was filled by the fetch
                # a few lines up — this is the one branch that can observe it.
                ghost = _ghost_for(hit, jd_text, sighting, now)
                if ghost is not None and ghost.closed:
                    return None, geo, ghost, mode
                # Third, and still before the model: the posting's own words about
                # where the work happens, read in full now that the text is here.
                mode = _work_mode_gate(hit, jd_text, ctx.work_mode)
                if mode is not None:
                    return None, geo, ghost, mode
                jd, score = analyze_and_score(resume, jd_text)
                top_matched, top_gaps = top_matched_and_gaps(score.gaps)
                match = JobMatch(
                    # The board's own card/record is authoritative for title/company;
                    # the LLM's JD extraction only fills in when the board lacks them.
                    title=hit.title or jd.job_title,
                    company=hit.company or jd.company,
                    overall=score.overall,
                    keyword_coverage=score.keyword_coverage,
                    fit_score=score.fit_score,
                    top_matched=top_matched,
                    top_gaps=top_gaps,
                    jd_text=jd_text,
                    url=hit.url,
                    location=hit.location,
                    posted_at=card_date,
                    first_posted_at=first_posted_at,
                    twin_posted_at=list(hit.twin_posted),
                    work_modes=_stated_modes(hit, jd_text),
                    source=hit.source,
                    logo_url=hit.logo_url,
                    also_on=[AlsoOn(**a) for a in hit.also_on],
                    salary=extract_salary(jd_text),
                    geo_restriction=geo,
                    ghost=ghost,
                    stale=stale,
                )
        return match, geo, ghost, mode

    with ThreadPoolExecutor(max_workers=SCORE_WORKERS) as pool:
        # copy_context() per submit, not a bare submit: a pool worker starts
        # from an EMPTY context, so the request's LLM token tally (PLAN 20.8/N2)
        # would be invisible here — and this loop is the single biggest token
        # spender in the app. A fresh copy each time because one Context cannot
        # be entered from two threads at once. The tally itself is mutable and
        # shared by reference, so the workers' usage lands on the request's.
        score_futures = [
            pool.submit(copy_context().run, _score_hit, i, hit) for i, hit in enumerate(hits)
        ]
    for future in score_futures:
        # _score_hit swallows per-job failures by design, so this only re-raises
        # a bug in the wrapper itself — which is exactly what should still be loud.
        future.result()

    # hits order survives (matches_by_hit is index-addressed), so the sort below
    # stays stable across ties exactly as the serial append-then-sort was.
    matches = [m for m in matches_by_hit if m is not None]
    # WHY each posting was deliberately removed, one answer per hit, "" for
    # "it wasn't". Computed once and read TWICE — by `filtered` below and by the
    # score_errors re-attribution further down — because those two ask the same
    # question ("is this missing match a decision or a failure?") and a second
    # copy of the rule is check-mirrors 1's defect in Python: the closed case
    # gets added to one and forgotten in the other, and a genuinely broken
    # posting silently loses its diagnostic.
    #
    # A posting can trip BOTH gates, and GEO WINS. It is the more specific claim
    # about the READER — "this posting says it will not hire someone where you
    # are" is a fact about them, which nothing else on the page tells them —
    # while "closed" is a fact about the posting that is equally true for
    # everyone; and a card headed "no longer accepting applications" would let
    # the user file the removal under bad luck when what we actually found was a
    # hiring restriction they may want to appeal (they hold a second passport;
    # the sponsorship question lives in the form). Both REPORTS ride along on
    # the row either way, so nothing is hidden by the choice of heading.
    #
    # This is written as ONE reason per hit rather than two concatenated
    # comprehensions on purpose: two lists would emit TWO rows for a posting
    # that trips both, and `filtered` would report more removals than there
    # were removed hits while `skipped` below counted them once. Today's order
    # in `_build_match` (geo returns before ghost is even classified) makes the
    # overlap unreachable — the rule is written down anyway so a future
    # reordering cannot resurrect that double count silently.
    #
    # The work-mode reasons come LAST: "this posting says it will not hire you
    # where you are" and "this posting is dead" are both stronger facts than "it
    # says hybrid". `_build_match` never reaches the gate after either, so the
    # overlap is unreachable today; the order is written down for the same reason
    # as geo's.
    filter_reasons = [
        "restriction"
        if geo is not None and geo.blocking
        else "closed"
        if ghost is not None and ghost.closed
        else mode[0]
        if mode is not None
        else ""
        for geo, ghost, mode in zip(geo_by_hit, ghost_by_hit, mode_by_hit)
    ]
    filtered = [
        FilteredJob(
            title=hits[i].title,
            company=hits[i].company,
            location=hits[i].location,
            url=hits[i].url,
            source=hits[i].source,
            posted_at=hits[i].posted_at,
            logo_url=hits[i].logo_url,
            geo_restriction=geo_by_hit[i],
            ghost=ghost_by_hit[i],
            reason=reason,
            work_modes=_stated(mode_by_hit[i]),
            work_mode_evidence=mode_by_hit[i][1].evidence if mode_by_hit[i] else "",
        )
        for i, reason in enumerate(filter_reasons)
        if reason
    ]
    # `skipped` keeps its documented meaning — "listings found but not
    # fetchable/scorable". A geo-filtered posting was perfectly fetchable; it
    # gets its own list, and folding the two would make the UI's skipped string
    # a lie.
    #
    # A CLOSED posting was fetchable too — more so than any other row here: we
    # know it is closed BECAUSE we fetched it and the board said so in its own
    # words. So it joins `filtered` under its own `reason` rather than inflating
    # `skipped`, which would tell the user the boards were throttling us at the
    # exact moment we had the clearest possible answer from one. The arithmetic
    # survives the second kind because `filter_reasons` holds at most one
    # reason per hit by construction (see above).
    #
    # It subtracts the per-hit REASONS, never `len(filtered)`, and the market
    # rows join `filtered` only AFTER it: a market row was never in `hits`, so
    # counting it here would push `skipped` one lower per hidden posting, and
    # below zero on a morning of Bulgarian cards.
    skipped = len(hits) - len(matches) - sum(1 for reason in filter_reasons if reason)
    filtered = filtered + market_rows

    if not matches and any(filter_reasons):
        # Nothing ranked, but a SELECTED posting was filtered. Return the 200
        # with the filtered list rather than raising: this is the maximum-
        # suspicion case, the one where the user most needs to read what we
        # fired on — and the throttling message below would send them to re-run
        # a search that fails identically. The only existing contract this
        # design changes.
        #
        # It needs a PER-HIT reason, and market rows alone never make one. A
        # market row describes a posting that was never selected, so it cannot
        # answer for the ones that were: when every selected posting failed to
        # fetch or to score, the search raises below exactly as it would with
        # nothing hidden. That raise is `alerts.run_alert`'s only error channel.
        # As a 200 it wrote `last_error = ""` and `last_above_min = 0` (a
        # measured "none cleared") for a morning where nothing was scored, and a
        # fetch failure leaves no `score_errors` to attribute, so the Jobs page
        # showed no warning either. The market rows go with that raise; the
        # failure is the truer answer. A search whose every posting was hidden
        # before selection already returned its 200 above, where nothing was
        # selected that could fail. With a per-hit reason present, the market
        # rows ride along in this 200.
        #
        # A morning where every posting the boards returned has closed is
        # exactly as much a "we removed these on purpose, here they are" answer
        # as a morning where every one states a hiring restriction — and
        # raising would destroy the list in both. This
        # function states no reason of its own: the response carries
        # `filtered[i].reason` and the UI switches on it, so nothing here can
        # tell a user their search was blocked by a hiring restriction when what
        # we actually found was a dead posting.
        #
        # The guard is any per-hit reason, not "everything was filtered", so postings
        # that genuinely broke can be in here too — and their diagnostic must
        # not vanish with the raise we are skipping. Attribute each to the board
        # it came from, which is where the UI already reports board trouble; a
        # scoring failure blamed on nothing at all is how "0 ranked, 9 skipped"
        # becomes an unexplained dead end. `filter_reasons` is what separates a
        # decision from a failure here, and it is the SAME list `filtered` was
        # built from — testing `geo_by_hit[i] is None` alone would re-attribute
        # every closed posting as a board error and put a scary board message
        # under a row that says, correctly, "no longer accepting applications".
        if score_errors:
            for i, m in enumerate(matches_by_hit):
                if m is None and not filter_reasons[i]:
                    source_errors.setdefault(hits[i].source, score_errors[0])
        return JobSearchResult(
            context=ctx,
            matches=[],
            skipped=skipped,
            filtered=filtered,
            source_errors=source_errors,
            source_empty=source_empty,
            hidden=hidden_count,
        )

    if not matches:
        if score_errors:
            # Say what actually broke. Blaming board throttling when every job
            # died on the model sends the user to re-run a search that will fail
            # the same way.
            raise ValueError(
                f"Found {len(hits)} jobs but couldn't score any of them — {score_errors[0]}"
            )
        raise ValueError(
            "Found jobs but couldn't fetch any of their descriptions (the boards may be "
            "throttling). Try again shortly or lower the result count."
        )
    matches.sort(key=lambda m: m.overall, reverse=True)
    return JobSearchResult(
        context=ctx,
        matches=matches,
        skipped=skipped,
        filtered=filtered,
        source_errors=source_errors,
        source_empty=source_empty,
        hidden=hidden_count,
    )
