"""Multi-source job search: fan out to job-board providers, rank by résumé fit.

Search context (what title, where) is derived from the résumé automatically via
the SEARCH_CONTEXT LLM task, with a deterministic fallback; the user can override
any field, including which boards to search (`SearchContext.sources`, validated
against the provider registry). Each board lives in `app.core.providers`; one
broken/blocked board degrades the search (reported via `source_errors`) instead
of sinking it — the search only fails when every selected board fails.
"""
from __future__ import annotations

import hashlib
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Callable

# Re-exported for the smoke test and any older callers: the LinkedIn card parser
# and URL builder are pure functions pinned by tests/smoke_test.py.
from app.core.providers import DEFAULT_SOURCES, PROVIDERS, JobHit, NoResultsError
from app.core.providers.linkedin import (  # noqa: F401 - re-exports
    _build_search_url,
    parse_search_results,
)
from app.core.relevance import RELEVANT_MIN, title_relevance
from app.core.salary import extract_salary
from app.core.scorer import analyze_and_score, top_matched_and_gaps
from app.llm import prompts
from app.llm.client import get_llm_client
from app.models import AlsoOn, JobMatch, JobSearchResult, ResumeModel, SearchContext

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

# Worldwide-remote opt-in (SearchContext.include_worldwide + work_mode "remote" or "any"):
# extra locations queried on the board(s) with global reach, targeting remote
# roles hiring from high-earning markets. These queries are always remote-only
# regardless of the context's work mode (see _board_queries). "European Union" is a real LinkedIn
# location that covers the high-paying EU markets in one query — keep this list
# short: every entry multiplies the per-board query count by len(job_titles).
WORLDWIDE_REMOTE_LOCATIONS: list[str] = ["United States", "United Kingdom", "European Union"]
WORLDWIDE_BOARD = "linkedin"  # the only registered board with worldwide inventory


def resume_hash(resume: ResumeModel) -> str:
    """Content identity of a résumé: sha256 hex of its canonical JSON. History
    rows stamp it so a later search can tell "same résumé, reuse the scores"
    from "different résumé, rescore" (PLAN 12.4)."""
    return hashlib.sha256(resume.model_dump_json().encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class CachedScore:
    """One fresh history row, ready for reuse in `search_jobs` (PLAN 12.4).

    Built by `app.db.history.load_score_cache`, which owns the freshness (TTL)
    and non-empty-jd_text filters — core just trusts what it's given. When
    `is_full_match` is True the row was scored against the CURRENT résumé, so
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
        if customize.work_mode in ("any", "onsite", "remote", "hybrid"):
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


def _posted_datetime(posted_at: str) -> datetime | None:
    """Lenient parse of a JobHit.posted_at ISO string ('' / junk → None).
    Timezone info is dropped — freshness only needs day granularity."""
    try:
        dt = datetime.fromisoformat(posted_at.strip())
    except ValueError:
        return None
    return dt.replace(tzinfo=None)


def freshest_first(hits: list[JobHit], max_age_days: int, now: datetime | None = None) -> list[JobHit]:
    """Drop hits posted before the cutoff and order the rest newest-first, so
    the per-hit fetch/scoring budget is spent on fresh postings. Hits with no
    parseable date are kept (missing data shouldn't hide a job) but sort last.
    Pure given `now`; pinned by the smoke test."""
    if max_age_days > 0:
        cutoff = (now or datetime.now()) - timedelta(days=max_age_days)
        kept = []
        for hit in hits:
            dt = _posted_datetime(hit.posted_at)
            if dt is None or dt >= cutoff:
                kept.append(hit)
        hits = kept
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
    Pure given `now`; pinned by the smoke test."""
    tiers: list[dict[str, list[JobHit]]] = [{}, {}, {}]
    cutoff = (now or datetime.now()) - timedelta(days=max_age_days) if max_age_days > 0 else None
    for name, hits in hits_by_source.items():
        # Same lexicographic newest-first trick as freshest_first: "" (unknown
        # date) is smallest, so reverse=True puts undated hits last.
        for hit in sorted(hits, key=lambda h: h.posted_at, reverse=True):
            relevant = title_relevance(hit.title, query_titles) >= RELEVANT_MIN
            dt = _posted_datetime(hit.posted_at)
            fresh = cutoff is None or dt is None or dt >= cutoff
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


def _board_queries(name: str, ctx: SearchContext) -> list[tuple[str, str, str]]:
    """(job_title, location, work_mode) triples one board will be queried with —
    normally every keyword against the context's own location and work mode.
    The worldwide-remote opt-in (work_mode "remote"/"any" + include_worldwide)
    adds each high-earning market in WORLDWIDE_REMOTE_LOCATIONS, but ONLY on
    the board with global inventory — the local Israeli boards never see those
    locations. Worldwide queries are always remote-only, even when the context's
    work mode is "any": abroad, only remote roles are workable, while the local
    location keeps the user's mode. A board that joined the fan-out purely for
    the worldwide pass (the user unchecked it in `sources`) skips the local
    location. Pure; pinned by the smoke test."""
    locations = [(ctx.location, ctx.work_mode)] if name in ctx.sources else []
    if name == WORLDWIDE_BOARD and ctx.work_mode in ("remote", "any") and ctx.include_worldwide:
        locations = locations + [(loc, "remote") for loc in WORLDWIDE_REMOTE_LOCATIONS]
    return [
        (t, loc, mode)
        for t in ctx.job_titles
        for loc, mode in (locations or [(ctx.location, ctx.work_mode)])
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
    for query_i, (title, location, work_mode) in enumerate(_board_queries(name, ctx)):
        if query_i:
            time.sleep(FETCH_DELAY_S)  # polite gap between queries to the same board
        query_ctx = ctx.model_copy(
            update={"job_title": title, "location": location, "work_mode": work_mode}
        )
        try:
            board_hits.extend(PROVIDERS[name].search(query_ctx))
        except NoResultsError as e:  # board worked, this query just matched nothing
            board_empty.append(str(e))
        except ValueError as e:  # board-level failure, user-facing message
            board_errors.append(str(e))
        except Exception:  # noqa: BLE001 - a buggy provider must not sink the rest
            board_errors.append(f"Searching {name} failed unexpectedly. Try again shortly.")
    return board_hits, board_errors, board_empty


def search_jobs(
    resume: ResumeModel,
    customize: SearchContext | None = None,
    progress: ProgressFn | None = None,
    cache: dict[str, CachedScore] | None = None,
) -> JobSearchResult:
    """`cache` maps URL-dedupe keys (`url.rstrip("/")` — same key as
    `_interleave_and_dedupe`) to fresh history rows; see CachedScore for the
    two reuse tiers. None/{} means every hit takes the full fetch+score path."""
    notify = progress or (lambda event: None)
    ctx = _resolve_context(resume, customize)
    if not ctx.job_title:
        raise ValueError(
            "Couldn't derive a job title from your résumé. "
            "Check 'Customize search' and enter one."
        )

    # Boards stage: one worker per board — there's no reason LinkedIn should
    # wait for Drushim; within a board queries stay serial (see _search_board).
    # Results are classified in fan-out order so _interleave_and_dedupe's
    # round-robin order stays stable regardless of which board finishes first.
    # The worldwide-remote pass rides the global-reach board's own worker (its
    # extra locations come from _board_queries), so it joins the fan-out even
    # when the user unchecked that board for local results.
    fanout = list(ctx.sources)
    if ctx.include_worldwide and ctx.work_mode in ("remote", "any") and WORLDWIDE_BOARD not in fanout:
        fanout.append(WORLDWIDE_BOARD)
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

    # Relevance-first selection (PLAN 15.6): budget goes to title-relevant
    # postings first, then old-but-relevant backfill (marked stale), then
    # description-only matches. Old + irrelevant stays dropped.
    hits = select_hits(tiered_by_source(hits_by_source, ctx.job_titles, ctx.max_age_days), ctx.limit)
    if not hits:  # boards answered, but only with old postings that don't match the keywords
        raise NoResultsError(
            f"Found jobs, but none posted in the last {ctx.max_age_days} days — and the "
            "older ones don't match your keywords. Loosen 'Posted within' or adjust the "
            "keywords under 'Customize search' and try again."
        )

    # Scoring stage: fetch + score concurrently — each job is ONE merged JD_FIT
    # LLM call (analyze_and_score) instead of the old analyze_jd + fit_score
    # pair. Detail fetches to the SAME board stay serialized and throttled via
    # a per-source lock; boards that inline the description never fetch at all.
    matches_by_hit: list[JobMatch | None] = [None] * len(hits)
    fetch_locks: dict[str, threading.Lock] = {h.source: threading.Lock() for h in hits}
    last_fetch: dict[str, float] = {}
    scored_done = 0

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
        nonlocal scored_done
        cached = (cache or {}).get(hit.url.rstrip("/"))
        match: JobMatch | None = None
        if cached is not None and cached.is_full_match:
            # Tier 1 (PLAN 12.4): this exact posting was scored against this
            # exact résumé within the TTL — rebuild the match from the history
            # row with zero LLM calls and zero network fetch. The FRESH hit's
            # card fields win where the board provided them (the board is
            # authoritative for title/company/location/posted_at/logo_url);
            # scores/keywords/jd_text come from the row.
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
                posted_at=hit.posted_at or cached.posted_at,
                source=hit.source,
                logo_url=hit.logo_url or cached.logo_url,
                also_on=[AlsoOn(**a) for a in hit.also_on],
                salary=extract_salary(cached.jd_text),
                stale=hit.stale,
            )
            matches_by_hit[hit_i] = match
        else:
            # Tier 2: a fresh row for a DIFFERENT résumé still spares the
            # description fetch (and its politeness throttle) — the posting's
            # text hasn't changed; only the scoring must rerun.
            jd_text = hit.description or (cached.jd_text if cached else "") or _fetch_throttled(hit)
            if jd_text:
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
                    posted_at=hit.posted_at,
                    source=hit.source,
                    logo_url=hit.logo_url,
                    also_on=[AlsoOn(**a) for a in hit.also_on],
                    salary=extract_salary(jd_text),
                    stale=hit.stale,
                )
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

    with ThreadPoolExecutor(max_workers=SCORE_WORKERS) as pool:
        score_futures = [pool.submit(_score_hit, i, hit) for i, hit in enumerate(hits)]
    for future in score_futures:
        future.result()  # re-raise the first fetch/LLM failure, like the old serial loop

    # hits order survives (matches_by_hit is index-addressed), so the sort below
    # stays stable across ties exactly as the serial append-then-sort was.
    matches = [m for m in matches_by_hit if m is not None]
    skipped = len(hits) - len(matches)

    if not matches:
        raise ValueError(
            "Found jobs but couldn't fetch any of their descriptions (the boards may be "
            "throttling). Try again shortly or lower the result count."
        )
    matches.sort(key=lambda m: m.overall, reverse=True)
    return JobSearchResult(
        context=ctx,
        matches=matches,
        skipped=skipped,
        source_errors=source_errors,
        source_empty=source_empty,
    )


# Backwards-compatible alias from the LinkedIn-only era.
search_linkedin_jobs = search_jobs
