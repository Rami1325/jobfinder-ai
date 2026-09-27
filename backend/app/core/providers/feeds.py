"""Per-company feeds for the registry boards: a cache, one fetch at a time per
company, a memory of failures, and a time budget per search (2026-09-28).

Comeet, Greenhouse, Lever and Ashby have no keyword search: a search pulls
every registered company's whole board and filters it here. Growing the Comeet
registry from 28 to 79 companies roughly tripled the requests one search makes,
so the fan-out that each provider used to build for itself (a fresh 8-worker
pool per query, a 15-minute cache, every failure retried on every query) is one
object per board now, and it does four things the old one did not:

  - ONE FETCH AT A TIME PER COMPANY. A search runs up to five keyword queries
    against one board, one after another, and a company still loading from the
    first query used to be requested again by the second. A fetch in flight is
    shared: the second query waits on the same request.
  - A FAILURE IS REMEMBERED for `fail_ttl_s`. A company whose careers page lost
    its token, or a board that answers 404, cost one request on EVERY query of
    every search (measured 2026-09-28: three dead Comeet pages and Greenhouse's
    moved `sisense` board, 4 requests a search, all failing).
  - A TIME BUDGET. `gather` returns after `budget_s` with what arrived, and the
    slow companies are counted as `late` rather than holding the whole search:
    their requests keep running in this board's pool and land in the cache for
    the next query, so one slow company never stalls a search.
  - A BOUNDED POOL, shared by every search in the process (`workers`), where
    each search used to open its own, so two searches at once never double the
    burst against one board's host.

Pure bookkeeping around the fetch it is handed: no network of its own (every
request is the provider's, through `job_match._http_get`), and the clock is
injectable so the smoke test can age entries without sleeping.
"""
from __future__ import annotations

import dataclasses
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from typing import Callable


def fresh_copy(hit):
    """A cached `JobHit` handed to one search: a new object with its own lists,
    because the fan-out writes on a hit (`origin_market`, `also_on`,
    `twin_posted`, `stale`, `closed`, `applicants`) and the cached one serves
    every later query. `raw` is shared: nothing downstream writes to it."""
    return dataclasses.replace(hit, also_on=[], twin_posted=[])


@dataclass
class Gathered:
    """What one `gather` found: each answering company's value by key, how many
    failed (now, or remembered from a recent failure), and how many were still
    loading when the budget ran out."""

    values: dict = field(default_factory=dict)
    failed: int = 0
    late: int = 0


class CompanyFeeds:
    def __init__(
        self,
        name: str,
        *,
        workers: int,
        ttl_s: float,
        fail_ttl_s: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.name = name
        self.workers = workers
        self.ttl_s = ttl_s
        self.fail_ttl_s = fail_ttl_s
        self.clock = clock
        self._lock = threading.Lock()
        self._fresh: dict[str, tuple[float, object]] = {}
        self._failed: dict[str, float] = {}
        self._inflight: dict[str, Future] = {}
        # When each fetch in flight started, on the REAL clock (the budget is
        # wall time, whatever clock the cache ages on).
        self._started: dict[str, float] = {}
        self._pool: ThreadPoolExecutor | None = None

    def _executor(self) -> ThreadPoolExecutor:
        if self._pool is None:
            self._pool = ThreadPoolExecutor(max_workers=self.workers, thread_name_prefix=f"{self.name}-feed")
        return self._pool

    def clear(self) -> None:
        """Forget every cached value and failure (the smoke test, and a probe)."""
        with self._lock:
            self._fresh.clear()
            self._failed.clear()

    def cached(self, key: str) -> object | None:
        """The fresh cached value for `key`, or None."""
        with self._lock:
            hit = self._fresh.get(key)
            if hit is not None and self.clock() - hit[0] < self.ttl_s:
                return hit[1]
        return None

    def _run(self, key: str, fetch: Callable[[], object]) -> object:
        try:
            value = fetch()
        except BaseException:
            with self._lock:
                self._failed[key] = self.clock()
                self._inflight.pop(key, None)
                self._started.pop(key, None)
            raise
        with self._lock:
            self._fresh[key] = (self.clock(), value)
            self._failed.pop(key, None)
            self._inflight.pop(key, None)
            self._started.pop(key, None)
        return value

    def gather(self, jobs: list[tuple[str, Callable[[], object]]], budget_s: float) -> Gathered:
        """Every company's value, from the cache or a fetch, within `budget_s`.

        `jobs` is (key, fetch) per company; `fetch` raises on failure. Never
        raises itself: a failure is a count, as the providers already treat it
        (one company must not sink the board).

        NO FETCH IS WAITED ON LONGER THAN `budget_s` AFTER IT STARTED, by any
        caller. A search sends up to five keyword queries to a board one after
        another; a company the first query left `late` is still in flight when
        the second arrives, and waiting the whole budget again on every query
        would make one hung company cost five budgets. The second query waits
        only what is left of that fetch's own budget (usually nothing), while a
        concurrent search that joins a fetch started a second ago still waits
        for it."""
        out = Gathered()
        waiting: dict[str, Future] = {}
        deadline = 0.0
        with self._lock:
            now = self.clock()
            for key, fetch in jobs:
                hit = self._fresh.get(key)
                if hit is not None and now - hit[0] < self.ttl_s:
                    out.values[key] = hit[1]
                    continue
                failed_at = self._failed.get(key)
                if failed_at is not None and now - failed_at < self.fail_ttl_s:
                    out.failed += 1
                    continue
                future = self._inflight.get(key)
                if future is None:
                    self._started[key] = time.monotonic()
                    future = self._executor().submit(self._run, key, fetch)
                    self._inflight[key] = future
                deadline = max(deadline, self._started.get(key, time.monotonic()) + budget_s)
                waiting[key] = future
        if waiting:
            done, _ = wait(list(waiting.values()), timeout=max(0.0, deadline - time.monotonic()))
            for key, future in waiting.items():
                if future not in done:
                    out.late += 1
                    continue
                try:
                    out.values[key] = future.result()
                except Exception:  # noqa: BLE001 - counted, never raised
                    out.failed += 1
        return out
