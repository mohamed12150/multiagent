"""The clock of the network: fires each agent's routines, hands due posts to their channel agent, and watches the
task runtime (restarting it if it ever stops). The guardian in turn watches this scheduler's heartbeat."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select

from .. import db, events, settings
from ..agents.registry import CHANNEL_LABELS
from ..agents.runtime import already_pending, enqueue, runtime
from ..db import iso, utcnow
from ..models import Agent, Post, Setting
from . import clock, incidents

log = logging.getLogger("qsm.scheduler")
TICK_S = 20
STATE_KEY = "scheduler_state"
AT_GRACE_H = 3  # a daily routine missed by more than this (e.g. server was off) waits for tomorrow

ROUTINE_SKILLS: dict[tuple[str, str], str] = {
    ("ceo", "plan_day"): "ceo.plan_day",
    ("campaigns", "optimize"): "campaigns.optimize",
    ("campaigns", "propose"): "campaigns.propose",
    ("coordinator", "distribute"): "coordinator.distribute",
    ("coordinator", "report"): "coordinator.daily_report",
    ("guardian", "sweep"): "guardian.sweep",
}
CHANNEL_ROUTINES = {"engage": "channel.engage", "metrics": "channel.metrics", "analyze": "channel.analyze"}
TITLES = {"ceo.plan_day": "تخطيط محتوى اليوم", "campaigns.optimize": "مراجعة الحملات والليمت",
          "campaigns.propose": "اقتراح حملات الأسبوع", "coordinator.distribute": "جدولة المحتوى المعتمد",
          "coordinator.daily_report": "تقرير الإنجاز اليومي", "guardian.sweep": "فحص النظام",
          "channel.engage": "متابعة التعليقات والرسائل", "channel.metrics": "تحديث المؤشرات",
          "channel.analyze": "تحليل الأداء", "channel.publish": "نشر المجدول"}


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.rstrip("Z"))
    except ValueError:
        return None


def due(cfg: dict[str, Any], last: datetime | None, now_utc: datetime, *, at_override: str | None = None) -> bool:
    if not cfg.get("enabled", True):
        return False
    every = cfg.get("every_min")
    if every:
        return last is None or now_utc - last >= timedelta(minutes=int(every))
    at = at_override or cfg.get("at")
    if not at:
        return False
    zone = clock.tz()
    local = clock.to_local(now_utc, zone)
    if "weekday" in cfg and local.weekday() != int(cfg["weekday"]):
        return False
    target = local.replace(hour=clock.parse_hhmm(at).hour, minute=clock.parse_hhmm(at).minute, second=0,
                           microsecond=0)
    if local < target or local - target > timedelta(hours=AT_GRACE_H):
        return False
    return last is None or clock.to_local(last, zone).date() < local.date() or clock.to_local(last, zone) < target


class Scheduler:
    def __init__(self) -> None:
        self.heartbeat: datetime | None = None
        self._task: asyncio.Task[None] | None = None

    @property
    def alive(self) -> bool:
        return self._task is not None and not self._task.done()

    def start(self) -> None:
        if not self.alive:
            self._task = asyncio.create_task(self._loop(), name="qsm-scheduler")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        self._task = None

    async def restart(self) -> None:
        await self.stop()
        self.start()

    async def _loop(self) -> None:
        while True:
            self.heartbeat = utcnow()
            try:
                self.watchdog()
                self.tick()
            except Exception:
                log.exception("scheduler tick failed")
            await asyncio.sleep(TICK_S)

    def watchdog(self) -> None:
        if runtime.alive:
            return
        runtime.start()
        with db.session() as s:
            inc, _ = incidents.open_incident(s, check="runtime", fingerprint="runtime:stopped", severity="critical",
                                             title="توقف محرك المهام", detail="أعاد الحارس تشغيل محرك المهام تلقائيًا",
                                             fix_action="restart_runtime")
            incidents.close(s, inc, "fixed", "أُعيد تشغيل المحرك")
            events.record(s, "guardian.fixed", "الحارس أعاد تشغيل محرك المهام", actor="guardian")

    def tick(self, now: datetime | None = None) -> list[str]:
        """One pass; returns the task kinds it enqueued (tests read this)."""
        now = now or utcnow()
        fired: list[str] = []
        with db.session() as s:
            row = s.get(Setting, STATE_KEY)
            state: dict[str, str] = dict(row.value) if row is not None and isinstance(row.value, dict) else {}
            report_at = settings.get(s, "notify").report_time
            agents = s.scalars(select(Agent).where(Agent.enabled.is_(True), Agent.paused.is_(False))).all()
            for agent in agents:
                for name, cfg in (agent.routines or {}).items():
                    kind = CHANNEL_ROUTINES.get(name) if agent.tier == 2 else ROUTINE_SKILLS.get((agent.id, name))
                    if kind is None:
                        continue
                    key = f"{agent.id}:{name}"
                    override = report_at if kind == "coordinator.daily_report" else None
                    if not due(cfg if override is None else {**cfg, "at": override}, _parse(state.get(key)), now):
                        continue
                    state[key] = iso(now) or ""
                    if already_pending(s, kind, agent.id):
                        continue
                    label = TITLES.get(kind, kind)
                    if agent.channel:
                        label = f"{label} — {CHANNEL_LABELS[agent.channel]}"
                    enqueue(s, kind=kind, title=label, channel=agent.channel, created_by=agent.id, origin="routine",
                            priority=7 if name in ("metrics", "sweep") else 5)
                    fired.append(kind)
            channels_due = set(s.scalars(select(Post.channel).where(
                Post.status == "scheduled", Post.scheduled_at <= now)).all())
            for ch in channels_due:
                agent = s.get(Agent, ch)
                if agent is None or not agent.enabled or agent.paused:
                    continue
                if not already_pending(s, "channel.publish", ch):
                    enqueue(s, kind="channel.publish", title=f"نشر المجدول — {CHANNEL_LABELS[ch]}", channel=ch,
                            created_by=ch, origin="routine", priority=1)
                    fired.append("channel.publish")
            if row is None:
                s.add(Setting(key=STATE_KEY, value=state))
            else:
                row.value = state
        return fired


scheduler = Scheduler()
