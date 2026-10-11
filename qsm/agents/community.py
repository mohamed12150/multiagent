"""The brand's voice with customers: classify every message, answer professionally, escalate complaints to the
owner, flag leads — and the approval resolvers for content and replies."""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import select

from .. import connectors, db, events, settings
from ..connectors.base import ConnectorError
from ..db import utcnow
from ..engine import approvals, limits, notify, policy
from ..models import Approval, Contact, Conversation, Message, Post
from . import prompts, text
from .guard import risky
from .registry import CHANNEL_LABELS
from .runtime import Ctx, SkillError, enqueue, skill

HISTORY = 12
CATEGORIES = ("inquiry", "lead", "complaint", "praise", "spam", "other")
CATEGORY_LABELS = {"inquiry": "استفسار", "lead": "فرصة بيع", "complaint": "شكوى", "praise": "إشادة", "spam": "مزعج",
                   "other": "أخرى"}

REPLY_SCHEMA: dict[str, Any] = {"type": "object", "properties": {
    "category": {"type": "string", "enum": list(CATEGORIES)},
    "sentiment": {"type": "string", "enum": ["positive", "neutral", "negative"]},
    "priority": {"type": "integer", "description": "1 عاجل جدًا … 5 عادي"},
    "reply": {"type": "string", "description": "الرد المقترح؛ فارغ للرسائل المزعجة"},
    "escalate": {"type": "boolean", "description": "هل يحتاج تدخل المالك"},
    "summary": {"type": "string", "description": "خلاصة المحادثة في سطر"}}}


def classify(message: str) -> str:
    if text.has_any(message, "متأخر", "عيب", "سيء", "سيئ", "ما أحد يرد", "استرجاع", "شكوى", "زعلان", "خربان"):
        return "complaint"
    if text.has_any(message, "أبغى أطلب", "ابغى اطلب", "كمية", "لشركتنا", "مهتم", "عرض سعر", "تعاقد"):
        return "lead"
    if text.has_any(message, "كم السعر", "متى", "وين", "هل", "تفاصيل", "؟", "?"):
        return "inquiry"
    if text.has_any(message, "شكرًا", "شكرا", "ما شاء الله", "روعة", "👏", "أحسن", "جميل"):
        return "praise"
    if len(message.strip()) <= 4:
        return "spam"
    return "other"


def simulated_reply(category: str, name: str, brand: settings.Brand) -> dict[str, Any]:
    contact = brand.phone or brand.website or "الخاص"
    greet = f"أهلًا {name} 🌷" if name else "أهلًا بك 🌷"
    replies = {
        "inquiry": f"{greet} شكرًا لسؤالك! أرسلنا لك التفاصيل كاملة على الخاص، ولأي استفسار سريع تواصل معنا على {contact}.",
        "lead": f"{greet} يسعدنا اهتمامك! فريق المبيعات بيتواصل معك خلال ساعات عمل اليوم، وإن حاب تختصر الوقت كلمنا على {contact}.",
        "complaint": f"{greet} نعتذر لك جدًا عن هذي التجربة، وصلنا طلبك وحوّلناه مباشرة للمسؤول وبنرجع لك اليوم بحل واضح.",
        "praise": f"{greet} كلامك وسام على صدورنا! شكرًا لثقتك 🤍",
        "other": f"{greet} شكرًا لتواصلك معنا! كيف نقدر نخدمك؟",
        "spam": "",
    }
    return {"category": category, "sentiment": {"complaint": "negative", "praise": "positive"}.get(category, "neutral"),
            "priority": {"complaint": 1, "lead": 2, "inquiry": 3}.get(category, 4), "reply": replies[category],
            "escalate": category == "complaint", "summary": f"{CATEGORY_LABELS[category]} من {name or 'عميل'}"}


async def send_message(message_id: str) -> str:
    """Send an outbound message through its channel; returns the new status."""
    with db.session() as s:
        m = s.get(Message, message_id)
        if m is None:
            return "missing"
        conv = s.get(Conversation, m.conversation_id)
        contact = s.get(Contact, conv.contact_id) if conv and conv.contact_id else None
        channel, kind, ref, body = conv.channel, conv.kind, conv.external_ref, m.text
        to = (contact.phone or contact.handle) if contact else ""
    conn = connectors.build(channel)
    try:
        ext = await conn.reply(kind=kind, external_ref=ref, to=to, text=body)
        status, error = "sent", ""
    except ConnectorError as exc:
        ext, status, error = "", "failed", str(exc)
    with db.session() as s:
        m = s.get(Message, message_id)
        conv = s.get(Conversation, m.conversation_id)
        m.status, m.external_id = status, ext
        m.meta = {**(m.meta or {}), "error": error, "sandbox": not conn.live}
        if status == "sent" and conv.status != "escalated":
            conv.status = "answered"
        events.publish("inbox", {"conversation_id": conv.id, "status": conv.status})
    if status == "failed":
        raise ConnectorError(error, transient=True)
    return status


@skill("content.reply")
async def reply(ctx: Ctx) -> dict[str, Any]:
    conv_id = ctx.input.get("conversation_id") or ""
    with db.session() as s:
        conv = s.get(Conversation, conv_id)
        if conv is None:
            raise SkillError("المحادثة غير موجودة")
        msgs = list(s.scalars(select(Message).where(Message.conversation_id == conv_id)
                              .order_by(Message.created_at.desc()).limit(HISTORY)).all())[::-1]
        if any(m.direction == "out" and m.status == "pending" for m in msgs):
            return {"summary": "بانتظار اعتمادك لرد سابق"}
        if not msgs or msgs[-1].direction != "in":
            return {"summary": "لا توجد رسالة جديدة"}
        contact = s.get(Contact, conv.contact_id) if conv.contact_id else None
        name = contact.name if contact else ""
        brand = settings.get(s, "brand")
        cap = settings.get(s, "limits").replies_per_hour
        if cap and limits.replies_last_hour(s) >= cap:
            enqueue(s, kind="content.reply", title=ctx.title, input={"conversation_id": conv_id},
                    run_after=utcnow() + timedelta(minutes=10), created_by="content", origin="event")
            return {"summary": "أُجّل الرد — بلغنا حد الردود في الساعة"}
        post = s.get(Post, conv.post_id) if conv.post_id else None
        channel, kind = conv.channel, conv.kind
        transcript = "\n".join(f"{'العميل' if m.direction == 'in' else 'نحن'}: {m.text}" for m in msgs)
        last_text = msgs[-1].text
    if classify(last_text) == "spam":  # emoji-only or near-empty: no model call, no reply (spam cannot drain the budget)
        with db.session() as s:
            conv = s.get(Conversation, conv_id)
            conv.category, conv.status, conv.unread = "spam", "closed", 0
        return {"summary": "رسالة مزعجة — أُغلقت دون رد", "category": "spam", "quiet": True}
    ctx.progress(f"يرد على عميل في {CHANNEL_LABELS[channel]}")
    prompt = (f"محادثة {('تعليق' if kind == 'comment' else 'رسالة خاصة')} على {CHANNEL_LABELS[channel]}"
              f"{(' — على منشور: ' + text.clip(post.caption, 140)) if post else ''}.\n"
              f"اسم العميل كما كتبه: {prompts.untrusted(name or 'عميل')}\n"
              f"{prompts.untrusted(transcript)}\n\nصنّف آخر رسالة واكتب ردًا احترافيًا دافئًا بلهجة العلامة "
              f"({'قصير جدًا لأنه تعليق عام' if kind == 'comment' else 'واضح ومفيد'}). "
              "لا تذكر أسعارًا أو مواعيد غير موجودة في ملف العلامة؛ وجّه للتواصل الخاص عند الحاجة. "
              "الشكوى: اعتذار + وعد بالمتابعة + escalate=true. المزعج: reply فارغ.")
    result = await ctx.ai(prompt=prompt, schema=REPLY_SCHEMA, max_tokens=900,
                          simulate=lambda: simulated_reply(classify(last_text), name, brand))
    d = result.data or {}
    category = d.get("category") if d.get("category") in CATEGORIES else "other"
    body = str(d.get("reply") or "").strip()
    escalate = bool(d.get("escalate")) or category == "complaint"
    with db.session() as s:
        conv = s.get(Conversation, conv_id)
        conv.category, conv.sentiment = category, d.get("sentiment") or "neutral"
        conv.priority, conv.unread = max(1, min(int(d.get("priority") or 3), 5)), 0
        contact = s.get(Contact, conv.contact_id) if conv.contact_id else None
        if contact is not None and category == "lead":
            contact.stage, contact.lead_score = "lead", min(100, (contact.lead_score or 0) + 30)
        if category == "spam" or not body:
            conv.status = "closed"
            return {"summary": f"{CATEGORY_LABELS[category]} — بدون رد", "category": category}
        decision = policy.decide(s, "content", "reply")
        hold = risky(body, brand)
        if hold and decision == "auto":
            decision = "approve"
        if decision == "off":
            conv.status = "escalated" if escalate else "pending"
            return {"summary": "الرد التلقائي موقوف — بانتظارك", "category": category}
        m = Message(conversation_id=conv_id, direction="out", author="content", text=body,
                    status="queued" if decision == "auto" else "pending",
                    meta={"category": category, "summary": d.get("summary", ""), "simulated": result.simulated,
                          "held": hold})
        s.add(m)
        s.flush()
        conv.status = "escalated" if escalate else ("pending" if decision != "auto" else conv.status)
        conv.last_message_at = utcnow()
        if decision != "auto":
            approvals.request(s, "reply", ref_id=m.id, agent_id="content",
                              title=f"رد على {name or 'عميل'} في {CHANNEL_LABELS[channel]} ({CATEGORY_LABELS[category]})",
                              summary=body, payload={"conversation_id": conv_id, "incoming": text.clip(last_text, 300),
                                                     "held": hold})
        message_id, auto = m.id, decision == "auto"
    if auto:
        await send_message(message_id)
    if escalate:
        await notify.owner_alert("approval", f"عميل يحتاج تدخلك — {CHANNEL_LABELS[channel]}",
                                 f"{name or 'عميل'}: {text.clip(last_text, 200)}", level="warning",
                                 link=f"/inbox?c={conv_id}")
    verb = "رد على" if auto else "جهّز ردًا بانتظار اعتمادك على"
    return {"summary": f"{verb} {name or 'عميل'} في {CHANNEL_LABELS[channel]} ({CATEGORY_LABELS[category]})",
            "category": category}


@skill("content.send_reply")
async def send_reply(ctx: Ctx) -> dict[str, Any]:
    status = await send_message(ctx.input.get("message_id") or "")
    return {"summary": "أُرسل الرد" if status == "sent" else f"حالة الرد: {status}"}


# ---------------------------------------------------------------- approval resolvers

@approvals.resolver("post")
def _resolve_post(s: Any, a: Approval, approved: bool) -> None:
    post = s.get(Post, a.ref_id)
    if post is None or post.status != "review":
        return
    if approved:
        post.status, post.approved_by, post.approved_at = "approved", a.decided_by, utcnow()
        enqueue(s, kind="coordinator.distribute", title="جدولة المحتوى المعتمد", created_by=a.decided_by or "owner",
                origin="user", priority=3)
    elif a.note.strip():
        post.status, post.review_note = "draft", a.note
        enqueue(s, kind="content.revise", title=f"تعديل: {post.title or 'منشور'}",
                input={"post_id": post.id, "note": a.note}, created_by=a.decided_by or "owner", origin="user",
                priority=3)
    else:
        post.status, post.review_note = "rejected", "رفضه المالك"


@approvals.resolver("reply")
def _resolve_reply(s: Any, a: Approval, approved: bool) -> None:
    m = s.get(Message, a.ref_id)
    if m is None or m.status != "pending":
        return
    if approved:
        m.status = "queued"
        enqueue(s, kind="content.send_reply", title="إرسال رد معتمد", input={"message_id": m.id},
                created_by=a.decided_by or "owner", origin="user", priority=2)
    else:
        m.status = "discarded"
