"""How a company registry's seed list reaches a database that already exists.

The Comeet and Greenhouse registries were seeded only into an EMPTY table
(`list_companies`, July 2026), so a company added to a seed file never reached
production, and a dead one could not leave it: editing the file changed
nothing on a deployed database. A seed file is now a list of BATCHES, each
applied to a database exactly once (`app.db.registry_seed.sync_registry`
records every batch it applied in `registry_seeds`):

  - a batch ADDS companies that are not in the table, and RETIRES the slugs it
    names (a board that moved or died);
  - a batch already applied is never applied again, so a company an admin
    deleted from the table stays deleted, and a retired company an admin adds
    back stays;
  - the first batch of each registry is the July 2026 list, marked `legacy`:
    a table that already holds rows but has no batch recorded was seeded by the
    old code, so that batch counts as applied WITHOUT inserting anything (a
    missing row there is one an admin removed).

A batch's `name` is its identity forever: never rename or reorder one that has
shipped, only append a new batch. Pure data, no database here.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SeedBatch:
    name: str  # "<registry>:<date>", unique for ever
    add: tuple[dict, ...] = ()  # rows to insert when their slug is absent
    retire: tuple[str, ...] = ()  # slugs to delete
    legacy: bool = False  # the list the pre-batch code seeded into an empty table


def effective(batches: tuple[SeedBatch, ...]) -> list[dict]:
    """The rows a fresh database ends with after every batch: each batch's adds
    (first spelling of a slug wins) minus its retirements, in batch order."""
    rows: dict[str, dict] = {}
    for batch in batches:
        for row in batch.add:
            rows.setdefault(row["slug"], row)
        for slug in batch.retire:
            rows.pop(slug, None)
    return list(rows.values())
