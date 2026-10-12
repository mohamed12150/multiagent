"""Unified inbox across the five channels, and the contact book with WhatsApp consent."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import events, permissions
from ..agents.runtime import already_pending, enqueue, task_dict
from ..db import utcnow
from ..engine import approvals
from ..models import Contact, Conversation, Message, User
from . import serial
from .deps import ApiError, actor, ai_quota, cap, found, get_db, ok, viewer

router = APIRouter(prefix="/api", tags=["inbox"])
STATUSES = ("open", "pending", "answered", "escalated", "closed")


def _last(s: Session, conv_id: str) -> Message | None:
    return s.scalars(select(Message).where(Message.conversation_id == conv_id)
                     .order_by(Message.created_at.desc()).limit(1)).first()


@router.get("/inbox")
def inbox(status: str | None = None, channel: str | None = None, category: str | None = None,
          limit: int = Query(100, ge=1, le=300), _: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    q = select(Conversation)
    if status:
        q = q.where(Conversation.status.in_(status.split(",")))
    if channel:
        q = q.where(Conversation.channel == channel)
    if category:
        q = q.where(Conversation.category == category)
    rows = s.scalars(q.order_by(Conversation.priority, Conversation.last_message_at.desc()).limit(limit)).all()
    out = [serial.conversation(c, s.get(Contact, c.contact_id) if c.contact_id else None, _last(s, c.id))
           for c in rows]
    counts = {st: int(n) for st, n in s.execute(select(Conversation.status, func.count())
                                                 .group_by(Conversation.status)).all()}
    return ok(out, counts=counts)


@router.get("/inbox/{conv_id}")
def conversation(conv_id: str, _: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    c = found(s.get(Conversation, conv_id), "المحادثة")
    msgs = s.scalars(select(Message).where(Message.conversation_id == conv_id).order_by(Message.created_at)).all()
    if c.unread:
        c.unread = 0
    contact = s.get(Contact, c.contact_id) if c.contact_id else None
    return ok({**serial.conversation(c, contact), "messages": [serial.message(m) for m in msgs]})


class ReplyIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


@router.post("/inbox/{conv_id}/reply")
def human_reply(conv_id: str, body: ReplyIn, user: User = Depends(cap("inbox")), s: Session = Depends(get_db, scope="function")) -> dict:
    c = found(s.get(Conversation, conv_id), "المحادثة")
    for pending in s.scalars(select(Message).where(Message.conversation_id == conv_id,
                                                   Message.status == "pending")).all():
        pending.status = "discarded"
        approvals.cancel_for(s, "reply", pending.id)
    m = Message(conversation_id=conv_id, direction="out", author=actor(user), text=body.text.strip(), status="queued")
    s.add(m)
    s.flush()
    c.last_message_at, c.status = utcnow(), "answered" if c.status != "escalated" else "escalated"
    t = enqueue(s, kind="content.send_reply", title="إرسال رد المالك", input={"message_id": m.id},
                created_by=actor(user), origin="user", priority=1)
    return ok({"message": serial.message(m), "task": task_dict(t)})


@router.post("/inbox/{conv_id}/ai-reply")
def ai_reply(conv_id: str, user: User = Depends(cap("inbox")), s: Session = Depends(get_db, scope="function")) -> dict:
    found(s.get(Conversation, conv_id), "المحادثة")
    ai_quota(user)
    if already_pending(s, "content.reply", "content", "conversation_id", conv_id):
        raise ApiError(409, "busy", "صانع المحتوى يجهّز الرد الآن")
    t = enqueue(s, kind="content.reply", title="رد على عميل", input={"conversation_id": conv_id},
                created_by=actor(user), origin="user", priority=1)
    return ok(task_dict(t))


class ConvPatch(BaseModel):
    status: str


@router.patch("/inbox/{conv_id}")
def set_status(conv_id: str, body: ConvPatch, user: User = Depends(cap("inbox")), s: Session = Depends(get_db, scope="function")) -> dict:
    c = found(s.get(Conversation, conv_id), "المحادثة")
    if body.status not in STATUSES:
        raise ApiError(422, "bad_status", "حالة غير معروفة")
    c.status = body.status
    events.publish("inbox", {"conversation_id": c.id, "status": c.status})
    return ok(serial.conversation(c))


@router.get("/contacts")
def contacts(channel: str | None = None, opted_in: bool | None = None, stage: str | None = None,
             limit: int = Query(200, ge=1, le=1000), _: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    q = select(Contact)
    if channel:
        q = q.where(Contact.channel == channel)
    if opted_in is not None:
        q = q.where(Contact.opted_in.is_(opted_in))
    if stage:
        q = q.where(Contact.stage == stage)
    rows = s.scalars(q.order_by(Contact.last_seen_at.desc()).limit(limit)).all()
    return ok([serial.contact(c) for c in rows])


class ContactPatch(BaseModel):
    name: str | None = Field(default=None, max_length=160)
    stage: str | None = None
    notes: str | None = Field(default=None, max_length=2000)
    opted_in: bool | None = None
    opt_source: str | None = Field(default=None, max_length=80)


@router.patch("/contacts/{contact_id}")
def edit_contact(contact_id: str, body: ContactPatch, user: User = Depends(cap("inbox")),
                 s: Session = Depends(get_db, scope="function")) -> dict:
    c = found(s.get(Contact, contact_id), "جهة الاتصال")
    if body.stage is not None:
        if body.stage not in ("new", "lead", "customer"):
            raise ApiError(422, "bad_stage", "مرحلة غير معروفة")
        c.stage = body.stage
    if body.name is not None:
        c.name = body.name
    if body.notes is not None:
        c.notes = body.notes
    if body.opted_in is not None:
        if not permissions.has(user, "approve"):
            raise ApiError(403, "consent_manager", "تسجيل موافقة التواصل يعتمده المدير أو المالك")
        if body.opted_in and not (body.opt_source or "").strip():
            raise ApiError(422, "consent_source", "حدد مصدر الموافقة (مثل: نموذج الموقع، طلب شفهي موثق)")
        c.opted_in = body.opted_in
        c.opted_in_at = utcnow() if body.opted_in else c.opted_in_at
        c.opt_source = f"manual:{(body.opt_source or 'opt_out').strip()} by {actor(user)}"
    return ok(serial.contact(c))

