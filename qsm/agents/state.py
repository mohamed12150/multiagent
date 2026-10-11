"""Numbers the agents reason over — always computed in code, never by the model, so reports stay exact."""
from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..engine import clock, limits
from ..models import CHANNELS, Agent, Campaign, Contact, Conversation, Incident, Message, Post, Task

METRIC_KEYS = ("reach", "views", "likes", "comments", "shares", "saves", "clicks")


def engagement(m: dict[str, int]) -> int:
    return int(m.get("likes", 0) + m.get("comments", 0) + m.get("shares", 0) + m.get("saves", 0))


def rate(m: dict[str, int]) -> float:
    reach = m.get("reach", 0) or m.get("views", 0)
    return round(engagement(m) / reach * 100, 2) if reach else 0.0


def _sum(posts: list[Post]) -> dict[str, int]:
    total = dict.fromkeys(METRIC_KEYS, 0)
    for p in posts:
        for k in METRIC_KEYS:
            total[k] += int((p.metrics or {}).get(k, 0))
    return total


def published_between(s: Session, start_day: date, end_day: date, channel: str | None = None) -> list[Post]:
    start, _ = clock.day_bounds_utc(start_day)
    _, end = clock.day_bounds_utc(end_day)
    q = select(Post).where(Post.status == "published", Post.published_at >= start, Post.published_at < end)
    if channel:
        q = q.where(Post.channel == channel)
    return list(s.scalars(q.order_by(Post.published_at)).all())


def channel_kpis(s: Session, start_day: date, end_day: date) -> dict[str, dict[str, Any]]:
    out = {}
    for ch in CHANNELS:
        posts = published_between(s, start_day, end_day, ch)
        m = _sum(posts)
        agent = s.get(Agent, ch)
        followers = int(((agent.insights or {}).get("followers") or 0) if agent else 0)
        out[ch] = {"posts": len(posts), **m, "engagement": engagement(m), "engagement_rate": rate(m),
                   "followers": followers}
    return out


def totals(kpis: dict[str, dict[str, Any]]) -> dict[str, Any]:
    t = {k: sum(int(v.get(k, 0)) for v in kpis.values()) for k in ("posts", *METRIC_KEYS, "engagement", "followers")}
    return {**t, "engagement_rate": rate(t)}


def conversations_between(s: Session, start_day: date, end_day: date) -> dict[str, int]:
    start, _ = clock.day_bounds_utc(start_day)
    _, end = clock.day_bounds_utc(end_day)
    inbound = int(s.scalar(select(func.count()).select_from(Message).where(
        Message.direction == "in", Message.created_at >= start, Message.created_at < end)) or 0)
    replies = int(s.scalar(select(func.count()).select_from(Message).where(
        Message.direction == "out", Message.status == "sent", Message.created_at >= start,
        Message.created_at < end)) or 0)
    leads = int(s.scalar(select(func.count()).select_from(Conversation).where(
        Conversation.category == "lead", Conversation.created_at >= start, Conversation.created_at < end)) or 0)
    complaints = int(s.scalar(select(func.count()).select_from(Conversation).where(
        Conversation.category == "complaint", Conversation.created_at >= start, Conversation.created_at < end)) or 0)
    waiting = int(s.scalar(select(func.count()).select_from(Conversation).where(
        Conversation.status.in_(("open", "pending", "escalated")))) or 0)
    return {"inbound": inbound, "replies": replies, "leads": leads, "complaints": complaints, "waiting": waiting}


def top_posts(s: Session, start_day: date, end_day: date, n: int = 3) -> list[dict[str, Any]]:
    posts = published_between(s, start_day, end_day)
    ranked = sorted(posts, key=lambda p: engagement(p.metrics or {}), reverse=True)[:n]
    return [{"id": p.id, "channel": p.channel, "title": p.title or p.caption[:60], "engagement": engagement(p.metrics),
             "reach": int((p.metrics or {}).get("reach", 0)), "rate": rate(p.metrics or {})} for p in ranked]


def task_stats(s: Session, start_day: date, end_day: date) -> dict[str, Any]:
    start, _ = clock.day_bounds_utc(start_day)
    _, end = clock.day_bounds_utc(end_day)
    rows = s.execute(select(Task.agent_id, Task.status, func.count()).where(
        Task.created_at >= start, Task.created_at < end).group_by(Task.agent_id, Task.status)).all()
    by_agent: dict[str, dict[str, int]] = {}
    for agent_id, status, n in rows:
        by_agent.setdefault(agent_id, {})[status] = int(n)
    return by_agent


def incidents_between(s: Session, start_day: date, end_day: date) -> dict[str, int]:
    start, _ = clock.day_bounds_utc(start_day)
    _, end = clock.day_bounds_utc(end_day)
    rows = s.execute(select(Incident.status, func.count()).where(
        Incident.created_at >= start, Incident.created_at < end).group_by(Incident.status)).all()
    return {str(st): int(n) for st, n in rows}


def overview(s: Session, days: int = 7) -> dict[str, Any]:
    """Compact business picture for the CEO and the campaign manager."""
    today = clock.today()
    start = today - timedelta(days=days - 1)
    kpis = channel_kpis(s, start, today)
    campaigns = s.scalars(select(Campaign).where(Campaign.status.in_(("active", "approved", "proposed")))
                          .order_by(Campaign.created_at.desc()).limit(8)).all()
    insights = {a.id: (a.insights or {}).get("summary", "") for a in s.scalars(
        select(Agent).where(Agent.tier == 2)).all()}
    leads = int(s.scalar(select(func.count()).select_from(Contact).where(Contact.stage == "lead")) or 0)
    return {
        "period_days": days,
        "channels": kpis,
        "totals": totals(kpis),
        "conversations": conversations_between(s, start, today),
        "top_posts": top_posts(s, start, today),
        "campaigns": [{"id": c.id, "name": c.name, "status": c.status, "objective": c.objective,
                       "channels": c.channels, "spent": round(c.spent, 2), "budget": c.budget_total}
                      for c in campaigns],
        "limits": limits.snapshot(s),
        "channel_insights": insights,
        "open_leads": leads,
        "pipeline": {st: int(n) for st, n in s.execute(
            select(Post.status, func.count()).group_by(Post.status)).all()},
    }


def compact(data: dict[str, Any]) -> str:
    """A readable, deterministic text rendering for prompts (sorted keys keep the cache prefix stable)."""
    return json.dumps(data, ensure_ascii=False, sort_keys=True, default=str)
