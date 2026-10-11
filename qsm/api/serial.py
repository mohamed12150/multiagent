"""Row → JSON. The only place the API shape is defined, so the UI reads one vocabulary."""
from __future__ import annotations

from typing import Any

from ..agents.registry import BY_ID, CHANNEL_LABELS, PERMISSIONS
from ..agents.state import engagement, rate
from ..ai.models import MODELS
from ..connectors import catalog
from ..db import iso
from ..engine import clock
from ..models import (
    Agent,
    Approval,
    Asset,
    Campaign,
    Competitor,
    Connection,
    Contact,
    Conversation,
    LimitChange,
    Message,
    Notification,
    Post,
    Report,
    User,
)


def user(u: User) -> dict[str, Any]:
    return {"id": u.id, "email": u.email, "name": u.name, "role": u.role, "active": u.active,
            "last_login_at": iso(u.last_login_at), "created_at": iso(u.created_at)}


def agent(a: Agent) -> dict[str, Any]:
    spec = BY_ID.get(a.id)
    return {"id": a.id, "name": a.name, "title": a.title, "tier": a.tier, "channel": a.channel, "model": a.model,
            "model_label": MODELS.get(a.model, {}).get("label", a.model), "effort": a.effort, "enabled": a.enabled,
            "paused": a.paused, "instructions": a.instructions, "status": a.status, "status_note": a.status_note,
            "current_task_id": a.current_task_id, "permissions": a.permissions or {},
            "permission_keys": list(spec.permissions) if spec else [], "skills": list(spec.skills) if spec else [],
            "routines": a.routines or {}, "insights": a.insights or {}, "last_run_at": iso(a.last_run_at)}


def asset(x: Asset) -> dict[str, Any]:
    return {"id": x.id, "kind": x.kind, "title": x.title, "original_name": x.original_name, "mime": x.mime,
            "size": x.size_bytes, "width": x.width, "height": x.height, "duration": x.duration_s,
            "has_thumb": x.has_thumb, "description": x.description, "tags": x.tags or [], "folder": x.folder,
            "status": x.status, "review_note": x.review_note, "ai_described": x.ai_described,
            "used_count": x.used_count, "uploaded_by": x.uploaded_by, "created_at": iso(x.created_at),
            "url": f"/api/library/{x.id}/file", "thumb": f"/api/library/{x.id}/thumb"}


def post(p: Post, assets: dict[str, Asset] | None = None) -> dict[str, Any]:
    m = p.metrics or {}
    return {"id": p.id, "channel": p.channel, "channel_label": CHANNEL_LABELS.get(p.channel, p.channel),
            "format": p.format, "status": p.status, "title": p.title, "brief": p.brief, "caption": p.caption,
            "script": p.script, "hashtags": p.hashtags or [], "cta": p.cta, "asset_ids": p.asset_ids or [],
            "assets": [asset(assets[i]) for i in (p.asset_ids or []) if assets and i in assets],
            "campaign_id": p.campaign_id, "scheduled_at": iso(p.scheduled_at), "published_at": iso(p.published_at),
            "scheduled_human": clock.human(p.scheduled_at) if p.scheduled_at else "",
            "external_url": p.external_url, "metrics": m, "engagement": engagement(m), "engagement_rate": rate(m),
            "promoted_budget": p.promoted_budget, "author_agent": p.author_agent, "version": p.version,
            "review_note": p.review_note, "approved_by": p.approved_by, "error": p.error,
            "sandbox": bool(m.get("sandbox")) or p.external_id.startswith("sbx_"), "created_at": iso(p.created_at),
            "updated_at": iso(p.updated_at)}


def campaign(c: Campaign, results: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"id": c.id, "name": c.name, "objective": c.objective, "status": c.status, "channels": c.channels or [],
            "audience": c.audience, "offer": c.offer, "budget_total": c.budget_total,
            "daily_budget_cap": c.daily_budget_cap, "spent": round(c.spent or 0, 2), "posts_per_day": c.posts_per_day,
            "start_date": c.start_date, "end_date": c.end_date, "kpis": c.kpis or {}, "proposal": c.proposal or {},
            "results": results or c.results or {}, "created_by": c.created_by, "approved_by": c.approved_by,
            "created_at": iso(c.created_at)}


def competitor(c: Competitor) -> dict[str, Any]:
    return {"id": c.id, "name": c.name, "website": c.website, "handles": c.handles or {}, "notes": c.notes,
            "analysis": c.analysis or {}, "analyzed_at": iso(c.analyzed_at), "created_at": iso(c.created_at)}


def contact(c: Contact) -> dict[str, Any]:
    return {"id": c.id, "channel": c.channel, "handle": c.handle, "name": c.name, "phone": c.phone, "email": c.email,
            "opted_in": c.opted_in, "opted_in_at": iso(c.opted_in_at), "opt_source": c.opt_source, "stage": c.stage,
            "lead_score": c.lead_score, "tags": c.tags or [], "notes": c.notes, "last_seen_at": iso(c.last_seen_at)}


def message(m: Message) -> dict[str, Any]:
    return {"id": m.id, "direction": m.direction, "author": m.author, "text": m.text, "status": m.status,
            "meta": m.meta or {}, "created_at": iso(m.created_at)}


def conversation(c: Conversation, who: Contact | None = None, last: Message | None = None) -> dict[str, Any]:
    return {"id": c.id, "channel": c.channel, "channel_label": CHANNEL_LABELS.get(c.channel, c.channel),
            "kind": c.kind, "status": c.status, "category": c.category, "sentiment": c.sentiment,
            "priority": c.priority, "unread": c.unread, "post_id": c.post_id, "last_message_at": iso(c.last_message_at),
            "contact": contact(who) if who else None, "last": message(last) if last else None,
            "created_at": iso(c.created_at)}


def report(r: Report, full: bool = True) -> dict[str, Any]:
    base = {"id": r.id, "day": r.day, "kind": r.kind, "title": r.title, "headline": r.headline,
            "summary": r.summary, "deliveries": r.deliveries or [], "created_at": iso(r.created_at),
            "simulated": bool((r.sections or {}).get("simulated"))}
    if full:
        base |= {"data": r.data or {}, "sections": r.sections or {}}
    else:
        base["totals"] = (r.data or {}).get("totals", {})
    return base


def approval(a: Approval) -> dict[str, Any]:
    return {"id": a.id, "kind": a.kind, "ref_id": a.ref_id, "agent_id": a.agent_id,
            "agent_name": BY_ID[a.agent_id].name if a.agent_id in BY_ID else a.agent_id, "title": a.title,
            "summary": a.summary, "payload": a.payload or {}, "status": a.status, "decided_by": a.decided_by,
            "note": a.note, "created_at": iso(a.created_at), "decided_at": iso(a.decided_at)}


def notification(n: Notification) -> dict[str, Any]:
    return {"id": n.id, "level": n.level, "kind": n.kind, "title": n.title, "body": n.body, "link": n.link,
            "read": n.read, "channels": n.channels or [], "created_at": iso(n.created_at)}


def connection(c: Connection, hints: dict[str, str]) -> dict[str, Any]:
    meta = catalog.PROVIDERS[c.id]
    plain = {k: v for k, v in (c.config or {}).items() if k in catalog.plain_fields(c.id)}
    return {"id": c.id, "label": meta["label"], "group": meta["group"], "color": meta["color"], "about": meta["about"],
            "docs": meta["docs"], "fields": meta["fields"], "webhook": bool(meta.get("webhook")), "mode": c.mode,
            "status": c.status, "config": plain, "secrets": hints, "account": c.account or {},
            "last_checked_at": iso(c.last_checked_at), "last_error": c.last_error,
            "token_expires_at": iso(c.token_expires_at)}


def limit_change(c: LimitChange) -> dict[str, Any]:
    return {"id": c.id, "key": c.key, "old": c.old_value, "new": c.new_value, "by": c.by_actor, "reason": c.reason,
            "status": c.status, "created_at": iso(c.created_at)}


def permissions_catalog() -> dict[str, Any]:
    return PERMISSIONS
