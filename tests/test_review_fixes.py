"""Regressions for the security review of users, capabilities and القائد's steering (2026-10-12)."""
from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select

from tests.conftest import OWNER, H
from tests.test_ceo_steer import _campaign, _get
from tests.test_users import PASS, _add, _login_as


def test_a_parked_manager_cannot_be_taken_over_by_a_lesser_admin(owner: TestClient) -> None:
    big = _add(owner, "bigman", role="manager")
    _add(owner, "small", role="viewer", perms=["users", "inbox"])
    owner.patch(f"/api/users/{big['id']}", json={"active": False}, headers=H)
    _login_as(owner, "small")
    r = owner.patch(f"/api/users/{big['id']}", json={"active": True, "password": "Hijack-pass-2026"}, headers=H)
    assert r.status_code == 403
    assert owner.delete(f"/api/users/{big['id']}", headers=H).status_code == 403


def test_deciding_a_limit_or_plan_needs_the_capability_that_owns_it(owner: TestClient) -> None:
    from qsm import db, settings
    from qsm.engine import limits

    with db.session() as s:
        limits.request_raise(s, key="daily_ad_spend_cap", value=900, by="campaigns", reason="x")
    _add(owner, "apr", role="viewer", perms=["approve"])
    _login_as(owner, "apr")
    pid = owner.get("/api/approvals?kind=limit").json()["data"][0]["id"]
    assert owner.post(f"/api/approvals/{pid}/decide", json={"approve": True}, headers=H).status_code == 403
    with db.session() as s:
        assert settings.get(s, "limits").daily_ad_spend_cap == 300


def test_an_approval_is_applied_once(owner: TestClient) -> None:
    from qsm import db
    from qsm.engine import approvals, limits

    with db.session() as s:
        limits.request_raise(s, key="daily_ad_spend_cap", value=900, by="campaigns", reason="x")
    pid = owner.get("/api/approvals?kind=limit").json()["data"][0]["id"]
    assert owner.post(f"/api/approvals/{pid}/decide", json={"approve": True}, headers=H).status_code == 200
    assert owner.post(f"/api/approvals/{pid}/decide", json={"approve": True}, headers=H).status_code == 409
    with db.session() as s:
        try:
            approvals.decide(s, pid, True, by="user:x")
            raise AssertionError("second decision should fail")
        except approvals.ApprovalError:
            pass


def test_editors_propose_campaigns_but_do_not_create_or_launch_them(owner: TestClient) -> None:
    _add(owner, "edit1", role="editor")
    _login_as(owner, "edit1")
    body = {"name": "حملة", "channels": ["x"], "daily_budget_cap": 100, "launch": True}
    assert owner.post("/api/campaigns", json=body, headers=H).status_code == 403
    assert owner.post("/api/campaigns/propose", json={"focus": "رمضان"}, headers=H).status_code == 200
    assert owner.post("/api/competitors", json={"name": "منافس"}, headers=H).status_code == 200


def test_launching_a_manual_campaign_needs_approve(owner: TestClient) -> None:
    _add(owner, "camp1", role="viewer", perms=["campaigns"])
    _login_as(owner, "camp1")
    body = {"name": "حملة", "channels": ["x"], "daily_budget_cap": 100, "launch": True}
    assert owner.post("/api/campaigns", json=body, headers=H).status_code == 403
    r = owner.post("/api/campaigns", json={**body, "launch": False}, headers=H)
    assert r.status_code == 200 and r.json()["data"]["status"] == "approved"
    cid = r.json()["data"]["id"]
    assert owner.patch(f"/api/campaigns/{cid}", json={"status": "active"}, headers=H).status_code == 403


def test_own_password_changes_only_through_the_account_page(owner: TestClient) -> None:
    me = owner.get("/api/auth/me").json()["data"]
    r = owner.patch(f"/api/users/{me['id']}", json={"password": "Brand-new-pass-2026"}, headers=H)
    assert r.status_code == 409 and r.json()["error"]["code"] == "self_password"


def test_a_peer_admin_keeps_capabilities_they_cannot_grant(owner: TestClient) -> None:
    peer = _add(owner, "peer1", role="viewer", perms=["users", "inbox"])
    _add(owner, "admin1", role="viewer", perms=["users", "inbox", "reports"])
    _login_as(owner, "admin1")
    r = owner.patch(f"/api/users/{peer['id']}", json={"permissions": ["users", "inbox", "reports"]}, headers=H)
    assert r.status_code == 200 and r.json()["data"]["caps"] == ["inbox", "reports", "users"]


def test_email_and_username_share_one_failure_budget(owner: TestClient) -> None:
    _add(owner, "khalid")
    owner.post("/api/auth/logout", headers=H)
    for login in ("khalid", "khalid@example.test") * 3:
        owner.post("/api/auth/login", json={"login": login, "password": "wrong-pass-2026"}, headers=H)
    r = owner.post("/api/auth/login", json={"login": "khalid", "password": PASS}, headers=H)
    assert r.status_code == 429


def test_goals_need_only_autonomy(owner: TestClient) -> None:
    from qsm import db
    from qsm.models import User

    m = _add(owner, "steerer", role="viewer", perms=["autonomy"])
    with db.session() as s:
        assert s.get(User, m["id"]).permissions == ["autonomy"]
    _login_as(owner, "steerer")
    goals = owner.get("/api/settings").json()["data"]["sections"]["goals"]
    assert owner.put("/api/settings/goals", json={**goals, "monthly_leads": 200}, headers=H).status_code == 200
    assert owner.put("/api/settings/brand", json={"name": "x"}, headers=H).status_code == 403


def test_a_shift_never_leaves_the_source_uncapped(owner: TestClient) -> None:
    from qsm import db
    from qsm.agents import steer

    a = _campaign("a", reach=10_000, likes=40, cap=100)
    b = _campaign("b", reach=10_000, likes=900, cap=200)
    with db.session() as s:
        assert steer.clean(s, {"type": "shift_budget", "campaign_id": a, "to_campaign_id": b, "value": 100}) is None


def test_a_plan_overtaken_by_events_is_skipped(owner: TestClient) -> None:
    from qsm import db
    from qsm.agents import steer
    from qsm.models import Campaign

    a = _campaign("a", reach=10_000, likes=40, cap=100)
    b = _campaign("b", reach=10_000, likes=900, cap=200)
    with db.session() as s:
        act = steer.clean(s, {"type": "shift_budget", "campaign_id": a, "to_campaign_id": b, "value": 50})
        pid = steer.file_plan(s, [act], assessment="a", ref_id="t", source="steer").id
        steer.apply(s, [act], by="ceo", parent_id=None)  # an auto run applied the same move meanwhile
    assert owner.post(f"/api/approvals/{pid}/decide", json={"approve": True}, headers=H).status_code == 200
    assert _get(Campaign, a).daily_budget_cap == 50 and _get(Campaign, b).daily_budget_cap == 250


def test_untrusted_model_values_are_dropped_not_crashing(owner: TestClient) -> None:
    from qsm import db
    from qsm.agents import steer

    bad = ({"type": "raise_channel_capacity", "channel": "x", "value": float("nan")},
           {"type": "raise_channel_capacity", "channel": "x", "value": float("inf")},
           {"type": "raise_channel_capacity", "channel": "x", "value": 500},
           {"type": "commission_content", "channel": "x", "count": float("inf")},
           {"type": ["pause_campaign"]}, "pause", None)
    with db.session() as s:
        assert all(steer.clean(s, raw) is None for raw in bad)


def test_resume_only_what_an_agent_paused(owner: TestClient) -> None:
    from qsm import db
    from qsm.agents import steer
    from qsm.models import Campaign

    mine = _campaign("أوقفها المالك", reach=1000, likes=10, cap=100)
    agents = _campaign("أوقفها القائد", reach=1000, likes=10, cap=100)
    assert owner.patch(f"/api/campaigns/{mine}", json={"status": "paused"}, headers=H).status_code == 200
    with db.session() as s:
        s.get(Campaign, agents).status, s.get(Campaign, agents).paused_by = "paused", "ceo"
    with db.session() as s:
        assert steer.clean(s, {"type": "resume_campaign", "campaign_id": mine}) is None
        assert steer.clean(s, {"type": "resume_campaign", "campaign_id": agents}) is not None
    assert owner.patch(f"/api/campaigns/{mine}", json={"end_date": "soon"}, headers=H).status_code == 422


def test_delegation_off_is_noted_not_queued(owner: TestClient) -> None:
    from qsm import db
    from qsm.agents import steer
    from qsm.models import Agent, Approval

    with db.session() as s:
        ag = s.get(Agent, "ceo")
        ag.permissions = {**(ag.permissions or {}), "delegate": "off"}
    with db.session() as s:
        act = steer.clean(s, {"type": "analyze_channel", "channel": "x", "reason": "r"})
        out = steer.carry_out(s, [act], mode="auto", room=5, ref_id="t", parent_id=None, assessment="a", source="steer")
        assert out["results"][0]["status"] == "observed"
        assert s.scalar(select(Approval).where(Approval.kind == "plan")) is None


def test_a_command_does_not_cancel_the_reviews_plan(owner: TestClient) -> None:
    from qsm import db
    from qsm.agents import steer
    from qsm.models import Approval

    a = _campaign("a", reach=10_000, likes=40, cap=100)
    with db.session() as s:
        act = steer.clean(s, {"type": "pause_campaign", "campaign_id": a, "reason": "r"})
        steer.file_plan(s, [act], assessment="a", ref_id="review", source="steer")
        steer.file_plan(s, [act], assessment="b", ref_id="order", source="command")
        assert len(s.scalars(select(Approval).where(Approval.kind == "plan", Approval.status == "pending")).all()) == 2


def test_owner_fixture_still_signs_in(client: TestClient) -> None:
    assert client.post("/api/auth/setup", json=OWNER, headers=H).status_code == 200
