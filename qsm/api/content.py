"""Content pipeline: posts from idea to published, approvals of content, scheduling and the calendar."""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import events, security
from ..agents.content import FORMATS, file_for_review
from ..agents.registry import CHANNEL_LABELS
from ..agents.runtime import enqueue, task_dict
from ..db import utcnow
from ..engine import approvals, clock, limits
from ..models import CHANNELS, Approval, Asset, Campaign, Post, User
from . import serial
from .deps import ApiError, actor, ai_quota, editor, found, get_db, manager, ok, viewer

router = APIRouter(prefix="/api/posts", tags=["content"])
EDITABLE = ("draft", "review", "approved", "scheduled", "rejected", "failed", "idea")


def _assets(s: Session, posts: list[Post]) -> dict[str, Asset]:
    ids = {i for p in posts for i in (p.asset_ids or [])}
    if not ids:
        return {}
    return {a.id: a for a in s.scalars(select(Asset).where(Asset.id.in_(ids))).all()}


def _out(s: Session, p: Post) -> dict:
    return serial.post(p, _assets(s, [p]))


@router.get("")
def list_posts(status: str | None = None, channel: str | None = None, campaign: str | None = None,
               q: str | None = None, limit: int = Query(200, ge=1, le=500), _: User = Depends(viewer),
               s: Session = Depends(get_db, scope="function")) -> dict:
    query = select(Post)
    if status:
        query = query.where(Post.status.in_(status.split(",")))
    if channel:
        query = query.where(Post.channel == channel)
    if campaign:
        query = query.where(Post.campaign_id == campaign)
    if q:
        like = f"%{q.strip()[:80]}%"
        query = query.where(Post.title.like(like) | Post.caption.like(like))
    rows = list(s.scalars(query.order_by(Post.updated_at.desc()).limit(limit)).all())
    counts = {st: int(n) for st, n in s.execute(select(Post.status, func.count()).group_by(Post.status)).all()}
    assets = _assets(s, rows)
    return ok([serial.post(p, assets) for p in rows], counts=counts)


@router.get("/calendar")
def calendar(start: str, days: int = Query(7, ge=1, le=42), _: User = Depends(viewer),
             s: Session = Depends(get_db, scope="function")) -> dict:
    try:
        first = datetime.fromisoformat(start).date()
    except ValueError as exc:
        raise ApiError(422, "bad_date", "تاريخ غير صالح") from exc
    lo, _hi = clock.day_bounds_utc(first)
    _lo, hi = clock.day_bounds_utc(first + timedelta(days=days - 1))
    when = func.coalesce(Post.published_at, Post.scheduled_at)
    rows = list(s.scalars(select(Post).where(when >= lo, when < hi, Post.status.in_(
        ("scheduled", "approved", "publishing", "published", "failed"))).order_by(when)).all())
    assets = _assets(s, rows)
    return ok([serial.post(p, assets) for p in rows])


@router.get("/{post_id}")
def get_post(post_id: str, _: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    p = found(s.get(Post, post_id), "المنشور")
    pending = s.scalar(select(Approval).where(Approval.kind == "post", Approval.ref_id == post_id,
                                              Approval.status == "pending"))
    return ok({**_out(s, p), "approval_id": pending.id if pending else None})


class PostIn(BaseModel):
    channel: str
    format: str = "post"
    title: str = Field(default="", max_length=200)
    caption: str = Field(default="", max_length=6000)
    script: str = Field(default="", max_length=6000)
    hashtags: list[str] = Field(default_factory=list, max_length=30)
    cta: str = Field(default="", max_length=200)
    asset_ids: list[str] = Field(default_factory=list, max_length=10)
    campaign_id: str | None = None
    submit: bool = False


def _validate(s: Session, body: PostIn) -> None:
    if body.channel not in CHANNELS:
        raise ApiError(422, "bad_channel", "القناة غير معروفة")
    if body.format not in FORMATS[body.channel]:
        raise ApiError(422, "bad_format", "الصيغة غير متاحة لهذه القناة")
    if body.campaign_id and s.get(Campaign, body.campaign_id) is None:
        raise ApiError(422, "bad_campaign", "الحملة غير موجودة")
    for aid in body.asset_ids:
        a = s.get(Asset, aid)
        if a is None or a.status != "approved":
            raise ApiError(422, "asset_not_approved", "استخدم ملفات معتمدة من المكتبة فقط")


@router.post("")
def create_post(body: PostIn, user: User = Depends(editor), s: Session = Depends(get_db, scope="function")) -> dict:
    _validate(s, body)
    p = Post(channel=body.channel, format=body.format, title=body.title, caption=body.caption, script=body.script,
             hashtags=body.hashtags, cta=body.cta, asset_ids=body.asset_ids, campaign_id=body.campaign_id or None,
             status="review" if body.submit else "draft", author_agent=actor(user))
    s.add(p)
    s.flush()
    if body.submit:
        file_for_review(s, p, agent_id="content")
    return ok(_out(s, p))


class PostPatch(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    caption: str | None = Field(default=None, max_length=6000)
    script: str | None = Field(default=None, max_length=6000)
    hashtags: list[str] | None = Field(default=None, max_length=30)
    cta: str | None = Field(default=None, max_length=200)
    asset_ids: list[str] | None = Field(default=None, max_length=10)
    format: str | None = None


@router.patch("/{post_id}")
def update_post(post_id: str, body: PostPatch, user: User = Depends(editor), s: Session = Depends(get_db, scope="function")) -> dict:
    p = found(s.get(Post, post_id), "المنشور")
    if p.status not in EDITABLE:
        raise ApiError(409, "locked", "لا يمكن تعديل منشور قيد النشر أو منشور")
    if body.asset_ids is not None:
        for aid in body.asset_ids:
            a = s.get(Asset, aid)
            if a is None or a.status != "approved":
                raise ApiError(422, "asset_not_approved", "استخدم ملفات معتمدة من المكتبة فقط")
        p.asset_ids = body.asset_ids
    if body.format is not None:
        if body.format not in FORMATS[p.channel]:
            raise ApiError(422, "bad_format", "الصيغة غير متاحة لهذه القناة")
        p.format = body.format
    for field in ("title", "caption", "script", "hashtags", "cta"):
        value = getattr(body, field)
        if value is not None:
            setattr(p, field, value)
    p.version = (p.version or 1) + 1
    if p.status in ("review", "approved", "scheduled"):
        approvals.cancel_for(s, "post", p.id)  # an approval always covers the exact text and media that go out
        if security.has_role(user, "manager") and p.status != "review":
            p.approved_by, p.approved_at = actor(user), utcnow()
        else:
            p.status, p.scheduled_at = "review", None
            file_for_review(s, p)
    return ok(_out(s, p))


class DecisionIn(BaseModel):
    note: str = Field(default="", max_length=2000)


def _pending(s: Session, post_id: str) -> Approval | None:
    return s.scalar(select(Approval).where(Approval.kind == "post", Approval.ref_id == post_id,
                                           Approval.status == "pending"))


@router.post("/{post_id}/submit")
def submit(post_id: str, user: User = Depends(editor), s: Session = Depends(get_db, scope="function")) -> dict:
    p = found(s.get(Post, post_id), "المنشور")
    if p.status not in ("draft", "rejected", "idea", "failed"):
        raise ApiError(409, "bad_state", "المنشور ليس مسودة")
    if p.channel in ("instagram", "tiktok") and not p.asset_ids:
        raise ApiError(422, "needs_media", "أرفق صورة أو مقطعًا معتمدًا قبل الإرسال للاعتماد")
    p.status, p.review_note = "review", ""
    file_for_review(s, p)
    return ok(_out(s, p))


@router.post("/{post_id}/approve")
def approve(post_id: str, body: DecisionIn, user: User = Depends(manager), s: Session = Depends(get_db, scope="function")) -> dict:
    p = found(s.get(Post, post_id), "المنشور")
    a = _pending(s, post_id)
    if a is not None:
        approvals.decide(s, a.id, True, by=actor(user), note=body.note)
    elif p.status in ("review", "draft"):
        p.status, p.approved_by, p.approved_at = "approved", actor(user), utcnow()
        enqueue(s, kind="coordinator.distribute", title="جدولة المحتوى المعتمد", created_by=actor(user),
                origin="user", priority=3)
    else:
        raise ApiError(409, "bad_state", "المنشور ليس بانتظار الاعتماد")
    return ok(_out(s, p))


@router.post("/{post_id}/reject")
def reject(post_id: str, body: DecisionIn, user: User = Depends(manager), s: Session = Depends(get_db, scope="function")) -> dict:
    p = found(s.get(Post, post_id), "المنشور")
    a = _pending(s, post_id)
    if a is not None:
        approvals.decide(s, a.id, False, by=actor(user), note=body.note)
    elif p.status in ("review", "draft", "approved", "scheduled"):
        if body.note.strip():
            p.status, p.review_note = "draft", body.note
            enqueue(s, kind="content.revise", title=f"تعديل: {p.title or 'منشور'}",
                    input={"post_id": p.id, "note": body.note}, created_by=actor(user), origin="user", priority=3)
        else:
            p.status = "rejected"
        p.scheduled_at = None
    else:
        raise ApiError(409, "bad_state", "لا يمكن رفض هذا المنشور")
    return ok(_out(s, p))


class ScheduleIn(BaseModel):
    at: str  # local "YYYY-MM-DDTHH:MM"


@router.post("/{post_id}/schedule")
def schedule(post_id: str, body: ScheduleIn, user: User = Depends(editor), s: Session = Depends(get_db, scope="function")) -> dict:
    p = found(s.get(Post, post_id), "المنشور")
    if p.status not in ("approved", "scheduled"):
        raise ApiError(409, "not_approved", "اعتمد المنشور أولًا ثم جدوله")
    try:
        local = datetime.fromisoformat(body.at)
    except ValueError as exc:
        raise ApiError(422, "bad_time", "وقت غير صالح") from exc
    at = clock.to_utc(local)
    if at < utcnow() - timedelta(minutes=1):
        raise ApiError(422, "past", "الوقت في الماضي")
    room = limits.room_for(s, p, clock.to_local(at).date())
    already = p.status == "scheduled" and p.scheduled_at and clock.to_local(p.scheduled_at).date() == local.date()
    if room.remaining <= 0 and not already:
        raise ApiError(409, "limit_reached", f"اكتمل ليمت ذلك اليوم ({room.limit}) — ارفع الليمت أو اختر يومًا آخر")
    p.scheduled_at, p.status, p.review_note = at, "scheduled", ""
    events.record(s, "post.scheduled", f"جُدول منشور {CHANNEL_LABELS[p.channel]} {clock.human(at)}", actor=actor(user),
                  ref_kind="post", ref_id=p.id)
    return ok(_out(s, p))


@router.post("/{post_id}/unschedule")
def unschedule(post_id: str, user: User = Depends(editor), s: Session = Depends(get_db, scope="function")) -> dict:
    p = found(s.get(Post, post_id), "المنشور")
    if p.status != "scheduled":
        raise ApiError(409, "bad_state", "المنشور غير مجدول")
    p.status, p.scheduled_at = "approved", None
    return ok(_out(s, p))


@router.post("/{post_id}/publish-now")
def publish_now(post_id: str, user: User = Depends(manager), s: Session = Depends(get_db, scope="function")) -> dict:
    p = found(s.get(Post, post_id), "المنشور")
    if p.status not in ("approved", "scheduled", "failed"):
        raise ApiError(409, "not_approved", "اعتمد المنشور أولًا")
    p.status, p.scheduled_at, p.attempts = "scheduled", utcnow(), 0
    t = enqueue(s, kind="channel.publish", title=f"نشر فوري — {CHANNEL_LABELS[p.channel]}", channel=p.channel,
                created_by=actor(user), origin="user", priority=1)
    return ok({"post": _out(s, p), "task": task_dict(t)})


@router.delete("/{post_id}")
def delete_post(post_id: str, user: User = Depends(manager), s: Session = Depends(get_db, scope="function")) -> dict:
    p = found(s.get(Post, post_id), "المنشور")
    if p.status in ("publishing",):
        raise ApiError(409, "busy", "المنشور قيد النشر الآن")
    approvals.cancel_for(s, "post", p.id)
    s.delete(p)
    return ok()


class GenerateIn(BaseModel):
    channel: str
    brief: str = Field(default="", max_length=1500)
    count: int = Field(default=1, ge=1, le=5)
    campaign_id: str | None = None


@router.post("/generate")
def generate(body: GenerateIn, user: User = Depends(editor), s: Session = Depends(get_db, scope="function")) -> dict:
    if body.channel not in CHANNELS:
        raise ApiError(422, "bad_channel", "القناة غير معروفة")
    ai_quota(user)
    t = enqueue(s, kind="content.create_post", title=f"كتابة محتوى {CHANNEL_LABELS[body.channel]}",
                input={"brief": body.brief, "count": body.count, "campaign_id": body.campaign_id or ""},
                channel=body.channel, created_by=actor(user), origin="user", priority=2)
    return ok(task_dict(t))

