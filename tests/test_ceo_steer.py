"""القائد steers on its own: measures the month against the goals, then acts within the permission matrix."""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import H, enqueue, run_tasks


def _campaign(name: str, *, reach: int, likes: int, cap: float, days: int = 5, spent: float = 60) -> str:
    from qsm import db
    from qsm.db import utcnow
    from qsm.engine import clock
    from qsm.models import Campaign, Post

    today = clock.today()
    with db.session() as s:
        c = Campaign(name=name, status="active", channels=["instagram"], daily_budget_cap=cap, budget_total=5000,
                     spent=spent, posts_per_day=2, start_date=(today - timedelta(days=days)).isoformat(),
                     end_date=(today + timedelta(days=20)).isoformat())
        s.add(c)
        s.flush()
        s.add(Post(channel="instagram", campaign_id=c.id, status="published", caption=name,
                   published_at=utcnow() - timedelta(hours=1), metrics={"reach": reach, "likes": likes}))
        return c.id


def _get(model: Any, oid: str) -> Any:
    from qsm import db

    with db.session() as s:
        return s.get(model, oid)


def _intervene(value: str) -> None:
    from qsm import db
    from qsm.models import Agent

    with db.session() as s:
        agent = s.get(Agent, "ceo")
        agent.permissions = {**(agent.permissions or {}), "intervene": value}


def _steer() -> dict[str, Any]:
    from qsm.models import Task

    tid = enqueue("ceo.steer", created_by="ceo")
    assert "ceo.steer" in run_tasks()
    return _get(Task, tid).output


def test_steer_moves_budget_from_weak_to_strong_campaign(owner: TestClient) -> None:
    from qsm.models import Campaign

    weak = _campaign("حملة ضعيفة", reach=10_000, likes=50, cap=100)
    strong = _campaign("حملة قوية", reach=10_000, likes=900, cap=200)
    out = _steer()
    assert out["mode"] == "auto"
    shift = next(a for a in out["actions"] if a["type"] == "shift_budget")
    assert shift["status"] == "done" and "حملة ضعيفة" in shift["label"]
    assert _get(Campaign, weak).daily_budget_cap == 50
    assert _get(Campaign, strong).daily_budget_cap == 250  # +50 is a 25% step: inside the raise authority
    data = owner.get("/api/network").json()["data"]["steering"]
    assert data["decisions"][0]["source"] == "steer" and data["used_today"] >= 1
    assert data["progress"]["leads"]["target"] == 120


def test_steer_files_one_plan_when_intervention_needs_approval(owner: TestClient) -> None:
    from qsm.models import Approval, Campaign

    weak = _campaign("أ", reach=10_000, likes=40, cap=100)
    _campaign("ب", reach=10_000, likes=900, cap=200)
    _intervene("approve")
    out = _steer()
    assert out["mode"] == "approval"
    assert _get(Campaign, weak).daily_budget_cap == 100  # nothing changed yet
    plans = owner.get("/api/approvals?kind=plan").json()["data"]
    plan = next(p for p in plans if p["kind"] == "plan" and p["status"] == "pending")
    assert plan["payload"]["actions"][0]["type"] == "shift_budget"
    r = owner.post(f"/api/approvals/{plan['id']}/decide", json={"approve": True}, headers=H)
    assert r.status_code == 200
    assert _get(Campaign, weak).daily_budget_cap == 50
    assert _get(Approval, plan["id"]).payload["results"][0]["status"] == "done"


def test_a_newer_plan_supersedes_the_pending_one(owner: TestClient) -> None:
    _campaign("أ", reach=10_000, likes=40, cap=100)
    _campaign("ب", reach=10_000, likes=900, cap=200)
    _intervene("approve")
    _steer()
    _steer()
    assert len(owner.get("/api/approvals?kind=plan").json()["data"]) == 1
    assert len(owner.get("/api/approvals?kind=plan&status=expired").json()["data"]) == 1


def test_steer_only_observes_when_intervention_is_off(owner: TestClient) -> None:
    from qsm.models import Campaign

    weak = _campaign("أ", reach=10_000, likes=40, cap=100)
    _campaign("ب", reach=10_000, likes=900, cap=200)
    _intervene("off")
    out = _steer()
    assert out["mode"] == "observe"
    assert all(a["status"] == "observed" for a in out["actions"] if a["type"] == "shift_budget")
    assert _get(Campaign, weak).daily_budget_cap == 100


def test_daily_intervention_cap_defers_extra_actions(owner: TestClient) -> None:
    from qsm import db, settings

    _campaign("أ", reach=10_000, likes=40, cap=100)
    _campaign("ب", reach=10_000, likes=900, cap=200)
    with db.session() as s:
        settings.put(s, "goals", {**settings.get(s, "goals").model_dump(), "max_daily_interventions": 0})
    out = _steer()
    assert out["actions"] and all(a["status"] == "deferred" for a in out["actions"])


def test_young_campaigns_are_not_judged(owner: TestClient) -> None:
    _campaign("جديدة", reach=10_000, likes=10, cap=100, days=1)
    _campaign("ب", reach=10_000, likes=900, cap=200)
    out = _steer()
    assert not any(a["type"] == "shift_budget" for a in out["actions"])


def test_model_actions_are_validated_against_live_state(owner: TestClient) -> None:
    from qsm import db
    from qsm.agents import steer

    a = _campaign("أ", reach=10_000, likes=40, cap=100)
    b = _campaign("ب", reach=10_000, likes=900, cap=200)
    with db.session() as s:
        assert steer.clean(s, {"type": "shift_budget", "campaign_id": a, "to_campaign_id": a, "value": 10}) is None
        assert steer.clean(s, {"type": "shift_budget", "campaign_id": a, "to_campaign_id": b, "value": 500}) is None
        assert steer.clean(s, {"type": "pause_campaign", "campaign_id": "ghost"}) is None
        assert steer.clean(s, {"type": "set_campaign_posts", "campaign_id": a, "value": 999}) is None
        assert steer.clean(s, {"type": "raise_channel_capacity", "channel": "myspace", "value": 9}) is None
        assert steer.clean(s, {"type": "drop_tables"}) is None
        assert steer.clean(s, {"type": "commission_content", "channel": "x", "count": 50, "value": "x"}) is None
        ok = steer.clean(s, {"type": "commission_content", "channel": "x", "count": 50, "campaign_id": a})
        assert ok["count"] == 5 and ok["campaign_id"] == ""  # campaign a does not run on X


def test_raise_beyond_authority_goes_to_the_approval_desk(owner: TestClient) -> None:
    from qsm import db, settings
    from qsm.agents import steer

    with db.session() as s:
        act = steer.clean(s, {"type": "raise_channel_capacity", "channel": "instagram", "value": 40,
                              "reason": "أعلى تفاعل"})
        out = steer.carry_out(s, [act], mode="auto", room=5, ref_id="t", parent_id=None, assessment="", source="steer")
        assert out["results"][0]["status"] == "pending"  # 2 → 40 breaks both the step and the ceiling
        assert settings.get(s, "limits").organic_posts_per_day["instagram"] == 2


def test_command_can_pause_a_named_campaign(owner: TestClient) -> None:
    from qsm.models import Campaign

    cid = _campaign("حملة الصيف", reach=1000, likes=10, cap=100)
    owner.post("/api/command", json={"text": "أوقف حملة الصيف فورًا"}, headers=H)
    run_tasks()
    assert _get(Campaign, cid).status == "paused"


def test_member_without_campaigns_capability_gets_a_plan_not_a_change(owner: TestClient, client: TestClient) -> None:
    from qsm.models import Campaign

    cid = _campaign("حملة الصيف", reach=1000, likes=10, cap=100)
    r = owner.post("/api/users", json={"name": "مشغل", "username": "operator", "email": "op@example.test",
                                       "password": "Operator-pass-2026", "role": "viewer",
                                       "permissions": ["command"]}, headers=H)
    assert r.status_code == 200, r.text
    owner.post("/api/auth/logout", headers=H)
    assert client.post("/api/auth/login", json={"login": "operator", "password": "Operator-pass-2026"},
                       headers=H).status_code == 200
    assert client.post("/api/command", json={"text": "أوقف حملة الصيف"}, headers=H).status_code == 200
    run_tasks()
    assert _get(Campaign, cid).status == "active"
    from sqlalchemy import select

    from qsm import db
    from qsm.models import Approval

    with db.session() as s:
        assert s.scalar(select(Approval).where(Approval.kind == "plan", Approval.status == "pending")) is not None


def test_steer_waits_for_review_hours(owner: TestClient) -> None:
    from datetime import datetime

    from qsm.engine import clock
    from qsm.engine.scheduler import Scheduler

    night = clock.to_utc(datetime.combine(clock.today(), datetime.min.time()).replace(hour=3))
    noon = clock.to_utc(datetime.combine(clock.today(), datetime.min.time()).replace(hour=12))
    sched = Scheduler()
    assert "ceo.steer" not in sched.tick(night)
    assert "ceo.steer" in sched.tick(noon)


def test_goals_need_the_autonomy_capability(owner: TestClient, client: TestClient) -> None:
    body = {"focus": "sales", "monthly_leads": 300, "monthly_reach": 200000, "target_engagement_rate": 5,
            "max_daily_interventions": 4, "review_start": "09:00", "review_end": "22:00", "notes": "ركّز على الباقات"}
    r = owner.put("/api/settings/goals", json=body, headers=H)
    assert r.status_code == 200, r.text
    assert owner.put("/api/settings/goals", json={**body, "review_start": "25:00"}, headers=H).status_code == 422
    owner.post("/api/users", json={"name": "مدير", "username": "mgr1", "email": "m@example.test",
                                   "password": "Manager-pass-2026", "role": "manager"}, headers=H)
    owner.post("/api/auth/logout", headers=H)
    client.post("/api/auth/login", json={"login": "mgr1", "password": "Manager-pass-2026"}, headers=H)
    assert client.put("/api/settings/goals", json=body, headers=H).status_code == 403
