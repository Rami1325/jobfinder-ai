"""Multi-source job search: fan out to job-board providers, rank by résumé fit.

Search context (what title, where) is derived from the résumé automatically via
the SEARCH_CONTEXT LLM task, with a deterministic fallback; the user can override
any field, including which boards to search (`SearchContext.sources`, validated
against the provider registry). Each board lives in `app.core.providers`; one
broken/blocked board degrades the search (reported via `source_errors`) instead
of sinking it — the search only fails when every selected board fails.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta

from app.core.jd_analyzer import analyze_jd

# Re-exported for the smoke test and any older callers: the LinkedIn card parser
# and URL builder are pure functions pinned by tests/smoke_test.py.
from app.core.providers import DEFAULT_SOURCES, PROVIDERS, JobHit
from app.core.providers.linkedin import (  # noqa: F401 - re-exports
    _build_search_url,
    parse_search_results,
)
from app.core.scorer import score_resume
from app.llm import prompts
from app.llm.client import get_llm_client
from app.models import JobMatch, JobSearchResult, ResumeModel, SearchContext

MAX_JOBS = 25
MAX_AGE_DAYS_CAP = 365
FETCH_DELAY_S = 0.5  # pause between per-job network fetches to stay under the radar


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
    ctx = derive_search_context(resume)
    if customize is not None:
        if customize.job_title.strip():
            ctx.job_title = customize.job_title.strip()
        if customize.location.strip():
            ctx.location = customize.location.strip()
        if customize.work_mode in ("any", "onsite", "remote", "hybrid"):
            ctx.work_mode = customize.work_mode
        ctx.limit = customize.limit
        ctx.sources = customize.sources
        ctx.max_age_days = customize.max_age_days
    # Unknown board names are ignored; an empty (or all-unknown) selection falls
    # back to every registered provider so old clients keep working unchanged.
    ctx.sources = [s for s in ctx.sources if s in PROVIDERS] or list(DEFAULT_SOURCES)
    ctx.limit = max(1, min(MAX_JOBS, ctx.limit))
    ctx.max_age_days = max(0, min(MAX_AGE_DAYS_CAP, ctx.max_age_days))
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


def _interleave_and_dedupe(hits_by_source: dict[str, list[JobHit]], limit: int) -> list[JobHit]:
    """Round-robin merge across sources (so one board can't crowd out the
    others), deduped by URL, capped at `limit`. Source order follows the
    context's `sources` order; within a source hits arrive newest-first
    (see `freshest_first`)."""
    merged: list[JobHit] = []
    seen: set[str] = set()
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
        merged.append(hit)
    return merged


def search_jobs(
    resume: ResumeModel, customize: SearchContext | None = None
) -> JobSearchResult:
    ctx = _resolve_context(resume, customize)
    if not ctx.job_title:
        raise ValueError(
            "Couldn't derive a job title from your résumé. "
            "Check 'Customize search' and enter one."
        )

    hits_by_source: dict[str, list[JobHit]] = {}
    source_errors: dict[str, str] = {}
    for name in ctx.sources:
        try:
            hits_by_source[name] = freshest_first(
                PROVIDERS[name].search(ctx), ctx.max_age_days
            )
        except ValueError as e:  # board-level, user-facing message
            source_errors[name] = str(e)
        except Exception:  # noqa: BLE001 - a buggy provider must not sink the rest
            source_errors[name] = f"Searching {name} failed unexpectedly. Try again shortly."
    if not hits_by_source:
        raise ValueError(
            "All job boards failed: "
            + " · ".join(f"{name}: {msg}" for name, msg in source_errors.items())
        )

    hits = _interleave_and_dedupe(hits_by_source, ctx.limit)
    if not hits:  # every board answered, but only with postings older than the cutoff
        raise ValueError(
            f"Found jobs, but none posted in the last {ctx.max_age_days} days. "
            "Loosen 'Posted within' under 'Customize search' and try again."
        )

    matches: list[JobMatch] = []
    skipped = 0
    network_fetches = 0
    for hit in hits:
        jd_text = hit.description
        if not jd_text:  # scrape-style board — fetch the posting, politely throttled
            if network_fetches:
                time.sleep(FETCH_DELAY_S)
            network_fetches += 1
            jd_text = PROVIDERS[hit.source].fetch_description(hit)
        if not jd_text:
            skipped += 1
            continue
        jd = analyze_jd(jd_text)
        score = score_resume(resume, jd)
        top_gaps = [g.keyword for g in score.gaps if g.status != "covered"][:6]
        matches.append(
            JobMatch(
                # The board's own card/record is authoritative for title/company;
                # the LLM's JD extraction only fills in when the board lacks them.
                title=hit.title or jd.job_title,
                company=hit.company or jd.company,
                overall=score.overall,
                keyword_coverage=score.keyword_coverage,
                fit_score=score.fit_score,
                top_gaps=top_gaps,
                jd_text=jd_text,
                url=hit.url,
                location=hit.location,
                posted_at=hit.posted_at,
                source=hit.source,
                logo_url=hit.logo_url,
            )
        )

    if not matches:
        raise ValueError(
            "Found jobs but couldn't fetch any of their descriptions (the boards may be "
            "throttling). Try again shortly or lower the result count."
        )
    matches.sort(key=lambda m: m.overall, reverse=True)
    return JobSearchResult(
        context=ctx, matches=matches, skipped=skipped, source_errors=source_errors
    )


# Backwards-compatible alias from the LinkedIn-only era.
search_linkedin_jobs = search_jobs
