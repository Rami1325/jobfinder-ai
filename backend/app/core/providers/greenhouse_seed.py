"""Seed registry of Israeli tech companies hosting careers on Greenhouse.

Every slug was live-verified against the public boards API (July 2026):
`GET https://boards-api.greenhouse.io/v1/boards/<slug>/jobs` answered 200 with
open positions in Israel (Tel Aviv / Jerusalem / Herzliya…) at probe time.
No token or auth of any kind — the boards API is Greenhouse's official public
job-board feed.

Users grow this registry at runtime via POST /jobs/greenhouse/companies with a
board slug or careers URL; rows live in the `greenhouse_companies` table and
this list is only inserted when that table is empty.

(Lever was probed the same day with 60+ Israeli-company slug candidates against
a verified-working API and found ZERO Israeli tenants — the local ecosystem is
on Comeet/Greenhouse — so no Lever provider exists. See PLAN.md 9.3.)
"""
from __future__ import annotations

SEED_COMPANIES: list[dict[str, str]] = [
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
]


def board_url(slug: str) -> str:
    return f"https://job-boards.greenhouse.io/{slug}"
