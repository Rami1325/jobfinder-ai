"""SQLAlchemy engine/session setup (SQLite)."""
from __future__ import annotations

from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import get_settings

settings = get_settings()


def _normalize_url(url: str) -> str:
    """Neon/Heroku-style URLs use postgres:// (or bare postgresql://);
    SQLAlchemy needs the driver-qualified scheme for psycopg v3."""
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+psycopg://", 1)
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


_url = _normalize_url(settings.database_url)
_connect_args = {"check_same_thread": False} if _url.startswith("sqlite") else {}
# pool_pre_ping/pool_recycle are no-ops for SQLite but essential for Neon,
# whose pooler drops idle connections between serverless invocations.
engine = create_engine(_url, connect_args=_connect_args, pool_pre_ping=True, pool_recycle=300)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _default_clause(col) -> str | None:
    """Render a column's static default as a SQL literal, or None if not expressible."""
    default = getattr(col.default, "arg", None)
    if default is None or callable(default):
        return None
    if isinstance(default, bool):
        if engine.dialect.name == "sqlite":
            return "1" if default else "0"
        return "TRUE" if default else "FALSE"
    if isinstance(default, (int, float)):
        return str(default)
    return "'" + str(default).replace("'", "''") + "'"


def _migrate_missing_columns() -> None:
    """Lightweight migration shim: ADD COLUMN for ORM columns missing from live tables.

    create_all only creates missing tables — it never alters existing ones, so a
    pre-existing DB silently lacks columns added to the models later. Additive
    ALTERs are enough for this app; anything fancier belongs in a real migration
    tool. Runs on SQLite (local dev) and Postgres (Neon prod) only.
    """
    if engine.dialect.name not in ("sqlite", "postgresql"):
        return
    inspector = inspect(engine)
    with engine.connect() as conn:
        for table in Base.metadata.sorted_tables:
            if not inspector.has_table(table.name):
                continue  # create_all handles brand-new tables
            live_cols = {c["name"] for c in inspector.get_columns(table.name)}
            for col in table.columns:
                if col.name in live_cols:
                    continue
                # IF NOT EXISTS guards the concurrent-cold-start race on serverless
                # Postgres; SQLite (single-process local dev) doesn't support it.
                exists_guard = "IF NOT EXISTS " if engine.dialect.name == "postgresql" else ""
                ddl = (
                    f"ALTER TABLE {table.name} ADD COLUMN {exists_guard}"
                    f"{col.name} {col.type.compile(engine.dialect)}"
                )
                default = _default_clause(col)
                if default is not None:
                    ddl += f" DEFAULT {default}"
                conn.exec_driver_sql(ddl)
        conn.commit()


def init_db() -> None:
    # Import models so they register on Base before create_all.
    from app.db import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _migrate_missing_columns()

    # Multi-user backfill (PLAN 7): make sure the admin user exists (its invite
    # code mirrors APP_ACCESS_CODE) and stamp pre-multi-user rows as the admin's.
    from app.db.users import backfill_user_ids

    db = SessionLocal()
    try:
        backfill_user_ids(db)
    finally:
        db.close()
