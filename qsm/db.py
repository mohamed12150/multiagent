"""Database engine, sessions and small shared helpers.

Datetimes are stored as naive UTC (`utcnow()`); the API serialises them with a trailing "Z".
"""
from __future__ import annotations

import re
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from . import config


class Base(DeclarativeBase):
    pass


_engine: Engine | None = None
_factory: sessionmaker[Session] | None = None


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def new_id() -> str:
    return uuid.uuid4().hex


def iso(value: datetime | None) -> str | None:
    return value.isoformat(timespec="seconds") + "Z" if value else None


def _sqlite_pragmas(dbapi_conn: Any, _record: Any) -> None:
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA busy_timeout=5000")
    cur.close()


def engine() -> Engine:
    global _engine, _factory
    if _engine is None:
        url = config.get().database_url
        kwargs: dict[str, Any] = {"future": True}
        if url.startswith("sqlite"):
            kwargs["connect_args"] = {"check_same_thread": False, "timeout": 10}
        _engine = create_engine(url, **kwargs)
        if url.startswith("sqlite"):
            event.listen(_engine, "connect", _sqlite_pragmas)
        _factory = sessionmaker(bind=_engine, expire_on_commit=False, future=True)
    return _engine


# Columns added after the first release: (table, column, DDL). create_all() never alters an existing table.
ADDED_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("users", "username", "VARCHAR(40)"),
    ("users", "permissions", "JSON"),
    ("campaigns", "paused_by", "VARCHAR(64) DEFAULT ''"),
)


def _username_from(email: str, taken: set[str]) -> str:
    base = re.sub(r"[^a-z0-9._-]", "", email.split("@")[0].lower())[:28] or "user"
    if not base[0].isalnum():
        base = f"u{base}"
    base = base.ljust(3, "0")
    name, n = base, 2
    while name in taken:
        name, n = f"{base}{n}", n + 1
    return name


def _migrate(eng: Engine) -> None:
    insp = inspect(eng)
    with eng.begin() as conn:
        for table, column, ddl in ADDED_COLUMNS:
            if table in insp.get_table_names() and column not in {c["name"] for c in insp.get_columns(table)}:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username ON users (username)"))
        # Accounts created before usernames existed get one from their email, so they can sign in either way.
        rows = conn.execute(text("SELECT id, email, username FROM users ORDER BY created_at")).all()
        taken = {r.username for r in rows if r.username}
        for r in rows:
            if not r.username:
                name = _username_from(r.email, taken)
                taken.add(name)
                conn.execute(text("UPDATE users SET username = :u WHERE id = :i"), {"u": name, "i": r.id})


def init_db() -> None:
    from . import models  # noqa: F401  (register tables)

    eng = engine()
    Base.metadata.create_all(eng)
    _migrate(eng)


@contextmanager
def session() -> Iterator[Session]:
    """A unit of work: commits on success, rolls back on error."""
    engine()
    assert _factory is not None
    s = _factory()
    try:
        yield s
        s.commit()
    except BaseException:
        s.rollback()
        raise
    finally:
        s.close()


def dispose() -> None:
    """Tests: drop the engine so the next call binds to a fresh database."""
    global _engine, _factory
    if _engine is not None:
        _engine.dispose()
    _engine, _factory = None, None
