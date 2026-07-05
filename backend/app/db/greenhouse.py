"""Persistence helpers for the Greenhouse company registry (greenhouse_companies).

Mirrors app/db/comeet.py: rows drive `app.core.providers.greenhouse` and are
returned as plain tuples so the provider can use them across worker threads
without touching ORM state. No tokens to manage — the boards API is public.
"""
from __future__ import annotations

from typing import NamedTuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.providers.greenhouse_seed import SEED_COMPANIES
from app.db.models import GreenhouseCompany


class BoardRef(NamedTuple):
    slug: str
    name: str


def _ref(row: GreenhouseCompany) -> BoardRef:
    return BoardRef(slug=row.slug, name=row.name or row.slug)


def list_companies(db: Session) -> list[BoardRef]:
    """All registered companies, seeding the table on first use."""
    rows = db.execute(
        select(GreenhouseCompany).order_by(GreenhouseCompany.slug)
    ).scalars().all()
    if not rows:
        for entry in SEED_COMPANIES:
            db.add(GreenhouseCompany(slug=entry["slug"], name=entry["name"]))
        db.commit()
        rows = db.execute(
            select(GreenhouseCompany).order_by(GreenhouseCompany.slug)
        ).scalars().all()
    return [_ref(r) for r in rows]


def upsert_company(db: Session, *, slug: str, name: str) -> BoardRef:
    """Insert or refresh one company (matched by slug)."""
    row = db.execute(
        select(GreenhouseCompany).where(GreenhouseCompany.slug == slug)
    ).scalars().first()
    if row is None:
        row = GreenhouseCompany(slug=slug)
        db.add(row)
    row.name = name
    db.commit()
    return _ref(row)
