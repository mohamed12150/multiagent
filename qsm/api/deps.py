"""Shared API plumbing: the response envelope, the signed-in user, role gates and input helpers."""
from __future__ import annotations

import time
from collections import defaultdict, deque
from collections.abc import Iterator
from typing import Any

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .. import db, security
from ..models import User


class ApiError(HTTPException):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(status_code=status, detail={"code": code, "message": message})


def ok(data: Any = None, **meta: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"ok": True, "data": data}
    if meta:
        body["meta"] = meta
    return body


def get_db() -> Iterator[Session]:
    """Used with scope="function": the unit of work commits before the response is sent, so no SQLite write lock is
    ever held while a response streams (the agents' loop would otherwise wait on it)."""
    with db.session() as s:
        yield s


def current_user(request: Request, s: Session = Depends(get_db, scope="function")) -> User:
    user = security.resolve_session(s, request.cookies.get(security.COOKIE_NAME))
    if user is None:
        raise ApiError(401, "unauthorized", "انتهت الجلسة — سجّل الدخول")
    return user


def role(minimum: str) -> Any:
    def dep(user: User = Depends(current_user)) -> User:
        if not security.has_role(user, minimum):
            raise ApiError(403, "forbidden", "لا تملك صلاحية هذا الإجراء")
        return user
    return dep


viewer = role("viewer")
editor = role("editor")
manager = role("manager")
owner = role("owner")


def actor(user: User) -> str:
    return f"user:{user.id}"


def found(obj: Any, what: str = "العنصر") -> Any:
    if obj is None:
        raise ApiError(404, "not_found", f"{what} غير موجود")
    return obj


MAX_KEYS = 10_000


class RateLimiter:
    """Sliding window per key (login attempts per IP)."""

    def __init__(self, limit: int, window_s: int):
        self.limit, self.window = limit, window_s
        self.hits: dict[str, deque[float]] = defaultdict(deque)

    def _window(self, key: str) -> deque[float]:
        now = time.monotonic()
        q = self.hits[key]
        while q and now - q[0] > self.window:
            q.popleft()
        if len(self.hits) > MAX_KEYS:  # prune idle keys so the table never grows without bound
            for k in [k for k, v in self.hits.items() if not v][:MAX_KEYS // 2]:
                self.hits.pop(k, None)
        return q

    def blocked(self, key: str) -> bool:
        return len(self._window(key)) >= self.limit

    def hit(self, key: str) -> None:
        self._window(key).append(time.monotonic())

    def clear(self, key: str) -> None:
        self.hits.pop(key, None)

    def check(self, key: str) -> None:
        if self.blocked(key):
            raise ApiError(429, "rate_limited", "محاولات كثيرة — انتظر دقيقة ثم حاول مجددًا")
        self.hit(key)


def client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


ai_limiter = RateLimiter(limit=40, window_s=600)  # owner-triggered AI work per user (commands, generation, analysis)


def ai_quota(user: User) -> None:
    ai_limiter.check(f"ai:{user.id}")
