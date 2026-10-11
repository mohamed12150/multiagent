"""ASGI body limit: counts the bytes actually received, so chunked uploads cannot bypass a Content-Length check."""
from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

Scope = dict[str, Any]
Message = dict[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
App = Callable[[Scope, Receive, Send], Awaitable[None]]


class TooLarge(Exception):
    pass


class BodyLimit:
    def __init__(self, app: App, *, default: int, overrides: dict[str, int]):
        self.app = app
        self.default = default
        self.overrides = overrides

    async def _reject(self, send: Send, status: int, message: str) -> None:
        body = json.dumps({"ok": False, "data": None, "error": {"code": "too_large" if status == 413 else "bad_request",
                                                                  "message": message}}, ensure_ascii=False).encode()
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = self.overrides.get(scope.get("path", ""), self.default)
        headers = dict(scope.get("headers") or [])
        declared = headers.get(b"content-length")
        if declared is not None:
            try:
                size = int(declared)
            except ValueError:
                await self._reject(send, 400, "طلب غير صالح")
                return
            if size > limit:
                await self._reject(send, 413, "حجم الطلب أكبر من المسموح")
                return
        seen = 0
        started = False

        async def counted() -> Message:
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > limit:
                    raise TooLarge
            return msg

        async def tracking_send(msg: Message) -> None:
            nonlocal started
            if msg["type"] == "http.response.start":
                started = True
            await send(msg)

        try:
            await self.app(scope, counted, tracking_send)
        except TooLarge:
            if not started:
                await self._reject(send, 413, "حجم الطلب أكبر من المسموح")
