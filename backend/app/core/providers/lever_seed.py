"""Seed registry of companies with openings in Israel on Lever (2026-09-28).

Each entry names its API HOST: Lever runs two regions, `api.lever.co` and
`api.eu.lever.co`, and a site lives on one. The July 2026 probe that found "no
Israeli tenant" asked the first host only; Mobileye is on the EU host. Every
site was verified live on 2026-09-27 through the postings API on its host, with
that day's count of openings in Israel. Site names are case-sensitive (`Zadara`).

Batches, as for Comeet and Greenhouse (`registry_seeds.py`): never edit one that
shipped, append a new one.
"""
from __future__ import annotations

from app.core.providers.registry_seeds import SeedBatch, effective

US = "api.lever.co"
EU = "api.eu.lever.co"

SEED_BATCHES: tuple[SeedBatch, ...] = (
    SeedBatch(
        "lever:2026-09-28",
        add=(
            {"slug": "mobileye", "name": "Mobileye", "host": EU},  # 145 in Israel of 172
            {"slug": "walkme", "name": "WalkMe", "host": US},  # 4
            {"slug": "cloudinary", "name": "Cloudinary", "host": US},  # 4
            {"slug": "houzz", "name": "Houzz", "host": US},  # 4
            {"slug": "lendbuzz", "name": "Lendbuzz", "host": US},  # 4
            {"slug": "traildsoftware", "name": "Traild", "host": US},  # 2
            {"slug": "Zadara", "name": "Zadara", "host": US},  # 2
        ),
    ),
)

SEED_COMPANIES: list[dict[str, str]] = effective(SEED_BATCHES)
