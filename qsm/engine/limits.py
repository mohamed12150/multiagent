"""Daily limits and the campaign manager's authority to raise them.

Two kinds of daily post limit:
- organic (no campaign) per channel — `limits.organic_posts_per_day[channel]`;
- per campaign — the smaller of the campaign's own `posts_per_day` and `limits.campaign_posts_per_day`.
Ad spend has a daily and a monthly cap, plus each campaign's own daily cap and total budget.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import events, settings
from ..db import utcnow
from ..models import CHANNELS, Campaign, LimitChange, Message, Post
from . import approvals, clock, policy

COUNTED = ("scheduled", "publishing", "published")
RAISABLE = {"organic_posts_per_day", "campaign_posts_per_day", "daily_ad_spend_cap", "monthly_ad_spend_cap"}
CAMPAIGN_FIELDS = {"campaign.posts_per_day": "posts_per_day", "campaign.daily_budget_cap": "daily_budget_cap"}


class LimitError(ValueError):
    pass


@dataclass(frozen=True)
class Room:
    used: int
    limit: int

    @property
    def remaining(self) -> int:
        return max(0, self.limit - self.used)


def _post_count(s: Session, day: date, *, channel: str | None = None, campaign_id: str | None = None,
                organic: bool = False) -> int:
    start, end = clock.day_bounds_utc(day)
    when = func.coalesce(Post.published_at, Post.scheduled_at)
    q = select(func.count()).select_from(Post).where(Post.status.in_(COUNTED), when >= start, when < end)
    if channel:
        q = q.where(Post.channel == channel)
    if organic:
        q = q.where(Post.campaign_id.is_(None))
    elif campaign_id:
        q = q.where(Post.campaign_id == campaign_id)
    return int(s.scalar(q) or 0)


def organic_room(s: Session, channel: str, day: date | None = None) -> Room:
    lim = settings.get(s, "limits").organic_posts_per_day.get(channel, 0)
    return Room(used=_post_count(s, day or clock.today(), channel=channel, organic=True), limit=lim)


def campaign_room(s: Session, campaign: Campaign, day: date | None = None) -> Room:
    cap = settings.get(s, "limits").campaign_posts_per_day
    lim = min(campaign.posts_per_day or cap, cap)
    return Room(used=_post_count(s, day or clock.today(), campaign_id=campaign.id), limit=lim)


def room_for(s: Session, post: Post, day: date | None = None) -> Room:
    if post.campaign_id:
        campaign = s.get(Campaign, post.campaign_id)
        if campaign is not None:
            return campaign_room(s, campaign, day)
    return organic_room(s, post.channel, day)


def spend_between(s: Session, start_day: date, end_day: date, campaign_id: str | None = None) -> float:
    start, _ = clock.day_bounds_utc(start_day)
    _, end = clock.day_bounds_utc(end_day)
    q = select(func.coalesce(func.sum(Post.promoted_budget), 0.0)).where(
        Post.status == "published", Post.published_at >= start, Post.published_at < end)
    if campaign_id:
        q = q.where(Post.campaign_id == campaign_id)
    return float(s.scalar(q) or 0.0)


def can_spend(s: Session, amount: float, campaign: Campaign | None) -> tuple[bool, str]:
    if amount <= 0:
        return True, ""
    lim = settings.get(s, "limits")
    day = clock.today()
    if spend_between(s, day, day) + amount > lim.daily_ad_spend_cap:
        return False, f"يتجاوز سقف الصرف اليومي ({lim.daily_ad_spend_cap:g})"
    if spend_between(s, day.replace(day=1), day) + amount > lim.monthly_ad_spend_cap:
        return False, f"يتجاوز سقف الصرف الشهري ({lim.monthly_ad_spend_cap:g})"
    if campaign is not None:
        if campaign.daily_budget_cap and spend_between(s, day, day, campaign.id) + amount > campaign.daily_budget_cap:
            return False, f"يتجاوز سقف الحملة اليومي ({campaign.daily_budget_cap:g})"
        if campaign.budget_total and campaign.spent + amount > campaign.budget_total:
            return False, "يتجاوز ميزانية الحملة الكلية"
    return True, ""


def replies_last_hour(s: Session) -> int:
    since = utcnow() - timedelta(hours=1)
    return int(s.scalar(select(func.count()).select_from(Message).where(
        Message.direction == "out", Message.status == "sent", Message.created_at >= since)) or 0)


def broadcasts_on(s: Session, day: date) -> int:
    """WhatsApp messages sent to subscribers that day (each broadcast post records its recipient count)."""
    start, end = clock.day_bounds_utc(day)
    rows = s.scalars(select(Post).where(Post.channel == "whatsapp", Post.status == "published",
                                        Post.published_at >= start, Post.published_at < end)).all()
    return sum(int((p.metrics or {}).get("recipients", 0)) for p in rows)


def snapshot(s: Session) -> dict[str, Any]:
    """Today's usage against every limit — the Limits panel and the agents' context."""
    lim = settings.get(s, "limits")
    day = clock.today()
    channels = {}
    for ch in CHANNELS:
        r = organic_room(s, ch, day)
        channels[ch] = {"used": r.used, "limit": r.limit}
    active = s.scalars(select(Campaign).where(Campaign.status == "active")).all()
    return {
        "day": day.isoformat(),
        "organic": channels,
        "campaigns": [{"id": c.id, "name": c.name, "used": campaign_room(s, c, day).used,
                       "limit": campaign_room(s, c, day).limit, "spent": round(c.spent, 2),
                       "budget_total": c.budget_total, "daily_budget_cap": c.daily_budget_cap} for c in active],
        "spend_today": round(spend_between(s, day, day), 2),
        "spend_month": round(spend_between(s, day.replace(day=1), day), 2),
        "replies_last_hour": replies_last_hour(s),
        "broadcasts_today": broadcasts_on(s, day),
        "limits": lim.model_dump(mode="json"),
    }


# ---------------------------------------------------------------- raising limits

def _current(lim: settings.Limits, key: str, channel: str | None, camp: Campaign | None = None) -> float:
    if key in CAMPAIGN_FIELDS:
        return float(getattr(camp, CAMPAIGN_FIELDS[key]) or 0)
    if key == "organic_posts_per_day":
        return float(lim.organic_posts_per_day.get(str(channel), 0))
    return float(getattr(lim, key))


def _ceiling(lim: settings.Limits, key: str) -> float:
    auth = lim.raise_authority
    if key == "campaign.posts_per_day":
        return float(min(auth.ceiling_campaign_posts, lim.campaign_posts_per_day))
    if key == "campaign.daily_budget_cap":
        return float(min(auth.ceiling_daily_ad_spend, lim.daily_ad_spend_cap))
    return {"organic_posts_per_day": auth.ceiling_organic_posts, "campaign_posts_per_day": auth.ceiling_campaign_posts,
            "daily_ad_spend_cap": auth.ceiling_daily_ad_spend,
            "monthly_ad_spend_cap": auth.ceiling_daily_ad_spend * 31}[key]


def _apply(s: Session, key: str, channel: str | None, value: float, *, by: str, campaign_id: str | None = None) -> None:
    if key in CAMPAIGN_FIELDS:
        camp = s.get(Campaign, campaign_id or "")
        if camp is not None:
            setattr(camp, CAMPAIGN_FIELDS[key], int(value) if key == "campaign.posts_per_day" else float(value))
        return
    lim = settings.get(s, "limits").model_dump(mode="json")
    if key == "organic_posts_per_day":
        lim = {**lim, "organic_posts_per_day": {**lim["organic_posts_per_day"], str(channel): int(value)}}
    else:
        lim = {**lim, key: int(value) if key == "campaign_posts_per_day" else float(value)}
    settings.put(s, "limits", lim, by=by)


def label(key: str, channel: str | None) -> str:
    names = {"campaign.posts_per_day": "منشورات الحملة اليومية", "campaign.daily_budget_cap": "سقف الحملة اليومي",
             "organic_posts_per_day": "منشورات اليوم بدون حملات", "campaign_posts_per_day": "منشورات الحملة اليومية",
             "daily_ad_spend_cap": "سقف الصرف اليومي", "monthly_ad_spend_cap": "سقف الصرف الشهري"}
    base = names.get(key, key)
    return f"{base} — {channel}" if channel else base


def request_raise(s: Session, *, key: str, value: float, by: str, reason: str,
                  channel: str | None = None, campaign_id: str | None = None,
                  permission: str = "raise_limits") -> LimitChange:
    """An agent (or the owner) asks to change a limit. Owner/manager changes apply at once; the campaign manager
    applies its own raise only when `raise_limits` is auto, authority is enabled, and the new value respects both the
    step and the ceiling — otherwise the request goes to the approval desk."""
    if key not in RAISABLE and key not in CAMPAIGN_FIELDS:
        raise LimitError(f"limit {key} cannot be raised this way")
    if key == "organic_posts_per_day" and channel not in CHANNELS:
        raise LimitError("organic limit needs a channel")
    camp = s.get(Campaign, campaign_id or "") if key in CAMPAIGN_FIELDS else None
    if key in CAMPAIGN_FIELDS and camp is None:
        raise LimitError("campaign limit needs an existing campaign")
    if value < 0:
        raise LimitError("limit cannot be negative")
    lim = settings.get(s, "limits")
    old = _current(lim, key, channel, camp)
    full_key = f"{key}.{channel}" if channel else (f"{key}.{campaign_id}" if camp is not None else key)
    change = LimitChange(key=full_key, old_value=old, new_value=value, by_actor=by, reason=reason[:1000])
    s.add(change)
    if by.startswith("user:"):
        _apply(s, key, channel, value, by=by, campaign_id=campaign_id)
        change.status = "applied"
    else:
        decision = policy.decide(s, by, permission)
        auth = lim.raise_authority
        # From zero there is no step to measure: a frozen limit is the owner's decision to unfreeze.
        step_ok = old > 0 and (value - old) / old * 100 <= auth.max_step_pct
        within = value <= _ceiling(lim, key)
        if decision == "off":
            change.status = "rejected"
        # lowering is always allowed: it only tightens spend
        elif value <= old or (decision == "auto" and auth.enabled and step_ok and within):
            _apply(s, key, channel, value, by=by, campaign_id=campaign_id)
            change.status = "applied"
        else:
            change.status = "pending"
            s.flush()
            approvals.request(s, "limit", ref_id=change.id, agent_id=by,
                              title=f"رفع {label(key, channel)} من {old:g} إلى {value:g}", summary=reason,
                              payload={"key": key, "channel": channel, "campaign_id": campaign_id, "old": old,
                                       "new": value, "within_authority": bool(step_ok and within)})
    s.flush()
    verb = {"applied": "رُفع", "pending": "طُلب رفع", "rejected": "رُفض رفع"}[change.status]
    events.record(s, "limit.change", f"{verb} {label(key, channel)}: {old:g} ← {value:g}", actor=by,
                  ref_kind="limit", ref_id=change.id, detail={"reason": reason, "status": change.status})
    return change


@approvals.resolver("limit")
def _resolve_limit(s: Session, approval: Any, approved: bool) -> None:
    change = s.get(LimitChange, approval.ref_id)
    if change is None or change.status != "pending":
        return
    if approved:
        p = approval.payload
        _apply(s, p["key"], p.get("channel"), float(p["new"]), by=approval.decided_by or "owner",
               campaign_id=p.get("campaign_id"))
        change.status = "applied"
    else:
        change.status = "rejected"


def recent_changes(s: Session, limit: int = 30) -> list[LimitChange]:
    return list(s.scalars(select(LimitChange).order_by(LimitChange.created_at.desc()).limit(limit)).all())
