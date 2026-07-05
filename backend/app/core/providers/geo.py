"""Shared Israeli-geography tokens for providers whose location data is English.

Comeet and Greenhouse both store office locations in English while Israeli
users often search in Hebrew, so their client-side location filters alias the
common city names. Kept here (not in base.py) so the provider abstraction
stays dependency-free of any locale knowledge.
"""
from __future__ import annotations

HE_CITY_ALIASES: dict[str, str] = {
    "תל אביב": "tel aviv",
    "תל אביב-יפו": "tel aviv",
    "ירושלים": "jerusalem",
    "חיפה": "haifa",
    "הרצליה": "herzliya",
    "רמת גן": "ramat gan",
    "בני ברק": "bnei brak",
    "באר שבע": "beer sheva",
    "פתח תקווה": "petah tikva",
    "נתניה": "netanya",
    "רעננה": "raanana",
    "כפר סבא": "kfar saba",
    "רחובות": "rehovot",
    "יקנעם": "yokneam",
    "לוד": "lod",
}

ISRAEL_TOKENS: set[str] = {"israel", "ישראל"}
