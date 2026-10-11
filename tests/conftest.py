"""Test harness: a fresh data folder and database per test, the app without background loops, and a helper that
runs queued agent tasks to completion in the test thread (simulation mode — no network, no keys)."""
from __future__ import annotations

import asyncio
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update

H = {"X-QSM-Request": "1"}
OWNER = {"name": "مالك الاختبار", "email": "owner@example.test", "password": "Owner-pass-2026", "company": "متجر الورد"}


@pytest.fixture()
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    monkeypatch.setenv("QSM_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("QSM_SCHEDULER", "0")
    monkeypatch.delenv("QSM_ENV", raising=False)
    from qsm import config, db

    config.reset()
    db.dispose()
    db.init_db()
    from qsm.agents.loader import load_all
    from qsm.seed import run as seed

    load_all()
    with db.session() as s:
        seed(s)
    yield tmp_path
    db.dispose()
    config.reset()


@pytest.fixture()
def client(env: Path) -> Iterator[TestClient]:
    from qsm.api import auth, deps
    from qsm.app import create_app

    for limiter in (auth.login_limiter, auth.failure_limiter, auth.setup_limiter, deps.ai_limiter):
        limiter.hits.clear()  # module-level limiters would otherwise carry over between tests
    with TestClient(create_app()) as c:
        yield c


@pytest.fixture()
def owner(client: TestClient) -> TestClient:
    r = client.post("/api/auth/setup", json=OWNER, headers=H)
    assert r.status_code == 200, r.text
    return client


def run_tasks(max_rounds: int = 30) -> list[str]:
    """Claim and run every due queued task (and the ones they spawn) — returns the kinds that ran."""
    from qsm import db
    from qsm.agents.runtime import run_task
    from qsm.db import utcnow
    from qsm.models import Task

    ran: list[str] = []
    for _ in range(max_rounds):
        with db.session() as s:
            due = s.scalars(select(Task).where(Task.status == "queued", Task.run_after <= utcnow())
                            .order_by(Task.priority, Task.created_at)).all()
            batch = [(t.id, t.kind) for t in due]
            for tid, _kind in batch:
                s.execute(update(Task).where(Task.id == tid).values(status="running", started_at=utcnow()))
        if not batch:
            return ran
        for tid, kind in batch:
            asyncio.run(run_task(tid))
            ran.append(kind)
    return ran


def enqueue(kind: str, **kw: Any) -> str:
    from qsm import db
    from qsm.agents.runtime import enqueue as _enqueue

    with db.session() as s:
        return _enqueue(s, kind=kind, title=kw.pop("title", kind), **kw).id


def png_bytes() -> bytes:
    """A valid 1×1 PNG."""
    return bytes.fromhex(
        "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
        "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")


@pytest.fixture()
def data_dir(env: Path) -> Path:
    return Path(os.environ["QSM_DATA_DIR"])
