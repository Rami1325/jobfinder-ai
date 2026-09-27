"""Apply a company registry's seed batches to a database, each exactly once.

See `app/core/providers/registry_seeds.py` for the rules. This is the
database half: `sync_registry` reads which batches this database has applied
(`registry_seeds`), treats the legacy batch as applied on a table the old code
had already seeded, and applies every other pending batch in order, each in one
transaction that starts by CLAIMING the batch (inserting its `registry_seeds`
row). Two cold starts racing on one deploy: the loser's claim fails on the
unique name, it rolls back and moves on, so a batch is never applied twice.

`ensure_synced` is what the registries call on first use: once per process per
registry, and never an error for the search that triggered it (bookkeeping may
never turn a served request into a failure, the house rule `usage.record_tokens`
follows): a sync that fails is rolled back and tried again on the next list.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Callable

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.providers.registry_seeds import SeedBatch
from app.db.models import RegistrySeed

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Registry:
    """What the sync needs to know about one registry table."""

    key: str  # "comeet"; every batch name starts with "<key>:"
    batches: tuple[SeedBatch, ...]
    slugs: Callable[[Session], set[str]]  # the slugs the table holds
    insert: Callable[[Session, dict], None]  # add one seed row (not committed)
    delete: Callable[[Session, str], None]  # remove one slug's row (not committed)


@dataclass
class SyncReport:
    applied: list[str] = field(default_factory=list)  # batch names applied now
    inserted: int = 0
    retired: int = 0


def _applied_names(db: Session, key: str) -> set[str]:
    rows = db.execute(select(RegistrySeed.name).where(RegistrySeed.name.like(f"{key}:%"))).scalars()
    return set(rows)


def sync_registry(db: Session, registry: Registry) -> SyncReport:
    """Apply every batch of `registry` this database has not applied yet."""
    report = SyncReport()
    for batch in registry.batches:
        if not batch.name.startswith(f"{registry.key}:"):
            raise ValueError(f"seed batch {batch.name!r} does not belong to {registry.key!r}")
    applied = _applied_names(db, registry.key)
    pending = [b for b in registry.batches if b.name not in applied]
    if not pending:
        return report
    # A table that holds rows while no batch is recorded was seeded by the code
    # that predates batches, from exactly the legacy list: that batch has run,
    # and a legacy company missing from the table is one an admin removed.
    legacy_done = not applied and bool(registry.slugs(db))
    for batch in pending:
        try:
            db.add(RegistrySeed(name=batch.name))
            db.flush()  # the claim: a concurrent applier's identical row fails here
            if not (batch.legacy and legacy_done):
                present = registry.slugs(db)
                for row in batch.add:
                    if row["slug"] not in present:
                        registry.insert(db, row)
                        present.add(row["slug"])
                        report.inserted += 1
                for slug in batch.retire:
                    if slug in present:
                        registry.delete(db, slug)
                        present.discard(slug)
                        report.retired += 1
            db.commit()
            report.applied.append(batch.name)
        except IntegrityError:
            db.rollback()  # another instance claimed (and applied) this batch
    return report


_synced: set[str] = set()
_sync_lock = threading.Lock()


def ensure_synced(db: Session, registry: Registry) -> None:
    """`sync_registry` once per process per registry; a failure is logged,
    rolled back and retried on the next call, never raised."""
    if registry.key in _synced:
        return
    with _sync_lock:
        if registry.key in _synced:
            return
        try:
            sync_registry(db, registry)
        except Exception:  # noqa: BLE001 - bookkeeping never fails a search
            db.rollback()
            log.exception("seeding the %s registry failed; retrying on the next search", registry.key)
            return
        _synced.add(registry.key)


def forget_synced() -> None:
    """Let the next `ensure_synced` run again (the smoke test's fresh databases)."""
    with _sync_lock:
        _synced.clear()
