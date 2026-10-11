"""Settings: brand, notifications, general, AI, autonomy presets, connections (API keys) and users."""
from __future__ import annotations

import secrets
from typing import Any, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import connectors, db, events, security, settings, vault
from ..agents.registry import PERMISSIONS, PRESETS
from ..ai import client as ai
from ..ai.models import catalog as model_catalog
from ..connectors import catalog
from ..connectors.base import ConnectorError
from ..db import utcnow
from ..engine import media, policy
from ..models import ROLES, Connection, User
from . import serial
from .deps import ApiError, actor, found, get_db, manager, ok, owner, viewer

router = APIRouter(prefix="/api", tags=["settings"])
EDITABLE_SECTIONS = ("brand", "notify", "general", "ai")
OWNER_SECTIONS = ("notify", "general")  # where reports go and which public URL links point at are trust anchors
CREDENTIAL_ANCHORS = {"email": ("smtp_host", "smtp_port", "username")}


@router.get("/settings")
def get_settings(_: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    return ok({"sections": settings.all_sections(s), "models": model_catalog(), "permissions": PERMISSIONS,
               "presets": PRESETS})


@router.put("/settings/{section}")
def put_section(section: str, body: dict[str, Any], user: User = Depends(manager), s: Session = Depends(get_db, scope="function")) -> dict:
    if section not in EDITABLE_SECTIONS:
        raise ApiError(404, "unknown_section", "قسم إعدادات غير معروف")
    if section in OWNER_SECTIONS and not security.has_role(user, "owner"):
        raise ApiError(403, "owner_only", "هذا القسم يغيّره المالك فقط")
    try:
        obj = settings.put(s, section, body, by=actor(user))
    except settings.SettingsError as exc:
        raise ApiError(422, "invalid", str(exc)) from exc
    events.record(s, "settings.updated", f"حُدّثت إعدادات {section}", actor=actor(user))
    return ok(obj.model_dump(mode="json"))


class AutonomyIn(BaseModel):
    level: Literal["manual", "assisted", "autopilot"]


@router.post("/settings/autonomy")
def set_autonomy(body: AutonomyIn, user: User = Depends(owner), s: Session = Depends(get_db, scope="function")) -> dict:
    policy.apply_preset(s, body.level, by=actor(user))
    label = {"manual": "يدوي", "assisted": "شبه آلي", "autopilot": "طيار آلي"}[body.level]
    events.record(s, "autonomy", f"مستوى الاستقلالية ← {label}", actor=actor(user))
    events.publish("autonomy", {"level": body.level})
    return ok({"level": body.level})


# ---------------------------------------------------------------- connections

def _conn_out(s: Session, c: Connection) -> dict:
    return serial.connection(c, vault.hints(s, c.id))


@router.get("/connections")
def list_connections(_: User = Depends(manager), s: Session = Depends(get_db, scope="function")) -> dict:
    rows = {c.id: c for c in s.scalars(select(Connection)).all()}
    return ok([_conn_out(s, rows[p]) for p in catalog.ORDER if p in rows])


class ConnectionIn(BaseModel):
    config: dict[str, str] = Field(default_factory=dict)
    secrets: dict[str, str] = Field(default_factory=dict)
    mode: Literal["sandbox", "live"] | None = None


@router.put("/connections/{provider}")
def save_connection(provider: str, body: ConnectionIn, user: User = Depends(manager),
                    s: Session = Depends(get_db, scope="function")) -> dict:
    if provider not in catalog.PROVIDERS:
        raise ApiError(404, "unknown_provider", "خدمة غير معروفة")
    c = found(s.get(Connection, provider), "الربط")
    plain, secret = catalog.plain_fields(provider), catalog.secret_fields(provider)
    unknown = (set(body.config) - plain) | (set(body.secrets) - secret)
    if unknown:
        raise ApiError(422, "unknown_fields", f"حقول غير معروفة: {', '.join(sorted(unknown))}")
    config = {k: v.strip()[:500] for k, v in body.config.items()}
    bad = [k for k, v in config.items() if v and not catalog.valid_value(k, v)]
    if bad:
        raise ApiError(422, "bad_value", f"قيمة غير صالحة: {', '.join(bad)}")
    for key in CREDENTIAL_ANCHORS.get(provider, ()):
        moved = key in config and config[key] != str((c.config or {}).get(key, ""))
        if moved and "password" not in {k for k, v in body.secrets.items() if v.strip()}:
            vault.delete(s, f"{provider}.password")  # never send a stored password to a new destination
    if provider == "email" and config.get("smtp_host") and catalog.private_host(config["smtp_host"]):
        raise ApiError(422, "private_host", "خادم البريد يجب أن يكون عنوانًا عامًا")
    c.config = {**(c.config or {}), **config}
    for key, value in body.secrets.items():
        if value.strip():
            vault.put(s, f"{provider}.{key}", value.strip())
    if body.mode == "live":
        cfg = connectors.config_for(s, provider)
        missing = [k for k in catalog.required_fields(provider) if not str(cfg.get(k) or "").strip()]
        if missing:
            raise ApiError(422, "missing_fields", "أكمل الحقول المطلوبة قبل التفعيل: " + "، ".join(missing))
        c.mode = "live"
        c.status = "connected" if c.status in ("connected",) else "not_configured"
    elif body.mode == "sandbox":
        c.mode, c.status = "sandbox", "not_configured"
    events.record(s, "connection.saved", f"حُدّث الربط: {catalog.PROVIDERS[provider]['label']}", actor=actor(user))
    return ok(_conn_out(s, c))


@router.post("/connections/{provider}/test")
async def test_connection(provider: str, user: User = Depends(manager)) -> dict:
    if provider not in catalog.PROVIDERS:
        raise ApiError(404, "unknown_provider", "خدمة غير معروفة")
    try:
        if provider == "anthropic":
            with db.session() as s:
                key = vault.get(s, "anthropic.api_key")
            if not key:
                raise ConnectorError("أضف مفتاح API أولًا")
            detail = await ai.ping(key)
            account: dict[str, Any] = {"name": detail}
        else:
            info = await connectors.build(provider, force_live=True).test()
            detail = f"متصل — {info.name or info.handle}"
            account = {"name": info.name, "handle": info.handle, "followers": info.followers}
        status, error = "connected", ""
    except (ConnectorError, ai.AIError) as exc:
        detail, status, error, account = str(exc), "error", str(exc), {}
    with db.session() as s:
        c = s.get(Connection, provider)
        c.status, c.last_error, c.last_checked_at = status, error[:500], utcnow()
        if account:
            c.account = {**(c.account or {}), **account}
        out = _conn_out(s, c)
    return ok({"ok": status == "connected", "detail": detail, "connection": out})


@router.delete("/connections/{provider}")
def clear_connection(provider: str, user: User = Depends(manager), s: Session = Depends(get_db, scope="function")) -> dict:
    c = found(s.get(Connection, provider), "الربط")
    vault.delete_prefix(s, provider)
    c.mode, c.status, c.config, c.account, c.last_error = "sandbox", "not_configured", catalog.defaults(provider), {}, ""
    events.record(s, "connection.cleared", f"أُزيل الربط: {catalog.PROVIDERS[provider]['label']}", actor=actor(user))
    return ok(_conn_out(s, c))


@router.get("/webhooks")
def webhooks(request: Request, _: User = Depends(manager), s: Session = Depends(get_db, scope="function")) -> dict:
    token = vault.get(s, "meta.verify_token")
    if not token:
        token = secrets.token_urlsafe(24)
        vault.put(s, "meta.verify_token", token)
    base = media.public_base(s) or str(request.base_url).rstrip("/")
    return ok({"meta_url": f"{base}/api/hooks/meta", "verify_token": token,
               "fields": ["messages", "comments", "mentions"]})


# ---------------------------------------------------------------- users

class UserIn(BaseModel):
    email: str = Field(max_length=200)
    name: str = Field(min_length=2, max_length=120)
    role: str = "editor"
    password: str = Field(max_length=200)


@router.get("/users")
def users(_: User = Depends(manager), s: Session = Depends(get_db, scope="function")) -> dict:
    return ok([serial.user(u) for u in s.scalars(select(User).order_by(User.created_at)).all()])


@router.post("/users")
def add_user(body: UserIn, user: User = Depends(owner), s: Session = Depends(get_db, scope="function")) -> dict:
    email = body.email.strip().lower()
    if not security.EMAIL_RE.match(email):
        raise ApiError(422, "bad_email", "البريد غير صحيح")
    if body.role not in ROLES or body.role == "owner":
        raise ApiError(422, "bad_role", "اختر دورًا: مدير، محرر، مشاهد")
    if s.scalar(select(User.id).where(User.email == email)):
        raise ApiError(409, "exists", "يوجد مستخدم بهذا البريد")
    problem = security.password_problem(body.password)
    if problem:
        raise ApiError(422, "weak_password", problem)
    u = User(email=email, name=body.name, role=body.role, password_hash=security.hash_password(body.password))
    s.add(u)
    s.flush()
    events.record(s, "user.added", f"أُضيف المستخدم {u.name} ({u.role})", actor=actor(user))
    return ok(serial.user(u))


class UserPatch(BaseModel):
    role: str | None = None
    active: bool | None = None
    name: str | None = Field(default=None, max_length=120)


@router.patch("/users/{user_id}")
def edit_user(user_id: str, body: UserPatch, user: User = Depends(owner), s: Session = Depends(get_db, scope="function")) -> dict:
    u = found(s.get(User, user_id), "المستخدم")
    if u.id == user.id and (body.role or body.active is False):
        raise ApiError(409, "self", "لا يمكنك تغيير دورك أو تعطيل حسابك")
    if body.role is not None:
        if body.role not in ROLES or body.role == "owner":
            raise ApiError(422, "bad_role", "دور غير صالح")
        u.role = body.role
    if body.active is not None:
        u.active = body.active
        if not body.active:
            security.end_all_sessions(s, u.id)
    if body.name is not None:
        u.name = body.name
    return ok(serial.user(u))
