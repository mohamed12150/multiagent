"""Approval desk, notifications, the guardian's health board and AI usage."""
from __future__ import annotations

import shutil

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from .. import config, events, permissions
from ..agents.guardian import FIX_LABELS
from ..agents.runtime import enqueue, runtime, task_dict
from ..ai import client as ai
from ..connectors import catalog
from ..engine import approvals, incidents
from ..engine.scheduler import scheduler
from ..models import Approval, Connection, Incident, Message, Notification, Setting, Task, User
from . import serial
from .deps import ApiError, actor, cap, found, get_db, ok, viewer

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/approvals")
def list_approvals(status: str = "pending", kind: str | None = None, limit: int = Query(100, ge=1, le=300),
                   _: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    q = select(Approval).where(Approval.status == status)
    if kind:
        q = q.where(Approval.kind == kind)
    rows = s.scalars(q.order_by(Approval.created_at.desc()).limit(limit)).all()
    counts = {k: int(n) for k, n in s.execute(select(Approval.kind, func.count()).where(
        Approval.status == "pending").group_by(Approval.kind)).all()}
    return ok([serial.approval(a) for a in rows], counts=counts)


class DecisionIn(BaseModel):
    approve: bool
    note: str = Field(default="", max_length=2000)
    text: str | None = Field(default=None, max_length=4000)  # an edited reply before approving it


# Approving these applies limit, budget or system changes that their own screens reserve for these capabilities.
DECIDE_CAP = {"limit": "autonomy", "plan": "autonomy", "fix": "agents"}


@router.post("/approvals/{approval_id}/decide")
def decide(approval_id: str, body: DecisionIn, user: User = Depends(cap("approve")), s: Session = Depends(get_db, scope="function")) -> dict:
    a = found(s.get(Approval, approval_id), "الطلب")
    need = DECIDE_CAP.get(a.kind)
    if need and not permissions.has(user, need):
        label = permissions.CAPABILITIES[need]["label"]
        raise ApiError(403, "forbidden", f"هذا الطلب يغيّر ما تحكمه صلاحية «{label}»")
    if body.text is not None and a.kind == "reply" and body.approve:
        m = s.get(Message, a.ref_id)
        if m is not None and m.status == "pending":
            m.text = body.text.strip() or m.text
    try:
        approvals.decide(s, approval_id, body.approve, by=actor(user), note=body.note)
    except approvals.ApprovalError as exc:
        raise ApiError(409, "decided", str(exc)) from exc
    return ok(serial.approval(a))


@router.get("/notifications")
def notifications(limit: int = Query(40, ge=1, le=200), _: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    rows = s.scalars(select(Notification).order_by(Notification.created_at.desc()).limit(limit)).all()
    unread = int(s.scalar(select(func.count()).select_from(Notification).where(Notification.read.is_(False))) or 0)
    return ok([serial.notification(n) for n in rows], unread=unread)


@router.post("/notifications/read")
def read_all(_: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    s.execute(update(Notification).where(Notification.read.is_(False)).values(read=True))
    return ok()


@router.get("/guardian")
def guardian(_: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    rows = s.scalars(select(Incident).order_by(Incident.created_at.desc()).limit(80)).all()
    last = s.get(Setting, "guardian_last")
    disk = shutil.disk_usage(config.get().data_dir)
    conns = s.scalars(select(Connection)).all()
    queued = int(s.scalar(select(func.count()).select_from(Task).where(Task.status == "queued")) or 0)
    failed = int(s.scalar(select(func.count()).select_from(Task).where(Task.status == "failed")) or 0)
    components = [
        {"id": "runtime", "label": "محرك المهام", "ok": runtime.alive,
         "detail": f"{runtime.concurrency} مسارات متوازية · {queued} بالطابور"},
        {"id": "scheduler", "label": "المجدول", "ok": scheduler.alive or not config.get().scheduler_enabled,
         "detail": "يعمل كل 20 ثانية" if scheduler.alive else "متوقف"},
        {"id": "ai", "label": "الذكاء الاصطناعي", "ok": True,
         "detail": "متصل (Claude)" if ai.is_live() else "وضع المحاكاة — أضف مفتاح Claude"},
        {"id": "disk", "label": "التخزين", "ok": disk.free > 1024**3, "detail": f"{disk.free / 1024**3:.1f} جيجابايت متاحة"},
        {"id": "tasks", "label": "المهام المتعثرة", "ok": failed == 0, "detail": f"{failed} مهمة"},
    ] + [{"id": f"conn:{c.id}", "label": catalog.PROVIDERS.get(c.id, {}).get("label", c.id), "ok": c.status != "error",
          "detail": {"sandbox": "محاكاة", "live": "مباشر"}[c.mode] + (f" — {c.last_error[:80]}" if c.last_error else "")}
         for c in conns]
    return ok({"incidents": [incidents.incident_dict(i) for i in rows], "last": last.value if last else None,
               "components": components, "fix_labels": FIX_LABELS})


@router.post("/guardian/sweep")
def sweep(user: User = Depends(cap("command")), s: Session = Depends(get_db, scope="function")) -> dict:
    t = enqueue(s, kind="guardian.sweep", title="فحص شامل (طلب المالك)", created_by=actor(user), origin="user",
                priority=1)
    return ok(task_dict(t))


@router.post("/guardian/incidents/{incident_id}/fix")
def fix(incident_id: str, user: User = Depends(cap("agents")), s: Session = Depends(get_db, scope="function")) -> dict:
    inc = found(s.get(Incident, incident_id), "الحادثة")
    if not inc.fix_action:
        raise ApiError(409, "no_playbook", "لا توجد خطة إصلاح آلية لهذه الحالة")
    inc.status, inc.attempts = "open", 0
    t = enqueue(s, kind="guardian.apply_fix", title=f"تنفيذ إصلاح: {inc.title}",
                input={"incident_id": inc.id, "fix": inc.fix_action, "data": {}}, created_by=actor(user),
                origin="user", priority=1)
    return ok(task_dict(t))


@router.post("/guardian/incidents/{incident_id}/ignore")
def ignore(incident_id: str, user: User = Depends(cap("agents")), s: Session = Depends(get_db, scope="function")) -> dict:
    inc = found(s.get(Incident, incident_id), "الحادثة")
    incidents.close(s, inc, "ignored", f"تجاهلها {actor(user)}")
    events.record(s, "guardian.ignored", f"تجاهل المالك: {inc.title}", actor=actor(user))
    return ok(incidents.incident_dict(inc))


@router.get("/usage")
def usage(days: int = Query(1, ge=1, le=90), _: User = Depends(viewer)) -> dict:
    return ok({**ai.usage_summary(days), "days": days, "live": ai.is_live()})
