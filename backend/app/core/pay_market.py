"""Is this worldwide posting in a country where pay is well below Israel's?
Deterministic: no model, no network, no clock.

One consumer: `job_search.search_jobs`, which hides a WORLDWIDE-origin posting
whose card location names a country below the line, before the result slots are
filled (Phase 30 J). LinkedIn's "European Union" location returns postings in
every member state, and the owner's daily email carried Sofia and Bucharest.

THE RULE, WITH ITS SOURCE. A country is high-pay when its GNI per capita, Atlas
method, current US$, 2025 (World Bank indicator NY.GNP.PCAP.CD) is at least 85%
of Israel's. Israel is $56,180, so the line is $47,753. Retrieved 2026-09-15 from
api.worldbank.org; the source was last updated 2026-07-13. Two other lines were
measured and rejected:
  - The World Bank's own "high income" group (FY27: above $14,375) contains
    Bulgaria ($17,780), Romania, Poland, Croatia, Greece and Portugal. As a
    filter it would drop nothing.
  - Israel's own level drops the United Kingdom (97.1%), one of the three
    markets the worldwide pass queries, by three points.
FRANCE IS THE CLOSEST KEEP, at 86.6%. If the owner asks to drop it, that is one
code out of `HIGH_PAY_COUNTRIES` and nothing else.

THREE ANSWERS, NEVER TWO. True (a high-pay country is named), False (a named
country below the line), None (nothing we can place: an empty location, a region
tag such as "European Union", "EMEA" or "Remote", or a string no table knows).
Only False hides anything. An unfamiliar format must never silently delete a
real job, so unknown is KEPT; LinkedIn names the country for every non-US
location seen in production, so the filter does not need to guess.

Every code this module can return has a 2025 figure on the same side of the line
as its verdict, checked against the data rather than assumed. So five countries a
remote posting might name are deliberately ABSENT from the tables and read as
unknown: Qatar ($74,330, 132% of Israel) and Hong Kong ($62,500, 111%) are above
the line; the UAE has no 2025 figure ($51,550, 91.8%, in 2024); Liechtenstein and
Taiwan have no World Bank figure at all. Listing any of them would hide jobs the
rule keeps.

ONE PLACE IS KEPT AGAINST ITS OWN FIGURE, BY DECISION: PUERTO RICO. The World
Bank lists it as its own economy at $27,320 for 2025 (48.6% of Israel's, below
the line). But it is a US jurisdiction that LinkedIn writes as a US place ("San
Juan, PR"), and the build spec folds it into the US beside DC, so "PR" and
"puerto rico" read as the US and the posting is kept: the direction every place
this module could read two ways errs in. Hiding it is those two table entries
plus the smoke check that pins the decision.

How `country_of` reads a location. The order is the algorithm:
  1. Fold: NFKD, strip combining marks, casefold, plus the few letters NFKD
     leaves whole (ł ø đ ı æ œ), so "Île-de-France" is "ile-de-france" and
     "Łódź" is "lodz". Split on commas and drop empty segments.
  2. The LAST segment names a country: that country. Checked first, so a
     spelled-out country always wins ("London, Ontario, Canada" is Canada).
  3. The last segment, in its ORIGINAL casing, is a US state code: the US.
     LinkedIn writes US places "Chicago, IL". Only an uppercase pair counts, so
     "de" or "in" as a lowercase word is never Delaware or Indiana. An ISO code
     written the same way ("Valletta, MT") reads as a state, which errs toward
     keeping the posting.
  4. The last segment is a full US state name: the US.
  5. The first segment, then the last, is a city or metro in the table: its
     country.
Metro wording ("Greater ...", "... Metropolitan Area", "... Area", "... Region")
is stripped wherever a segment is looked up, so "Greater Warsaw Area" is Warsaw
and "Naples, Florida Metropolitan Area" is Florida, never Naples.

THE GEORGIA AND JERSEY TRAPS. "Atlanta, GA" is the US, and the country Georgia
shares the state's name; "Jersey City, NJ" is the US, and Jersey is an island.
So neither "georgia" nor "jersey" is an alias, and a location whose last segment
is one of them is UNKNOWN before the city table runs: otherwise "Athens, Georgia"
(a US city) would read as Greece and hide a US job. "Tbilisi, Georgia" is
unknown by design.

Tel Aviv is deliberately NOT in the city table. The caller never classifies a
posting the user's own location query returned (its gate is the origin stamp),
so an Israeli city here would be a decision nothing can reach.
"""
from __future__ import annotations

import re
import unicodedata

# ISO 3166-1 alpha-2, with each country's 2025 GNI per capita as a share of
# Israel's. Everything this module can name that is not here is below the line.
HIGH_PAY_COUNTRIES: frozenset[str] = frozenset(
    {
        "IL",  # Israel, 100.0 (the reference)
        "US",  # United States, 158.1
        "GB",  # United Kingdom, 97.1
        "CA",  # Canada, 100.4
        "AU",  # Australia, 114.1
        "SG",  # Singapore, 145.5
        "CH",  # Switzerland, 196.4
        "NO",  # Norway, 173.2
        "IS",  # Iceland, 158.8
        "IE",  # Ireland, 155.5
        "LU",  # Luxembourg, 170.4
        "DK",  # Denmark, 137.4
        "NL",  # Netherlands, 122.0
        "SE",  # Sweden, 112.2
        "AT",  # Austria, 107.4
        "DE",  # Germany, 107.2
        "BE",  # Belgium, 105.9
        "FI",  # Finland, 98.3
        "FR",  # France, 86.6 (the closest keep)
    }
)

# Country names as boards write them, folded. Below the line, for reference:
# New Zealand 83.0, Italy 74.9, Malta 74, Japan 68.2, Spain 66.1, Cyprus 64,
# Slovenia 63, Czechia 58.7, Estonia 58, Lithuania 54, Portugal 53.3, Slovakia 47,
# Poland 45.4, Greece 45.1, Croatia 45.1, Latvia 44, Hungary 42, Romania 35.9,
# Bulgaria 31.6. NOT here: "georgia" and "jersey" (see _AMBIGUOUS), and Qatar,
# Hong Kong, the UAE, Liechtenstein and Taiwan (see the module docstring).
_COUNTRIES: dict[str, str] = {
    # The EU27.
    "austria": "AT", "belgium": "BE", "bulgaria": "BG", "croatia": "HR", "cyprus": "CY",
    "czechia": "CZ", "czech republic": "CZ", "denmark": "DK", "estonia": "EE",
    "finland": "FI", "france": "FR", "germany": "DE", "greece": "GR", "hungary": "HU",
    "ireland": "IE", "italy": "IT", "latvia": "LV", "lithuania": "LT", "luxembourg": "LU",
    "malta": "MT", "netherlands": "NL", "the netherlands": "NL", "poland": "PL",
    "portugal": "PT", "romania": "RO", "slovakia": "SK", "slovak republic": "SK",
    "slovenia": "SI", "spain": "ES", "sweden": "SE",
    # The rest of the EEA, and Switzerland.
    "iceland": "IS", "norway": "NO", "switzerland": "CH",
    # The UK and the US, every way a board writes them.
    "united kingdom": "GB", "uk": "GB", "great britain": "GB", "england": "GB",
    "scotland": "GB", "wales": "GB", "northern ireland": "GB",
    "united states": "US", "united states of america": "US", "usa": "US", "us": "US",
    "canada": "CA", "australia": "AU", "new zealand": "NZ", "singapore": "SG",
    "japan": "JP", "israel": "IL",
    # Common origins of remote hiring outside the EU.
    "india": "IN", "ukraine": "UA", "serbia": "RS", "turkey": "TR", "turkiye": "TR",
    "egypt": "EG", "philippines": "PH", "pakistan": "PK", "vietnam": "VN",
    "viet nam": "VN", "brazil": "BR", "mexico": "MX", "argentina": "AR",
    "colombia": "CO", "south africa": "ZA", "nigeria": "NG", "kenya": "KE",
    "saudi arabia": "SA", "russia": "RU", "russian federation": "RU", "belarus": "BY",
    "moldova": "MD", "north macedonia": "MK", "macedonia": "MK", "albania": "AL",
    "bosnia and herzegovina": "BA", "montenegro": "ME", "kosovo": "XK",
    "armenia": "AM", "azerbaijan": "AZ", "kazakhstan": "KZ", "uzbekistan": "UZ",
    "morocco": "MA", "tunisia": "TN", "china": "CN", "south korea": "KR",
    "korea": "KR", "thailand": "TH", "malaysia": "MY", "indonesia": "ID",
}

# Two-letter US codes as LinkedIn writes them: the 50 states, DC and Puerto Rico
# (the US by decision, although below the line on its own figure: see the docstring).
# Compared in the segment's ORIGINAL casing, so only an uppercase pair matches.
_US_STATE_CODES: frozenset[str] = frozenset(
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE "
    "NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR".split()
)

# Full state names, folded. "georgia" is missing on purpose: it is also a country.
# "puerto rico" is here by the same decision as "PR" above.
_US_STATES: frozenset[str] = frozenset(
    {
        "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
        "connecticut", "delaware", "florida", "hawaii", "idaho", "illinois", "indiana",
        "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts",
        "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska",
        "nevada", "new hampshire", "new jersey", "new mexico", "new york",
        "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
        "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah",
        "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming",
        "district of columbia", "puerto rico",
    }
)

# A last segment that names two different places is unknown, and the city table
# may not guess past it (see the module docstring).
_AMBIGUOUS: frozenset[str] = frozenset({"georgia", "jersey"})

# Cities and metros, folded, for a location that names no country or state.
_CITIES: dict[str, str] = {
    # High-pay hubs.
    "london": "GB", "manchester": "GB", "edinburgh": "GB",
    "dublin": "IE", "cork": "IE",
    "berlin": "DE", "munich": "DE", "hamburg": "DE", "frankfurt": "DE",
    "cologne": "DE", "stuttgart": "DE",
    "amsterdam": "NL", "rotterdam": "NL", "the hague": "NL", "utrecht": "NL",
    "eindhoven": "NL", "randstad": "NL",
    "paris": "FR", "lyon": "FR",
    "stockholm": "SE", "gothenburg": "SE",
    "copenhagen": "DK", "helsinki": "FI", "vienna": "AT",
    "brussels": "BE", "antwerp": "BE", "luxembourg": "LU",
    "zurich": "CH", "geneva": "CH", "oslo": "NO",
    # US metros LinkedIn names without a state.
    "st. louis": "US", "new york city": "US", "boston": "US", "seattle": "US",
    "chicago": "US", "los angeles": "US", "san francisco bay": "US", "denver": "US",
    "austin": "US", "dallas-fort worth": "US", "atlanta": "US",
    "washington dc-baltimore": "US", "philadelphia": "US", "houston": "US",
    "miami-fort lauderdale": "US", "minneapolis-st. paul": "US", "phoenix": "US",
    "detroit": "US", "salt lake city": "US", "raleigh-durham-chapel hill": "US",
    "pittsburgh": "US", "nashville": "US", "portland": "US",
    # Low-pay hubs.
    "sofia": "BG", "plovdiv": "BG", "varna": "BG",
    "bucharest": "RO", "cluj-napoca": "RO", "iasi": "RO", "timisoara": "RO", "brasov": "RO",
    "warsaw": "PL", "krakow": "PL", "wroclaw": "PL", "gdansk": "PL", "poznan": "PL",
    "lodz": "PL", "katowice": "PL",
    "budapest": "HU", "prague": "CZ", "brno": "CZ", "bratislava": "SK",
    "lisbon": "PT", "porto": "PT",
    "madrid": "ES", "barcelona": "ES", "valencia": "ES", "seville": "ES", "malaga": "ES",
    "milan": "IT", "rome": "IT", "turin": "IT", "naples": "IT",
    "athens": "GR", "thessaloniki": "GR",
    "zagreb": "HR", "ljubljana": "SI", "tallinn": "EE", "riga": "LV",
    "vilnius": "LT", "kaunas": "LT", "nicosia": "CY", "limassol": "CY", "valletta": "MT",
    "belgrade": "RS", "novi sad": "RS", "kyiv": "UA", "lviv": "UA", "istanbul": "TR",
    "bengaluru": "IN", "bangalore": "IN", "hyderabad": "IN", "pune": "IN",
    "cairo": "EG", "manila": "PH", "sao paulo": "BR", "mexico city": "MX",
    "buenos aires": "AR",
}

# The letters NFKD leaves whole, so every table above can be written in ASCII.
_LETTERS = str.maketrans({"ł": "l", "ø": "o", "đ": "d", "ı": "i", "æ": "ae", "œ": "oe"})
_PREFIX_RE = re.compile(r"^(?:greater|the)\s+", re.IGNORECASE)
_SUFFIX_RE = re.compile(
    r"\s+(?:metropolitan area|metropolitan region|metro area|area|region)$", re.IGNORECASE
)


def _segments(location: str) -> list[str]:
    """Comma segments with the combining marks removed and whitespace collapsed.
    CASE IS KEPT, because a US state code is recognised by being uppercase."""
    decomposed = unicodedata.normalize("NFKD", location or "")
    plain = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return [" ".join(seg.split()) for seg in plain.split(",") if seg.strip()]


def _fold(text: str) -> str:
    return text.casefold().translate(_LETTERS)


def _variants(segment: str) -> list[str]:
    """The segment as written, then without its metro wording: the suffix alone,
    the prefix alone, both. Suffix-only comes before any prefix strip so "The
    Hague Metropolitan Area" still reaches "The Hague", whose "The" is its name."""
    bare = _SUFFIX_RE.sub("", segment)
    out: list[str] = []
    for form in (segment, bare, _PREFIX_RE.sub("", segment), _PREFIX_RE.sub("", bare)):
        if form and form not in out:
            out.append(form)
    return out


def country_of(location: str) -> str | None:
    """The ISO 3166-1 alpha-2 code of the country a card location names, or None
    when it names nothing we can place. The order is in the module docstring."""
    segments = _segments(location)
    if not segments:
        return None
    last = _variants(segments[-1])
    last_folded = [_fold(form) for form in last]
    for form in last_folded:
        if form in _COUNTRIES:
            return _COUNTRIES[form]
    if any(form in _US_STATE_CODES for form in last):
        return "US"
    if any(form in _AMBIGUOUS for form in last_folded):
        return None
    if any(form in _US_STATES for form in last_folded):
        return "US"
    for segment in dict.fromkeys((segments[0], segments[-1])):
        for form in _variants(segment):
            code = _CITIES.get(_fold(form))
            if code:
                return code
    return None


def high_pay_market(location: str) -> bool | None:
    """True = a high-pay country is named; False = a named country below the line;
    None = unknown (empty, a region tag like "European Union"/"EMEA"/"Remote",
    or a string we cannot place). Only False ever hides anything."""
    code = country_of(location)
    if code is None:
        return None
    return code in HIGH_PAY_COUNTRIES
