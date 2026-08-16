"""Per-request LLM token accounting (PLAN 20.8 / N2).

The daily caps count REQUESTS, which is a poor proxy for money: tailoring a
126-project master and writing a follow-up email are both "one action" and
differ by orders of magnitude. The OpenAI SDK hands back `resp.usage` on every
call and `OpenAIClient` was throwing it away.

Shape: a request opens a `meter()`, every LLM call inside it reports into the
tally through `record()`, and the route's dependency writes the total onto the
user's `UsageLog` row when the request finishes. The client stays
provider-agnostic — it reports numbers and knows nothing about users or the DB.

THREADS. The tally lives in a ContextVar, and a ContextVar is per-context, not
global — so the job search's scoring pool would see an empty one and silently
drop the tokens from the single biggest spender in the app. Two things make it
work: the tally is a MUTABLE object (a copied context shares the same instance,
so a worker's writes land on the request's tally), and `job_search` submits its
scoring work through `copy_context().run` so each worker starts from the
request's context rather than a blank one. `Context.run` cannot be entered from
two threads at once, hence a fresh copy per submit rather than one shared copy.
"""
from __future__ import annotations

import threading
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Iterator


@dataclass
class TokenTally:
    """Running total for one request. Mutated from worker threads, so locked."""

    prompt: int = 0
    completion: int = 0
    calls: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add(self, prompt: int, completion: int) -> None:
        with self._lock:
            self.prompt += max(0, prompt)
            self.completion += max(0, completion)
            self.calls += 1

    @property
    def total(self) -> int:
        return self.prompt + self.completion


_current: ContextVar[TokenTally | None] = ContextVar("llm_token_tally", default=None)


@contextmanager
def meter() -> Iterator[TokenTally]:
    """Collect the token usage of every LLM call made inside this block."""
    tally = TokenTally()
    token = _current.set(tally)
    try:
        yield tally
    finally:
        _current.reset(token)


def record(prompt: int, completion: int) -> None:
    """Report one call's usage. A no-op outside a `meter()` — background work
    (the alert cron, the kit drain) is not attributed to a live request, and
    metering must never be the thing that breaks an LLM call."""
    tally = _current.get()
    if tally is not None:
        tally.add(prompt, completion)


@contextmanager
def bind(tally: TokenTally) -> Iterator[TokenTally]:
    """Make an EXISTING tally current, for work that outlives a request's
    dependency scope. The SSE search is the case: it hands back a
    StreamingResponse immediately and does its LLM calls in a worker thread
    afterwards, so there is no dependency teardown left to read a tally from."""
    token = _current.set(tally)
    try:
        yield tally
    finally:
        _current.reset(token)


def current_tally() -> TokenTally | None:
    """The tally in scope, if any. For tests and for the SSE path, which has to
    read the total after its streaming generator finishes rather than at the
    point the dependency's teardown would normally run."""
    return _current.get()
