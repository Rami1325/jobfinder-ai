"""Seed registry of Israeli tech companies hosting careers on Comeet.

Every entry was live-verified via its public careers page (July 2026):
`https://www.comeet.com/jobs/<slug>/<uid>`. The API token is NOT seeded — it
is scraped from the careers page on first search and cached in the DB (see
providers/comeet.py), so entries here can never go stale on token rotation.

Users grow this registry at runtime via POST /jobs/comeet/companies with any
Comeet careers-page URL; rows live in the `comeet_companies` table and this
list is only inserted when that table is empty.
"""
from __future__ import annotations

SEED_COMPANIES: list[dict[str, str]] = [
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
]


def careers_url(slug: str, uid: str) -> str:
    return f"https://www.comeet.com/jobs/{slug}/{uid}"
