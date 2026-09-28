"""Seed registry of companies with openings in Israel on SmartRecruiters (2026-09-28).

The slug is the company IDENTIFIER in SmartRecruiters' public posting URLs
(`jobs.smartrecruiters.com/<identifier>/...`), which is not guessable from the
name: Check Point is `CheckPointSoftwareTechnologies2`, Wix is `Wix2`, and
Armis's Israeli roles are on `ServiceNow`. Each was verified live on
2026-09-27 with `country=il`, with that day's count.

Batches, as for Comeet and Greenhouse (`registry_seeds.py`): never edit one that
shipped, append a new one.
"""
from __future__ import annotations

from app.core.providers.registry_seeds import SeedBatch, effective

SEED_BATCHES: tuple[SeedBatch, ...] = (
    SeedBatch(
        "smartrecruiters:2026-09-28",
        add=(
            {"slug": "CheckPointSoftwareTechnologies2", "name": "Check Point Software Technologies"},  # 105 in Israel
            {"slug": "Wix2", "name": "Wix"},  # 34
            {"slug": "ServiceNow", "name": "ServiceNow"},  # 11, the Armis roles
        ),
    ),
)

SEED_COMPANIES: list[dict[str, str]] = effective(SEED_BATCHES)
