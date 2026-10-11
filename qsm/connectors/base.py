"""The connector contract every channel speaks, plus the shared HTTP helper.

A connector is built per call from the Connection row and its vault secrets; nothing secret is cached."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

log = logging.getLogger("qsm.connectors")
HTTP_TIMEOUT = httpx.Timeout(30.0, connect=10.0)
UPLOAD_TIMEOUT = httpx.Timeout(300.0, connect=15.0)


class ConnectorError(Exception):
    """`auth` → the owner must reconnect; `transient` → retry later; neither → fix the content/config."""

    def __init__(self, message: str, *, transient: bool = False, auth: bool = False, status: int = 0):
        super().__init__(message)
        self.transient = transient
        self.auth = auth
        self.status = status


@dataclass(frozen=True)
class MediaFile:
    path: Path
    mime: str
    kind: str  # image|video
    size: int
    public_url: str = ""  # signed, time-limited link (Instagram/TikTok pull media from it)


@dataclass(frozen=True)
class OutboundPost:
    post_id: str
    channel: str
    format: str
    text: str
    title: str = ""
    media: tuple[MediaFile, ...] = ()
    recipients: tuple[str, ...] = ()  # WhatsApp broadcast: opted-in numbers only


@dataclass(frozen=True)
class PublishResult:
    external_id: str
    url: str = ""
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Inbound:
    external_ref: str  # thread/comment/conversation key
    kind: str  # comment|dm|whatsapp
    text: str
    external_id: str
    handle: str = ""
    name: str = ""
    phone: str = ""
    post_external_id: str = ""
    at: datetime | None = None


@dataclass(frozen=True)
class AccountInfo:
    name: str = ""
    handle: str = ""
    followers: int = 0
    extra: dict[str, Any] = field(default_factory=dict)


class Connector:
    provider = "base"
    live = False

    def __init__(self, cfg: dict[str, Any]):
        self.cfg = cfg

    async def test(self) -> AccountInfo:
        raise NotImplementedError

    async def account(self) -> AccountInfo:
        return await self.test()

    async def publish(self, post: OutboundPost) -> PublishResult:
        raise ConnectorError("النشر غير مدعوم لهذه القناة")

    async def metrics(self, external_ids: list[str]) -> dict[str, dict[str, int]]:
        return {}

    async def inbox(self, since: datetime | None) -> list[Inbound]:
        return []

    async def reply(self, *, kind: str, external_ref: str, to: str, text: str) -> str:
        raise ConnectorError("الرد غير مدعوم لهذه القناة")

    async def send(self, *, to: str, text: str, subject: str = "", html: str = "",
                   template: dict[str, Any] | None = None) -> str:
        raise ConnectorError("الإرسال المباشر غير مدعوم لهذه القناة")

    async def refresh(self) -> dict[str, Any] | None:
        """Refresh OAuth tokens when supported → {field: new value, 'expires_in': s}; None when not supported."""
        return None


def need(cfg: dict[str, Any], *keys: str) -> None:
    missing = [k for k in keys if not str(cfg.get(k) or "").strip()]
    if missing:
        raise ConnectorError("بيانات الربط ناقصة: " + "، ".join(missing))


def _detail(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        return resp.text[:200]
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            return str(err.get("message") or err.get("error_user_msg") or err)[:240]
        if isinstance(err, str):
            return (body.get("error_description") or err)[:240]
        for k in ("detail", "message", "title"):
            if body.get(k):
                return str(body[k])[:240]
        if isinstance(body.get("errors"), list) and body["errors"]:
            return str(body["errors"][0].get("message", body["errors"][0]))[:240]
    return str(body)[:240]


def check(resp: httpx.Response, provider: str) -> httpx.Response:
    if resp.status_code < 400:
        return resp
    detail = _detail(resp)
    if resp.status_code in (401, 403):
        raise ConnectorError(f"{provider}: صلاحية الوصول مرفوضة — {detail}", auth=True, status=resp.status_code)
    if resp.status_code == 429 or resp.status_code >= 500:
        raise ConnectorError(f"{provider}: الخدمة مشغولة ({resp.status_code}) — {detail}", transient=True,
                             status=resp.status_code)
    raise ConnectorError(f"{provider}: {resp.status_code} — {detail}", status=resp.status_code)


async def request(provider: str, method: str, url: str, *, timeout: httpx.Timeout = HTTP_TIMEOUT,
                  **kwargs: Any) -> httpx.Response:
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            resp = await client.request(method, url, **kwargs)
    except httpx.TimeoutException as exc:
        raise ConnectorError(f"{provider}: انتهت مهلة الاتصال", transient=True) from exc
    except httpx.HTTPError as exc:
        raise ConnectorError(f"{provider}: تعذر الاتصال", transient=True) from exc
    return check(resp, provider)


def split_text(text: str, limit: int) -> list[str]:
    """Split on paragraph/sentence boundaries into chunks of at most `limit` characters (X threads)."""
    if len(text) <= limit:
        return [text]
    parts: list[str] = []
    current = ""
    for piece in text.replace("\n\n", "\n").split("\n"):
        candidate = f"{current}\n{piece}".strip() if current else piece
        if len(candidate) <= limit:
            current = candidate
            continue
        if current:
            parts.append(current)
        while len(piece) > limit:
            cut = piece.rfind(" ", 0, limit)
            cut = cut if cut > limit // 2 else limit
            parts.append(piece[:cut].strip())
            piece = piece[cut:].strip()
        current = piece
    if current:
        parts.append(current)
    return parts
