"""A posting's employment type, read from the BOARD's own field, never from its words.

2026-09-28 (freelance, the small version). The label a job row shows when the
posting is NOT plain full-time: Contract, Freelance, Also freelance, Temporary,
Part-time, Internship. Nothing is shown for full-time, for a board that states no
type, or for a value this module does not know: unknown is never "full-time" and
never a guess, and a "Full-time" chip on every card would be noise.

NEVER FROM THE TITLE, and that is the point of this module. In Israel "Contract"
or "חוזה" in a title usually means a fixed-term EMPLOYEE, and LinkedIn itself
labels those postings Full-time ("Software Engineer - 12 Month Fixed-Term
Contract", measured 2026-09-27). A matcher on the word would label them
contractors. So each board's own field is read, by its own reader here, and a
board with no such field gets no label:

- LinkedIn: the guest job page's "Employment type" criterion (read in
  `providers/linkedin.py`, on the page the search already fetches), one of
  Full-time, Part-time, Contract, Temporary, Internship, Volunteer, Other.
- JobMaster: the card's `jobType` list ("משרה חלקית , משרה מלאה , פרילאנס"),
  which names every arrangement the employer ticked (`from_jobmaster`).
- Drushim: `JobContent.Scopes` codes, 3 = משרה זמנית, 2 = משרה חלקית, 1 = משרה
  מלאה; there is no freelance code (`from_drushim_scopes`).
- Lever `categories.commitment`, SmartRecruiters `typeOfEmployment`, Ashby
  `employmentType`, Himalayas `employmentType` and Comeet `employment_type`:
  English values, read EXACTLY (after case, spaces and punctuation), never as a
  word inside a longer value (`from_field`). Greenhouse states no type.

No filter reads this (docs/handbook/job-search.md, *The employment type*): on the
Israeli boards it would mostly return nothing.

Deterministic: no model, no network, no clock (AST-pinned by the smoke test).
"""
from __future__ import annotations

import re

EMPLOYMENT_TYPES = (  # one quoted entry per line: check-mirrors 103 reads it
    "contract",
    "freelance",
    "also_freelance",
    "temporary",
    "part_time",
    "internship",
)

# An English board field, after case, spaces and punctuation are taken out.
# Full-time and permanent are plain (no label), and so is anything not here.
_FIELD: dict[str, str] = {
    "parttime": "part_time",
    "contract": "contract",
    "contractor": "contract",
    "contracttohire": "contract",
    "freelance": "freelance",
    "freelancer": "freelance",
    "temporary": "temporary",
    "temp": "temporary",
    "internship": "internship",
    "intern": "internship",
}
_NOT_LETTERS = re.compile(r"[^a-z]+")

# JobMaster's type list, as the board spells it (the alef spelling פרילאנס is the
# board's own; פרילנס is how people write it).
_JM_FREELANCE = {"פרילאנס", "פרילנס", "פרי לאנס"}
_JM_FULL = {"משרה מלאה"}
_JM_PART = {"משרה חלקית"}
_JM_TEMPORARY = {"עבודה זמנית", "משרה זמנית"}

# Drushim's scope codes (measured on 11 queries, 2026-09-27).
_DRUSHIM_FULL, _DRUSHIM_PART, _DRUSHIM_TEMPORARY = 1, 2, 3


def from_field(value: object) -> str:
    """A board's English employment field, as a label ("" for plain or unknown).

    Exact after normalising, so "Full-time", "FullTime" and "full time" are one
    value, and "Contract" is contract while "Fixed-Term Contract" or "Contract -
    6 months" (a value no board sends as its type, but a title could) is not."""
    if not isinstance(value, str):
        return ""
    return _FIELD.get(_NOT_LETTERS.sub("", value.lower()), "")


def from_jobmaster(job_type: object) -> str:
    """JobMaster's `jobType` list as ONE honest label.

    Freelance only when it is listed, and "also freelance" when an employee
    arrangement (full-time or part-time) is listed beside it, since the posting
    then offers both. Temporary whenever it is listed. Part-time only when it
    stands without full-time: "full-time, part-time" is either, so no label.
    Shifts (משמרות) and anything unknown say nothing."""
    if not isinstance(job_type, str):
        return ""
    listed = {" ".join(part.split()) for part in job_type.split(",") if part.strip()}
    if listed & _JM_FREELANCE:
        return "also_freelance" if listed & (_JM_FULL | _JM_PART) else "freelance"
    if listed & _JM_TEMPORARY:
        return "temporary"
    if listed & _JM_PART and not listed & _JM_FULL:
        return "part_time"
    return ""


def from_drushim_scopes(scopes: object) -> str:
    """Drushim's `JobContent.Scopes` as a label: temporary whenever code 3 is
    listed (a temporary job is temporary, full-time or not: "משרה זמנית לשלושה
    חודשים" lists all three codes), part-time when code 2 stands without code
    1, and nothing else (Drushim has no freelance code)."""
    codes: set[int] = set()
    for scope in scopes if isinstance(scopes, list) else []:
        code = scope.get("Code") if isinstance(scope, dict) else None
        if isinstance(code, int) and not isinstance(code, bool):
            codes.add(code)
    if _DRUSHIM_TEMPORARY in codes:
        return "temporary"
    if _DRUSHIM_PART in codes and _DRUSHIM_FULL not in codes:
        return "part_time"
    return ""
