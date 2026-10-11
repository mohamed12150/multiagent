from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import OWNER, H


def test_setup_creates_owner_and_signs_in(client: TestClient) -> None:
    assert client.get("/api/auth/state").json()["data"]["setup_needed"] is True
    r = client.post("/api/auth/setup", json=OWNER, headers=H)
    assert r.status_code == 200
    assert r.json()["data"]["role"] == "owner"
    state = client.get("/api/auth/state").json()["data"]
    assert state["setup_needed"] is False and state["user"]["email"] == OWNER["email"]
    assert state["company"] == OWNER["company"]


def test_setup_only_once(owner: TestClient) -> None:
    r = owner.post("/api/auth/setup", json={**OWNER, "email": "other@example.test"}, headers=H)
    assert r.status_code == 409


def test_weak_password_rejected(client: TestClient) -> None:
    r = client.post("/api/auth/setup", json={**OWNER, "password": "short"}, headers=H)
    assert r.status_code == 422
    assert "كلمة المرور" in r.json()["error"]["message"]


def test_writes_need_the_csrf_header(owner: TestClient) -> None:
    r = owner.post("/api/command", json={"text": "اقترح حملة"})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "csrf"


def test_login_logout_and_lockout(owner: TestClient) -> None:
    owner.post("/api/auth/logout", headers=H)
    assert owner.get("/api/network").status_code == 401
    for _ in range(5):
        assert owner.post("/api/auth/login", json={"email": OWNER["email"], "password": "wrong-pass-1"},
                          headers=H).status_code == 401
    locked = owner.post("/api/auth/login", json={"email": OWNER["email"], "password": OWNER["password"]}, headers=H)
    assert locked.status_code == 429  # this email from this address is throttled…
    from qsm.api import auth

    assert not auth.failure_limiter.blocked(f"{OWNER['email']}|203.0.113.9")  # …but nobody can lock the owner out globally


def test_unknown_and_known_accounts_answer_alike(client: TestClient) -> None:
    client.post("/api/auth/setup", json=OWNER, headers=H)
    client.post("/api/auth/logout", headers=H)
    a = client.post("/api/auth/login", json={"email": "ghost@example.test", "password": "whatever-123"}, headers=H)
    b = client.post("/api/auth/login", json={"email": OWNER["email"], "password": "whatever-123"}, headers=H)
    assert a.status_code == b.status_code == 401 and a.json()["error"] == b.json()["error"]


def test_production_setup_needs_the_token(env, monkeypatch) -> None:  # noqa: ANN001
    from qsm import config

    monkeypatch.setenv("QSM_ENV", "production")
    monkeypatch.setenv("QSM_SECRET_KEY", "s" * 40)
    monkeypatch.setenv("QSM_MASTER_KEY", "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyMTI=")
    monkeypatch.setenv("QSM_SETUP_TOKEN", "t" * 20)
    config.reset()
    from qsm.app import create_app

    with TestClient(create_app()) as c:
        assert c.post("/api/auth/setup", json=OWNER, headers=H).status_code == 403
        ok = c.post("/api/auth/setup", json={**OWNER, "setup_token": "t" * 20}, headers=H)
        assert ok.status_code == 200
        assert "Strict-Transport-Security" in ok.headers


def test_dev_mode_refuses_public_bind(env, monkeypatch) -> None:  # noqa: ANN001
    import pytest

    from qsm import config

    monkeypatch.setenv("QSM_HOST", "0.0.0.0")  # noqa: S104
    with pytest.raises(config.ConfigError):
        config.load()


def test_login_succeeds(owner: TestClient) -> None:
    owner.post("/api/auth/logout", headers=H)
    r = owner.post("/api/auth/login", json={"email": OWNER["email"].upper(), "password": OWNER["password"]}, headers=H)
    assert r.status_code == 200
    assert owner.get("/api/auth/me").json()["data"]["email"] == OWNER["email"]


def test_roles_gate_writes(owner: TestClient) -> None:
    r = owner.post("/api/users", json={"email": "viewer@example.test", "name": "مشاهد", "role": "viewer",
                                       "password": "Viewer-pass-2026"}, headers=H)
    assert r.status_code == 200
    owner.post("/api/auth/logout", headers=H)
    owner.post("/api/auth/login", json={"email": "viewer@example.test", "password": "Viewer-pass-2026"}, headers=H)
    assert owner.get("/api/network").status_code == 200
    assert owner.post("/api/command", json={"text": "اقترح حملة"}, headers=H).status_code == 403
    assert owner.put("/api/limits", json={}, headers=H).status_code == 403
    assert owner.get("/api/connections").status_code == 403


def test_password_change_rotates_sessions(owner: TestClient) -> None:
    bad = owner.post("/api/auth/password", json={"current": "nope-nope-1", "new": "Another-pass-2026"}, headers=H)
    assert bad.status_code == 403
    ok = owner.post("/api/auth/password", json={"current": OWNER["password"], "new": "Another-pass-2026"}, headers=H)
    assert ok.status_code == 200
    assert owner.get("/api/auth/me").status_code == 200  # the new cookie keeps this browser signed in


def test_security_headers_and_spa(owner: TestClient) -> None:
    r = owner.get("/campaigns")
    assert r.status_code == 200 and "text/html" in r.headers["content-type"]
    assert "frame-ancestors 'self'" in r.headers["content-security-policy"]
    assert r.headers["x-content-type-options"] == "nosniff"
    assert owner.get("/api/nope").status_code == 404


def test_oversized_json_body_is_refused(owner: TestClient) -> None:
    r = owner.post("/api/command", content=b"x" * (3 * 1024 * 1024), headers={**H, "Content-Type": "application/json"})
    assert r.status_code == 413
