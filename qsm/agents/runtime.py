"""The task engine of the live network.

Every piece of work is a persisted `Task` owned by one agent. A worker loop claims queued tasks (respecting paused
agents and `run_after`), runs the skill handler, and publishes each transition on the live stream so the network
map can draw the hand-off from one agent to the next. Transient failures retry with backoff; a spent AI budget
parks the task until the next local day.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select, update

from .. import db, events, settings
from ..ai import client as ai
from ..connectors.base import ConnectorError
from ..db import iso, utcnow
from ..engine import clock, policy
from ..models import Agent, Task
from . import prompts
from .registry import BY_ID, owner_of

log = logging.getLogger("qsm.runtime")
Handler = Callable[["Ctx"], Awaitable[dict[str, Any]]]
HANDLERS: dict[str, Handler] = {}
POLL_S = 1.0
BACKOFF_S = 30
TERMINAL = ("done", "failed", "cancelled")
# Kinds whose result is worth a feed line (kinds that record their own richer event are left out).
NOTABLE = {"channel.analyze", "campaigns.optimize", "campaigns.analyze_competitors", "ceo.plan_day", "ceo.steer",
           "guardian.apply_fix",
           "content.reply", "content.revise"}


class SkillError(Exception):
    """A handler's clean failure: the message is shown to the owner as-is."""


def skill(kind: str) -> Callable[[Handler], Handler]:
    def wrap(fn: Handler) -> Handler:
        HANDLERS[kind] = fn
        return fn
    return wrap


def task_dict(t: Task) -> dict[str, Any]:
    return {"id": t.id, "agent_id": t.agent_id, "parent_id": t.parent_id, "kind": t.kind, "title": t.title,
            "status": t.status, "summary": t.summary, "error": t.error, "origin": t.origin,
            "created_by": t.created_by, "attempts": t.attempts, "cost_usd": round(t.cost_usd or 0, 4),
            "input": t.input or {}, "output": t.output or {}, "created_at": iso(t.created_at),
            "started_at": iso(t.started_at), "finished_at": iso(t.finished_at), "run_after": iso(t.run_after)}


def enqueue(s: Any, *, kind: str, title: str, input: dict[str, Any] | None = None, channel: str | None = None,
            parent_id: str | None = None, origin: str = "routine", created_by: str = "system", priority: int = 5,
            run_after: datetime | None = None, max_attempts: int = 3) -> Task:
    data = dict(input or {})
    if channel:
        data = {**data, "channel": channel}
    agent_id = owner_of(kind, data.get("channel"))
    t = Task(agent_id=agent_id, kind=kind, title=title[:240], input=data, parent_id=parent_id, origin=origin,
             created_by=created_by, priority=priority, run_after=run_after or utcnow(), max_attempts=max_attempts)
    s.add(t)
    s.flush()
    events.publish("task", {"event": "created", "from": created_by, "to": agent_id, "task": task_dict(t)})
    return t


def already_pending(s: Any, kind: str, agent_id: str, key: str | None = None, value: Any = None) -> bool:
    rows = s.scalars(select(Task).where(Task.kind == kind, Task.agent_id == agent_id,
                                        Task.status.in_(("queued", "running")))).all()
    if key is None:
        return bool(rows)
    return any((r.input or {}).get(key) == value for r in rows)


@dataclass
class Ctx:
    task_id: str
    agent_id: str
    kind: str
    title: str
    input: dict[str, Any]
    origin: str
    cost_usd: float = 0.0
    simulated: bool = False
    sources: list[dict[str, str]] = field(default_factory=list)

    def decide(self, action: str) -> str:
        with db.session() as s:
            return policy.decide(s, self.agent_id, action)

    def progress(self, note: str) -> None:
        with db.session() as s:
            agent = s.get(Agent, self.agent_id)
            if agent is not None:
                agent.status_note = note[:240]
        events.publish("agent", {"id": self.agent_id, "status": "working", "note": note[:240],
                                 "task_id": self.task_id})

    def spawn(self, kind: str, title: str, input: dict[str, Any] | None = None, *, channel: str | None = None,
              priority: int = 5, run_after: datetime | None = None) -> str:
        with db.session() as s:
            t = enqueue(s, kind=kind, title=title, input=input, channel=channel, parent_id=self.task_id,
                        origin="event", created_by=self.agent_id, priority=priority, run_after=run_after)
            return t.id

    async def ai(self, *, prompt: str | list[dict[str, Any]], simulate: Callable[[], Any],
                 schema: dict[str, Any] | None = None, max_tokens: int = 3000, web_search: bool = False,
                 extra: dict[str, Any] | None = None, max_searches: int = 5) -> ai.AIResult:
        with db.session() as s:
            agent = s.get(Agent, self.agent_id)
            brand = settings.get(s, "brand")
            model, effort, instructions = agent.model, agent.effort, agent.instructions or ""
        spec = BY_ID[self.agent_id]
        now = clock.now_local()
        result = await ai.generate(
            agent_id=self.agent_id, model=model, effort=effort, task_id=self.task_id,
            system_static=prompts.static_system(spec, brand, instructions),
            system_dynamic=prompts.dynamic_context(f"{clock.WEEKDAYS_AR[now.weekday()]} {now:%Y-%m-%d %H:%M}",
                                                   extra),
            prompt=prompt, schema=schema, max_tokens=max_tokens, web_search=web_search, simulate=simulate,
            max_searches=max_searches)
        self.cost_usd += result.cost_usd
        self.simulated = self.simulated or result.simulated
        self.sources.extend(result.sources)
        return result


def _set_agent(s: Any, agent_id: str, status: str, note: str = "", task_id: str | None = None) -> None:
    agent = s.get(Agent, agent_id)
    if agent is None:
        return
    agent.status, agent.status_note, agent.current_task_id = status, note[:240], task_id
    if status == "working":
        agent.last_run_at = utcnow()
    events.publish("agent", {"id": agent_id, "status": status, "note": note[:240], "task_id": task_id})


def _settle_agent(s: Any, agent_id: str) -> None:
    busy = s.scalar(select(Task.id).where(Task.agent_id == agent_id, Task.status == "running").limit(1))
    agent = s.get(Agent, agent_id)
    if agent is None:
        return
    if busy:
        return
    _set_agent(s, agent_id, "paused" if agent.paused else "idle")


def _next_local_midnight() -> datetime:
    tomorrow = clock.today() + timedelta(days=1)
    return clock.day_bounds_utc(tomorrow)[0] + timedelta(minutes=5)


def _close_parent(s: Any, parent_id: str | None) -> None:
    """When every child of a command is terminal, the command completes with a roll-up of their outcomes."""
    if not parent_id:
        return
    parent = s.get(Task, parent_id)
    if parent is None or parent.status != "waiting":
        return
    children = s.scalars(select(Task).where(Task.parent_id == parent_id)).all()
    if any(c.status not in TERMINAL for c in children):
        return
    done = [c for c in children if c.status == "done"]
    failed = [c for c in children if c.status == "failed"]
    lines = [f"✓ {BY_ID[c.agent_id].name}: {c.summary or c.title}" for c in done]
    lines += [f"✗ {BY_ID[c.agent_id].name}: {c.error or c.title}" for c in failed]
    parent.status, parent.finished_at = "done", utcnow()
    parent.summary = (parent.summary + "\n\n" if parent.summary else "") + "\n".join(lines)
    parent.cost_usd = (parent.cost_usd or 0) + sum(c.cost_usd or 0 for c in children)
    events.record(s, "command.completed", f"اكتمل تنفيذ الأمر: {parent.title}", actor=parent.agent_id,
                  ref_kind="task", ref_id=parent.id, detail={"done": len(done), "failed": len(failed)})
    events.publish("task", {"event": "done", "from": parent.agent_id, "to": parent.created_by,
                            "task": task_dict(parent)})


async def run_task(task_id: str) -> None:
    with db.session() as s:
        t = s.get(Task, task_id)
        if t is None or t.status != "running":
            return
        ctx = Ctx(task_id=t.id, agent_id=t.agent_id, kind=t.kind, title=t.title, input=dict(t.input or {}),
                  origin=t.origin)
        _set_agent(s, t.agent_id, "working", t.title, t.id)
        events.publish("task", {"event": "started", "from": t.agent_id, "to": t.agent_id, "task": task_dict(t)})
    handler = HANDLERS.get(ctx.kind)
    try:
        if handler is None:
            raise SkillError(f"لا يوجد منفّذ للمهارة {ctx.kind}")
        output = await handler(ctx)
        _finish(task_id, ctx, output)
    except ai.AIBudgetExceeded as exc:
        _park(task_id, str(exc), _next_local_midnight())
    except (ai.AIError, ConnectorError) as exc:
        _fail(task_id, str(exc), transient=bool(getattr(exc, "transient", False)))
    except SkillError as exc:
        _fail(task_id, str(exc), transient=False)
    except Exception as exc:  # last line of defence: the guardian sees the failed task and diagnoses it
        log.exception("task %s (%s) crashed", task_id, ctx.kind)
        _fail(task_id, f"خطأ داخلي: {exc.__class__.__name__}", transient=False)


def _finish(task_id: str, ctx: Ctx, output: dict[str, Any]) -> None:
    with db.session() as s:
        t = s.get(Task, task_id)
        if t is None:
            return
        summary = str(output.pop("summary", "") or "")
        waiting = bool(output.pop("_wait_children", False))
        quiet = bool(output.pop("quiet", False))
        if ctx.sources:
            output = {**output, "sources": ctx.sources[:12]}
        if ctx.simulated:
            output = {**output, "simulated": True}
        t.output, t.summary, t.cost_usd = output, summary, (t.cost_usd or 0) + ctx.cost_usd
        has_children = s.scalar(select(Task.id).where(Task.parent_id == task_id).limit(1)) is not None
        if waiting and has_children:
            t.status = "waiting"
        else:
            t.status, t.finished_at = "done", utcnow()
        events.publish("task", {"event": "done" if t.status == "done" else "waiting", "from": t.agent_id,
                                "to": t.created_by, "task": task_dict(t)})
        if summary and not quiet and (t.origin in ("command", "user") or t.kind in NOTABLE):
            events.record(s, "task.done", f"{BY_ID[t.agent_id].name}: {summary.splitlines()[0][:200]}",
                          actor=t.agent_id, ref_kind="task", ref_id=t.id)
        _settle_agent(s, t.agent_id)
        _close_parent(s, t.parent_id)
        if t.status == "waiting":
            _close_parent(s, t.id)


def _fail(task_id: str, error: str, *, transient: bool) -> None:
    with db.session() as s:
        t = s.get(Task, task_id)
        if t is None:
            return
        t.attempts = (t.attempts or 0) + 1
        t.error = error[:2000]
        if transient and t.attempts < (t.max_attempts or 3):
            t.status = "queued"
            t.run_after = utcnow() + timedelta(seconds=BACKOFF_S * 2 ** (t.attempts - 1))
            events.publish("task", {"event": "retry", "from": t.agent_id, "to": t.agent_id, "task": task_dict(t)})
        else:
            t.status, t.finished_at = "failed", utcnow()
            events.record(s, "task.failed", f"تعثّر {BY_ID[t.agent_id].name}: {t.title} — {error[:160]}",
                          actor=t.agent_id, ref_kind="task", ref_id=t.id)
            events.publish("task", {"event": "failed", "from": t.agent_id, "to": t.agent_id, "task": task_dict(t)})
        agent = s.get(Agent, t.agent_id)
        if agent is not None:
            _set_agent(s, t.agent_id, "error" if t.status == "failed" else "idle", error[:240])
            if t.status != "failed":
                _settle_agent(s, t.agent_id)
        _close_parent(s, t.parent_id)


def _park(task_id: str, reason: str, until: datetime) -> None:
    with db.session() as s:
        t = s.get(Task, task_id)
        if t is None:
            return
        t.status, t.run_after, t.error = "queued", until, reason[:2000]
        _set_agent(s, t.agent_id, "waiting", reason[:240])


class Runtime:
    """The worker loop. One per process; `heartbeat` lets the guardian see a stalled loop."""

    def __init__(self, concurrency: int = 3):
        self.concurrency = concurrency
        self.heartbeat: datetime | None = None
        self._task: asyncio.Task[None] | None = None
        self._running: set[asyncio.Task[None]] = set()
        self._stop = asyncio.Event()

    @property
    def alive(self) -> bool:
        return self._task is not None and not self._task.done()

    def start(self) -> None:
        if self.alive:
            return
        self._stop = asyncio.Event()
        self._task = asyncio.create_task(self._loop(), name="qsm-runtime")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        for t in list(self._running):
            t.cancel()
        self._task = None

    async def restart(self) -> None:
        await self.stop()
        self.start()

    def _claim(self, limit: int) -> list[str]:
        now = utcnow()
        claimed: list[str] = []
        with db.session() as s:
            active = select(Agent.id).where(Agent.enabled.is_(True), Agent.paused.is_(False))
            ids = s.scalars(select(Task.id).where(Task.status == "queued", Task.run_after <= now,
                                                  Task.agent_id.in_(active))
                            .order_by(Task.priority, Task.created_at).limit(limit)).all()
            for tid in ids:
                res = s.execute(update(Task).where(Task.id == tid, Task.status == "queued")
                                .values(status="running", started_at=now))
                if res.rowcount:
                    claimed.append(tid)
        return claimed

    async def _loop(self) -> None:
        while not self._stop.is_set():
            self.heartbeat = utcnow()
            try:
                free = self.concurrency - len(self._running)
                if free > 0:
                    for tid in self._claim(free):
                        job = asyncio.create_task(run_task(tid), name=f"task-{tid[:8]}")
                        self._running.add(job)
                        job.add_done_callback(self._running.discard)
            except Exception:
                log.exception("runtime tick failed")
            await asyncio.sleep(POLL_S)

    async def drain(self, timeout: float = 30.0) -> None:
        """Tests: run until nothing is queued-and-due or running."""
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            with db.session() as s:
                busy = s.scalar(select(Task.id).where(
                    (Task.status == "running") | ((Task.status == "queued") & (Task.run_after <= utcnow()))).limit(1))
            if not busy and not self._running:
                return
            await asyncio.sleep(0.05)


runtime = Runtime()
