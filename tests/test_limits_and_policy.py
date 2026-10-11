"""Limits, the campaign manager's raise authority, and the permission matrix."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tests.conftest import H, run_tasks


def _raise(key: str, value: float, by: str = "campaigns", channel: str | None = None):
    from qsm import db
    from qsm.engine import limits

    with db.session() as s:
        ch = limits.request_raise(s, key=key, value=value, by=by, reason="اختبار", channel=channel)
        return ch.status, ch.id


def _limits() -> dict:
    from qsm import db, settings

    with db.session() as s:
        return settings.get(s, "limits").model_dump()


def test_raise_within_authority_applies(env) -> None:
    status, _ = _raise("organic_posts_per_day", 3, channel="instagram")  # 2 → 3 = +50% > 30% step
    assert status == "pending"
    status, _ = _raise("daily_ad_spend_cap", 380)  # 300 → 380 = +26.7%, under the 1000 ceiling
    assert status == "applied" and _limits()["daily_ad_spend_cap"] == 380


def test_raise_above_ceiling_waits_for_owner(owner: TestClient) -> None:
    status, change_id = _raise("daily_ad_spend_cap", 5000)
    assert status == "pending"
    pending = owner.get("/api/approvals?kind=limit").json()["data"]
    assert pending[0]["ref_id"] == change_id and pending[0]["payload"]["within_authority"] is False
    owner.post(f"/api/approvals/{pending[0]['id']}/decide", json={"approve": True}, headers=H)
    assert _limits()["daily_ad_spend_cap"] == 5000
    changes = owner.get("/api/limits").json()["data"]["changes"]
    assert any(c["id"] == change_id and c["status"] == "applied" for c in changes)


def test_raise_off_is_rejected(owner: TestClient) -> None:
    owner.patch("/api/agents/campaigns", json={"permissions": {"raise_limits": "off"}}, headers=H)
    status, _ = _raise("campaign_posts_per_day", 7)
    assert status == "rejected" and _limits()["campaign_posts_per_day"] == 6


def test_owner_changes_apply_directly_and_are_logged(env) -> None:
    status, _ = _raise("monthly_ad_spend_cap", 99999, by="user:abc")
    assert status == "applied" and _limits()["monthly_ad_spend_cap"] == 99999


def test_unknown_limit_rejected(env) -> None:
    from qsm.engine.limits import LimitError

    with pytest.raises(LimitError):
        _raise("ai_daily_cost_cap_usd", 1000)
    with pytest.raises(LimitError):
        _raise("organic_posts_per_day", 3)  # needs a channel


def test_put_limits_validates(owner: TestClient) -> None:
    lim = owner.get("/api/limits").json()["data"]["limits"]
    bad = {**lim, "organic_posts_per_day": {**lim["organic_posts_per_day"], "facebook": 2}}
    assert owner.put("/api/limits", json=bad, headers=H).status_code == 422
    neg = {**lim, "daily_ad_spend_cap": -5}
    assert owner.put("/api/limits", json=neg, headers=H).status_code == 422


def test_optimize_requests_a_raise_when_organic_room_is_full(owner: TestClient) -> None:
    lim = owner.get("/api/limits").json()["data"]["limits"]
    lim["organic_posts_per_day"]["x"] = 1
    owner.put("/api/limits", json=lim, headers=H)
    owner.post("/api/settings/autonomy", json={"level": "autopilot"}, headers=H)
    owner.post("/api/posts/generate", json={"channel": "x", "count": 1}, headers=H)
    run_tasks()
    from qsm import db
    from qsm.db import utcnow
    from qsm.models import Post

    with db.session() as s:  # the post goes out today so today's room is full
        for p in s.query(Post).all():
            p.scheduled_at = utcnow()
    owner.post("/api/agents/campaigns/run", json={"kind": "campaigns.optimize"}, headers=H)
    run_tasks()
    changes = owner.get("/api/limits").json()["data"]["changes"]
    assert any(c["key"] == "organic_posts_per_day.x" for c in changes)


def test_permission_matrix_and_presets(owner: TestClient) -> None:
    assert owner.patch("/api/agents/content", json={"permissions": {"publish": "auto"}}, headers=H).status_code == 422
    assert owner.patch("/api/agents/content", json={"permissions": {"reply": "maybe"}}, headers=H).status_code == 422
    owner.post("/api/settings/autonomy", json={"level": "manual"}, headers=H)
    agent = owner.get("/api/agents/content").json()["data"]
    assert agent["permissions"]["reply"] == "approve" and agent["permissions"]["create_content"] == "auto"
    owner.post("/api/settings/autonomy", json={"level": "autopilot"}, headers=H)
    assert owner.get("/api/agents/whatsapp").json()["data"]["permissions"]["broadcast"] == "approve"


def test_agent_settings_validation(owner: TestClient) -> None:
    assert owner.patch("/api/agents/ceo", json={"model": "gpt-9"}, headers=H).status_code == 422
    r = owner.patch("/api/agents/ceo", json={"model": "claude-sonnet-5-5", "effort": "low",
                                             "routines": {"plan_day": {"at": "07:30", "enabled": False}}}, headers=H)
    assert r.status_code == 200
    a = r.json()["data"]
    assert a["model"] == "claude-sonnet-5-5" and a["routines"]["plan_day"] == {"enabled": False, "at": "07:30"}
    assert owner.patch("/api/agents/ceo", json={"routines": {"nope": {}}}, headers=H).status_code == 422
    assert owner.patch("/api/agents/ceo", json={"routines": {"plan_day": {"at": "25:99"}}}, headers=H).status_code == 422
