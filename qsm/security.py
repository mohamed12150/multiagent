"""Passwords (scrypt), session tokens and request-origin checks."""
from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
from datetime import timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .db import utcnow
from .models import AuthSession, User

SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**15, 8, 1
SESSION_DAYS = 14
SEEN_EVERY = timedelta(minutes=5)
LOCK_AFTER_FAILURES = 5
LOCK_MINUTES = 15
MIN_PASSWORD_LEN = 10
COOKIE_NAME = "qsm_session"
CSRF_HEADER = "x-qsm-request"
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
# Role ladder: a route that needs `editor` admits editor, manager and owner.
ROLE_RANK = {"viewer": 0, "editor": 1, "manager": 2, "owner": 3}


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, maxmem=64 * 1024 * 1024)
    return f"scrypt${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt_b64, digest_b64 = stored.split("$")
    except ValueError:
        return False
    if scheme != "scrypt":
        return False
    salt, expected = base64.b64decode(salt_b64), base64.b64decode(digest_b64)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, maxmem=64 * 1024 * 1024)
    return hmac.compare_digest(digest, expected)


def password_problem(password: str) -> str | None:
    """A user-facing reason the password is too weak, or None."""
    if len(password) < MIN_PASSWORD_LEN:
        return f"كلمة المرور يجب ألا تقل عن {MIN_PASSWORD_LEN} أحرف"
    if password.isdigit() or password.isalpha():
        return "استخدم مزيجًا من الأحرف والأرقام"
    return None


def token_id(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(s: Session, user: User, *, ip: str = "", user_agent: str = "") -> str:
    token = secrets.token_urlsafe(32)
    s.add(AuthSession(id=token_id(token), user_id=user.id, expires_at=utcnow() + timedelta(days=SESSION_DAYS),
                      ip=ip[:64], user_agent=user_agent[:300]))
    user.last_login_at = utcnow()
    return token


def resolve_session(s: Session, token: str | None) -> User | None:
    if not token:
        return None
    row = s.get(AuthSession, token_id(token))
    if row is None or row.expires_at < utcnow():
        return None
    user = s.get(User, row.user_id)
    if user is None or not user.active:
        return None
    if row.last_seen_at is None or utcnow() - row.last_seen_at > SEEN_EVERY:
        row.last_seen_at = utcnow()  # throttled: most requests stay read-only and never take the write lock
    return user


def end_session(s: Session, token: str | None) -> None:
    if token:
        s.execute(delete(AuthSession).where(AuthSession.id == token_id(token)))


def end_all_sessions(s: Session, user_id: str) -> None:
    s.execute(delete(AuthSession).where(AuthSession.user_id == user_id))


def register_failure(user: User) -> None:
    user.failed_logins = (user.failed_logins or 0) + 1
    if user.failed_logins >= LOCK_AFTER_FAILURES:
        user.locked_until = utcnow() + timedelta(minutes=LOCK_MINUTES)
        user.failed_logins = 0


def is_locked(user: User) -> bool:
    return bool(user.locked_until and user.locked_until > utcnow())


def has_role(user: User, minimum: str) -> bool:
    return ROLE_RANK.get(user.role, -1) >= ROLE_RANK[minimum]


def any_user(s: Session) -> bool:
    return s.scalar(select(User.id).limit(1)) is not None


def sign(value: str, key: str) -> str:
    """HMAC-SHA256 hex — signed media links and webhook checks."""
    return hmac.new(key.encode(), value.encode(), hashlib.sha256).hexdigest()
