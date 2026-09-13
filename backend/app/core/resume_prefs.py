"""Per-user resume preferences (spec 07 / R1): `users.resume_prefs_json`.

One switch today — leave Arabic off tailored resumes for jobs in Israel. OFF by
default for every user, and an unreadable row reads as the default, never as ON:
the preference removes a true fact from a document, so a corrupt row must fail
toward the document the user uploaded.

SENSITIVE: the switch implies the user's ethnicity. `_wipe_user_rows` clears
the column exactly like `search_prefs_json` / `writing_prefs_json`.
"""
from __future__ import annotations

from app.db.models import User
from app.models import ResumePrefs


def load(user: User) -> ResumePrefs:
    raw = getattr(user, "resume_prefs_json", "") or ""
    if not raw:
        return ResumePrefs()
    try:
        return ResumePrefs.model_validate_json(raw)
    except Exception:  # noqa: BLE001 - legacy/corrupt row: the default, never ON
        return ResumePrefs()


def hide_arabic_in_israel(user: User) -> bool:
    return load(user).hide_arabic_in_israel


def dump(prefs: ResumePrefs) -> str:
    return prefs.model_dump_json()
