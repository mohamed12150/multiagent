"""The live network: agents, tasks, the CEO command bar, the activity feed and the SSE stream."""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import db, events, permissions, security, settings
from ..agents import state, steer
from ..agents.registry import BY_ID, CHANNEL_LABELS, PERMISSIONS, VALUES
from ..agents.runtime import enqueue, runtime, task_dict
from ..ai import client as ai
from ..ai.models import EFFORTS, MODELS
from ..db import utcnow
from ..engine import approvals, clock, limits
from ..engine.scheduler import TITLES
from ..models import Agent, Connection, Event, Task, User
from . import serial
from .deps import ApiError, actor, ai_quota, cap, found, get_db, ok, viewer

router = APIRouter(prefix="/api", tags=["network"])
HEARTBEAT_S = 15
RUNNABLE = {"ceo": ("ceo.steer", "ceo.plan_day"), "campaigns": ("campaigns.propose", "campaigns.analyze_competitors",
                                                     "campaigns.optimize"),
            "coordinator": ("coordinator.distribute", "coordinator.daily_report"), "guardian": ("guardian.sweep",),
            "content": ()}
CHANNEL_RUNNABLE = ("channel.analyze", "channel.engage", "channel.metrics", "channel.publish")


def _today_tasks(s: Session) -> dict[str, dict[str, int]]:
    start, _ = clock.day_bounds_utc(clock.today())
    rows = s.execute(select(Task.agent_id, Task.status, func.count()).where(Task.created_at >= start)
                     .group_by(Task.agent_id, Task.status)).all()
    out: dict[str, dict[str, int]] = {}
    for agent_id, status, n in rows:
        out.setdefault(agent_id, {})[status] = int(n)
    return out


@router.get("/network")
def network(_: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    agents = s.scalars(select(Agent).order_by(Agent.tier, Agent.id)).all()
    counts = _today_tasks(s)
    today = clock.today()
    kpis = state.channel_kpis(s, today, today)
    conns = {c.id: {"mode": c.mode, "status": c.status} for c in s.scalars(select(Connection)).all()}
    usage = ai.usage_summary(1)
    return ok({
        "agents": [{**serial.agent(a), "today": counts.get(a.id, {}),
                    "cost_today": usage["by_agent"].get(a.id, {}).get("cost_usd", 0)} for a in agents],
        "kpis": {"channels": kpis, "totals": state.totals(kpis),
                 "conversations": state.conversations_between(s, today, today)},
        "limits": limits.snapshot(s),
        "pending_approvals": approvals.pending_count(s),
        "steering": steer.overview(s),
        "autonomy": settings.get(s, "autonomy").level,
        "ai_live": ai.is_live(), "ai_cost_today": usage["cost_usd"],
        "connections": conns,
        "engine": {"runtime": runtime.alive, "concurrency": runtime.concurrency},
    })


@router.get("/agents/{agent_id}")
def agent_detail(agent_id: str, _: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    a = found(s.get(Agent, agent_id), "الوكيل")
    tasks = s.scalars(select(Task).where(Task.agent_id == agent_id).order_by(Task.created_at.desc()).limit(25)).all()
    usage = ai.usage_summary(7)["by_agent"].get(agent_id, {})
    runnable = CHANNEL_RUNNABLE if a.tier == 2 else RUNNABLE.get(agent_id, ())
    return ok({**serial.agent(a), "tasks": [task_dict(t) for t in tasks], "usage_7d": usage,
               "runnable": [{"kind": k, "label": TITLES.get(k, k)} for k in runnable],
               "permission_catalog": {k: PERMISSIONS[k] for k in BY_ID[agent_id].permissions}})


class AgentPatch(BaseModel):
    enabled: bool | None = None
    paused: bool | None = None
    model: str | None = None
    effort: Literal["low", "medium", "high", "xhigh"] | None = None
    instructions: str | None = Field(default=None, max_length=4000)
    permissions: dict[str, str] | None = None
    routines: dict[str, dict[str, Any]] | None = None


def _clean_routines(current: dict[str, Any], incoming: dict[str, dict[str, Any]]) -> dict[str, Any]:
    out = dict(current)
    for name, cfg in incoming.items():
        if name not in current:
            raise ApiError(422, "bad_routine", f"روتين غير معروف: {name}")
        merged = {**current[name]}
        if "enabled" in cfg:
            merged["enabled"] = bool(cfg["enabled"])
        if "every_min" in cfg and "every_min" in current[name]:
            merged["every_min"] = max(5, min(int(cfg["every_min"]), 1440))
        if "at" in cfg and "at" in current[name]:
            try:
                clock.parse_hhmm(str(cfg["at"]))
            except (ValueError, IndexError) as exc:
                raise ApiError(422, "bad_time", "صيغة الوقت HH:MM") from exc
            merged["at"] = str(cfg["at"])
        out[name] = merged
    return out


@router.patch("/agents/{agent_id}")
def update_agent(agent_id: str, body: AgentPatch, user: User = Depends(cap("agents")), s: Session = Depends(get_db, scope="function")) -> dict:
    a = found(s.get(Agent, agent_id), "الوكيل")
    spec = BY_ID[agent_id]
    changes: list[str] = []
    if body.model is not None:
        if body.model not in MODELS:
            raise ApiError(422, "bad_model", "النموذج غير مدعوم")
        a.model = body.model
        changes.append(f"النموذج → {MODELS[body.model]['label']}")
    if body.effort is not None:
        if body.effort not in EFFORTS:
            raise ApiError(422, "bad_effort", "مستوى التفكير غير صالح")
        a.effort = body.effort
        changes.append(f"عمق التفكير → {body.effort}")
    if body.instructions is not None:
        a.instructions = body.instructions.strip()
        changes.append("التعليمات الإضافية")
    if body.permissions is not None:
        if not permissions.has(user, "autonomy"):
            raise ApiError(403, "forbidden", "لا تملك صلاحية «الاستقلالية والصلاحيات والليمت»")
        bad = [k for k, v in body.permissions.items() if k not in spec.permissions or v not in VALUES]
        if bad:
            raise ApiError(422, "bad_permission", f"صلاحية غير صالحة: {', '.join(bad)}")
        a.permissions = {**(a.permissions or {}), **body.permissions}
        changes.append("الصلاحيات")
    if body.routines is not None:
        a.routines = _clean_routines(a.routines or {}, body.routines)
        changes.append("الجدول الزمني")
    if body.enabled is not None:
        a.enabled = body.enabled
        changes.append("مفعّل" if body.enabled else "معطّل")
    if body.paused is not None:
        a.paused = body.paused
        a.status = "paused" if body.paused else "idle"
        changes.append("إيقاف مؤقت" if body.paused else "استئناف")
        events.publish("agent", {"id": a.id, "status": a.status, "note": ""})
    if changes:
        events.record(s, "agent.updated", f"تحديث {a.name}: {'، '.join(changes)}", actor=actor(user), ref_kind="agent",
                      ref_id=a.id)
    return ok(serial.agent(a))


class RunIn(BaseModel):
    kind: str
    input: dict[str, Any] = Field(default_factory=dict)


@router.post("/agents/{agent_id}/run")
def run_skill(agent_id: str, body: RunIn, user: User = Depends(cap("command")), s: Session = Depends(get_db, scope="function")) -> dict:
    a = found(s.get(Agent, agent_id), "الوكيل")
    ai_quota(user)
    allowed = CHANNEL_RUNNABLE if a.tier == 2 else RUNNABLE.get(agent_id, ())
    if body.kind not in allowed:
        raise ApiError(422, "not_runnable", "لا يمكن تشغيل هذه المهارة يدويًا")
    title = TITLES.get(body.kind, body.kind) + (f" — {CHANNEL_LABELS[a.channel]}" if a.channel else "")
    t = enqueue(s, kind=body.kind, title=title, input={k: v for k, v in body.input.items() if k in ("focus", "day")},
                channel=a.channel, created_by=actor(user), origin="user", priority=2)
    return ok(task_dict(t))


class CommandIn(BaseModel):
    text: str = Field(min_length=2, max_length=2000)


@router.post("/command")
def command(body: CommandIn, user: User = Depends(cap("command")), s: Session = Depends(get_db, scope="function")) -> dict:
    ai_quota(user)
    t = enqueue(s, kind="ceo.command", title=body.text.strip()[:200],
                input={"text": body.text.strip(), "can_steer": permissions.has(user, "campaigns")},
                created_by=actor(user), origin="command", priority=1)
    events.record(s, "command", f"أمر للقائد: {body.text.strip()[:160]}", actor=actor(user), ref_kind="task",
                  ref_id=t.id)
    return ok(task_dict(t))


@router.get("/tasks")
def tasks(agent: str | None = None, status: str | None = None, origin: str | None = None,
          limit: int = Query(50, ge=1, le=200), _: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    q = select(Task)
    if agent:
        q = q.where(Task.agent_id == agent)
    if status:
        q = q.where(Task.status == status)
    if origin:
        q = q.where(Task.origin == origin)
    rows = s.scalars(q.order_by(Task.created_at.desc()).limit(limit)).all()
    return ok([task_dict(t) for t in rows])


@router.get("/tasks/{task_id}")
def task(task_id: str, _: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    t = found(s.get(Task, task_id), "المهمة")
    children = s.scalars(select(Task).where(Task.parent_id == task_id).order_by(Task.created_at)).all()
    return ok({**task_dict(t), "children": [task_dict(c) for c in children]})


@router.post("/tasks/{task_id}/cancel")
def cancel(task_id: str, user: User = Depends(cap("command")), s: Session = Depends(get_db, scope="function")) -> dict:
    t = found(s.get(Task, task_id), "المهمة")
    if t.status not in ("queued", "waiting"):
        raise ApiError(409, "not_cancellable", "لا يمكن إلغاء مهمة قيد التنفيذ أو منتهية")
    t.status, t.finished_at = "cancelled", utcnow()
    for child in s.scalars(select(Task).where(Task.parent_id == task_id, Task.status == "queued")).all():
        child.status, child.finished_at = "cancelled", utcnow()
    events.publish("task", {"event": "cancelled", "from": actor(user), "to": t.agent_id, "task": task_dict(t)})
    return ok(task_dict(t))


@router.post("/tasks/{task_id}/retry")
def retry(task_id: str, user: User = Depends(cap("command")), s: Session = Depends(get_db, scope="function")) -> dict:
    t = found(s.get(Task, task_id), "المهمة")
    if t.status != "failed":
        raise ApiError(409, "not_failed", "المهمة ليست متعثرة")
    new = enqueue(s, kind=t.kind, title=t.title, input=t.input, created_by=actor(user), origin="user", priority=2)
    t.status = "cancelled"
    return ok(task_dict(new))


@router.get("/feed")
def feed(before: int | None = None, limit: int = Query(40, ge=1, le=200), kind: str | None = None,
         _: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    q = select(Event)
    if before:
        q = q.where(Event.id < before)
    if kind:
        q = q.where(Event.kind.startswith(kind))
    rows = s.scalars(q.order_by(Event.id.desc()).limit(limit)).all()
    return ok([events.event_dict(e) for e in rows])


MAX_STREAMS_PER_USER = 12  # a reload's old stream is only noticed at its next heartbeat
_streams: dict[str, int] = {}


def _session_user(token: str | None) -> str | None:
    with db.session() as s:
        user = security.resolve_session(s, token)
        return user.id if user else None


@router.get("/stream")
async def stream(request: Request) -> StreamingResponse:
    token = request.cookies.get(security.COOKIE_NAME)
    user_id = _session_user(token)
    if user_id is None:
        raise ApiError(401, "unauthorized", "انتهت الجلسة")
    if _streams.get(user_id, 0) >= MAX_STREAMS_PER_USER:
        raise ApiError(429, "too_many_streams", "نوافذ مفتوحة كثيرة — أغلق بعضها")
    _streams[user_id] = _streams.get(user_id, 0) + 1

    async def gen() -> AsyncIterator[bytes]:
        q = events.subscribe()
        try:
            yield b"retry: 3000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    frame = await asyncio.wait_for(q.get(), timeout=HEARTBEAT_S)
                except TimeoutError:
                    if _session_user(token) != user_id:  # logged out, deactivated or password changed
                        break
                    yield b": ping\n\n"
                    continue
                data = json.dumps(frame, ensure_ascii=False, default=str)
                yield f"event: {frame['kind']}\nid: {frame['seq']}\ndata: {data}\n\n".encode()
        finally:
            events.unsubscribe(q)
            _streams[user_id] = max(0, _streams.get(user_id, 1) - 1)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
