"""Permission checks: every side effect an agent takes asks `decide(agent, action)` first."""
from __future__ import annotations

from sqlalchemy.orm import Session

from .. import settings
from ..agents.registry import BY_ID, PRESETS, VALUES
from ..models import Agent


def decide(s: Session, agent_id: str, action: str) -> str:
    """'auto' (act now), 'approve' (ask the owner first) or 'off' (never)."""
    agent = s.get(Agent, agent_id)
    if agent is None or not agent.enabled:
        return "off"
    value = (agent.permissions or {}).get(action)
    if value in VALUES:
        return str(value)
    spec = BY_ID.get(agent_id)
    if spec is None or action not in spec.permissions:
        return "off"
    return PRESETS[settings.get(s, "autonomy").level].get(action, "approve")


def apply_preset(s: Session, level: str, *, by: str) -> None:
    """Rewrite every agent's matrix from a preset (new dicts — never mutate the stored ones)."""
    if level not in PRESETS:
        raise ValueError(f"unknown autonomy level {level}")
    settings.put(s, "autonomy", {"level": level}, by=by)
    preset = PRESETS[level]
    for spec in BY_ID.values():
        agent = s.get(Agent, spec.id)
        if agent is not None:
            agent.permissions = {p: preset[p] for p in spec.permissions}
