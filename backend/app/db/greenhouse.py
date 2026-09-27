"""Persistence helpers for the Greenhouse company registry (greenhouse_companies).

Mirrors app/db/comeet.py: rows drive `app.core.providers.greenhouse` and are
returned as plain tuples so the provider can use them across worker threads
without touching ORM state. No tokens to manage — the boards API is public.
"""
from __future__ import annotations

from typing import NamedTuple

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.providers.greenhouse_seed import SEED_BATCHES
from app.db.models import GreenhouseCompany
from app.db.registry_seed import Registry, ensure_synced


class BoardRef(NamedTuple):
    slug: str
    name: str


def _ref(row: GreenhouseCompany) -> BoardRef:
    return BoardRef(slug=row.slug, name=row.name or row.slug)


def _slugs(db: Session) -> set[str]:
    return set(db.execute(select(GreenhouseCompany.slug)).scalars())


def _insert(db: Session, row: dict) -> None:
    db.add(GreenhouseCompany(slug=row["slug"], name=row["name"]))


def _delete(db: Session, slug: str) -> None:
    db.execute(delete(GreenhouseCompany).where(GreenhouseCompany.slug == slug))


REGISTRY = Registry(key="greenhouse", batches=SEED_BATCHES, slugs=_slugs, insert=_insert, delete=_delete)


def list_companies(db: Session) -> list[BoardRef]:
    """All registered companies, after applying any seed batch this database
    has not applied yet (once per process; `app/db/registry_seed.py`)."""
    ensure_synced(db, REGISTRY)
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
