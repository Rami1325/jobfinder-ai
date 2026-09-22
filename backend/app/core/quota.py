"""Monthly uses (Phase 30 / B): one shared pool of FREE_MONTHLY_USES a month per person.

The user-facing unit is a "use" ("10 uses a month"), never a "credit". The code
name is quota. Every AI feature spends from the pool; the admin and plan
"unlimited" do not, and write nothing here at all.

**Deterministic, and pinned that way through the AST** (smoke 32.15): nothing
here imports a model client or the network, and it owns its clock instead of
borrowing job_search's. It decides whether a request may spend the owner's
money, so nothing it reads may be a model's opinion or a remote answer.

**The pool belongs to the person, not to the account** (owner decision OD-5).
`quota_key` is a keyed hash of the CANONICAL sign-in address (`canonical_email`
folds the aliases), so closing the account, deleting the data or signing up
again with the same address changes nothing about this month's count: the
Phase 29 A7 rule, "closing never resets a limit", applied to the free limit. An
account with no sign-in address (the admin, an invite code) is a pool of its
own, `u:<id>`. The rows hold no content (a keyed hash, a user id, a month,
feature names and counts), so neither privacy door deletes them, and `prune`
drops them once they are older than the previous month.

**Atomic on the caller's session.** A reserve upserts the month row, then takes
with ONE conditional UPDATE (`used + n <= limit`), with immediate commits and
never a second connection: two SQLite connections in one request can deadlock
on a flushed write. The rowcount is the decision, and the count a 429 reports is
read back with SQL, never off an ORM object the caller may be holding stale.

**A refund lands in the charge's own month, at most once**: a charge event's
`refunded` column can only grow up to its `delta`. The ledger invariant is
`SUM(delta) == used` for every (pool, month).

**Clock.** Every function that takes a `now` refuses a naive one (ValueError): a
naive datetime is local time or UTC, and guessing is how "Posted N days ago"
went wrong. Stored datetimes are naive UTC, the form these columns compare in.
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Iterator

from fastapi import HTTPException
from sqlalchemy import delete, func, insert, or_, select, update
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.core.sessions import hkey
from app.db.models import UsageEvent, UsageMonth, UsagePass, User, UserLogin
from app.models import JDModel, UsageOut, UsagePassOut

logger = logging.getLogger(__name__)

FEATURES = (            # one quoted entry per line: a cross-lane contract (32(b))
    "tailor",
    "search",
    "company_brief",
    "scan",
    "interview",
    "cover_letter",
    "linkedin",
    "follow_up",
    "outreach",
    "screening",
    "fit_check",
    "rewrites",
    "job_alert",
)
PASS_RULES = {                                   # feature -> (window, max_calls)
    "interview": (timedelta(hours=3), 60),       # ref ""
    "screening": (timedelta(hours=3), 6),        # ref ""
    "cover_letter": (timedelta(hours=24), 10),   # ref = jd_ref(body.jd)
}
FIT_RIDE = "tailor_after_fit"                    # a pass-row marker only, never a ledger feature
# How long a fit check covers tailoring the same posting (OD-1).
FIT_RIDE_WINDOW = timedelta(hours=24)

FREE = "free"
UNLIMITED = "unlimited"
PLANS = (FREE, UNLIMITED)
# The passes /auth/me lists. A cover-letter pass belongs to ONE posting, so it
# travels on its own response (`changes_left`, `expires_in_s`) instead, and a page
# that remounted reads it back through `posting_pass` (POST /cover-letter/pass).
LISTED_PASSES = ("interview", "screening")
_GMAIL_DOMAINS = frozenset({"gmail.com", "googlemail.com"})

_MONTHS = UsageMonth.__table__
_EVENTS = UsageEvent.__table__
_PASSES = UsagePass.__table__


# --- the clock ------------------------------------------------------------------------
def utc_now() -> datetime:
    """Aware UTC, read at call time."""
    return datetime.now(timezone.utc)


def _aware(now: datetime) -> datetime:
    if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("quota needs an aware datetime: a naive one could be local time or UTC")
    return now.astimezone(timezone.utc)


def _clock(now: datetime | None) -> datetime:
    return utc_now() if now is None else _aware(now)


def naive_utc(now: datetime) -> datetime:
    """What SQL compares against: the columns store naive UTC."""
    return _aware(now).replace(tzinfo=None)


def _stored(value: datetime) -> datetime:
    """A DateTime column reads back naive; it was written as naive UTC."""
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _shift(year: int, month: int, months: int) -> tuple[int, int]:
    index = year * 12 + (month - 1) + months
    return index // 12, index % 12 + 1


def period_of(now: datetime) -> str:
    """The UTC month, "YYYY-MM". 00:30 on the 1st at +03:00 is still the previous month."""
    moment = _aware(now)
    return f"{moment.year:04d}-{moment.month:02d}"


def resets_on(now: datetime) -> date:
    """The 1st of the next UTC month (December rolls into January)."""
    moment = _aware(now)
    year, month = _shift(moment.year, moment.month, 1)
    return date(year, month, 1)


def _seconds_left(expires_at: datetime | None, now: datetime) -> int:
    return 0 if expires_at is None else max(0, int((expires_at - now).total_seconds()))


def seconds_until(expires_at: datetime | None, now: datetime | None = None) -> int:
    """Seconds from `now` (read at call time by default) to an aware end, 0 for
    None or the past. What a response sends beside an absolute instant, because
    a phone whose clock runs ahead reads the instant as already over."""
    return _seconds_left(None if expires_at is None else _aware(expires_at), _clock(now))


# --- who is limited ----------------------------------------------------------------------
def plan_of(user: User) -> str:
    """The user's plan. An unknown stored value reads as "free", failing toward the
    limit, and is logged: a typo in the column must never hand out unlimited use."""
    plan = user.plan
    if plan in PLANS:
        return plan
    logger.warning("users.plan %r on user %s is not a known plan; it reads as free", plan, user.id)
    return FREE


def _limit(is_admin: bool, plan: str, settings: Settings) -> int | None:
    if is_admin or plan == UNLIMITED:
        return None
    cap = int(settings.free_monthly_uses)
    return cap if cap > 0 else None


def limit_for(user: User, settings: Settings | None = None) -> int | None:
    """The monthly limit, or None for no limit: the admin (whatever users.plan
    says), plan "unlimited", or FREE_MONTHLY_USES <= 0 (the daily caps'
    kill-switch shape)."""
    if user.is_admin:
        return None
    return _limit(False, plan_of(user), settings or get_settings())


def _who(user: User) -> tuple[int, str, int | None]:
    """(user id, plan, limit), read off the row ONCE, before any commit expires it."""
    user_id, is_admin, plan = user.id, bool(user.is_admin), plan_of(user)
    return user_id, plan, _limit(is_admin, plan, get_settings())


# --- whose pool ---------------------------------------------------------------------------
def canonical_email(email: str) -> str:
    """One spelling per mailbox: normalised (NFKC, stripped, lower-cased), the local
    part cut at the first "+" when something precedes it, and for gmail.com and
    googlemail.com every "." in the local part dropped and the domain mapped to
    gmail.com. No other domain loses its dots: first.last@ and firstlast@ are two
    people everywhere Gmail does not say otherwise."""
    # Imported here, never at module level: accounts imports this module.
    from app.core.accounts import normalize_email

    address = normalize_email(email)
    local, at, domain = address.rpartition("@")
    if not at or not local:
        return address
    plus = local.find("+")
    if plus > 0:
        local = local[:plus]
    if domain in _GMAIL_DOMAINS:
        local = local.replace(".", "")
        domain = "gmail.com"
    return f"{local}@{domain}"


def key_for(user_id: int, login_email: str | None) -> str:
    """The pool key from values already in hand. A keyed hash, never the address:
    these rows outlive the account, and an unkeyed hash of an email is a lookup
    table away from the email."""
    if login_email:
        return "em:" + hkey("quota", canonical_email(login_email))
    return f"u:{user_id}"


def quota_key(db: Session, user: User) -> str:
    """Derived at RESERVE time from the login's address, never stamped at signup:
    an unverified login can still change its address, and the pool must follow
    the address it verifies. Never keyed on a Google `sub` either, so linking a
    Google account mid-month changes nothing."""
    user_id = user.id
    email = db.execute(select(UserLogin.email).where(UserLogin.user_id == user_id)).scalar()
    return key_for(user_id, email)


def jd_ref(jd: JDModel) -> str:
    """sha256 hex of the canonical analysed JD: the key a fit ride and a
    cover-letter pass are held under.

    Fields still at their DEFAULT are left out (`exclude_defaults`), nested ones
    too. With every field hashed, a deploy that added a field to JDModel changed
    the hash of every JD, so every live pass and fit ride was orphaned at once
    and the next call on each was charged again. A new field with a default now
    leaves every existing key alone, and one that is SET still separates two
    postings. (This change itself re-keyed every pass once, at its deploy.)"""
    canonical = json.dumps(
        jd.model_dump(mode="json", exclude_defaults=True), sort_keys=True, ensure_ascii=False, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _used(db: Session, key: str, period: str) -> int:
    """`used` read with SQL, the only form a 429 or a header may report."""
    value = db.execute(
        select(_MONTHS.c.used).where(_MONTHS.c.quota_key == key, _MONTHS.c.period == period)
    ).scalar()
    return int(value or 0)


def used_by_keys(db: Session, keys: set[str], period: str) -> dict[str, int]:
    """`used` for many pools in one query (the admin user list)."""
    if not keys:
        return {}
    rows = db.execute(
        select(_MONTHS.c.quota_key, _MONTHS.c.used)
        .where(_MONTHS.c.period == period, _MONTHS.c.quota_key.in_(sorted(keys)))
    ).all()
    return {str(key): int(used or 0) for key, used in rows}


# --- the response headers (B7) ------------------------------------------------------------
@dataclass
class UsesHolder:
    """What this request's ledger writes leave for the response headers. Bound by
    the `uses_meter` middleware in app/main.py; written only for the user it was
    bound to, so a cron that charges many users never leaks one of them a header."""

    user_id: int | None
    remaining: int | None = None
    pass_: tuple | None = None  # (feature, calls_left, expires_in_s)


_holder: ContextVar[UsesHolder | None] = ContextVar("quota_uses_holder", default=None)


@contextmanager
def bind_uses(user_id: int | None) -> Iterator[UsesHolder]:
    """Make a fresh holder current for one request. Set and reset in ONE context,
    which is why this lives in a middleware and never in a yield dependency."""
    holder = UsesHolder(user_id=user_id)
    token = _holder.set(holder)
    try:
        yield holder
    finally:
        _holder.reset(token)


def current_uses() -> UsesHolder | None:
    return _holder.get()


def _bound(user_id: int | None) -> UsesHolder | None:
    holder = _holder.get()
    if holder is None or holder.user_id is None or user_id is None or holder.user_id != user_id:
        return None
    return holder


def _note_remaining(db: Session, user_id: int, key: str, period: str, limit: int | None) -> None:
    holder = _bound(user_id)
    if holder is not None and limit is not None:
        holder.remaining = max(0, limit - _used(db, key, period))


def _note_pass(user_id: int, feature: str, ref: str, calls_left: int, expires_in_s: int) -> None:
    if ref:
        return  # a per-posting pass is exposed on its own response, never in the feature-keyed header
    holder = _bound(user_id)
    if holder is not None:
        holder.pass_ = (feature, max(0, int(calls_left)), max(0, int(expires_in_s)))


# --- the SQL, built in one place so smoke can compile it for both dialects ---------------------
def _month_upsert(dialect: str, key: str, period: str, user_id: int | None, now: datetime):  # noqa: ANN202
    """INSERT … ON CONFLICT (quota_key, period) DO NOTHING, in the live dialect."""
    values = dict(quota_key=key, user_id=user_id, period=period, used=0, updated_at=naive_utc(now))
    if dialect == "postgresql":
        return postgresql.insert(_MONTHS).values(**values).on_conflict_do_nothing(index_elements=["quota_key", "period"])
    if dialect == "sqlite":
        return sqlite.insert(_MONTHS).values(**values).on_conflict_do_nothing(index_elements=["quota_key", "period"])
    raise ValueError(f"no month upsert for the {dialect!r} dialect (the app runs on sqlite and postgresql)")


def _month_take(key: str, period: str, n: int, limit: int, now: datetime):  # noqa: ANN202
    """The take: ONE conditional UPDATE, so no two requests can both see room for the last unit."""
    return (
        update(_MONTHS)
        .where(_MONTHS.c.quota_key == key, _MONTHS.c.period == period, _MONTHS.c.used + n <= limit)
        .values(used=_MONTHS.c.used + n, updated_at=naive_utc(now))
    )


def _month_lock(key: str, period: str, now: datetime):  # noqa: ANN202
    """A limit-independent write that locks the month row, serializing one pool's pass opens."""
    return (
        update(_MONTHS)
        .where(_MONTHS.c.quota_key == key, _MONTHS.c.period == period)
        .values(updated_at=naive_utc(now))
    )


def _newest_open(user_id: int, feature: str, ref: str, now: datetime):  # noqa: ANN202
    at = naive_utc(now)
    newest = _PASSES.alias("newest")
    return select(func.max(newest.c.id)).where(
        newest.c.user_id == user_id,
        newest.c.feature == feature,
        newest.c.ref == ref,
        newest.c.expires_at > at,
        newest.c.calls < newest.c.max_calls,
    )


def _pass_take(user_id: int, feature: str, ref: str, now: datetime):  # noqa: ANN202
    """One call on the newest open pass. Narrowed by max(id) so a call never takes
    two passes, with NO `ORDER BY … LIMIT`, and with the conditions repeated
    OUTSIDE the subquery: after a lock wait Postgres re-checks only the outer
    WHERE. The same statement is the fit-ride claim (feature FIT_RIDE)."""
    at = naive_utc(now)
    return (
        update(_PASSES)
        .where(
            _PASSES.c.id == _newest_open(user_id, feature, ref, now).scalar_subquery(),
            _PASSES.c.expires_at > at,
            _PASSES.c.calls < _PASSES.c.max_calls,
        )
        .values(calls=_PASSES.c.calls + 1)
    )


def _dialect(db: Session) -> str:
    return db.get_bind().dialect.name


def _take_pass(db: Session, user_id: int, feature: str, ref: str, now: datetime) -> int | None:
    """Run the pass take; the id of the pass it took, or None. Leaves the
    transaction open for the caller to commit or roll back."""
    stmt = _pass_take(user_id, feature, ref, now)
    if db.get_bind().dialect.update_returning:
        row = db.execute(stmt.returning(_PASSES.c.id)).first()
        return int(row[0]) if row is not None else None
    # An engine without UPDATE … RETURNING (SQLite before 3.35): name the
    # candidate first. Neither supported deployment takes this path.
    candidate = db.execute(_newest_open(user_id, feature, ref, now)).scalar()
    if candidate is None:
        return None
    return int(candidate) if db.execute(stmt).rowcount == 1 else None


def _insert_event(
    db: Session, *, user_id: int | None, key: str, period: str, feature: str, delta: int, ref: str, now: datetime
) -> int:
    result = db.execute(
        insert(_EVENTS).values(
            user_id=user_id,
            quota_key=key,
            period=period,
            feature=feature,
            delta=delta,
            refunded=0,
            ref=(ref or "")[:64],
            created_at=naive_utc(now),
        )
    )
    return int(result.inserted_primary_key[0])


def limit_detail(feature: str, plan: str, limit: int, used: int, now: datetime) -> dict[str, object]:
    """The 429 detail: a CODE the client translates, and the numbers it needs to say when."""
    return {
        "code": "monthly_limit",
        "feature": feature,
        "plan": plan,
        "limit": limit,
        "used": used,
        "remaining": max(0, limit - used),
        "resets_on": resets_on(now).isoformat(),
    }


# --- retention ----------------------------------------------------------------------------
def prune(db: Session, now: datetime | None = None) -> None:
    """Delete rows for months older than the previous one, and passes that expired
    before the previous month began. The previous month is KEPT so a refund
    across the month boundary still finds the row it restores. Commits."""
    moment = _clock(now)
    year, month = _shift(moment.year, moment.month, -1)
    keep_from = f"{year:04d}-{month:02d}"
    previous_start = datetime(year, month, 1)  # naive UTC, the form the column stores
    db.execute(delete(_MONTHS).where(_MONTHS.c.period < keep_from))
    db.execute(delete(_EVENTS).where(_EVENTS.c.period < keep_from))
    db.execute(delete(_PASSES).where(_PASSES.c.expires_at < previous_start))
    db.commit()


_prune_lock = threading.Lock()
_pruned_on = ""


def _maybe_prune(db: Session) -> None:
    """Prune on the first take of each UTC day in this process.

    Keyed and measured on the REAL clock, never on the `now` a caller injected:
    `now` exists to decide which month a charge lands in, and a test date far
    from today must not be able to delete this month's rows. In production the
    two are the same reading. Best effort: housekeeping may never cost a charge.
    """
    global _pruned_on
    today = utc_now()
    day = today.strftime("%Y-%m-%d")
    with _prune_lock:
        if _pruned_on == day:
            return
        _pruned_on = day
    try:
        prune(db, today)
    except Exception:  # noqa: BLE001 - never fail a charge over housekeeping
        db.rollback()
        logger.warning("quota prune failed; the next UTC day tries again", exc_info=True)


# --- charges -------------------------------------------------------------------------------
@dataclass(frozen=True)
class Charge:
    """A reserved charge. Never holds an ORM object or a session, so it can be
    refunded from another thread's session (the search stream's worker)."""

    user_id: int
    quota_key: str
    feature: str
    period: str
    n: int
    event_id: int | None

    def refund(self, db: Session) -> bool:
        """Give the use back. False when there is nothing to give (an exempt caller)
        or it was already given back."""
        if self.event_id is None:
            return False
        return refund_units(db, self.event_id, self.n, ref=f"refund:{self.event_id}")


def reserve(
    db: Session, user: User, feature: str, n: int = 1, *, now: datetime | None = None, ref: str = ""
) -> Charge:
    """Take `n` uses from the user's pool, or raise 429 `monthly_limit`.

    An exempt caller (no limit) gets a Charge with no event and nothing is
    written, the `check_and_count` precedent. Otherwise: the month row is
    upserted and committed, the conditional take decides, and the +n event is
    written in the same transaction as the take, so `SUM(delta) == used` holds
    at every commit.
    """
    moment = _clock(now)
    if feature not in FEATURES:
        raise ValueError(f"unknown quota feature {feature!r}")
    user_id, plan, limit = _who(user)
    period = period_of(moment)
    if limit is None or n <= 0:
        return Charge(user_id=user_id, quota_key="", feature=feature, period=period, n=max(0, n), event_id=None)
    key = quota_key(db, user)
    _maybe_prune(db)
    db.execute(_month_upsert(_dialect(db), key, period, user_id, moment))
    db.commit()
    if db.execute(_month_take(key, period, n, limit, moment)).rowcount != 1:
        db.rollback()
        raise HTTPException(429, detail=limit_detail(feature, plan, limit, _used(db, key, period), moment))
    event_id = _insert_event(db, user_id=user_id, key=key, period=period, feature=feature, delta=n, ref=ref, now=moment)
    db.commit()
    _note_remaining(db, user_id, key, period, limit)
    return Charge(user_id=user_id, quota_key=key, feature=feature, period=period, n=n, event_id=event_id)


def refund_units(
    db: Session, event_id: int | None, n: int, *, ref: str, commit: bool = True, now: datetime | None = None
) -> bool:
    """Give back `n` units of one charge event, in ONE transaction. True when it did.

    The refund lands in the CHARGE's month, never in the current one, and at most
    `delta` units of a charge can ever come back, across requests and processes.
    With `commit=False` it joins the caller's transaction (a kit's status write),
    and a failure undoes only its own write instead of rolling the caller back.

    The response HEADER it leaves behind reads the CURRENT month, which is the
    pool the caller can still spend (Phase 30 review, known item 2). The two
    differ across a month boundary — a kit paid for on the 31st that fails after
    midnight — and a header carrying last month's remaining had the client report
    a fresh month as used up until its next /auth/me.
    """
    moment = _clock(now)
    if event_id is None or n <= 0:
        return False
    charge = db.execute(
        select(_EVENTS.c.user_id, _EVENTS.c.quota_key, _EVENTS.c.period, _EVENTS.c.feature)
        .where(_EVENTS.c.id == event_id)
    ).first()
    if charge is None:
        return False
    user_id, key, period, feature = charge
    marked = db.execute(
        update(_EVENTS)
        .where(_EVENTS.c.id == event_id, _EVENTS.c.delta > 0, _EVENTS.c.refunded + n <= _EVENTS.c.delta)
        .values(refunded=_EVENTS.c.refunded + n)
    ).rowcount
    if marked != 1:
        if commit:
            db.rollback()
        return False  # already given back, up to this charge's own delta
    restored = db.execute(
        update(_MONTHS)
        .where(_MONTHS.c.quota_key == key, _MONTHS.c.period == period, _MONTHS.c.used >= n)
        .values(used=_MONTHS.c.used - n, updated_at=naive_utc(moment))
    ).rowcount
    if restored != 1:
        if commit:
            db.rollback()
        else:
            db.execute(update(_EVENTS).where(_EVENTS.c.id == event_id).values(refunded=_EVENTS.c.refunded - n))
        logger.warning("quota refund of event %s found no month row to restore (pruned or drifted)", event_id)
        return False
    _insert_event(db, user_id=user_id, key=key, period=period, feature=feature, delta=-n, ref=ref, now=moment)
    if commit:
        db.commit()
    holder = _bound(user_id)
    if holder is not None:
        owner = db.get(User, user_id)
        limit = limit_for(owner) if owner is not None else None
        if limit is not None:
            holder.remaining = max(0, limit - _used(db, key, period_of(moment)))
    return True


@contextmanager
def charged(db: Session, user: User, feature: str, n: int = 1, *, now: datetime | None = None) -> Iterator[Charge]:
    """Reserve, run the block, and give the use back if the block raises.

    Every failure is refunded for now (OD-3), whether the error is ours or the
    model's. The block sits OUTSIDE a route's `try/except -> 502`, or the 429 this
    raises would be re-wrapped as a 502.
    """
    charge = reserve(db, user, feature, n, now=now)
    try:
        yield charge
    except BaseException:
        try:
            db.rollback()
        except Exception:  # noqa: BLE001 - the refund below is what matters
            logger.warning("rollback before a quota refund failed", exc_info=True)
        try:
            charge.refund(db)
        except Exception:  # noqa: BLE001 - never mask the error that caused the refund
            logger.warning("quota refund after a failed %s did not complete", feature, exc_info=True)
        raise


# --- session passes (B5) -----------------------------------------------------------------------
@dataclass
class PassUse:
    """One call on a session pass, as `pass_charged` yields it."""

    feature: str
    ref: str = ""
    pass_id: int | None = None
    event_id: int | None = None
    opened: bool = False
    calls: int = 0
    max_calls: int = 0
    expires_at: datetime | None = None  # aware UTC

    @property
    def included_until(self) -> str:
        """ISO UTC while a pass covers the call, "" for an exempt caller."""
        return self.expires_at.isoformat() if self.expires_at is not None else ""

    @property
    def calls_left(self) -> int:
        """`max_calls - calls` after this call; 0 for an exempt caller."""
        return max(0, self.max_calls - self.calls) if self.pass_id is not None else 0

    def seconds_left(self, now: datetime | None = None) -> int:
        """Seconds until the pass ends, read NOW rather than when the call took its
        slot, so a response sent after a slow model call does not overstate them;
        0 for an exempt caller. Relative, like every pass /auth/me lists: a phone
        whose clock runs ahead reads an absolute `included_until` as already over
        (P30-RELOAD-PASS)."""
        return _seconds_left(self.expires_at, _clock(now)) if self.pass_id is not None else 0


def _open_pass(
    db: Session,
    *,
    user_id: int,
    plan: str,
    limit: int,
    key: str,
    period: str,
    feature: str,
    ref: str,
    now: datetime,
) -> tuple[int, int | None, bool]:
    """Open a pass, serialized per pool, in one transaction: upsert and lock the
    month row, re-run the ride (a concurrent first call may have opened one while
    this one waited), and only then take a use. The re-check comes BEFORE the 429
    decision, so at 9 of 10 used five concurrent first calls spend one use and
    none is refused. Returns (pass id, opening event id, whether this call opened it)."""
    window, max_calls = PASS_RULES[feature]
    _maybe_prune(db)
    db.execute(_month_upsert(_dialect(db), key, period, user_id, now))
    db.execute(_month_lock(key, period, now))
    ridden = _take_pass(db, user_id, feature, ref, now)
    if ridden is not None:
        db.commit()
        return ridden, None, False
    if db.execute(_month_take(key, period, 1, limit, now)).rowcount != 1:
        db.rollback()
        raise HTTPException(429, detail=limit_detail(feature, plan, limit, _used(db, key, period), now))
    event_id = _insert_event(db, user_id=user_id, key=key, period=period, feature=feature, delta=1, ref=ref, now=now)
    result = db.execute(
        insert(_PASSES).values(
            user_id=user_id,
            feature=feature,
            ref=ref,
            opened_at=naive_utc(now),
            expires_at=naive_utc(now + window),
            calls=1,
            max_calls=max_calls,
            event_id=event_id,
            succeeded=0,
            failed=0,
            opener_failed=False,
        )
    )
    pass_id = int(result.inserted_primary_key[0])
    db.commit()
    return pass_id, event_id, True


def _read_pass(db: Session, use: PassUse) -> None:
    row = db.execute(
        select(_PASSES.c.calls, _PASSES.c.max_calls, _PASSES.c.expires_at, _PASSES.c.event_id)
        .where(_PASSES.c.id == use.pass_id)
    ).first()
    if row is None:
        return
    calls, max_calls, expires_at, event_id = row
    use.calls, use.max_calls = int(calls), int(max_calls)
    use.expires_at = _stored(expires_at)
    use.event_id = event_id


def _close_if_nothing_served(db: Session, use: PassUse, user_id: int, now: datetime) -> None:
    """B5.3 step 3, in the transaction the caller opened: a pass whose opener failed
    and on which nothing was served is closed and refunded once. A pass on which
    ANY call succeeded keeps its use, so forcing the opener to fail late buys
    nothing.

    The condition is `succeeded == 0` with at least one recorded failure, where
    it used to be the stricter `failed == calls - 1` (Phase 30 review, P30-C2). A
    ride commits its call BEFORE its outcome is known, so a ride that never
    recorded one — a lost worker, a bookkeeping write that failed — left `failed`
    permanently short of `calls - 1` and pinned the pass open for ever: the use
    was kept for a pass on which nothing was ever served, which is the opposite
    of what this rule promises. Every pass the old condition closed still closes
    (`calls <= 1` keeps the no-rider shape). The cost runs one way only: a rider
    still in flight beside one that failed can now have its pass closed under it,
    so a call that then succeeds was served for a use we had given back —
    generous to the person, and bounded by the calls already taken."""
    at = naive_utc(now)
    closed = db.execute(
        update(_PASSES)
        .where(
            _PASSES.c.id == use.pass_id,
            _PASSES.c.opener_failed.is_(True),
            _PASSES.c.succeeded == 0,
            or_(_PASSES.c.failed >= 1, _PASSES.c.calls <= 1),
            _PASSES.c.expires_at > at,
        )
        .values(expires_at=at, max_calls=_PASSES.c.calls)
    ).rowcount
    if closed != 1:
        db.commit()
        return
    event_id = db.execute(select(_PASSES.c.event_id).where(_PASSES.c.id == use.pass_id)).scalar()
    # The refund joins THIS transaction (commit=False): if it cannot land (its
    # month row was pruned) it undoes only its own write, and the close stands.
    if event_id is not None:
        refund_units(db, event_id, 1, ref=f"refund:{event_id}", commit=False, now=now)
    db.commit()
    _note_pass(user_id, use.feature, use.ref, 0, 0)


def _record_failure(db: Session, use: PassUse, user_id: int, key: str, period: str, now: datetime) -> None:
    if use.opened:
        # With no rider the pass is deleted and its use refunded, under the month
        # row's lock so a concurrent open cannot ride a pass being taken away.
        db.execute(_month_lock(key, period, now))
        gone = db.execute(delete(_PASSES).where(_PASSES.c.id == use.pass_id, _PASSES.c.calls == 1)).rowcount
        if gone == 1:
            refund_units(db, use.event_id, 1, ref=f"refund:{use.event_id}", commit=False, now=now)
            db.commit()
            _note_pass(user_id, use.feature, use.ref, 0, 0)
            return
        db.execute(update(_PASSES).where(_PASSES.c.id == use.pass_id).values(opener_failed=True))
    else:
        # A failed ride keeps its slot (`calls` bounds calls MADE) and charges nothing.
        db.execute(update(_PASSES).where(_PASSES.c.id == use.pass_id).values(failed=_PASSES.c.failed + 1))
    _close_if_nothing_served(db, use, user_id, now)


@contextmanager
def pass_charged(
    db: Session, user: User, feature: str, *, now: datetime | None = None, ref: str = ""
) -> Iterator[PassUse]:
    """One call inside a session pass: interview practice (3 h / 60 calls), screening
    answers (3 h / 6) and a cover letter's changes (24 h / 10 per posting, `ref` =
    `jd_ref(jd)`). The first call opens the pass and uses 1; the rest ride it free.

    Placed after a handler's own 400 checks and OUTSIDE its `try/except -> 502`.
    An exempt caller writes no pass row. A pass keeps its use once any call on it
    succeeded; a pass on which none did is refunded once and closed (B5.3).
    """
    moment = _clock(now)
    if feature not in PASS_RULES:
        raise ValueError(f"{feature!r} has no pass rule")
    user_id, plan, limit = _who(user)
    use = PassUse(feature=feature, ref=ref)
    if limit is None:
        yield use
        return
    key = quota_key(db, user)
    period = period_of(moment)
    ridden = _take_pass(db, user_id, feature, ref, moment)
    if ridden is not None:
        db.commit()
        use.pass_id = ridden
    else:
        db.rollback()
        use.pass_id, _event_id, use.opened = _open_pass(
            db, user_id=user_id, plan=plan, limit=limit, key=key, period=period, feature=feature, ref=ref, now=moment
        )
    _read_pass(db, use)
    _note_remaining(db, user_id, key, period, limit)
    _note_pass(user_id, feature, ref, use.calls_left, _seconds_left(use.expires_at, moment))
    try:
        yield use
    except BaseException:
        try:
            db.rollback()
            _record_failure(db, use, user_id, key, period, moment)
        except Exception:  # noqa: BLE001 - never mask the error that failed the call
            db.rollback()
            logger.warning("recording a failed %s pass call did not complete", feature, exc_info=True)
        raise
    if not use.opened:
        try:
            db.execute(update(_PASSES).where(_PASSES.c.id == use.pass_id).values(succeeded=_PASSES.c.succeeded + 1))
            db.commit()
        except Exception:  # noqa: BLE001 - the call was served either way
            db.rollback()
            logger.warning("recording a served %s ride did not complete", feature, exc_info=True)


def posting_pass(db: Session, user: User, feature: str, *, ref: str, now: datetime | None = None) -> UsagePassOut:
    """The per-posting pass the NEXT call on `ref` would ride, read and never taken
    (P30-RELOAD-PASS): calls left and seconds left, 0/0 when none is open.

    A cover-letter pass belongs to one posting, so /auth/me cannot list it, and a
    page that remounted its card (a reload of /kits/:id, Tracker and back on /app)
    had nothing to read it from: at 0 uses left it disabled a change the server
    would still include. This names exactly the row `_take_pass` would take,
    through the same `_newest_open`, and writes nothing: no commit, no prune, no
    header. Relative seconds, like every pass /auth/me lists.

    Per-posting passes only, and ValueError otherwise: a listed pass is on
    /auth/me already, and the fit ride is not a pass a page may probe. An
    exempt caller reads 0/0 without a query, the same as it never writes a row.
    """
    moment = _clock(now)
    if feature not in PASS_RULES or feature in LISTED_PASSES:
        raise ValueError(f"{feature!r} has no per-posting pass to read")
    if not ref:
        raise ValueError("a per-posting pass is read by its posting's ref")
    user_id, _plan, limit = _who(user)
    if limit is None:
        return UsagePassOut()
    row = db.execute(
        select(_PASSES.c.calls, _PASSES.c.max_calls, _PASSES.c.expires_at)
        .where(_PASSES.c.id == _newest_open(user_id, feature, ref, moment).scalar_subquery())
    ).first()
    if row is None:
        return UsagePassOut()
    calls, max_calls, expires_at = row
    return UsagePassOut(
        calls_left=max(0, int(max_calls) - int(calls)),
        expires_in_s=_seconds_left(_stored(expires_at), moment),
    )


# --- check fit, then tailor: one use (B4.4) ------------------------------------------------------
def open_fit_ride(db: Session, user: User, *, ref: str, event_id: int | None, now: datetime) -> datetime | None:
    """After a successful fit check, cover one tailor of the same analysed JD for
    24 hours. Returns when the cover ends (aware UTC), or None for an exempt caller.

    A reload FORFEITS the ride (P30-RELOAD-PASS, recorded, not fixed: the owner
    accepted the second use on 2026-09-21). Its key is the analysed JD, which
    the page holds only in memory; after a reload the page analyses the posting
    again through /jd/analyze, a different task at temperature, so the tailor
    carries another jd_ref and is charged. Check fit, reload, tailor costs 2 uses,
    and the note saying so is true. The stub's `_stub_jd` ignores its input and
    would claim the ride offline: never pin the reload case through the stub."""
    moment = _clock(now)
    user_id, _plan, limit = _who(user)
    if limit is None or event_id is None:
        return None
    expires = moment + FIT_RIDE_WINDOW
    db.execute(
        insert(_PASSES).values(
            user_id=user_id,
            feature=FIT_RIDE,
            ref=ref,
            opened_at=naive_utc(moment),
            expires_at=naive_utc(expires),
            calls=0,
            max_calls=1,
            event_id=event_id,
            succeeded=0,
            failed=0,
            opener_failed=False,
        )
    )
    db.commit()
    return expires


def claim_fit_ride(db: Session, user: User, *, ref: str, now: datetime) -> int | None:
    """Claim the newest open fit ride for this JD: the pass id, or None (the tailor
    is then charged as usual). One tailor never claims two rides."""
    moment = _clock(now)
    user_id, _plan, limit = _who(user)
    if limit is None:
        return None
    pass_id = _take_pass(db, user_id, FIT_RIDE, ref, moment)
    if pass_id is None:
        db.rollback()
        return None
    db.commit()
    return pass_id


def release_fit_ride(db: Session, pass_id: int | None) -> None:
    """A covered tailor failed: give the ride back, with no ledger change, so the retry is still covered.

    Whatever the failed call left pending is rolled back first. Best effort, like
    the refund in `charged`: it may never mask the error that failed the tailor,
    and a ride it cannot give back only means the retry is charged as usual.
    """
    if pass_id is None:
        return
    try:
        db.rollback()
        db.execute(
            update(_PASSES)
            .where(_PASSES.c.id == pass_id, _PASSES.c.feature == FIT_RIDE, _PASSES.c.calls > 0)
            .values(calls=_PASSES.c.calls - 1)
        )
        db.commit()
    except Exception:  # noqa: BLE001 - never mask the error that failed the tailor
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        logger.warning("giving back fit ride %s did not complete; the retry will be charged", pass_id, exc_info=True)


def settle_fit_ride(
    db: Session, user: User, pass_id: int, *, fit_event_id: int | None = None, now: datetime | None = None
) -> None:
    """A covered tailor succeeded: reclassify the fit check's use as a tailored job
    (fit_check -1, tailor +1, both in the fit event's month, ref `ride:<pass id>`).
    `used` is unchanged, so the breakdown counts a tailored job for the one use.

    `fit_event_id` defaults to the ride's own `event_id`, the fit charge that
    opened it, which is all a caller holding only the claimed pass id can name.
    Written at most once per ride. Best effort: the tailor was already served, so
    a reclassification that cannot land leaves `used` right and only the
    breakdown still saying fit_check, where raising would lose the user a
    tailored resume the ride had already paid for.

    The events land in the fit's month; the response HEADER reads the CURRENT
    one (Phase 30 review, known item 2). A fit check at 23:00 on the 31st whose
    covered tailor arrives at 00:30 is the case: the header and /auth/me must
    describe the same pool, and last month's number reads as a fresh month
    already used up.
    """
    moment = _clock(now)
    user_id, _plan, limit = _who(user)
    try:
        if fit_event_id is None:
            fit_event_id = db.execute(
                select(_PASSES.c.event_id).where(_PASSES.c.id == pass_id, _PASSES.c.feature == FIT_RIDE)
            ).scalar()
        fit = (
            db.execute(select(_EVENTS.c.quota_key, _EVENTS.c.period).where(_EVENTS.c.id == fit_event_id)).first()
            if fit_event_id is not None
            else None
        )
        if fit is None:
            return
        key, period = fit
        ride = f"ride:{pass_id}"
        settled = db.execute(
            select(_EVENTS.c.id).where(_EVENTS.c.quota_key == key, _EVENTS.c.ref == ride).limit(1)
        ).first()
        if settled is None:
            _insert_event(
                db, user_id=user_id, key=key, period=period, feature="fit_check", delta=-1, ref=ride, now=moment
            )
            _insert_event(db, user_id=user_id, key=key, period=period, feature="tailor", delta=1, ref=ride, now=moment)
            db.commit()
        _note_remaining(db, user_id, key, period_of(moment), limit)
    except Exception:  # noqa: BLE001 - the tailor was served; never turn it into an error
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        logger.warning("settling fit ride %s did not complete; its use still counts as a fit check", pass_id,
                       exc_info=True)


# --- what /auth/me says (B7) ----------------------------------------------------------------------
def _open_passes(db: Session, user_id: int, now: datetime) -> dict[str, UsagePassOut]:
    rows = db.execute(
        select(_PASSES.c.feature, _PASSES.c.calls, _PASSES.c.max_calls, _PASSES.c.expires_at)
        .where(
            _PASSES.c.user_id == user_id,
            _PASSES.c.ref == "",
            _PASSES.c.feature.in_(LISTED_PASSES),
            _PASSES.c.expires_at > naive_utc(now),
            _PASSES.c.calls < _PASSES.c.max_calls,
        )
        .order_by(_PASSES.c.id.desc())
    ).all()
    passes: dict[str, UsagePassOut] = {}
    for feature, calls, max_calls, expires_at in rows:
        if feature not in passes:  # newest first: the pass the next call would ride
            passes[feature] = UsagePassOut(
                calls_left=int(max_calls) - int(calls), expires_in_s=_seconds_left(_stored(expires_at), now)
            )
    return passes


def snapshot(db: Session, user: User, now: datetime | None = None) -> UsageOut:
    """This month's uses for /auth/me. `limit` and `remaining` are null, and no pass
    is listed, when the user has no monthly limit. Passes are reported in RELATIVE
    seconds, so a phone whose clock is wrong cannot end one early."""
    moment = _clock(now)
    user_id, plan, limit = _who(user)
    key = quota_key(db, user)
    period = period_of(moment)
    used = _used(db, key, period)
    by_feature = {
        str(feature): int(total or 0)
        for feature, total in db.execute(
            select(_EVENTS.c.feature, func.sum(_EVENTS.c.delta))
            .where(_EVENTS.c.quota_key == key, _EVENTS.c.period == period)
            .group_by(_EVENTS.c.feature)
        ).all()
    }
    return UsageOut(
        plan=plan,
        limit=limit,
        used=used,
        remaining=None if limit is None else max(0, limit - used),
        resets_on=resets_on(moment).isoformat(),
        by_feature=by_feature,
        passes={} if limit is None else _open_passes(db, user_id, moment),
    )
