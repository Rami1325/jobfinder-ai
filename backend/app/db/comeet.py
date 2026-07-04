"""Persistence helpers for the Comeet company registry (comeet_companies).

The registry drives `app.core.providers.comeet`: each row is one company whose
careers board gets queried on a Comeet search. Rows are returned as plain
`CompanyRef` tuples so the provider can use them after the session closes
(and across worker threads) without touching ORM state.
"""
from __future__ import annotations

from typing import NamedTuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.providers.comeet_seed import SEED_COMPANIES, careers_url
from app.db.models import ComeetCompany


class CompanyRef(NamedTuple):
    slug: str
    name: str
    uid: str
    token: str
    careers_url: str


def _ref(row: ComeetCompany) -> CompanyRef:
    return CompanyRef(
        slug=row.slug,
        name=row.name or row.slug,
        uid=row.uid,
        token=row.token or "",
        careers_url=row.careers_url or careers_url(row.slug, row.uid),
    )


def list_companies(db: Session) -> list[CompanyRef]:
    """All registered companies, seeding the table on first use."""
    rows = db.execute(select(ComeetCompany).order_by(ComeetCompany.slug)).scalars().all()
    if not rows:
        for entry in SEED_COMPANIES:
            db.add(
                ComeetCompany(
                    slug=entry["slug"],
                    name=entry["name"],
                    uid=entry["uid"],
                    careers_url=careers_url(entry["slug"], entry["uid"]),
                )
            )
        db.commit()
        rows = db.execute(select(ComeetCompany).order_by(ComeetCompany.slug)).scalars().all()
    return [_ref(r) for r in rows]


def save_tokens(db: Session, tokens: dict[str, str]) -> None:
    """Persist freshly scraped API tokens, keyed by company slug."""
    if not tokens:
        return
    rows = db.execute(
        select(ComeetCompany).where(ComeetCompany.slug.in_(tokens))
    ).scalars().all()
    for row in rows:
        row.token = tokens[row.slug]
    db.commit()


def upsert_company(
    db: Session, *, slug: str, name: str, uid: str, token: str, careers_url: str
) -> CompanyRef:
    """Insert or refresh one company (matched by slug). Re-adding an existing
    company just refreshes its name/uid/token — useful when a token rotated."""
    row = db.execute(
        select(ComeetCompany).where(ComeetCompany.slug == slug)
    ).scalars().first()
    if row is None:
        row = ComeetCompany(slug=slug)
        db.add(row)
    row.name = name
    row.uid = uid
    row.token = token
    row.careers_url = careers_url
    db.commit()
    return _ref(row)
