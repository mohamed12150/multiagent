"""One page per channel: its agent, connection, today's room, KPIs, queue, published posts and what it learned."""
from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..agents import state
from ..agents.registry import CHANNEL_LABELS
from ..engine import clock, limits
from ..models import CHANNELS, Agent, Connection, Contact, Conversation, Post, User
from . import serial
from .deps import ApiError, found, get_db, ok, viewer

router = APIRouter(prefix="/api/channels", tags=["channels"])


def _series(s: Session, channel: str, days: int) -> list[dict]:
    today = clock.today()
    out = []
    for i in range(days - 1, -1, -1):
        day = today - timedelta(days=i)
        posts = state.published_between(s, day, day, channel)
        m = state._sum(posts)
        out.append({"day": day.isoformat(), "posts": len(posts), "reach": m["reach"],
                    "engagement": state.engagement(m)})
    return out


@router.get("/{channel}")
def channel_page(channel: str, _: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    if channel not in CHANNELS:
        raise ApiError(404, "not_found", "القناة غير معروفة")
    agent = found(s.get(Agent, channel), "الوكيل")
    conn = s.get(Connection, channel)
    today = clock.today()
    week = state.channel_kpis(s, today - timedelta(days=6), today)[channel]
    month = state.channel_kpis(s, today - timedelta(days=29), today)[channel]
    queue = list(s.scalars(select(Post).where(Post.channel == channel, Post.status.in_(("scheduled", "approved",
                                                                                       "review")))
                           .order_by(Post.scheduled_at.is_(None), Post.scheduled_at).limit(20)).all())
    published = list(s.scalars(select(Post).where(Post.channel == channel, Post.status == "published")
                               .order_by(Post.published_at.desc()).limit(20)).all())
    open_convs = int(s.scalar(select(func.count()).select_from(Conversation).where(
        Conversation.channel == channel, Conversation.status.in_(("open", "pending", "escalated")))) or 0)
    subscribers = int(s.scalar(select(func.count()).select_from(Contact).where(
        Contact.channel == channel, Contact.opted_in.is_(True))) or 0) if channel == "whatsapp" else None
    room = limits.organic_room(s, channel)
    return ok({
        "channel": channel, "label": CHANNEL_LABELS[channel], "agent": serial.agent(agent),
        "connection": {"mode": conn.mode if conn else "sandbox", "status": conn.status if conn else "not_configured",
                       "account": conn.account if conn else {}},
        "room": {"used": room.used, "limit": room.limit},
        "week": week, "month": month, "series": _series(s, channel, 14),
        "queue": [serial.post(p) for p in queue], "published": [serial.post(p) for p in published],
        "open_conversations": open_convs, "subscribers": subscribers,
        "followers_history": (agent.insights or {}).get("followers_history", {}),
    })
