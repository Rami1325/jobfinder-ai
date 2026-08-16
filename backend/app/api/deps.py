"""Request-scoped dependencies: the current user and admin check (PLAN 7.1).

The access-gate middleware (app.main) resolves X-App-Key → user and stashes
the id on request.state. With the gate off (local dev, no APP_ACCESS_CODE)
every request acts as the auto-created admin user, so single-user dev
behavior is unchanged.
"""
from __future__ import annotations

from typing import Iterator

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.usage import check_and_count, record_tokens
from app.db.database import get_db
from app.db.models import User
from app.db.users import ensure_admin


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    user_id = getattr(request.state, "user_id", None)
    if user_id is not None:
        user = db.get(User, user_id)
        if user is not None and user.is_active:
            return user
        raise HTTPException(401, "Access code required.")
    if get_settings().app_access_code:
        # Gate is on but the middleware didn't resolve a user — only possible
        # on gate-exempt paths, which must not use this dependency.
        raise HTTPException(401, "Access code required.")
    return ensure_admin(db)


def admin_user(user: User = Depends(current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(403, "Admin only.")
    return user


def _write_tally(request: Request, db: Session, user: User) -> None:
    """Persist the request's LLM token usage, if any was recorded.

    The tally is read off `request.state`, NOT a ContextVar. FastAPI runs a
    `yield` dependency's setup and teardown through `contextmanager_in_threadpool`,
    which can land them in different contexts — binding the ContextVar here
    raised "Token was created in a different Context" on teardown, and worse, the
    endpoint never saw the tally at all. The binding lives in the `llm_metering`
    middleware (app.main), whose set/reset happen in one context; `request.state`
    is a plain attribute and crosses threads without complaint.
    """
    tally = getattr(request.state, "llm_tally", None)
    if tally is not None:
        record_tokens(db, user.id, tally.prompt, tally.completion)


def metered_user(
    request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> Iterator[User]:
    """Record what this request's LLM calls actually cost (PLAN 20.8 / N2).

    Teardown runs before `get_db` closes the session (FastAPI unwinds
    dependencies in reverse), so the write lands on a live session. Metering
    only — routes with their own specific cap (tailor, search) use this so the
    tokens are counted without a second charge.
    """
    yield user
    _write_tally(request, db, user)


def llm_user(
    request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)
) -> Iterator[User]:
    """Charge one `llm` action against the daily cap AND meter the tokens.

    For the routes that had no cap at all before PLAN 20.6/S2. Charged up front,
    the same as every other action: a crashed run still consumed the API call.
    `current_user` is FastAPI-cached per request, so stacking this on a route
    that also injects the user costs no extra query.
    """
    check_and_count(db, user, "llm", get_settings().daily_llm_cap)
    yield user
    _write_tally(request, db, user)
