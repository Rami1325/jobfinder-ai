"""Seed registry of Israeli tech companies hosting careers on Greenhouse.

Every slug was live-verified against the public boards API:
`GET https://boards-api.greenhouse.io/v1/boards/<slug>/jobs` answered 200 with
open positions in Israel (Tel Aviv / Jerusalem / Herzliya…) at probe time.
No token or auth of any kind — the boards API is Greenhouse's official public
job-board feed.

The list is a sequence of BATCHES (`registry_seeds.py`), each applied to a
database once by `app.db.registry_seed.sync_registry`: a batch appended here
reaches production on its first search after the deploy, and a company an admin
removed from the table is never put back. Never edit a batch that has shipped;
append a new one. Admins still grow the registry at runtime via
POST /jobs/greenhouse/companies with a board slug or careers URL.

(Lever was probed in July 2026 on `api.lever.co` alone and found no Israeli
tenant; its EU host holds Mobileye, so Lever has its own provider since
2026-09-28 — providers/lever.py.)
"""
from __future__ import annotations

from app.core.providers.registry_seeds import SeedBatch, effective

SEED_BATCHES: tuple[SeedBatch, ...] = (
    # The July 2026 list (PLAN 9.3), which the old code inserted into an empty table.
    SeedBatch(
        "greenhouse:2026-07",
        legacy=True,
        add=(
            {"slug": "appsflyer", "name": "AppsFlyer"},
            {"slug": "axonius", "name": "Axonius"},
            {"slug": "catonetworks", "name": "Cato Networks"},
            {"slug": "fireblocks", "name": "Fireblocks"},
            {"slug": "forter", "name": "Forter"},
            {"slug": "jfrog", "name": "JFrog"},
            {"slug": "lightricks", "name": "Lightricks"},
            {"slug": "melio", "name": "Melio"},
            {"slug": "orcasecurity", "name": "Orca Security"},
            {"slug": "riskified", "name": "Riskified"},
            {"slug": "similarweb", "name": "Similarweb"},
            {"slug": "sisense", "name": "Sisense"},
            {"slug": "taboola", "name": "Taboola"},
            {"slug": "via", "name": "Via"},
            {"slug": "wizinc", "name": "Wiz"},
            {"slug": "yotpo", "name": "Yotpo"},
        ),
    ),
    # 2026-09-28 (PLAN 32, More places to search): 34 boards verified live on
    # 2026-09-27 (`company_name` checked on each), with the count of their
    # openings in Israel that day. `sisense` retired: its board answers 404
    # (Sisense moved to Ashby, providers/ashby.py). Left out on purpose: `island`
    # (a Greenhouse board of another company; the Israeli Island is on Comeet),
    # `pagaya` (its US board, none in Israel; `pagayais` is Pagaya Israel).
    SeedBatch(
        "greenhouse:2026-09-28",
        add=(
            {"slug": "aidocmedical", "name": "Aidoc"},  # 21 in Israel
            {"slug": "apiiro", "name": "Apiiro"},  # 4
            {"slug": "atbayjobs", "name": "At-Bay"},  # 3
            {"slug": "augury", "name": "Augury"},  # 1
            {"slug": "bigid", "name": "BigID"},  # 1
            {"slug": "capitolis", "name": "Capitolis"},  # 1
            {"slug": "connecteam", "name": "Connecteam"},  # 19
            {"slug": "cymulate", "name": "Cymulate"},  # 3
            {"slug": "datarails", "name": "Datarails"},  # 4
            {"slug": "descope", "name": "Descope"},  # 1
            {"slug": "duda", "name": "Duda"},  # 2
            {"slug": "elastic", "name": "Elastic"},  # 4, a board too large to read whole
            {"slug": "gongio", "name": "Gong"},  # 12
            {"slug": "khealthcareers", "name": "K Health"},  # 1
            {"slug": "lightrun", "name": "Lightrun"},  # 1
            {"slug": "mixtiles", "name": "Mixtiles"},  # 8
            {"slug": "myheritage", "name": "MyHeritage"},  # 6
            {"slug": "nextinsurance66", "name": "Next Insurance"},  # 10
            {"slug": "nice", "name": "NICE"},  # 17
            {"slug": "obligo", "name": "Obligo"},  # 2
            {"slug": "optimove", "name": "Optimove"},  # 3
            {"slug": "pagayais", "name": "Pagaya"},  # 9
            {"slug": "payoneer", "name": "Payoneer"},  # 23
            {"slug": "saltsecurity", "name": "Salt Security"},  # 6
            {"slug": "sentinellabs", "name": "SentinelOne"},  # 11
            {"slug": "tenableinc", "name": "Tenable"},  # 5
            {"slug": "tipaltisolutions", "name": "Tipalti"},  # 6
            {"slug": "tomorrow", "name": "Tomorrow.io"},  # 3
            {"slug": "toriihq", "name": "Torii"},  # 1
            {"slug": "torq", "name": "Torq"},  # 7
            {"slug": "transmitsecurity", "name": "Transmit Security"},  # 13
            {"slug": "tripactions", "name": "Navan"},  # 10
            {"slug": "tulip", "name": "Tulip"},  # 1
            {"slug": "venncity", "name": "Venn"},  # 2
        ),
        retire=("sisense",),
    ),
)

# What a fresh database holds once every batch has run.
SEED_COMPANIES: list[dict[str, str]] = effective(SEED_BATCHES)


def board_url(slug: str) -> str:
    return f"https://job-boards.greenhouse.io/{slug}"
