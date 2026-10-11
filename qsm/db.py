"""Database engine, sessions and small shared helpers.

Datetimes are stored as naive UTC (`utcnow()`); the API serialises them with a trailing "Z".
"""
from __future__ import annotations

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import create_engine, event
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


def init_db() -> None:
    from . import models  # noqa: F401  (register tables)

    Base.metadata.create_all(engine())


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
