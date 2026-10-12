"""Team members: the admin adds people with username, email, password and capabilities — and the guard rails hold."""
from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import OWNER, H

PASS = "Member-pass-2026"


def _add(c: TestClient, username: str, role: str = "editor", perms: list[str] | None = None, **extra: str) -> dict:
    body = {"name": f"عضو {username}", "username": username, "email": f"{username}@example.test", "password": PASS,
            "role": role, "permissions": perms, **extra}
    r = c.post("/api/users", json=body, headers=H)
    assert r.status_code == 200, r.text
    return r.json()["data"]


def _login_as(c: TestClient, login: str, password: str = PASS) -> None:
    c.post("/api/auth/logout", headers=H)
    r = c.post("/api/auth/login", json={"login": login, "password": password}, headers=H)
    assert r.status_code == 200, r.text


def test_owner_adds_member_with_custom_capabilities(owner: TestClient) -> None:
    m = _add(owner, "sara", role="viewer", perms=["inbox", "reports", "nonsense"])
    assert m["username"] == "sara" and m["caps"] == ["inbox", "reports"] and m["custom_permissions"] is True
    listing = owner.get("/api/users").json()
    assert {u["username"] for u in listing["data"]} >= {"sara", "owner"}
    assert "inbox" in listing["meta"]["catalog"]["capabilities"]


def test_member_signs_in_with_username_or_email(owner: TestClient) -> None:
    _add(owner, "khalid")
    _login_as(owner, "KHALID")
    assert owner.get("/api/auth/me").json()["data"]["username"] == "khalid"
    _login_as(owner, "khalid@example.test")
    owner.post("/api/auth/logout", headers=H)
    bad = owner.post("/api/auth/login", json={"login": "khalid", "password": "wrong-pass-2026"}, headers=H)
    assert bad.status_code == 401


def test_capabilities_gate_every_write(owner: TestClient) -> None:
    _add(owner, "replier", role="viewer", perms=["inbox"])
    _login_as(owner, "replier")
    assert owner.post("/api/command", json={"text": "اقترح حملة"}, headers=H).status_code == 403
    assert owner.post("/api/campaigns/propose", json={"focus": "x"}, headers=H).status_code == 403
    assert owner.put("/api/settings/brand", json={"name": "x"}, headers=H).status_code == 403
    assert owner.get("/api/users").status_code == 403
    assert owner.get("/api/network").status_code == 200  # reading stays open to every active member


def test_nobody_grants_what_they_do_not_hold(owner: TestClient) -> None:
    _add(owner, "admin2", role="manager", perms=["users", "content", "inbox"])
    _login_as(owner, "admin2")
    r = owner.post("/api/users", json={"name": "سعد", "username": "sub1", "email": "sub1@example.test",
                                       "password": PASS, "role": "viewer", "permissions": ["approve"]}, headers=H)
    assert r.status_code == 403 and r.json()["error"]["code"] == "cannot_grant"
    r = owner.post("/api/users", json={"name": "سعد", "username": "sub2", "email": "sub2@example.test",
                                       "password": PASS, "role": "viewer", "permissions": ["users"]}, headers=H)
    assert r.status_code == 403  # owner-only capability
    ok = _add(owner, "sub3", role="viewer", perms=["content"])
    assert ok["caps"] == ["content"]


def test_owner_account_is_locked_to_the_owner(owner: TestClient) -> None:
    me = owner.get("/api/auth/me").json()["data"]
    _add(owner, "admin3", role="manager", perms=["users", "content"])
    assert owner.patch(f"/api/users/{me['id']}", json={"role": "viewer"}, headers=H).status_code == 409
    _login_as(owner, "admin3")
    assert owner.patch(f"/api/users/{me['id']}", json={"name": "مخترق"}, headers=H).status_code == 403
    assert owner.delete(f"/api/users/{me['id']}", headers=H).status_code == 409


def test_member_cannot_edit_someone_with_more_power(owner: TestClient) -> None:
    big = _add(owner, "bigman", role="manager")
    _add(owner, "small", role="viewer", perms=["users", "inbox"])
    _login_as(owner, "small")
    assert owner.patch(f"/api/users/{big['id']}", json={"active": False}, headers=H).status_code == 403


def test_duplicate_and_invalid_usernames_are_refused(owner: TestClient) -> None:
    _add(owner, "unique")
    dup = owner.post("/api/users", json={"name": "بدر", "username": "UNIQUE", "email": "other@example.test",
                                         "password": PASS, "role": "editor"}, headers=H)
    assert dup.status_code == 409
    bad = owner.post("/api/users", json={"name": "بدر", "username": "سارة", "email": "s@example.test",
                                         "password": PASS, "role": "editor"}, headers=H)
    assert bad.status_code == 422
    weak = owner.post("/api/users", json={"name": "بدر", "username": "weakpw", "email": "w@example.test",
                                          "password": "123", "role": "editor"}, headers=H)
    assert weak.status_code == 422
    owner_role = owner.post("/api/users", json={"name": "بدر", "username": "boss2", "email": "b@example.test",
                                                "password": PASS, "role": "owner"}, headers=H)
    assert owner_role.status_code == 422


def test_password_reset_and_deactivation_end_sessions(owner: TestClient, client: TestClient) -> None:
    m = _add(owner, "leaver")
    from fastapi.testclient import TestClient as TC

    other = TC(client.app)
    assert other.post("/api/auth/login", json={"login": "leaver", "password": PASS}, headers=H).status_code == 200
    assert other.get("/api/auth/me").status_code == 200
    r = owner.patch(f"/api/users/{m['id']}", json={"password": "Fresh-pass-2026"}, headers=H)
    assert r.status_code == 200
    assert other.get("/api/auth/me").status_code == 401
    assert other.post("/api/auth/login", json={"login": "leaver", "password": "Fresh-pass-2026"},
                      headers=H).status_code == 200
    owner.patch(f"/api/users/{m['id']}", json={"active": False}, headers=H)
    assert other.get("/api/auth/me").status_code == 401
    assert other.post("/api/auth/login", json={"login": "leaver", "password": "Fresh-pass-2026"},
                      headers=H).status_code == 401


def test_use_preset_drops_custom_permissions(owner: TestClient) -> None:
    m = _add(owner, "flex", role="editor", perms=["inbox"])
    r = owner.patch(f"/api/users/{m['id']}", json={"use_preset": True}, headers=H).json()["data"]
    assert r["custom_permissions"] is False and "content" in r["caps"]


def test_setup_gives_the_owner_a_username(client: TestClient) -> None:
    r = client.post("/api/auth/setup", json=OWNER, headers=H)
    assert r.json()["data"]["username"] == "owner"


def test_accounts_from_before_usernames_get_one_on_upgrade(env) -> None:
    from sqlalchemy import text

    from qsm import db, security
    from qsm.models import User

    with db.session() as s:
        s.add(User(name="قديم", email="Old.Owner@example.test", password_hash=security.hash_password(PASS),
                   role="owner"))
        s.add(User(name="آخر", email="old.owner@other.test", password_hash=security.hash_password(PASS), role="editor"))
    with db.engine().begin() as conn:
        conn.execute(text("UPDATE users SET username = NULL"))
    db.init_db()  # what a restart on the new version does
    with db.session() as s:
        names = sorted(u.username for u in s.query(User).all())
    assert names == ["old.owner", "old.owner2"]
