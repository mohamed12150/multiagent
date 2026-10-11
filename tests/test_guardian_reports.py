"""الحارس's checks and playbooks, and المنسّق's daily report."""
from __future__ import annotations

import asyncio
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from tests.conftest import H, enqueue, run_tasks


@pytest.fixture(autouse=True)
def no_engine_restarts(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests run without background loops; a real restart would start one inside the test's event loop."""
    from qsm.agents import guardian

    monkeypatch.setattr(guardian, "CHECKS", [c for c in guardian.CHECKS if c.__name__ != "engines"])


def _sweep() -> list[str]:
    enqueue("guardian.sweep", origin="user")
    return run_tasks()


def test_stuck_task_is_requeued(owner: TestClient) -> None:
    from qsm import db
    from qsm.agents.runtime import run_task
    from qsm.db import utcnow
    from qsm.models import Task

    tid = enqueue("campaigns.optimize")
    with db.session() as s:
        t = s.get(Task, tid)
        t.status, t.started_at = "running", utcnow() - timedelta(minutes=40)
    sweep_id = enqueue("guardian.sweep", origin="user")
    with db.session() as s:
        s.get(Task, sweep_id).status = "running"
    asyncio.run(run_task(sweep_id))
    with db.session() as s:
        assert s.get(Task, tid).status == "queued"
    data = owner.get("/api/guardian").json()["data"]
    assert any(i["check"] == "stuck_task" and i["status"] == "fixed" for i in data["incidents"])


def test_failed_post_is_retried_and_owner_notified(owner: TestClient) -> None:
    from qsm import db
    from qsm.models import Post

    with db.session() as s:
        p = Post(channel="x", status="failed", caption="نص", error="X: الخدمة مشغولة (503)")
        s.add(p)
        s.flush()
        pid = p.id
    _sweep()
    with db.session() as s:
        assert s.get(Post, pid).status == "scheduled"
    notes = owner.get("/api/notifications").json()["data"]
    assert any("أصلح" in n["title"] for n in notes)


def test_backup_playbook_writes_a_copy(owner: TestClient, data_dir) -> None:
    _sweep()
    backups = list((data_dir / "backups").glob("qsm-*.db"))
    assert backups and backups[0].stat().st_size > 0


def test_recurring_problem_stops_auto_fixing(owner: TestClient) -> None:
    from qsm import db
    from qsm.engine import incidents
    from qsm.models import Incident

    with db.session() as s:
        for _ in range(3):
            inc, _created = incidents.open_incident(s, check="backup", fingerprint="loop-test", severity="warning",
                                                   title="x", detail="y")
            inc.status = "fixed"
    from qsm.agents import guardian

    def looping(s):
        return [guardian.Finding("backup", "loop-test", "warning", "مشكلة متكررة", "تفاصيل", "backup_db")]

    guardian.CHECKS.append(looping)
    try:
        _sweep()
    finally:
        guardian.CHECKS.remove(looping)
    with db.session() as s:
        latest = s.query(Incident).filter(Incident.fingerprint == "loop-test").order_by(Incident.created_at.desc()).first()
        assert latest.status == "needs_owner"


def test_fix_requires_approval_when_asked(owner: TestClient) -> None:
    owner.patch("/api/agents/guardian", json={"permissions": {"auto_fix": "approve"}}, headers=H)
    _sweep()
    pending = owner.get("/api/approvals?kind=fix").json()["data"]
    assert pending, "the backup fix should wait for the owner"
    owner.post(f"/api/approvals/{pending[0]['id']}/decide", json={"approve": True}, headers=H)
    run_tasks()
    inc = owner.get("/api/guardian").json()["data"]["incidents"]
    assert any(i["status"] == "fixed" for i in inc)


def test_guardian_page_and_manual_actions(owner: TestClient) -> None:
    data = owner.get("/api/guardian").json()["data"]
    assert {c["id"] for c in data["components"]} >= {"runtime", "scheduler", "ai", "disk"}
    task = owner.post("/api/guardian/sweep", headers=H).json()["data"]
    assert task["kind"] == "guardian.sweep"
    run_tasks()
    inc = owner.get("/api/guardian").json()["data"]["incidents"]
    if inc:
        r = owner.post(f"/api/guardian/incidents/{inc[0]['id']}/ignore", headers=H)
        assert r.json()["data"]["status"] == "ignored"


def test_daily_report_is_exact_and_delivered(owner: TestClient) -> None:
    owner.put("/api/settings/notify", json={"owner_whatsapp": "966500000009", "owner_emails": ["owner@example.test"],
                                            "report_time": "21:00", "report_channels": ["whatsapp", "email"]}, headers=H)
    owner.post("/api/posts/generate", json={"channel": "x", "count": 2}, headers=H)
    run_tasks()
    t = owner.post("/api/reports/generate", headers=H).json()["data"]
    run_tasks()
    assert owner.get(f"/api/tasks/{t['id']}").json()["data"]["status"] == "done"
    reports = owner.get("/api/reports").json()["data"]
    assert len(reports) == 1 and reports[0]["simulated"] is True
    rep = owner.get(f"/api/reports/{reports[0]['id']}").json()["data"]
    assert rep["data"]["totals"]["posts"] == 0  # nothing published yet — the report never invents numbers
    assert {d["channel"] for d in rep["deliveries"]} == {"whatsapp", "email"}
    assert all(d["status"] == "sandbox" for d in rep["deliveries"])
    assert "*تقرير" in rep["whatsapp_text"]
    html = owner.get(f"/api/reports/{rep['id']}/email")
    assert html.status_code == 200 and 'dir="rtl"' in html.text
    resent = owner.post(f"/api/reports/{rep['id']}/send", headers=H).json()["data"]
    assert len(resent["deliveries"]) == 4


def test_report_without_owner_contacts_is_skipped(owner: TestClient) -> None:
    owner.put("/api/settings/notify", json={"owner_emails": [], "owner_whatsapp": ""}, headers=H)
    owner.post("/api/reports/generate", headers=H)
    run_tasks()
    rep = owner.get("/api/reports").json()["data"][0]
    assert all(d["status"] == "skipped" for d in rep["deliveries"])


def test_report_renderers_escape_html(env) -> None:
    from qsm.engine import reports
    from qsm.models import Report

    r = Report(id="r1", day="2026-10-07", title="<b>x</b>", headline="<script>", summary="s", data={},
               sections={"highlights": ["<img src=x>"]})
    html = reports.email_html(r, "https://a.example")
    assert "<script>" not in html and "&lt;img" in html
    assert reports.whatsapp_text(r, "https://a.example").endswith("/reports/r1")
