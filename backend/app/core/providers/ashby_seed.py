"""Seed registry of companies with openings in Israel on Ashby (2026-09-28).

The slug is the company's JOB-BOARD NAME in Ashby's public posting API
(`api.ashbyhq.com/posting-api/job-board/<name>`), case-sensitive and sometimes
dotted (`Viz.ai`, `Irregular`, `HUMAN`, `Snappy`). Each was verified live on
2026-09-27, with that day's count of openings in Israel. Sisense moved here
from Greenhouse (whose `sisense` board now answers 404).

Batches, as for Comeet and Greenhouse (`registry_seeds.py`): never edit one that
shipped, append a new one.
"""
from __future__ import annotations

from app.core.providers.registry_seeds import SeedBatch, effective

SEED_BATCHES: tuple[SeedBatch, ...] = (
    SeedBatch(
        "ashby:2026-09-28",
        add=(
            {"slug": "moonactive", "name": "Moon Active"},  # 27 in Israel
            {"slug": "lemonade", "name": "Lemonade"},  # 23
            {"slug": "nexxen", "name": "Nexxen"},  # 13
            {"slug": "pointfive", "name": "PointFive"},  # 9
            {"slug": "Irregular", "name": "Irregular"},  # 9
            {"slug": "honeybook", "name": "HoneyBook"},  # 7
            {"slug": "Viz.ai", "name": "Viz.ai"},  # 7
            {"slug": "chainalysis-careers", "name": "Chainalysis"},  # 7
            {"slug": "semperis", "name": "Semperis"},  # 7
            {"slug": "finout", "name": "Finout"},  # 5
            {"slug": "mend-io", "name": "Mend.io"},  # 3
            {"slug": "tzafon", "name": "Tzafon"},  # 3
            {"slug": "sisense", "name": "Sisense"},  # 2
            {"slug": "unit", "name": "Unit"},  # 2
            {"slug": "HUMAN", "name": "HUMAN Security"},  # 2
            {"slug": "pi-security", "name": "Pi Security"},  # 2
            {"slug": "Snappy", "name": "Snappy"},  # 1
        ),
    ),
)

SEED_COMPANIES: list[dict[str, str]] = effective(SEED_BATCHES)
