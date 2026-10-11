"""Incident bookkeeping shared by the guardian and the scheduler's watchdog (no imports of either)."""
from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import events
from ..db import iso, utcnow
from ..models import Incident

OPEN = ("open", "fixing", "needs_owner")
SEVERITY_LEVEL = {"info": "info", "warning": "warning", "critical": "danger"}


def find_open(s: Session, fingerprint: str) -> Incident | None:
    return s.scalars(select(Incident).where(Incident.fingerprint == fingerprint, Incident.status.in_(OPEN))
                     .order_by(Incident.created_at.desc()).limit(1)).first()


def open_incident(s: Session, *, check: str, fingerprint: str, severity: str, title: str, detail: str,
                  fix_action: str = "") -> tuple[Incident, bool]:
    """(incident, created). An open incident with the same fingerprint is reused, never duplicated."""
    existing = find_open(s, fingerprint)
    if existing is not None:
        existing.detail = detail or existing.detail
        return existing, False
    inc = Incident(check=check, fingerprint=fingerprint[:160], severity=severity, title=title[:240], detail=detail,
                   fix_action=fix_action)
    s.add(inc)
    s.flush()
    events.publish("incident", incident_dict(inc))
    return inc, True


def close(s: Session, inc: Incident, status: str, detail: str = "") -> None:
    inc.status = status
    if detail:
        inc.fix_detail = detail[:2000]
    if status in ("fixed", "ignored"):
        inc.resolved_at = utcnow()
    events.publish("incident", incident_dict(inc))


def incident_dict(i: Incident) -> dict[str, Any]:
    return {"id": i.id, "check": i.check, "severity": i.severity, "title": i.title, "detail": i.detail,
            "status": i.status, "fix_action": i.fix_action, "fix_detail": i.fix_detail, "attempts": i.attempts,
            "created_at": iso(i.created_at), "updated_at": iso(i.updated_at), "resolved_at": iso(i.resolved_at)}
