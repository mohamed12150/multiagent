"""Team members: the admin adds people with a username, email, password and exactly the capabilities they need.

Guard rails: nobody grants a capability they do not hold; owner-only capabilities (autonomy, notify, users) are granted
by the owner alone; the owner account cannot be edited by anyone else, deactivated, demoted or restricted."""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import events, permissions, security
from ..models import ROLES, User
from . import serial
from .deps import ApiError, actor, cap, found, get_db, ok

router = APIRouter(prefix="/api/users", tags=["users"])
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,31}$")
MEMBER_ROLES = tuple(r for r in ROLES if r != "owner")


def _username(s: Session, value: str, *, exclude: str | None = None) -> str:
    name = value.strip().lower()
    if not USERNAME_RE.match(name):
        raise ApiError(422, "bad_username", "اسم المستخدم: 3-32 حرفًا إنجليزيًا صغيرًا أو أرقامًا أو . _ -")
    q = select(User.id).where(func.lower(User.username) == name)
    if exclude:
        q = q.where(User.id != exclude)
    if s.scalar(q):
        raise ApiError(409, "username_taken", "اسم المستخدم مستخدم من قبل")
    return name


def _email(s: Session, value: str, *, exclude: str | None = None) -> str:
    email = value.strip().lower()
    if not security.EMAIL_RE.match(email):
        raise ApiError(422, "bad_email", "البريد الإلكتروني غير صحيح")
    q = select(User.id).where(func.lower(User.email) == email)
    if exclude:
        q = q.where(User.id != exclude)
    if s.scalar(q):
        raise ApiError(409, "email_taken", "يوجد مستخدم بهذا البريد")
    return email


def _grantable(grantor: User, caps: list[str], *, already: frozenset[str] = frozenset()) -> None:
    """Refuse handing out what the grantor lacks; capabilities the member already holds may stay."""
    caps = [c for c in caps if c not in already]
    mine = permissions.effective(grantor)
    too_much = [c for c in caps if c not in mine or (c in permissions.OWNER_GRANTED and grantor.role != "owner")]
    if too_much:
        labels = "، ".join(permissions.CAPABILITIES[c]["label"] for c in too_much)
        raise ApiError(403, "cannot_grant", f"لا يمكنك منح صلاحيات لا تملكها: {labels}")


def _password(value: str) -> str:
    problem = security.password_problem(value)
    if problem:
        raise ApiError(422, "weak_password", problem)
    return security.hash_password(value)


@router.get("")
def list_users(_: User = Depends(cap("users")), s: Session = Depends(get_db, scope="function")) -> dict:
    rows = s.scalars(select(User).order_by(User.role != "owner", User.created_at)).all()
    return ok([serial.user(u) for u in rows], catalog=permissions.catalog())


@router.get("/catalog")
def capability_catalog(_: User = Depends(cap("users"))) -> dict:
    return ok(permissions.catalog())


class UserIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    username: str = Field(min_length=3, max_length=32)
    email: str = Field(max_length=200)
    password: str = Field(max_length=200)
    role: str = "editor"
    permissions: list[str] | None = None  # None → the role's preset


@router.post("")
def add_user(body: UserIn, user: User = Depends(cap("users")), s: Session = Depends(get_db, scope="function")) -> dict:
    if body.role not in MEMBER_ROLES:
        raise ApiError(422, "bad_role", "اختر دورًا: مدير، محرر، مشاهد")
    caps = permissions.clean(body.permissions)
    _grantable(user, caps if caps is not None else sorted(permissions.PRESETS[body.role]))
    u = User(name=body.name.strip(), username=_username(s, body.username), email=_email(s, body.email),
             password_hash=_password(body.password), role=body.role, permissions=caps)
    s.add(u)
    s.flush()
    events.record(s, "user.added", f"أُضيف {u.name} ({permissions.ROLE_LABELS[u.role]})", actor=actor(user),
                  ref_kind="user", ref_id=u.id)
    return ok(serial.user(u))


class UserPatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    username: str | None = Field(default=None, max_length=32)
    email: str | None = Field(default=None, max_length=200)
    role: str | None = None
    permissions: list[str] | None = None
    use_preset: bool = False  # drop custom permissions and follow the role again
    active: bool | None = None
    password: str | None = Field(default=None, max_length=200)


def _guard_target(user: User, target: User) -> None:
    if target.role == "owner" and user.id != target.id:
        raise ApiError(403, "owner_locked", "حساب المالك يعدّله المالك وحده")
    # Measured on what the account carries, active or not: a parked manager is still a manager.
    if user.role != "owner" and not permissions.granted(target) <= permissions.effective(user):
        raise ApiError(403, "above_you", "لا يمكنك تعديل عضو يملك صلاحيات أكثر منك")


@router.patch("/{user_id}")
def edit_user(user_id: str, body: UserPatch, user: User = Depends(cap("users")),
              s: Session = Depends(get_db, scope="function")) -> dict:
    u = found(s.get(User, user_id), "المستخدم")
    _guard_target(user, u)
    self_edit = u.id == user.id
    if self_edit and (body.role is not None or body.active is False or body.permissions is not None or body.use_preset):
        raise ApiError(409, "self", "لا يمكنك تغيير دورك أو صلاحياتك أو تعطيل حسابك")
    if self_edit and body.password:
        raise ApiError(409, "self_password", "غيّر كلمة مرورك من «حسابي» بإدخال كلمة المرور الحالية")
    held = permissions.granted(u)
    if body.name is not None:
        u.name = body.name.strip()
    if body.username is not None:
        u.username = _username(s, body.username, exclude=u.id)
    if body.email is not None:
        u.email = _email(s, body.email, exclude=u.id)
    if body.role is not None:
        if body.role not in MEMBER_ROLES:
            raise ApiError(422, "bad_role", "دور غير صالح")
        if u.permissions is None:
            _grantable(user, sorted(permissions.PRESETS[body.role]), already=held)
        u.role = body.role
    if body.use_preset:
        _grantable(user, sorted(permissions.PRESETS[u.role]), already=held)
        u.permissions = None
    elif body.permissions is not None:
        caps = permissions.clean(body.permissions) or []
        _grantable(user, caps, already=held)
        u.permissions = caps
    if body.password:
        u.password_hash = _password(body.password)
        u.failed_logins, u.locked_until = 0, None
        security.end_all_sessions(s, u.id)  # the member signs in again with the new password
    if body.active is not None:
        u.active = body.active
        if not body.active:
            security.end_all_sessions(s, u.id)
    events.record(s, "user.updated", f"حُدّث حساب {u.name}", actor=actor(user), ref_kind="user", ref_id=u.id)
    return ok(serial.user(u))


@router.delete("/{user_id}")
def delete_user(user_id: str, user: User = Depends(cap("users")),
                s: Session = Depends(get_db, scope="function")) -> dict:
    u = found(s.get(User, user_id), "المستخدم")
    if u.id == user.id or u.role == "owner":
        raise ApiError(409, "protected", "لا يمكن حذف حسابك أو حساب المالك")
    _guard_target(user, u)
    security.end_all_sessions(s, u.id)
    events.record(s, "user.deleted", f"حُذف حساب {u.name}", actor=actor(user))
    s.delete(u)
    return ok()
