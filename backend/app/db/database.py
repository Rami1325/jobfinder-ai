"""SQLAlchemy engine/session setup (SQLite)."""
from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import get_settings

settings = get_settings()

_connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
engine = create_engine(settings.database_url, connect_args=_connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _sqlite_default_clause(col) -> str | None:
    """Render a column's static default as a SQL literal, or None if not expressible."""
    default = getattr(col.default, "arg", None)
    if default is None or callable(default):
        return None
    if isinstance(default, bool):
        return "1" if default else "0"
    if isinstance(default, (int, float)):
        return str(default)
    return "'" + str(default).replace("'", "''") + "'"


def _migrate_missing_columns() -> None:
    """Lightweight SQLite migration shim: ADD COLUMN for ORM columns missing from live tables.

    create_all only creates missing tables — it never alters existing ones, so a
    pre-existing DB silently lacks columns added to the models later. Additive
    ALTERs are enough for this app; anything fancier belongs in a real migration tool.
    """
    if engine.dialect.name != "sqlite":
        return
    with engine.connect() as conn:
        for table in Base.metadata.sorted_tables:
            rows = conn.exec_driver_sql(f"PRAGMA table_info({table.name})").fetchall()
            live_cols = {row[1] for row in rows}
            if not live_cols:  # table doesn't exist yet; create_all handles it
                continue
            for col in table.columns:
                if col.name in live_cols:
                    continue
                ddl = f"ALTER TABLE {table.name} ADD COLUMN {col.name} {col.type.compile(engine.dialect)}"
                default = _sqlite_default_clause(col)
                if default is not None:
                    ddl += f" DEFAULT {default}"
                conn.exec_driver_sql(ddl)
        conn.commit()


def init_db() -> None:
    # Import models so they register on Base before create_all.
    from app.db import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _migrate_missing_columns()
