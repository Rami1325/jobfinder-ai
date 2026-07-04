"""Jooble provider (official affiliate REST API — free per-account key,
https://jooble.org/api/about).

`POST https://il.jooble.org/api/{key}` with `{"keywords", "location", "page"}`
returns `{"totalCount", "jobs": [{title, location, snippet, salary, source,
type, link, company, updated, id}]}` (shape per the official docs). The API
key comes from `JOOBLE_API_KEY` in .env; without one the provider raises a
clear ValueError so the fan-out reports it in `source_errors` instead of
crashing the whole search.

Jooble is an aggregator: results carry only a snippet, so this is a
scrape-style board — `JobHit.description` stays empty and `fetch_description`
runs the hit's URL through the generic `fetch_description_via_url` path,
falling back to the snippet when the underlying page won't give up its text.

Politeness: it's an official API, but we still cap at two pages per search.

`parse_jooble_results` is a pure function pinned by the offline smoke test
against the official docs' example response (tests/fixtures/jooble_search.json
— live fixture pending an API key; see PLAN 2.5).
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

from app.config import get_settings
from app.core.job_match import _html_to_text
from app.core.lang import detect_language
from app.core.providers.base import JobHit, fetch_description_via_url
from app.models import SearchContext

_API_URL = "https://il.jooble.org/api/{key}"
_TIMEOUT_S = 30
_MAX_PAGES = 2  # politeness cap, same spirit as the scrape boards
_PAGE_DELAY_S = 0.5


def _http_post_json(url: str, payload: dict, timeout: float = _TIMEOUT_S) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - fixed API host
        data = json.loads(resp.read(3_000_000).decode("utf-8", errors="ignore"))
    return data if isinstance(data, dict) else {}


def parse_jooble_results(data: dict) -> list[JobHit]:
    """Parse one API response into JobHits, deduped by Jooble id, order
    preserved. Descriptions stay empty (Jooble returns snippets only, stored
    in `raw` as the detail-fetch fallback). Pure function pinned by the smoke
    test against the official docs' example response."""
    hits: list[JobHit] = []
    seen: set[str] = set()
    for job in data.get("jobs") or []:
        if not isinstance(job, dict):
            continue
        url = str(job.get("link") or "").strip()
        if not url:
            continue
        key = str(job.get("id") or "").strip() or url
        if key in seen:
            continue
        seen.add(key)

        title = str(job.get("title") or "").strip()
        snippet = _html_to_text(str(job.get("snippet") or ""))
        # "2023-09-15T12:55:35.3870000" — trim the 7-digit fraction to plain
        # ISO seconds so downstream Date parsing can't choke on it.
        updated = str(job.get("updated") or "").strip()
        posted_at = updated[:19] if len(updated) >= 19 and updated[10:11] == "T" else updated

        hits.append(
            JobHit(
                source="jooble",
                external_id=str(job.get("id") or "").strip(),
                title=title,
                company=str(job.get("company") or "").strip(),
                location=str(job.get("location") or "").strip(),
                description="",  # snippets only — full text fetched per-hit
                url=url,
                posted_at=posted_at,
                language=detect_language(f"{title} {snippet}"),
                raw=dict(job) | {"snippet_text": snippet},
            )
        )
    return hits


class JoobleProvider:
    """Jooble as a `JobProvider` (see base.py). Scrape-style: the API returns
    snippets only, so full postings go through the generic URL-fetch path."""

    name = "jooble"

    def search(self, ctx: SearchContext) -> list[JobHit]:
        api_key = get_settings().jooble_api_key.strip()
        if not api_key:
            raise ValueError(
                "Jooble needs an API key — set JOOBLE_API_KEY in backend/.env "
                "(free key at jooble.org/api/about)."
            )
        if not ctx.job_title.strip():
            raise ValueError("Jooble search needs a job title.")

        url = _API_URL.format(key=api_key)
        hits: list[JobHit] = []
        seen: set[str] = set()
        for page in range(1, _MAX_PAGES + 1):
            if page > 1:
                time.sleep(_PAGE_DELAY_S)
            payload = {
                "keywords": ctx.job_title.strip(),
                "location": ctx.location.strip(),
                "page": page,
            }
            try:
                data = _http_post_json(url, payload)
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):
                    raise ValueError(
                        "Jooble rejected the API key. Check JOOBLE_API_KEY in backend/.env."
                    ) from e
                if page == 1:
                    raise ValueError(
                        "Couldn't reach Jooble's API. Try again in a minute."
                    ) from e
                break
            except Exception as e:  # noqa: BLE001 - network trouble; page 2 is optional
                if page == 1:
                    raise ValueError(
                        "Couldn't reach Jooble's API. Check your connection and try again."
                    ) from e
                break
            page_hits = parse_jooble_results(data)
            if not page_hits:
                break
            for hit in page_hits:
                key = hit.external_id or hit.url
                if key in seen:
                    continue
                seen.add(key)
                hits.append(hit)
            if len(hits) >= ctx.limit:
                break
        if not hits:
            where = f" in '{ctx.location}'" if ctx.location.strip() else ""
            raise ValueError(
                f"No Jooble jobs found for '{ctx.job_title}'{where}. "
                "Check 'Customize search' and adjust the title or location."
            )
        return hits[: ctx.limit]

    def fetch_description(self, hit: JobHit) -> str:
        snippet = str(hit.raw.get("snippet_text") or "") if isinstance(hit.raw, dict) else ""
        try:
            text = fetch_description_via_url(hit)
        except Exception:  # noqa: BLE001 - login walls / dead redirects raise here
            return snippet
        # A snippet still scores better than dropping the job entirely.
        return text or snippet
