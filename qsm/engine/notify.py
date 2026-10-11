"""Delivers owner-facing messages (daily report, fixes, approvals) to WhatsApp and email.

WhatsApp to the owner: free-form text reaches the owner only inside the 24-hour window after they last messaged
the business number; outside it Meta requires an approved utility template (Settings › الإشعارات › قالب واتساب).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Literal

from .. import connectors, db, events, settings
from ..connectors.base import ConnectorError
from ..db import iso, utcnow
from ..models import Notification
from . import clock

log = logging.getLogger("qsm.notify")
Kind = Literal["report", "fix", "approval", "incident"]


def _channels(cfg: settings.Notify, kind: Kind) -> list[str]:
    if kind == "report":
        return list(cfg.report_channels)
    if kind == "approval":
        return [c for c in cfg.approval_channels if c != "app"]
    return [c for c in cfg.fix_channels if c != "app"]


async def _whatsapp(cfg: settings.Notify, text: str) -> dict[str, Any]:
    to = cfg.owner_whatsapp.strip().lstrip("+")
    if not to:
        return {"channel": "whatsapp", "to": "", "status": "skipped", "error": "لم يُحدد رقم واتساب المالك"}
    conn = connectors.build("whatsapp")
    template = None
    if cfg.whatsapp_template:
        template = {"name": cfg.whatsapp_template, "lang": cfg.whatsapp_template_lang, "params": [text[:1000]]}
    try:
        ext = await conn.send(to=to, text=text, template=template)
    except ConnectorError as exc:
        return {"channel": "whatsapp", "to": to, "status": "failed", "error": str(exc)}
    return {"channel": "whatsapp", "to": to, "status": "sent" if conn.live else "sandbox", "id": ext}


async def _email(cfg: settings.Notify, subject: str, text: str, html: str) -> list[dict[str, Any]]:
    if not cfg.owner_emails:
        return [{"channel": "email", "to": "", "status": "skipped", "error": "لم يُحدد بريد المالك"}]
    conn = connectors.build("email")
    out = []
    for to in cfg.owner_emails:
        try:
            ext = await conn.send(to=to, subject=subject, text=text, html=html)
            out.append({"channel": "email", "to": to, "status": "sent" if conn.live else "sandbox", "id": ext})
        except ConnectorError as exc:
            out.append({"channel": "email", "to": to, "status": "failed", "error": str(exc)})
    return out


async def deliver(kind: Kind, *, subject: str, text: str, html: str = "", urgent: bool = False) -> list[dict[str, Any]]:
    with db.session() as s:
        cfg = settings.get(s, "notify")
    channels = _channels(cfg, kind)
    quiet = kind != "report" and not urgent and clock.in_window(cfg.quiet_start, cfg.quiet_end)
    results: list[dict[str, Any]] = []
    for ch in channels:
        if quiet:
            results.append({"channel": ch, "status": "skipped", "error": "ساعات الهدوء"})
            continue
        if ch == "whatsapp":
            results.append(await _whatsapp(cfg, text))
        elif ch == "email":
            results.extend(await _email(cfg, subject, text, html))
    stamp = iso(utcnow())
    return [{**r, "at": stamp} for r in results]


def fire(kind: Kind, *, subject: str, text: str) -> None:
    """Schedule an external delivery from sync code (any thread); in-app notifications are written by the caller."""
    loop = events._loop
    if loop is None or loop.is_closed():
        return
    asyncio.run_coroutine_threadsafe(deliver(kind, subject=subject, text=text), loop)


async def owner_alert(kind: Kind, title: str, body: str, *, level: str = "info", link: str = "",
                      urgent: bool = False) -> list[dict[str, Any]]:
    """In-app notification + external delivery per the owner's channel choices."""
    with db.session() as s:
        n = events.notify(s, title, body, level=level, kind=kind, link=link)
        nid = n.id
    deliveries = await deliver(kind, subject=title, text=f"{title}\n\n{body}".strip(), urgent=urgent)
    with db.session() as s:
        row = s.get(Notification, nid)
        if row is not None:
            row.channels = deliveries
    return deliveries
