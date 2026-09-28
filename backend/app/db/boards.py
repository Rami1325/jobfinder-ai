"""Persistence helpers for the per-board company registries in `board_companies`
(2026-09-28): Lever, SmartRecruiters and Ashby. Each board's rows are seeded by
its own batches (`app/db/registry_seed.py`) and returned as plain tuples, so a
provider can use them across worker threads without touching ORM state.

No route adds to these registries yet: a company joins by a seed batch, and
an admin removes one by deleting its row, which a later sync never undoes.
"""
from __future__ import annotations

from typing import NamedTuple

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.providers.registry_seeds import SeedBatch
from app.db.models import BoardCompany
from app.db.registry_seed import Registry, ensure_synced


class BoardRef(NamedTuple):
    slug: str
    name: str
    host: str


def registry(board: str, batches: tuple[SeedBatch, ...]) -> Registry:
    """The sync's view of one board's rows in the shared table."""

    def slugs(db: Session) -> set[str]:
        return set(db.execute(select(BoardCompany.slug).where(BoardCompany.board == board)).scalars())

    def insert(db: Session, row: dict) -> None:
        db.add(BoardCompany(board=board, slug=row["slug"], name=row["name"], host=row.get("host", "")))

    def remove(db: Session, slug: str) -> None:
        db.execute(delete(BoardCompany).where(BoardCompany.board == board, BoardCompany.slug == slug))

    return Registry(key=board, batches=batches, slugs=slugs, insert=insert, delete=remove)


def list_board_companies(db: Session, reg: Registry) -> list[BoardRef]:
    """One board's registered companies, after applying any seed batch this
    database has not applied yet (once per process)."""
    ensure_synced(db, reg)
    rows = db.execute(
        select(BoardCompany).where(BoardCompany.board == reg.key).order_by(BoardCompany.slug)
    ).scalars().all()
    return [BoardRef(slug=r.slug, name=r.name or r.slug, host=r.host or "") for r in rows]
