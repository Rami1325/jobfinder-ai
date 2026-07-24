"""Writing-profile feedback loop (CV humanization spec, stage 8 / §26).

When the user rejects a tailored edit in the per-bullet review, the AI wording
they rejected is recorded here as a negative signal. Future tailors receive the
list as an avoid-list in the TAILOR user message, so the system stops producing
phrasings this specific candidate has already said no to.

Learned ONLY from explicit user decisions (a reject click), never from
unapproved generated output — the spec's core learning constraint.
"""
from __future__ import annotations

import json

from sqlalchemy.orm import Session

from app.db.models import User

# Newest-first, deduped, capped: enough signal to steer the prompt without
# growing an unbounded blob on the user row.
_MAX_PHRASES = 50
# Phrases longer than this are whole rewritten bullets — too specific to ever
# recur verbatim, and they bloat the prompt. Keep the reusable-phrase range.
_MAX_PHRASE_LEN = 160


def _load(user: User) -> list[str]:
    if not user.writing_prefs_json:
        return []
    try:
        data = json.loads(user.writing_prefs_json)
        return [p for p in data if isinstance(p, str)] if isinstance(data, list) else []
    except json.JSONDecodeError:
        return []


def avoid_phrases(user: User) -> list[str]:
    """The user's rejected phrases, for injection into the TAILOR prompt."""
    return _load(user)


def record_rejected(db: Session, user: User, phrases: list[str]) -> list[str]:
    """Merge newly rejected phrases (newest first), dedupe case-insensitively,
    cap, persist. Returns the stored list."""
    cleaned = [p.strip() for p in phrases if p and p.strip() and len(p.strip()) <= _MAX_PHRASE_LEN]
    merged: list[str] = []
    seen: set[str] = set()
    for p in [*cleaned, *_load(user)]:
        key = " ".join(p.lower().split())
        if key not in seen:
            seen.add(key)
            merged.append(p)
        if len(merged) >= _MAX_PHRASES:
            break
    user.writing_prefs_json = json.dumps(merged, ensure_ascii=False)
    db.commit()
    return merged
