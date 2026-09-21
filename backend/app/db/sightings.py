"""The market memory: how long a posting has REALLY been open (PLAN 28.3).

Nothing else in this app can answer that question, and `db.history` is exactly
why. `job_search_hits` updates its row IN PLACE and bumps `searched_at` on every
write, so it only ever knows the LAST time we saw a posting; it is capped at the
newest 100 rows per user, so a posting that drops off that tail takes its whole
history with it; and it is per-user, so nothing accumulates across the people
searching the same market. `posting_sightings` outlives all three — one row per
(board, posting fingerprint), `first_seen_at` written once and then left alone.

WHY THERE IS NO `user_id`, and why this table must stay out of `_wipe_user_rows`
------------------------------------------------------------------------------
A row here is posting metadata a BOARD published: which board, the title+company
key, when we first and last saw it, its URLs, a count, and the earliest date the
board itself stated. It is not user content — nothing in it is derived from a
resume, from a search context, or from anything the user typed — it is not
per-user, and several users searching the same market legitimately share one row.

`routes._wipe_user_rows` deletes rows `WHERE model.user_id == user.id` for eight
tables (resumes, resume versions, applications, search history, alerts, usage,
feedback, kits) and additionally clears the two user-content COLUMNS on the
surviving `users` row (`search_prefs_json`, `writing_prefs_json`). This table has
no `user_id`, so it cannot even be expressed in that helper — and wiping it on
any other key would destroy market memory that OTHER users' searches wrote while
saying nothing at all about the person leaving. **Do not add it there.** The
absence of the column is what makes that decision defensible rather than merely
convenient, which is why both halves are smoke-pinned.

THE CONTINUITY RULE, which is why this is not a naive upsert
------------------------------------------------------------
`first_seen_at` means "the start of the CURRENT run", never "the first time we
ever saw this title at this company". When `now - last_seen_at` exceeds
`SIGHTING_GAP_DAYS`, the previous run is OVER: `first_seen_at`, `first_url`,
`first_posted_at` and `seen_count` all reset and `relist_count` goes up by one.
Without it a role that was filled in March and relisted in September reports as
"open 200 days" — a lie in the direction that costs the user a real job, since
`long_open` is what the Jobs card uses to say "don't bother".

`SIGHTING_GAP_DAYS = 21` is **TUNED, NOT MEASURED** (the `_PREFIX_MIN = 5`
precedent), and it has a false-positive case in each direction. Too short and an
ordinary search drought — the owner's alert cron skipped under its wall-clock
budget, a fortnight away from the app, a board that 403s for a week — resets a
posting that never came down, and a genuinely 90-day-old listing reads as new.
Too long and a real relist inherits the dead run's age. 21 days sits above the
longest plausible drought (a two-week holiday plus the weekends either side is
16) and below the shortest interval in which a board realistically takes a role
down, fills or abandons it, and puts it back.

Both public functions take the values the caller already holds and hand back
plain values: `load_sightings` returns frozen `Sighting` dataclasses, never ORM
rows, because the classifier is pure and must never hold a live session object
(a detached instance re-reading an attribute after `db.close()` is the
`DetachedInstanceError` the `last_seen_at` work already paid for once).
"""
from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select, tuple_
from sqlalchemy.orm import Session

# Module-level, not lazy: `app.core.ghost_signals` reaches only `app.models` and
# `app.core.geo_restriction`, and `app.core.job_search` reaches no `app.db`
# module at import time (its two db-backed providers import lazily, inside their
# own functions). `app.db.history` already imports `CachedScore` from
# job_search at module level, so this direction is the established one and was
# re-checked rather than assumed. `search_jobs` stays DB-free by taking a
# `sightings_fn` callable, so nothing points back here.
from app.core.ghost_signals import Sighting, parse_board_date
from app.core.job_search import content_key
from app.db.models import PostingSighting
from app.models import JobMatch

# A gap longer than this ends the run — see the continuity rule above.
SIGHTING_GAP_DAYS = 21
# Rows untouched for this long are deleted inside `record_sightings`, so growth
# is bounded without a second cron to forget about. It cannot evict a posting
# that is still open: every search we see it in stamps `last_seen_at = now`, so
# the sweep only ever reaches postings that have been gone for half a year —
# which are precisely the ones whose age nobody will ever ask about again.
# Growth is one row per distinct posting ever seen (~25/day for one user), so
# this bounds the table rather than tuning it.
SIGHTING_RETENTION_DAYS = 180


def _naive_utc(value: datetime) -> datetime:
    """Normalize to the naive-UTC shape the DateTime columns read back as.

    `datetime.now(timezone.utc)` is AWARE and the column is not, so rows come
    back naive from both SQLite and Neon (the same normalization
    `history.load_score_cache` does for `searched_at`). Subtracting one from the
    other raises `TypeError: can't subtract offset-naive and offset-aware
    datetimes` — and it would raise here, in bookkeeping, after a search has
    already spent 25 LLM calls.

    A naive input is taken AS-IS rather than guessed at: assuming a timezone for
    a naive datetime is how you get a three-hour lie you cannot see. It does not
    matter either way, because every threshold this module owns (21, 180) and
    every threshold the classifier derives from it (30, 60) is in DAYS.
    """
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _key(match: JobMatch) -> tuple[str, str] | None:
    """(source, content_key) for one match, or None when it cannot be filed.

    Two skips, each a guard whose absence writes a row that can only lie:

    * **No URL.** Pasted listings have none (the same skip `record_search_hits`
      makes), and `first_url`/`last_url` are exactly what the `reposted` signal
      compares — a sighting with no URL can never answer the question it exists
      for.
    * **Empty content_key.** `content_key` returns "" when the title or the
      company is missing, because merging on title alone would collapse
      different companies' identical roles. Stored, that one "" row per board
      would fuse every keyless posting into a single sighting whose
      `first_seen_at` is the oldest of them and whose `seen_count` counts
      unrelated jobs — "open 300 days" printed on a posting that went up today.
    """
    if not match.url:
        return None
    key = content_key(match.title or "", match.company or "")
    if not key:
        return None
    return (match.source or "", key)


def load_sightings(
    db: Session,
    keys: Iterable[tuple[str, str]],
    now: datetime | None = None,
) -> dict[tuple[str, str], Sighting]:
    """What we remember about these postings, as of the CURRENT run.

    ONE query for the whole batch — a search carries up to 25 postings and a
    query per key would be 25 round trips to Neon on the main thread, before the
    scoring pool has started. Keys the table has never seen are simply absent
    from the result: the caller passes `None` for those and the classifier
    abstains, which is what makes the read-before-write ordering safe (a posting
    seen for the first time has no row yet, so it cannot carry `long_open` in
    the search that first records it).

    **The continuity reset is applied HERE, on read**, so the `Sighting` handed
    to the pure classifier is already about the current run — the same division
    of labour as `history.load_score_cache`, which decides its own freshness TTL
    so that `core` never has to reason about one. A stale row keeps its
    `relist_count` (that history is real and is the point of the table) and
    loses the four fields that would be FALSE about the run now starting:

    * `first_seen_at` → None, not `now`. Unknown, never zero — the rule the
      nullable `last_above_min` and `voice_score` columns follow. The row for
      this run has not been written yet.
    * `first_url` → "", or `reposted` fires on a URL difference belonging to a
      run that ended months ago.
    * `seen_count` → 0. We have not recorded this sighting yet; reporting the
      dead run's 47 would describe a document that does not exist.
    * `first_posted_at` → "". It is a PRINTED date (the alert email's "older
      posting — D" and the card's "first posted"), so the dead run's March
      date would call a role relisted last week an older posting from March.

    `relist_count` is reported as STORED and not pre-incremented, for the same
    reason: `record_sightings` may never run (the request can fail after this
    read), and a count that anticipates a write is the changelog defect in a new
    costume.

    `now` defaults to the wall clock because this is a DB read, not a pure
    function; it stays injectable so the reset can be pinned deterministically.
    """
    cutoff = _naive_utc(now or datetime.now(timezone.utc)) - timedelta(days=SIGHTING_GAP_DAYS)
    wanted = {k for k in keys if k and k[1]}
    if not wanted:
        # An empty IN is a round trip that can only return nothing, and a
        # zero-length row-value IN is not portable SQL.
        return {}

    # Row-value IN, which both backends speak: Postgres renders it natively as
    # `(source, content_key) IN ((…),(…))` and SQLite as `IN (VALUES …)` (row
    # values since 3.15). Sorted so the SQL is stable between runs.
    rows = db.execute(
        select(PostingSighting).where(
            tuple_(PostingSighting.source, PostingSighting.content_key).in_(sorted(wanted))
        )
    ).scalars().all()

    out: dict[tuple[str, str], Sighting] = {}
    for row in rows:
        last_seen = row.last_seen_at
        stale = last_seen is None or _naive_utc(last_seen) < cutoff
        if stale:
            out[(row.source, row.content_key)] = Sighting(
                first_seen_at=None,
                first_url="",
                seen_count=0,
                relist_count=row.relist_count or 0,
                first_posted_at="",
            )
            continue
        out[(row.source, row.content_key)] = Sighting(
            first_seen_at=_naive_utc(row.first_seen_at) if row.first_seen_at else None,
            first_url=row.first_url or "",
            seen_count=row.seen_count or 0,
            relist_count=row.relist_count or 0,
            first_posted_at=row.first_posted_at or "",
        )
    return out


def _replaces(new: str, stored: str) -> bool:
    """True when `new` is an EARLIER board date than `stored`, compared as
    instants through the one parser (`ghost_signals.parse_board_date`), never
    as strings.

    Strings were fine while this column was write-only. It is a printed date
    now, and a mixed-offset pair orders wrongly lexicographically: Greenhouse's
    "2026-06-02T03:17:15-04:00" (07:17 UTC) sorts before "2026-06-02T05:00:00Z"
    although it is the later instant. A string we cannot read never displaces
    one we can, and "" is never stored over a real date."""
    if not new:
        return False
    if not stored:
        return True
    new_dt = parse_board_date(new)
    if new_dt is None:
        return False
    stored_dt = parse_board_date(stored)
    return stored_dt is None or new_dt < stored_dt


def record_sightings(db: Session, matches: list[JobMatch], now: datetime) -> None:
    """Upsert one sighting per posting in this search, then prune what has aged out.

    Call AFTER the search and after `load_sightings`, beside
    `record_search_hits`. Read before write, or a posting is "seen since today"
    by the very sighting the current search just wrote and `long_open` can never
    fire on anything.

    `now` is a parameter, never `datetime.now()` inside: the continuity rule is
    a date comparison and a caller that cannot control the clock cannot pin it
    (`jobmaster.parse_hebrew_relative_date` is the precedent).

    Not wrapped in a blanket try/except, deliberately. Bookkeeping should not
    turn a served request into an error — but `record_search_hits` runs first on
    exactly the same session and does not swallow either, so a swallow here
    would buy the caller nothing while hiding the continuity defects the smoke
    pins exist to catch.
    """
    now = _naive_utc(now)

    # Dedupe within the batch. The session is autoflush=False, so a row added
    # for one match is invisible to a later `select` in the same call — the
    # pending-dict trick `record_search_hits` uses for the identical reason.
    # It is also what makes `seen_count` mean "searches that saw this posting"
    # rather than "result rows": a board that lists the same role twice under
    # two ids is ONE sighting, and the first (higher-ranked) URL wins.
    batch: dict[tuple[str, str], JobMatch] = {}
    for match in matches:
        key = _key(match)
        if key is None or key in batch:
            continue
        batch[key] = match
    if not batch:
        return

    existing: dict[tuple[str, str], PostingSighting] = {}
    for row in db.execute(
        select(PostingSighting).where(
            tuple_(PostingSighting.source, PostingSighting.content_key).in_(sorted(batch))
        )
    ).scalars().all():
        existing[(row.source, row.content_key)] = row

    gap = timedelta(days=SIGHTING_GAP_DAYS)
    for (source, key), match in batch.items():
        posted_at = match.posted_at or ""
        row = existing.get((source, key))
        if row is None:
            db.add(
                PostingSighting(
                    source=source,
                    content_key=key,
                    first_seen_at=now,
                    last_seen_at=now,
                    first_url=match.url,
                    last_url=match.url,
                    seen_count=1,
                    first_posted_at=posted_at,
                    relist_count=0,
                )
            )
            continue

        last_seen = _naive_utc(row.last_seen_at) if row.last_seen_at else None
        if last_seen is None or now - last_seen > gap:
            # The previous run is over — this is the same role listed again, not
            # the same listing still open. `first_posted_at` resets WITH the
            # rest. It feeds `JobMatch.first_posted_at` — the PRINTED "older
            # posting" date, via `ghost_signals.earliest_board_date` — and never
            # the ghost age, so carrying March's date into September's listing
            # would print "older posting — March" about a role the board put up
            # last week: the identical lie the reset of `first_seen_at` exists
            # to prevent, arriving through the email instead of the badge.
            # Written from the CARD date (`match.posted_at`), never from
            # `match.first_posted_at`, which may itself have been read from
            # this row.
            row.first_seen_at = now
            row.first_url = match.url
            row.first_posted_at = posted_at
            row.seen_count = 1
            row.relist_count = (row.relist_count or 0) + 1
        else:
            row.seen_count = (row.seen_count or 0) + 1
            # Keep the EARLIEST board-stated date of this run, compared as
            # INSTANTS (`_replaces`). This used to be a string `<`, which held
            # only while the column was write-only: it is printed now, and a
            # mixed-offset pair orders wrongly as strings. Empty and unreadable
            # values never displace a date we can read.
            if _replaces(posted_at, row.first_posted_at or ""):
                row.first_posted_at = posted_at
        row.last_seen_at = now
        row.last_url = match.url

    # Flush BEFORE the prune. With autoflush off, the pending UPDATEs above are
    # invisible to a bulk DELETE, so a row we just refreshed after a long
    # absence would still carry its ancient `last_seen_at` in the database and
    # the sweep would delete the row this call is in the middle of writing.
    # Same ordering, same reason, as the cap-enforcement pass in
    # `record_search_hits`.
    db.flush()
    db.execute(
        delete(PostingSighting).where(
            PostingSighting.last_seen_at < now - timedelta(days=SIGHTING_RETENTION_DAYS)
        )
    )
    db.commit()
