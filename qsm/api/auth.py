"""Sign-in, first-run setup (creates the owner), password change."""
from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import config, events, security, settings
from ..models import User
from . import serial
from .deps import ApiError, RateLimiter, client_ip, current_user, get_db, ok

router = APIRouter(prefix="/api/auth", tags=["auth"])
login_limiter = RateLimiter(limit=10, window_s=60)       # per IP
failure_limiter = RateLimiter(limit=5, window_s=15 * 60)  # wrong passwords per (email, IP)
setup_limiter = RateLimiter(limit=5, window_s=60)
_DUMMY_HASH = security.hash_password("timing-equaliser-not-a-password")


class SetupIn(BaseModel):
    setup_token: str = Field(default="", max_length=200)
    name: str = Field(min_length=2, max_length=120)
    email: str = Field(max_length=200)
    password: str = Field(max_length=200)
    company: str = Field(min_length=2, max_length=120)


class LoginIn(BaseModel):
    email: str = Field(max_length=200)
    password: str = Field(max_length=200)


class PasswordIn(BaseModel):
    current: str = Field(max_length=200)
    new: str = Field(max_length=200)


def _set_cookie(response: Response, token: str, request: Request | None = None) -> None:
    https = request is not None and (request.url.scheme == "https"
                                     or request.headers.get("x-forwarded-proto", "") == "https")
    response.set_cookie(security.COOKIE_NAME, token, max_age=security.SESSION_DAYS * 86400, httponly=True,
                        samesite="strict", secure=config.get().is_production or https, path="/")


@router.get("/state")
def state(request: Request, s: Session = Depends(get_db, scope="function")) -> dict:
    user = security.resolve_session(s, request.cookies.get(security.COOKIE_NAME))
    brand = settings.get(s, "brand")
    return ok({"setup_needed": not security.any_user(s), "user": serial.user(user) if user else None,
               "company": brand.name})


@router.post("/setup")
def setup(body: SetupIn, request: Request, response: Response, s: Session = Depends(get_db, scope="function")) -> dict:
    setup_limiter.check(client_ip(request))
    if security.any_user(s):
        raise ApiError(409, "already_setup", "تم إعداد المنصة مسبقًا — سجّل الدخول")
    expected = config.get().setup_token
    if config.get().is_production and not (expected and hmac.compare_digest(body.setup_token.encode(), expected.encode())):
        raise ApiError(403, "setup_token", "رمز الإعداد غير صحيح (QSM_SETUP_TOKEN)")
    email = body.email.strip().lower()
    if not security.EMAIL_RE.match(email):
        raise ApiError(422, "bad_email", "البريد الإلكتروني غير صحيح")
    problem = security.password_problem(body.password)
    if problem:
        raise ApiError(422, "weak_password", problem)
    user = User(email=email, name=body.name.strip(), password_hash=security.hash_password(body.password), role="owner")
    s.add(user)
    s.flush()
    settings.patch(s, "brand", {"name": body.company.strip()}, by=f"user:{user.id}")
    settings.patch(s, "notify", {"owner_name": body.name.strip(), "owner_emails": [email]}, by=f"user:{user.id}")
    token = security.create_session(s, user, ip=client_ip(request), user_agent=request.headers.get("user-agent", ""))
    events.record(s, "auth.setup", f"أُطلقت المنصة لشركة {body.company.strip()}", actor=f"user:{user.id}")
    _set_cookie(response, token, request)
    return ok(serial.user(user))


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, s: Session = Depends(get_db, scope="function")) -> dict:
    ip = client_ip(request)
    email = body.email.strip().lower()
    login_limiter.check(ip)
    failures = f"{email}|{ip}"
    if failure_limiter.blocked(failures):
        raise ApiError(429, "locked", "محاولات خاطئة كثيرة — حاول بعد 15 دقيقة")
    user = s.scalar(select(User).where(func.lower(User.email) == email))
    # Same work and the same answer whether or not the account exists (no user enumeration by timing or status).
    valid = security.verify_password(body.password, user.password_hash if user else _DUMMY_HASH)
    if user is None or not user.active or not valid:
        failure_limiter.hit(failures)
        if user is not None:
            security.register_failure(user)  # kept for the audit trail; the lock itself is per (email, IP)
            s.commit()  # the error below rolls the request back; the record must survive it
        raise ApiError(401, "bad_credentials", "البريد أو كلمة المرور غير صحيحة")
    failure_limiter.clear(failures)
    user.failed_logins, user.locked_until = 0, None
    token = security.create_session(s, user, ip=client_ip(request), user_agent=request.headers.get("user-agent", ""))
    _set_cookie(response, token, request)
    return ok(serial.user(user))


@router.post("/logout")
def logout(request: Request, response: Response, s: Session = Depends(get_db, scope="function")) -> dict:
    security.end_session(s, request.cookies.get(security.COOKIE_NAME))
    response.delete_cookie(security.COOKIE_NAME, path="/")
    return ok()


@router.get("/me")
def me(user: User = Depends(current_user)) -> dict:
    return ok(serial.user(user))


@router.post("/password")
def change_password(body: PasswordIn, request: Request, response: Response, user: User = Depends(current_user),
                    s: Session = Depends(get_db, scope="function")) -> dict:
    row = s.get(User, user.id)
    if not security.verify_password(body.current, row.password_hash):
        raise ApiError(403, "bad_password", "كلمة المرور الحالية غير صحيحة")
    problem = security.password_problem(body.new)
    if problem:
        raise ApiError(422, "weak_password", problem)
    row.password_hash = security.hash_password(body.new)
    security.end_all_sessions(s, row.id)
    token = security.create_session(s, row, ip=client_ip(request), user_agent=request.headers.get("user-agent", ""))
    _set_cookie(response, token, request)
    return ok()
