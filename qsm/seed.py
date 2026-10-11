"""First-run rows: the ten agents and the seven connections. Existing rows are never overwritten, so the owner's
model, permission and routine choices survive restarts and upgrades; new routines are merged in."""
from __future__ import annotations

from sqlalchemy.orm import Session

from . import connectors, settings
from .agents.registry import SPECS, default_permissions
from .models import Agent


def ensure_agents(s: Session) -> None:
    level = settings.get(s, "autonomy").level
    for spec in SPECS:
        agent = s.get(Agent, spec.id)
        if agent is None:
            s.add(Agent(id=spec.id, name=spec.name, title=spec.title, tier=spec.tier, channel=spec.channel,
                        model=spec.model, effort=spec.effort, permissions=default_permissions(spec, level),
                        routines={k: dict(v) for k, v in spec.routines.items()}))
            continue
        missing = {k: dict(v) for k, v in spec.routines.items() if k not in (agent.routines or {})}
        if missing:
            agent.routines = {**(agent.routines or {}), **missing}
        perms = {p: v for p, v in default_permissions(spec, level).items() if p not in (agent.permissions or {})}
        if perms:
            agent.permissions = {**(agent.permissions or {}), **perms}
        if agent.status == "working":  # a restart interrupted it; the guardian requeues the task
            agent.status, agent.current_task_id = "idle", None


def run(s: Session) -> None:
    ensure_agents(s)
    connectors.ensure_rows(s)
