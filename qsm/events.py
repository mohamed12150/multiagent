"""The live pulse of the network: an in-process pub/sub for the SSE stream plus the persisted activity feed.

`publish` is safe from any thread (sync API routes run in a worker pool); frames reach every open stream.
"""
from __future__ import annotations

import asyncio
import contextlib
import itertools
import logging
import threading
from typing import Any

from sqlalchemy.orm import Session

from .db import iso, utcnow
from .models import Event, Notification

log = logging.getLogger("qsm.events")
QUEUE_SIZE = 500

_loop: asyncio.AbstractEventLoop | None = None
_subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
_lock = threading.Lock()
_seq = itertools.count(1)


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


def subscribe() -> asyncio.Queue[dict[str, Any]]:
    q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=QUEUE_SIZE)
    with _lock:
        _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue[dict[str, Any]]) -> None:
    with _lock:
        _subscribers.discard(q)


def _deliver(frame: dict[str, Any]) -> None:
    with _lock:
        targets = list(_subscribers)
    for q in targets:
        if q.full():  # a stalled client loses its oldest frame, never blocks the network
            with contextlib.suppress(asyncio.QueueEmpty):
                q.get_nowait()
        q.put_nowait(frame)


def publish(kind: str, data: dict[str, Any] | None = None) -> None:
    frame = {"seq": next(_seq), "kind": kind, "at": iso(utcnow()), "data": data or {}}
    loop = _loop
    if loop is None or loop.is_closed():
        return
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is loop:
        _deliver(frame)
    else:
        loop.call_soon_threadsafe(_deliver, frame)


def record(s: Session, kind: str, title: str, *, actor: str = "system", detail: dict[str, Any] | None = None,
           ref_kind: str = "", ref_id: str = "", live: bool = True) -> Event:
    """Persist an activity-feed entry and (by default) push it live."""
    ev = Event(kind=kind, title=title[:300], actor=actor, detail=detail or {}, ref_kind=ref_kind, ref_id=ref_id)
    s.add(ev)
    s.flush()
    if live:
        publish("feed", event_dict(ev))
    return ev


def event_dict(ev: Event) -> dict[str, Any]:
    return {"id": ev.id, "at": iso(ev.at), "actor": ev.actor, "kind": ev.kind, "title": ev.title,
            "detail": ev.detail or {}, "ref_kind": ev.ref_kind, "ref_id": ev.ref_id}


def notify(s: Session, title: str, body: str = "", *, level: str = "info", kind: str = "general",
           link: str = "") -> Notification:
    """An in-app notification. External delivery (WhatsApp/email) is the dispatcher's job — engine.notify."""
    n = Notification(title=title[:240], body=body, level=level, kind=kind, link=link)
    s.add(n)
    s.flush()
    publish("notification", {"id": n.id, "title": n.title, "body": body, "level": level, "kind": kind,
                             "link": link, "at": iso(n.created_at)})
    return n
