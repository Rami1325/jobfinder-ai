"""Seed registry of Israeli tech companies hosting careers on Comeet.

Every entry was live-verified via its public careers page:
`https://www.comeet.com/jobs/<slug>/<uid>`. The API token is NOT seeded — it
is scraped from the careers page on first search and cached in the DB (see
providers/comeet.py), so entries here can never go stale on token rotation.

The list is a sequence of BATCHES (`registry_seeds.py`), each applied to a
database once by `app.db.registry_seed.sync_registry`, so a batch appended here
reaches production on its first search after the deploy, and a company an admin
removed from the table is never put back. Never edit a batch that has shipped;
append a new one. Admins still grow the registry at runtime via
POST /jobs/comeet/companies with any Comeet careers-page URL.
"""
from __future__ import annotations

from app.core.providers.registry_seeds import SeedBatch, effective

SEED_BATCHES: tuple[SeedBatch, ...] = (
    # The July 2026 list (PLAN 9.2), which the old code inserted into an empty table.
    SeedBatch(
        "comeet:2026-07",
        legacy=True,
        add=(
            {"slug": "Aidoc", "uid": "B4.007", "name": "Aidoc"},
            {"slug": "abra_rnd", "uid": "15.007", "name": "abra R&D"},
            {"slug": "algosec", "uid": "71.006", "name": "AlgoSec"},
            {"slug": "altair-semi", "uid": "88.003", "name": "Sony Semiconductor Israel"},
            {"slug": "checkmarx", "uid": "C0.008", "name": "Checkmarx"},
            {"slug": "codevalue", "uid": "81.009", "name": "CodeValue"},
            {"slug": "crossriver", "uid": "C7.00F", "name": "Cross River"},
            {"slug": "cymotive", "uid": "F1.008", "name": "CYMOTIVE Technologies"},
            {"slug": "dbank", "uid": "F8.004", "name": "Discount Bank"},
            {"slug": "dealhub", "uid": "86.005", "name": "DealHub"},
            {"slug": "drivenets", "uid": "72.006", "name": "DriveNets"},
            {"slug": "esh", "uid": "87.003", "name": "Esh"},
            {"slug": "finubit", "uid": "A9.002", "name": "Finubit"},
            {"slug": "fullpath", "uid": "54.002", "name": "Fullpath"},
            {"slug": "guideline", "uid": "89.009", "name": "Guideline"},
            {"slug": "israeltechguard", "uid": "29.009", "name": "Israel Tech Guard"},
            {"slug": "joinattil", "uid": "38.00A", "name": "AT&T Israel"},
            {"slug": "kaltura", "uid": "E2.00D", "name": "Kaltura"},
            {"slug": "liquiditygroup", "uid": "77.00A", "name": "LIQUiDITY Group"},
            {"slug": "papayaglobal", "uid": "16.005", "name": "Papaya Global"},
            {"slug": "paragon", "uid": "76.006", "name": "Paragon"},
            {"slug": "port", "uid": "59.004", "name": "Port"},
            {"slug": "ptc", "uid": "32.005", "name": "PTC"},
            {"slug": "somekhchaikin", "uid": "F3.007", "name": "KPMG Israel"},
            {"slug": "sunbit", "uid": "37.001", "name": "Sunbit"},
            {"slug": "team8", "uid": "61.003", "name": "Team8"},
            {"slug": "vastdata", "uid": "43.001", "name": "VAST Data"},
            {"slug": "viber", "uid": "04.002", "name": "Viber"},
        ),
    ),
    # 2026-09-28 (PLAN 32, More places to search): 55 companies verified live on
    # 2026-09-27 through their careers page's token and the positions API, with
    # the count of their openings in Israel that day. Four retired: Aidoc,
    # LIQUiDITY and PTC carry no API token on their careers page any more (every
    # search spent a request that could only fail; Aidoc moved to Greenhouse,
    # `aidocmedical`), and CYMOTIVE had no openings at all.
    SeedBatch(
        "comeet:2026-09-28",
        add=(
            {"slug": "anyword", "uid": "30.00B", "name": "Anyword"},  # 1 in Israel
            {"slug": "aquasec", "uid": "91.001", "name": "Aqua Security"},  # 5
            {"slug": "arbe", "uid": "C6.001", "name": "Arbe"},  # 7
            {"slug": "biocatch", "uid": "03.00E", "name": "BioCatch"},  # 9
            {"slug": "bizzabo", "uid": "A5.000", "name": "Bizzabo"},  # 1
            {"slug": "chargeafter", "uid": "C5.004", "name": "ChargeAfter"},  # 4
            {"slug": "cheq", "uid": "65.005", "name": "CHEQ"},  # 3
            {"slug": "Claroty", "uid": "F2.004", "name": "Claroty"},  # 9
            {"slug": "coralogix", "uid": "06.004", "name": "Coralogix"},  # 10
            {"slug": "cyera", "uid": "17.008", "name": "Cyera"},  # 35
            {"slug": "earnix", "uid": "93.00B", "name": "Earnix"},  # 6
            {"slug": "easysend", "uid": "D5.009", "name": "EasySend"},  # 3
            {"slug": "Elementor", "uid": "A3.00F", "name": "Elementor"},  # 1
            {"slug": "empathy", "uid": "F8.007", "name": "Empathy"},  # 2
            {"slug": "etoro", "uid": "41.009", "name": "eToro"},  # 5
            {"slug": "exodigo", "uid": "89.005", "name": "Exodigo"},  # 15
            {"slug": "fiverr", "uid": "60.002", "name": "Fiverr"},  # 16
            {"slug": "flytrex", "uid": "77.003", "name": "Flytrex"},  # 3
            {"slug": "g2risksolutions", "uid": "C9.003", "name": "EverCompliant"},  # 2
            {"slug": "gett", "uid": "A0.002", "name": "Gett"},  # 13
            {"slug": "gloat", "uid": "E5.000", "name": "Gloat"},  # 6
            {"slug": "global-e", "uid": "62.002", "name": "Global-e"},  # 17
            {"slug": "guesty", "uid": "10.000", "name": "Guesty"},  # 4
            {"slug": "healthy", "uid": "B4.004", "name": "Healthy.io"},  # 1
            {"slug": "innoviz", "uid": "52.004", "name": "Innoviz Technologies"},  # 2
            {"slug": "ionix", "uid": "08.003", "name": "Cyberpion"},  # 3
            {"slug": "ironscales", "uid": "1A.007", "name": "IRONSCALES"},  # 4
            {"slug": "island", "uid": "09.00A", "name": "Island"},  # 12
            {"slug": "lumen", "uid": "1A.00E", "name": "Lumen"},  # 3
            {"slug": "lusha", "uid": "73.00B", "name": "Lusha"},  # 9
            {"slug": "minute", "uid": "45.00A", "name": "Minute Media"},  # 4
            {"slug": "naturalint", "uid": "71.001", "name": "Natural Intelligence"},  # 5
            {"slug": "nextsilicon", "uid": "18.007", "name": "NextSilicon"},  # 20
            {"slug": "nymhealth", "uid": "46.005", "name": "Nym Health"},  # 3
            {"slug": "optibus", "uid": "D1.00C", "name": "Optibus"},  # 2
            {"slug": "overwolf", "uid": "B1.001", "name": "Overwolf"},  # 6
            {"slug": "panorays", "uid": "97.00D", "name": "Panorays"},  # 1
            {"slug": "pentera", "uid": "C5.00D", "name": "Pentera"},  # 13
            {"slug": "quantummachines", "uid": "D6.000", "name": "Quantum Machines"},  # 36
            {"slug": "rapyd", "uid": "73.00E", "name": "Rapyd"},  # 16
            {"slug": "razorlabs", "uid": "A5.002", "name": "Razor Labs"},  # 8
            {"slug": "riverside-fm", "uid": "66.009", "name": "Riverside.fm"},  # 15
            {"slug": "scylladb", "uid": "E4.006", "name": "ScyllaDB"},  # 3
            {"slug": "silverfort", "uid": "54.007", "name": "Silverfort"},  # 11
            {"slug": "skai", "uid": "22.00A", "name": "Skai"},  # 9
            {"slug": "thetaray", "uid": "72.00F", "name": "ThetaRay"},  # 4
            {"slug": "toka", "uid": "46.00D", "name": "Toka"},  # 4
            {"slug": "travelier", "uid": "64.006", "name": "Bookaway"},  # 3
            {"slug": "trigo", "uid": "A6.005", "name": "Trigo"},  # 3
            {"slug": "tufin", "uid": "A1.00B", "name": "Tufin"},  # 4
            {"slug": "wiliot", "uid": "F6.003", "name": "Wiliot"},  # 10
            {"slug": "windward", "uid": "31.002", "name": "Windward"},  # 5
            {"slug": "xtend", "uid": "85.00A", "name": "XTEND"},  # 13
            {"slug": "zencity", "uid": "56.00B", "name": "Zencity"},  # 1
            {"slug": "zenity", "uid": "19.000", "name": "Zenity"},  # 10
        ),
        retire=("Aidoc", "liquiditygroup", "ptc", "cymotive"),
    ),
)

# What a fresh database holds once every batch has run: the list the smoke test
# and the handbook count.
SEED_COMPANIES: list[dict[str, str]] = effective(SEED_BATCHES)


def careers_url(slug: str, uid: str) -> str:
    return f"https://www.comeet.com/jobs/{slug}/{uid}"
