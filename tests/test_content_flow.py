"""Library → approval → content agent → approval → coordinator schedule → channel agent publishes (sandbox)."""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from tests.conftest import H, png_bytes, run_tasks


def upload(c: TestClient, name: str = "عرض-الورد.png") -> dict:
    r = c.post("/api/library", files=[("files", (name, png_bytes(), "image/png"))], data={"folder": "الحملات"}, headers=H)
    assert r.status_code == 200, r.text
    return r.json()["data"][0]


def test_upload_sniffs_type_and_rejects_fakes(owner: TestClient) -> None:
    a = upload(owner)
    assert a["kind"] == "image" and a["status"] == "pending" and a["folder"] == "الحملات"
    bad = owner.post("/api/library", files=[("files", ("x.png", b"<?php echo 1;", "image/png"))], headers=H)
    assert bad.json()["meta"]["errors"][0]["name"] == "x.png"
    assert owner.get(f"/api/library/{a['id']}/file").status_code == 200
    approvals = owner.get("/api/approvals?kind=asset").json()["data"]
    assert approvals and approvals[0]["ref_id"] == a["id"]


def test_describe_asset_runs_after_upload(owner: TestClient) -> None:
    a = upload(owner, "flowers_bouquet.png")
    run_tasks()
    got = owner.get("/api/library").json()["data"][0]
    assert got["ai_described"] is True and got["tags"]
    assert got["id"] == a["id"]


def test_full_pipeline_to_published(owner: TestClient) -> None:
    a = upload(owner)
    owner.post(f"/api/library/{a['id']}/review", json={"approve": True}, headers=H)
    assert owner.get("/api/library?status=approved").json()["data"][0]["id"] == a["id"]
    run_tasks()
    t = owner.post("/api/posts/generate", json={"channel": "instagram", "brief": "باقات الجمعة", "count": 1},
                   headers=H).json()["data"]
    run_tasks()
    assert owner.get(f"/api/tasks/{t['id']}").json()["data"]["status"] == "done"
    posts = owner.get("/api/posts?channel=instagram").json()["data"]
    assert len(posts) == 1
    post = posts[0]
    assert post["status"] == "review" and post["asset_ids"] == [a["id"]]  # assisted: publishing needs approval
    owner.post(f"/api/posts/{post['id']}/approve", json={}, headers=H)
    run_tasks()  # the coordinator schedules it
    post = owner.get(f"/api/posts/{post['id']}").json()["data"]
    assert post["status"] == "scheduled" and post["scheduled_at"]
    # Make it due now and let the channel agent publish.
    from qsm import db
    from qsm.db import utcnow
    from qsm.models import Post

    with db.session() as s:
        s.get(Post, post["id"]).scheduled_at = utcnow() - timedelta(minutes=1)
    owner.post("/api/agents/instagram/run", json={"kind": "channel.publish"}, headers=H)
    run_tasks()
    post = owner.get(f"/api/posts/{post['id']}").json()["data"]
    assert post["status"] == "published" and post["sandbox"] is True
    assert owner.get(f"/api/library/{a['id']}/file").status_code == 200
    asset = next(x for x in owner.get("/api/library").json()["data"] if x["id"] == a["id"])
    assert asset["used_count"] == 1
    owner.post("/api/agents/instagram/run", json={"kind": "channel.metrics"}, headers=H)
    run_tasks()
    post = owner.get(f"/api/posts/{post['id']}").json()["data"]
    assert post["metrics"]["reach"] >= 0 and "likes" in post["metrics"]


def test_instagram_post_without_media_stays_draft(owner: TestClient) -> None:
    owner.post("/api/posts/generate", json={"channel": "instagram", "count": 1}, headers=H)
    run_tasks()
    post = owner.get("/api/posts").json()["data"][0]
    assert post["status"] == "draft" and "المكتبة" in post["review_note"]
    assert owner.post(f"/api/posts/{post['id']}/submit", headers=H).status_code == 422


def test_reject_with_note_triggers_revision(owner: TestClient) -> None:
    owner.post("/api/posts/generate", json={"channel": "x", "brief": "نصيحة", "count": 1}, headers=H)
    run_tasks()
    post = owner.get("/api/posts?channel=x").json()["data"][0]
    assert post["status"] == "review"
    owner.post(f"/api/posts/{post['id']}/reject", json={"note": "اجعلها أقصر"}, headers=H)
    ran = run_tasks()
    assert "content.revise" in ran
    revised = owner.get(f"/api/posts/{post['id']}").json()["data"]
    assert revised["version"] == 2 and revised["status"] == "review"


def test_autopilot_skips_review_and_limits_spill_to_next_day(owner: TestClient) -> None:
    owner.post("/api/settings/autonomy", json={"level": "autopilot"}, headers=H)
    lim = owner.get("/api/limits").json()["data"]["limits"]
    lim["organic_posts_per_day"]["linkedin"] = 1
    assert owner.put("/api/limits", json=lim, headers=H).status_code == 200
    owner.post("/api/posts/generate", json={"channel": "linkedin", "count": 3}, headers=H)
    run_tasks()
    posts = owner.get("/api/posts?channel=linkedin").json()["data"]
    assert len(posts) == 3 and all(p["status"] == "scheduled" for p in posts)
    from qsm.engine import clock

    days = sorted({clock.to_local(datetime.fromisoformat(p["scheduled_at"].rstrip("Z"))).date() for p in posts})
    assert len(days) == 3  # one per day: the organic limit is respected


def test_schedule_respects_limit_and_past(owner: TestClient) -> None:
    owner.post("/api/posts/generate", json={"channel": "x", "count": 1}, headers=H)
    run_tasks()
    post = owner.get("/api/posts?channel=x").json()["data"][0]
    assert owner.post(f"/api/posts/{post['id']}/schedule", json={"at": "2030-01-01T10:00"}, headers=H).status_code == 409
    owner.post(f"/api/posts/{post['id']}/approve", json={}, headers=H)
    run_tasks()
    assert owner.post(f"/api/posts/{post['id']}/schedule", json={"at": "2001-01-01T10:00"}, headers=H).status_code == 422
    ok = owner.post(f"/api/posts/{post['id']}/schedule", json={"at": "2030-01-01T10:00"}, headers=H)
    assert ok.status_code == 200 and ok.json()["data"]["status"] == "scheduled"


def test_manual_post_and_calendar(owner: TestClient) -> None:
    r = owner.post("/api/posts", json={"channel": "x", "format": "post", "caption": "تجربة", "submit": True}, headers=H)
    assert r.status_code == 200 and r.json()["data"]["status"] == "review"
    assert owner.post("/api/posts", json={"channel": "x", "format": "reel"}, headers=H).status_code == 422
    assert owner.get("/api/posts/calendar?start=2026-10-04&days=7").status_code == 200
    pid = r.json()["data"]["id"]
    assert owner.delete(f"/api/posts/{pid}", headers=H).status_code == 200
    assert owner.get("/api/approvals?kind=post").json()["data"] == []


def test_signed_public_media_link(owner: TestClient) -> None:
    a = upload(owner)
    from qsm import db
    from qsm.engine import media
    from qsm.models import Asset

    owner.put("/api/settings/general", json={"public_base_url": "https://mk.example.sa"}, headers=H)
    with db.session() as s:
        url = media.signed_url(s, s.get(Asset, a["id"]))
    path = url.replace("https://mk.example.sa", "")
    assert owner.get(path).status_code == 403  # pending designs are never exposed
    with db.session() as s:
        s.get(Asset, a["id"]).status = "approved"
    assert owner.get(path).status_code == 200
    assert owner.get(path.replace("sig=", "sig=0")).status_code == 403


def test_editing_an_approved_post_needs_approval_again(owner: TestClient) -> None:
    owner.post("/api/users", json={"email": "ed@example.test", "username": "editor1", "name": "محرر", "role": "editor",
                                   "password": "Editor-pass-2026"}, headers=H)
    r = owner.post("/api/posts", json={"channel": "x", "format": "post", "caption": "نص سليم", "submit": True}, headers=H)
    pid = r.json()["data"]["id"]
    owner.post(f"/api/posts/{pid}/approve", json={}, headers=H)
    run_tasks()
    owner.post("/api/auth/logout", headers=H)
    owner.post("/api/auth/login", json={"email": "ed@example.test", "password": "Editor-pass-2026"}, headers=H)
    edited = owner.patch(f"/api/posts/{pid}", json={"caption": "زوروا http://evil.test"}, headers=H).json()["data"]
    assert edited["status"] == "review" and edited["scheduled_at"] is None
    assert owner.get("/api/approvals?kind=post").json()["data"][0]["ref_id"] == pid


def test_optimizer_respects_raise_authority(owner: TestClient, monkeypatch) -> None:
    from qsm.agents import campaigns as camp_mod

    r = owner.post("/api/campaigns", json={"name": "اختبار", "channels": ["x"], "daily_budget_cap": 50,
                                           "posts_per_day": 2, "launch": True}, headers=H)
    cid = r.json()["data"]["id"]
    run_tasks()
    owner.patch("/api/agents/campaigns", json={"permissions": {"raise_limits": "off"}}, headers=H)
    monkeypatch.setattr(camp_mod, "_simulate_optimize", lambda results, snap: {"assessment": "x", "limit_requests": [],
        "actions": [{"campaign_id": cid, "type": "raise_budget", "value": 300, "reason": ""},
                    {"campaign_id": cid, "type": "raise_posts", "value": 5, "reason": ""}]})
    owner.post("/api/agents/campaigns/run", json={"kind": "campaigns.optimize"}, headers=H)
    run_tasks()
    c = owner.get(f"/api/campaigns/{cid}").json()["data"]
    assert c["daily_budget_cap"] == 50 and c["posts_per_day"] == 2
