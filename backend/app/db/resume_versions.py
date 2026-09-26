"""Undo buffer for the master resume (PLAN 20.8 / N1).

`PUT /profile/resume` overwrites `saved_resumes` in place. The Builder saves,
the Skills editor saves, a re-upload replaces — and until this module existed a
bad one was unrecoverable, for the single most valuable object a user owns.

Shape, deliberately small: snapshot the OUTGOING row just before each overwrite,
keep the newest `MAX_VERSIONS` per (user, language), and offer a restore that
snapshots the current state on its way past — so restoring is itself undoable
and a mis-click can't be the thing that loses the resume.

All reads and writes are scoped to one user, same as `db.history`.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db.models import SavedResume, SavedResumeVersion

# Newest kept per (user, language). An undo buffer, not an archive: these rows
# hold a full resume each, and nobody is scrolling back past twenty saves.
MAX_VERSIONS = 20

# An autosave keeps at most one restore point per this much editing (PLAN
# 31.6/1). Autosave writes a pause after every change, and a snapshot per write
# would spend the twenty slots in a few minutes of typing, the uploaded
# original first. Measured on nothing: a round number a person would call "a
# while ago", which is what a restore point is for.
COALESCE_WINDOW = timedelta(minutes=30)


def list_versions(db: Session, user_id: int, language: str = "") -> list[SavedResumeVersion]:
    """The user's snapshots, newest first, optionally for one language slot."""
    stmt = select(SavedResumeVersion).where(SavedResumeVersion.user_id == user_id)
    if language:
        stmt = stmt.where(SavedResumeVersion.language == language)
    return list(
        db.execute(
            stmt.order_by(SavedResumeVersion.created_at.desc(), SavedResumeVersion.id.desc())
            .limit(MAX_VERSIONS * 2)  # both language slots at once
        ).scalars().all()
    )


def owned_version(db: Session, version_id: int, user_id: int) -> SavedResumeVersion | None:
    row = db.get(SavedResumeVersion, version_id)
    return row if row and row.user_id == user_id else None


def snapshot(
    db: Session, row: SavedResume, incoming_json: str, *, autosave: bool = False
) -> SavedResumeVersion | None:
    """Record `row`'s CURRENT content as a version. Call BEFORE overwriting it.

    Returns the new version, or None when there is nothing worth keeping:
    an empty row (the first ever save overwrites nothing), or an `incoming_json`
    byte-identical to what is already there — a save that changes nothing is
    not a restore point. That case is common, not theoretical: the Skills editor
    saves whether or not chips changed, and a re-upload of the same file lands
    the same JSON. Comparing against the newest stored VERSION instead of
    against the row is the obvious-looking version of this check and it is
    wrong — it lets an unchanged save through whenever the previous save did
    change something.

    An AUTOSAVE over content that an autosave wrote is coalesced: no version
    while the slot's newest one is younger than `COALESCE_WINDOW`. Content that
    arrived any other way (an upload, a restore, a save the user asked for) is
    always kept on its way out, so the first keystroke after an upload records
    the upload itself, the restore point that matters most.

    Does not commit: the caller is mid-transaction on the same session, and
    committing here would split the snapshot from the write it exists to protect.
    """
    if not (row.resume_json or "").strip():
        return None
    if row.resume_json == incoming_json:
        return None
    language = row.language or "en"
    if autosave and row.autosaved and _newest_age(db, row.user_id, language) < COALESCE_WINDOW:
        return None

    version = SavedResumeVersion(
        user_id=row.user_id,
        label=row.label,
        language=language,
        resume_json=row.resume_json,
        ledger_json=row.ledger_json,
    )
    db.add(version)
    db.flush()  # need its id before trimming, and to order it against the rest
    _trim(db, row.user_id, language)
    return version


def _newest_age(db: Session, user_id: int | None, language: str) -> timedelta:
    """How long ago this slot's newest version was taken; forever when none."""
    newest = db.execute(
        select(SavedResumeVersion.created_at)
        .where(SavedResumeVersion.user_id == user_id, SavedResumeVersion.language == language)
        .order_by(SavedResumeVersion.created_at.desc(), SavedResumeVersion.id.desc())
        .limit(1)
    ).scalar()
    if newest is None:
        return timedelta.max
    if newest.tzinfo is None:
        newest = newest.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - newest


def _trim(db: Session, user_id: int | None, language: str) -> None:
    keep = db.execute(
        select(SavedResumeVersion.id)
        .where(
            SavedResumeVersion.user_id == user_id,
            SavedResumeVersion.language == language,
        )
        .order_by(SavedResumeVersion.created_at.desc(), SavedResumeVersion.id.desc())
        .limit(MAX_VERSIONS)
    ).scalars().all()
    db.execute(
        delete(SavedResumeVersion).where(
            SavedResumeVersion.user_id == user_id,
            SavedResumeVersion.language == language,
            SavedResumeVersion.id.not_in(keep),
        )
    )
