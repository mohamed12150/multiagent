"""The owner's command travels القائد → the team; results roll back up into the command."""
from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import H, run_tasks


def test_command_is_planned_and_delegated(owner: TestClient) -> None:
    r = owner.post("/api/command", json={"text": "اقترح حملة للجمعة البيضاء وجهز محتوى انستقرام وتيك توك"}, headers=H)
    assert r.status_code == 200
    cmd = r.json()["data"]
    assert cmd["agent_id"] == "ceo" and cmd["status"] == "queued"
    ran = run_tasks()
    assert "ceo.command" in ran and "campaigns.propose" in ran and ran.count("content.create_post") == 2
    done = owner.get(f"/api/tasks/{cmd['id']}").json()["data"]
    assert done["status"] == "done"
    assert {c["agent_id"] for c in done["children"]} == {"campaigns", "content"}
    assert all(c["status"] == "done" for c in done["children"])
    assert "✓" in done["summary"]
    assert done["output"]["simulated"] is True


def test_proposal_waits_for_owner_then_launches(owner: TestClient) -> None:
    owner.post("/api/campaigns/propose", json={"focus": "رمضان"}, headers=H)
    run_tasks()
    proposed = owner.get("/api/campaigns?status=proposed").json()["data"]
    assert len(proposed) == 1
    camp = proposed[0]
    assert camp["approval_id"] and camp["proposal"]["rationale"]
    r = owner.post(f"/api/approvals/{camp['approval_id']}/decide", json={"approve": True}, headers=H)
    assert r.status_code == 200
    active = owner.get(f"/api/campaigns/{camp['id']}").json()["data"]
    assert active["status"] == "active"
    kinds = run_tasks()
    assert "content.create_post" in kinds  # launch posts were commissioned
    posts = owner.get(f"/api/posts?campaign={camp['id']}").json()["data"]
    assert posts and all(p["campaign_id"] == camp["id"] for p in posts)


def test_question_only_command_creates_no_tasks(owner: TestClient, monkeypatch) -> None:
    from qsm.agents import ceo

    monkeypatch.setattr(ceo, "_simulate_plan", lambda order, campaigns: {"reply": "نشرنا 0 منشورات اليوم.", "tasks": []})
    cmd = owner.post("/api/command", json={"text": "كم نشرنا اليوم؟"}, headers=H).json()["data"]
    run_tasks()
    done = owner.get(f"/api/tasks/{cmd['id']}").json()["data"]
    assert done["status"] == "done" and done["children"] == [] and "نشرنا" in done["summary"]


def test_invalid_plan_items_are_dropped(owner: TestClient, monkeypatch) -> None:
    from qsm.agents import ceo

    plan = {"reply": "تم", "tasks": [
        {"skill": "content.create_post", "title": "بدون قناة", "channel": "", "brief": "", "count": 1, "campaign_id": ""},
        {"skill": "rm -rf", "title": "x", "channel": "", "brief": "", "count": 1, "campaign_id": ""},
        {"skill": "channel.analyze", "title": "تحليل", "channel": "x", "brief": "", "count": 99, "campaign_id": "ghost"},
    ]}
    monkeypatch.setattr(ceo, "_simulate_plan", lambda order, campaigns: plan)
    cmd = owner.post("/api/command", json={"text": "حلل"}, headers=H).json()["data"]
    run_tasks()
    children = owner.get(f"/api/tasks/{cmd['id']}").json()["data"]["children"]
    assert [c["kind"] for c in children] == ["channel.analyze"]
    assert children[0]["agent_id"] == "x"


def test_cancel_and_retry(owner: TestClient) -> None:
    t = owner.post("/api/command", json={"text": "اقترح حملة"}, headers=H).json()["data"]
    assert owner.post(f"/api/tasks/{t['id']}/cancel", headers=H).json()["data"]["status"] == "cancelled"
    assert owner.post(f"/api/tasks/{t['id']}/retry", headers=H).status_code == 409


def test_paused_agent_holds_its_tasks(owner: TestClient) -> None:
    owner.patch("/api/agents/campaigns", json={"paused": True}, headers=H)
    owner.post("/api/campaigns/propose", json={}, headers=H)
    from qsm import db
    from qsm.agents.runtime import runtime
    from qsm.models import Task

    assert runtime._claim(5) == []  # the paused agent's task is not claimed
    with db.session() as s:
        assert s.query(Task).filter(Task.agent_id == "campaigns", Task.status == "queued").count() == 1
    owner.patch("/api/agents/campaigns", json={"paused": False}, headers=H)
    assert len(runtime._claim(5)) == 1
