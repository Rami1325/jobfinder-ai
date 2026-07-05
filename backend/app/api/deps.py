"""Request-scoped dependencies: the current user and admin check (PLAN 7.1).

The access-gate middleware (app.main) resolves X-App-Key → user and stashes
the id on request.state. With the gate off (local dev, no APP_ACCESS_CODE)
every request acts as the auto-created admin user, so single-user dev
behavior is unchanged.
"""
from __future__ import annotations

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.config import get_settings
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
