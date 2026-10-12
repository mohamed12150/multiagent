"""Campaigns, competitors, and the limits panel (with the campaign manager's raise authority)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import events, permissions, settings
from ..agents.campaigns import OBJECTIVES, activate, campaign_results
from ..agents.runtime import enqueue, task_dict
from ..engine import approvals, limits
from ..models import CHANNELS, Approval, Campaign, Competitor, LimitChange, Post, User
from . import serial
from .deps import ApiError, actor, ai_quota, cap, found, get_db, ok, viewer

router = APIRouter(prefix="/api", tags=["campaigns"])


@router.get("/campaigns")
def list_campaigns(status: str | None = None, _: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    q = select(Campaign)
    if status:
        q = q.where(Campaign.status.in_(status.split(",")))
    rows = s.scalars(q.order_by(Campaign.created_at.desc()).limit(100)).all()
    out = []
    for c in rows:
        pending = s.scalar(select(Approval.id).where(Approval.kind == "campaign", Approval.ref_id == c.id,
                                                     Approval.status == "pending"))
        results = campaign_results(s, c) if c.status in ("active", "paused", "completed") else None
        out.append({**serial.campaign(c, results), "approval_id": pending})
    return ok(out)


@router.get("/campaigns/{campaign_id}")
def get_campaign(campaign_id: str, _: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    c = found(s.get(Campaign, campaign_id), "الحملة")
    posts = s.scalars(select(Post).where(Post.campaign_id == campaign_id).order_by(Post.created_at.desc())).all()
    return ok({**serial.campaign(c, campaign_results(s, c)), "posts": [serial.post(p) for p in posts]})


class CampaignIn(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    objective: str = "sales"
    channels: list[str] = Field(default_factory=list)
    audience: str = Field(default="", max_length=2000)
    offer: str = Field(default="", max_length=2000)
    budget_total: float = Field(default=0, ge=0)
    daily_budget_cap: float = Field(default=0, ge=0)
    posts_per_day: int = Field(default=2, ge=1, le=50)
    start_date: str = ""
    end_date: str = ""
    kpis: dict[str, Any] = Field(default_factory=dict)
    pillars: list[str] = Field(default_factory=list, max_length=10)
    launch: bool = False


def _check(body: CampaignIn, s: Session) -> None:
    if body.objective not in OBJECTIVES:
        raise ApiError(422, "bad_objective", "هدف الحملة غير معروف")
    bad = [c for c in body.channels if c not in CHANNELS]
    if bad or not body.channels:
        raise ApiError(422, "bad_channels", "اختر قناة واحدة على الأقل من القنوات المتاحة")
    cap = settings.get(s, "limits").daily_ad_spend_cap
    if body.daily_budget_cap > cap:
        raise ApiError(422, "over_cap", f"السقف اليومي للحملة يتجاوز سقف الصرف اليومي العام ({cap:g})")


@router.post("/campaigns")
def create_campaign(body: CampaignIn, user: User = Depends(cap("campaigns")), s: Session = Depends(get_db, scope="function")) -> dict:
    _check(body, s)
    if body.launch and not permissions.has(user, "approve"):
        raise ApiError(403, "forbidden", "إطلاق الحملة مباشرة يحتاج صلاحية «الاعتماد» — احفظها دون إطلاق")
    c = Campaign(name=body.name, objective=body.objective, channels=body.channels, audience=body.audience,
                 offer=body.offer, budget_total=body.budget_total, daily_budget_cap=body.daily_budget_cap,
                 posts_per_day=body.posts_per_day, start_date=body.start_date, end_date=body.end_date,
                 kpis=body.kpis, proposal={"content_pillars": body.pillars}, created_by=actor(user),
                 status="approved")
    s.add(c)
    s.flush()
    if body.launch:
        activate(s, c, by=actor(user))
    events.record(s, "campaign.created", f"أُنشئت حملة: {c.name}", actor=actor(user), ref_kind="campaign", ref_id=c.id)
    return ok(serial.campaign(c))


class CampaignPatch(BaseModel):
    status: str | None = None
    budget_total: float | None = Field(default=None, ge=0)
    daily_budget_cap: float | None = Field(default=None, ge=0)
    posts_per_day: int | None = Field(default=None, ge=1, le=50)
    end_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    audience: str | None = Field(default=None, max_length=2000)
    offer: str | None = Field(default=None, max_length=2000)


TRANSITIONS = {"approved": {"active"}, "active": {"paused", "completed"}, "paused": {"active", "completed"},
               "proposed": {"rejected"}, "rejected": set(), "completed": set()}


@router.patch("/campaigns/{campaign_id}")
def update_campaign(campaign_id: str, body: CampaignPatch, user: User = Depends(cap("campaigns")),
                    s: Session = Depends(get_db, scope="function")) -> dict:
    c = found(s.get(Campaign, campaign_id), "الحملة")
    if body.status and body.status != c.status:
        if body.status not in TRANSITIONS.get(c.status, set()):
            raise ApiError(409, "bad_transition", "لا يمكن نقل الحملة إلى هذه الحالة")
        if body.status == "active" and c.status == "approved":
            if not permissions.has(user, "approve"):
                raise ApiError(403, "forbidden", "إطلاق الحملة يحتاج صلاحية «الاعتماد»")
            activate(s, c, by=actor(user))
        else:
            c.status = body.status
        c.paused_by = actor(user) if body.status == "paused" else ""
        events.record(s, "campaign.status", f"الحملة «{c.name}» ← {body.status}", actor=actor(user),
                      ref_kind="campaign", ref_id=c.id)
    if body.daily_budget_cap is not None:
        cap = settings.get(s, "limits").daily_ad_spend_cap
        if body.daily_budget_cap > cap:
            raise ApiError(422, "over_cap", f"يتجاوز سقف الصرف اليومي العام ({cap:g})")
        c.daily_budget_cap = body.daily_budget_cap
    for field in ("budget_total", "posts_per_day", "end_date", "audience", "offer"):
        value = getattr(body, field)
        if value is not None:
            setattr(c, field, value)
    return ok(serial.campaign(c))


class DecideIn(BaseModel):
    approve: bool
    note: str = Field(default="", max_length=2000)


@router.post("/campaigns/{campaign_id}/decide")
def decide_campaign(campaign_id: str, body: DecideIn, user: User = Depends(cap("approve")),
                    s: Session = Depends(get_db, scope="function")) -> dict:
    c = found(s.get(Campaign, campaign_id), "الحملة")
    pending = s.scalar(select(Approval).where(Approval.kind == "campaign", Approval.ref_id == campaign_id,
                                              Approval.status == "pending"))
    if pending is not None:
        approvals.decide(s, pending.id, body.approve, by=actor(user), note=body.note)
    elif c.status == "proposed":
        if body.approve:
            activate(s, c, by=actor(user))
        else:
            c.status = "rejected"
    else:
        raise ApiError(409, "bad_state", "الحملة ليست مقترحة")
    return ok(serial.campaign(c))


class ProposeIn(BaseModel):
    focus: str = Field(default="", max_length=600)


@router.post("/campaigns/propose")
def propose(body: ProposeIn, user: User = Depends(cap("proposals")), s: Session = Depends(get_db, scope="function")) -> dict:
    ai_quota(user)
    t = enqueue(s, kind="campaigns.propose", title="اقتراح حملة" + (f": {body.focus[:80]}" if body.focus else ""),
                input={"focus": body.focus}, created_by=actor(user), origin="user", priority=2)
    return ok(task_dict(t))


# ---------------------------------------------------------------- competitors

class CompetitorIn(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    website: str = Field(default="", max_length=300)
    handles: dict[str, str] = Field(default_factory=dict)
    notes: str = Field(default="", max_length=3000)


@router.get("/competitors")
def competitors(_: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    return ok([serial.competitor(c) for c in s.scalars(select(Competitor).order_by(Competitor.created_at)).all()])


@router.post("/competitors")
def add_competitor(body: CompetitorIn, user: User = Depends(cap("proposals")), s: Session = Depends(get_db, scope="function")) -> dict:
    handles = {k: v.strip()[:120] for k, v in body.handles.items() if k in CHANNELS and v.strip()}
    c = Competitor(name=body.name.strip(), website=body.website.strip(), handles=handles, notes=body.notes)
    s.add(c)
    s.flush()
    return ok(serial.competitor(c))


@router.patch("/competitors/{cid}")
def edit_competitor(cid: str, body: CompetitorIn, _: User = Depends(cap("proposals")), s: Session = Depends(get_db, scope="function")) -> dict:
    c = found(s.get(Competitor, cid), "المنافس")
    c.name, c.website, c.notes = body.name.strip(), body.website.strip(), body.notes
    c.handles = {k: v.strip()[:120] for k, v in body.handles.items() if k in CHANNELS and v.strip()}
    return ok(serial.competitor(c))


@router.delete("/competitors/{cid}")
def delete_competitor(cid: str, _: User = Depends(cap("campaigns")), s: Session = Depends(get_db, scope="function")) -> dict:
    s.delete(found(s.get(Competitor, cid), "المنافس"))
    return ok()


@router.post("/competitors/analyze")
def analyze(user: User = Depends(cap("proposals")), s: Session = Depends(get_db, scope="function")) -> dict:
    ai_quota(user)
    t = enqueue(s, kind="campaigns.analyze_competitors", title="تحليل المنافسين", created_by=actor(user),
                origin="user", priority=2)
    return ok(task_dict(t))


# ---------------------------------------------------------------- limits

@router.get("/limits")
def get_limits(_: User = Depends(viewer), s: Session = Depends(get_db, scope="function")) -> dict:
    return ok({**limits.snapshot(s), "changes": [serial.limit_change(c) for c in limits.recent_changes(s)]})


@router.put("/limits")
def put_limits(body: dict[str, Any], user: User = Depends(cap("autonomy")), s: Session = Depends(get_db, scope="function")) -> dict:
    before = settings.get(s, "limits").model_dump(mode="json")
    try:
        after = settings.put(s, "limits", body, by=actor(user)).model_dump(mode="json")
    except settings.SettingsError as exc:
        raise ApiError(422, "bad_limits", str(exc)) from exc
    for key, old in before.items():
        new = after.get(key)
        if old != new and key != "raise_authority":
            s.add(LimitChange(key=key, old_value=old, new_value=new, by_actor=actor(user), reason="تعديل المالك"))
    if before.get("raise_authority") != after.get("raise_authority"):
        s.add(LimitChange(key="raise_authority", old_value=before["raise_authority"],
                          new_value=after["raise_authority"], by_actor=actor(user), reason="تعديل صلاحية الرفع"))
    events.record(s, "limits.updated", "حدّث المالك الليمت", actor=actor(user))
    return ok(limits.snapshot(s))
