"""The approval desk. Agents file a request; the owner decides; a resolver registered per kind carries it out."""
from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import events, settings
from ..db import utcnow
from ..models import Approval
from . import notify

log = logging.getLogger("qsm.approvals")
Resolver = Callable[[Session, Approval, bool], None]
_resolvers: dict[str, Resolver] = {}
KIND_LABELS = {"post": "محتوى للنشر", "reply": "رد على عميل", "limit": "رفع ليمت", "campaign": "حملة",
               "broadcast": "رسالة جماعية", "fix": "إصلاح", "asset": "تصميم في المكتبة", "spend": "صرف ميزانية"}


class ApprovalError(ValueError):
    pass


def resolver(kind: str) -> Callable[[Resolver], Resolver]:
    def wrap(fn: Resolver) -> Resolver:
        _resolvers[kind] = fn
        return fn
    return wrap


def request(s: Session, kind: str, *, ref_id: str, agent_id: str, title: str, summary: str = "",
            payload: dict[str, Any] | None = None) -> Approval:
    existing = s.scalar(select(Approval).where(Approval.kind == kind, Approval.ref_id == ref_id,
                                               Approval.status == "pending"))
    if existing is not None:  # one open request per object
        return existing
    a = Approval(kind=kind, ref_id=ref_id, agent_id=agent_id, title=title[:240], summary=summary,
                 payload=payload or {})
    s.add(a)
    s.flush()
    events.record(s, "approval.requested", f"بانتظار اعتمادك: {title}", actor=agent_id, ref_kind="approval",
                  ref_id=a.id, detail={"kind": kind})
    events.publish("approvals", {"pending": pending_count(s)})
    label = KIND_LABELS.get(kind, kind)
    events.notify(s, f"بانتظار اعتمادك: {label}", title, level="info", kind="approval", link="/approvals")
    if any(c != "app" for c in settings.get(s, "notify").approval_channels):
        notify.fire("approval", subject=f"بانتظار اعتمادك: {label}", text=f"بانتظار اعتمادك ({label}):\n{title}")
    return a


def decide(s: Session, approval_id: str, approve: bool, *, by: str, note: str = "") -> Approval:
    a = s.get(Approval, approval_id)
    if a is None:
        raise ApprovalError("الطلب غير موجود")
    if a.status != "pending":
        raise ApprovalError("تم البت في هذا الطلب مسبقًا")
    a.status = "approved" if approve else "rejected"
    a.decided_by, a.note, a.decided_at = by, note[:2000], utcnow()
    fn = _resolvers.get(a.kind)
    if fn is not None:
        fn(s, a, approve)
    verb = "اعتمد" if approve else "رفض"
    events.record(s, "approval.decided", f"{verb} المالك: {a.title}", actor=by, ref_kind="approval", ref_id=a.id,
                  detail={"kind": a.kind, "approved": approve})
    events.publish("approvals", {"pending": pending_count(s)})
    return a


def cancel_for(s: Session, kind: str, ref_id: str) -> None:
    """Close open requests for an object that changed underneath them (e.g. a post edited by hand)."""
    for a in s.scalars(select(Approval).where(Approval.kind == kind, Approval.ref_id == ref_id,
                                              Approval.status == "pending")).all():
        a.status, a.decided_at, a.decided_by = "expired", utcnow(), "system"


def pending_count(s: Session) -> int:
    return int(s.scalar(select(func.count()).select_from(Approval).where(Approval.status == "pending")) or 0)
