"""The client-side filters of the whole-board providers added 2026-09-28 (Lever,
Ashby, SmartRecruiters, Himalayas): does a posting's title answer the search,
and is it in the place the search asked for.

Comeet and Greenhouse keep their own two functions (older, pinned as they are);
these add one thing they lack: a posting is IN ISRAEL when its board's own
country field says so, or when one of its location fields names an Israeli
place. Never its description: an Israeli company's board carries postings in
Beijing and Boston whose "about us" says "headquartered in Israel", and a
posting is where it says it is, not where its company is.

A Latin place name must stand as a whole word ("lod" is inside "lodging"); a
Hebrew one is a bare substring, because ב/ל/ה/ו/מ/ש glue onto the noun (the
house rule).
"""
from __future__ import annotations

import re
from typing import Iterable

from app.core.providers.geo import HE_CITY_ALIASES, ISRAEL_TOKENS

# Israeli places as boards write them in English, beyond the aliases' targets.
_ISRAELI_PLACES_EN: tuple[str, ...] = tuple(
    sorted(
        set(HE_CITY_ALIASES.values())
        | {
            "israel", "tel aviv", "tel-aviv", "tel aviv-yafo", "tel aviv yafo", "tlv", "jerusalem", "haifa",
            "herzliya", "herzelia", "ramat gan", "petah tikva", "petach tikva", "petah tiqva", "netanya",
            "beer sheva", "be'er sheva", "beersheba", "rehovot", "raanana", "ra'anana", "kfar saba",
            "bnei brak", "yokneam", "yoqneam", "hod hasharon", "rosh haayin", "rosh ha'ayin", "modiin",
            "caesarea", "airport city", "or yehuda", "holon", "rishon lezion", "rishon le zion",
            "ness ziona", "nes ziona", "migdal haemek", "kiryat gat", "yavne", "ashdod", "ashkelon",
            "nazareth", "karmiel", "lod", "givatayim", "bat yam", "hadera", "eilat", "kfar yona",
            "sderot", "ofakim", "dimona",
        }
    )
)
_ISRAELI_PLACES_HE: tuple[str, ...] = tuple(sorted(set(HE_CITY_ALIASES) | ISRAEL_TOKENS - {"israel"}))
_EN_PLACE_RE = re.compile(r"\b(?:" + "|".join(re.escape(p) for p in _ISRAELI_PLACES_EN) + r")\b")
_ISRAEL_COUNTRY = {"il", "isr", "israel", "ישראל"}


def title_words_match(job_title: str, *hay: str) -> bool:
    """Every word of the wanted title (two letters or more, `+` and `#` kept for
    C++ and C#) appears somewhere in the posting's title, team or description.
    Word characters include Hebrew. The rule Comeet and Greenhouse filter by."""
    tokens = [t for t in re.split(r"[^\w+#]+", job_title.lower()) if len(t) >= 2]
    if not tokens:
        return True
    text = " ".join(h for h in hay if h).lower()
    return all(t in text for t in tokens)


def in_israel(places: Iterable[str], country: str = "") -> bool | None:
    """True when the board's country field is Israel or a location field names an
    Israeli place; False when there is location data and none of it is Israeli;
    None when the posting carries no location data at all (unknown, never "not
    in Israel": a missing field must not hide a job)."""
    country = (country or "").strip().lower()
    if country in _ISRAEL_COUNTRY:
        return True
    texts = [p.strip().lower() for p in places if p and p.strip()]
    if not texts and not country:
        return None
    for text in texts:
        if _EN_PLACE_RE.search(text) or any(h in text for h in _ISRAELI_PLACES_HE):
            return True
    return False


def place_matches(wanted: str, places: Iterable[str], country: str = "") -> bool:
    """Is the posting where the search asked? `wanted` is the search's location,
    comma-separated ("Tel Aviv, Israel"); a posting matches when any part does.
    A part naming Israel matches every posting `in_israel`; a city matches a
    location field that contains it (Hebrew city names read as their English
    form). A posting with no location data is kept, as on the other boards."""
    tokens = [t.strip().lower() for t in wanted.split(",") if t.strip()]
    if not tokens:
        return True
    places = [p for p in places if p and p.strip()]
    israeli = in_israel(places, country)
    if israeli is None:
        return True
    texts = [p.strip().lower() for p in places]
    for token in tokens:
        token = HE_CITY_ALIASES.get(token, token)
        if token in ISRAEL_TOKENS:
            if israeli:
                return True
            continue
        if any(token in text for text in texts):
            return True
    return False
