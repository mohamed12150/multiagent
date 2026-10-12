"""القائد's own hand on the wheel: it measures the month against the owner's goals and acts on what it finds.

The model decides *what* to do; code decides what is *allowed*. Every action is re-validated against the live state
when it runs, every limit change still passes `limits.request_raise` (step + ceiling), spending can only move between
campaigns or go down, and the `intervene` permission picks the mode — auto: act now, approve: one plan on the
approval desk, off: observe and log only. Delegated work (content, analysis, engagement) follows `delegate`.
"""
from __future__ import annotations

import calendar
import logging
import math
from collections.abc import Callable
from datetime import date, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import events, settings
from ..db import iso, utcnow
from ..engine import approvals, clock, limits, policy
from ..models import CHANNELS, Agent, Approval, Campaign, Conversation, LimitChange, Post
from . import state, text
from .campaigns import campaign_results
from .registry import CHANNEL_LABELS
from .runtime import already_pending, enqueue

ACTIONS: dict[str, str] = {
    "pause_campaign": "إيقاف حملة مؤقتًا",
    "resume_campaign": "استئناف حملة",
    "shift_budget": "نقل ميزانية بين حملتين",
    "set_campaign_posts": "تعديل منشورات الحملة اليومية",
    "raise_channel_capacity": "رفع سعة قناة",
    "commission_content": "طلب محتوى",
    "analyze_channel": "تحليل قناة",
    "engage_channel": "تفاعل فوري على قناة",
    "request_optimization": "مراجعة الحملات",
    "request_proposal": "طلب حملة جديدة",
    "notify_owner": "تنبيه المالك",
}
# Actions that change campaigns or limits (the `intervene` permission); the rest is delegated work.
CHANGES = frozenset({"pause_campaign", "resume_campaign", "shift_budget", "set_campaign_posts",
                     "raise_channel_capacity"})
FOCUS_LABELS = {"leads": "العملاء المحتملون", "sales": "المبيعات", "engagement": "التفاعل", "awareness": "الوصول"}
log = logging.getLogger("qsm.steer")
MAX_ACTIONS = 6
MAX_CAMPAIGN_POSTS = 20
MAX_ORGANIC_POSTS = 50  # the Limits model's own bound
AGENT_PAUSERS = ("ceo", "campaigns")  # القائد resumes only what an agent paused, never what a person paused
DECISIONS_KEPT = 20
MIN_DAYS_TO_JUDGE = 3  # a campaign younger than this has not had a fair chance yet
WAITING = ("open", "pending", "escalated")
BLANK: dict[str, Any] = {"campaign_id": "", "to_campaign_id": "", "channel": "", "value": 0, "count": 0, "brief": "",
                         "reason": "", "expected": ""}

ACTION_ITEM: dict[str, Any] = {"type": "object", "properties": {
    "type": {"type": "string", "enum": list(ACTIONS)},
    "campaign_id": {"type": "string"},
    "to_campaign_id": {"type": "string", "description": "للنقل فقط: الحملة التي تستقبل الميزانية"},
    "channel": {"type": "string", "enum": ["", *CHANNELS]},
    "value": {"type": "number", "description": "القيمة الجديدة أو المبلغ المنقول"},
    "count": {"type": "integer"},
    "brief": {"type": "string"},
    "reason": {"type": "string", "description": "الرقم من الصورة الذي يبرر القرار"},
    "expected": {"type": "string", "description": "الأثر المتوقع"}}}

STEER_SCHEMA: dict[str, Any] = {"type": "object", "properties": {
    "assessment": {"type": "string", "description": "أين نحن من أهداف الشهر ولماذا — 2-3 جمل بالأرقام"},
    "risks": {"type": "array", "items": {"type": "string"}},
    "actions": {"type": "array", "items": ACTION_ITEM}}}

ACTION_GUIDE = """الإجراءات التي تملكها:
- pause_campaign (campaign_id): إيقاف حملة تستنزف الميزانية بلا نتيجة.
- resume_campaign (campaign_id): استئناف حملة موقوفة تحسنت ظروفها.
- shift_budget (campaign_id → to_campaign_id، value = المبلغ اليومي المنقول): من الأضعف عائدًا إلى الأقوى.
- set_campaign_posts (campaign_id، value = منشورات اليوم الجديدة).
- raise_channel_capacity (channel، value = سعة اليوم الجديدة بدون حملات) لقناة أثبتت عائدها.
- commission_content (channel، count 1-5، brief، campaign_id اختياري): محتوى يسد فجوة محددة.
- analyze_channel / engage_channel (channel): تحليل أداء، أو تفاعل فوري مع رسائل وتعليقات تنتظر.
- request_optimization: مراجعة تفصيلية للحملات مع مدير الحملات.
- request_proposal (brief): حملة جديدة عندما لا تكفي الحملات الحالية لبلوغ الهدف.
- notify_owner (reason): ما لا يحله إلا المالك (اعتمادات متراكمة، قناة غير مربوطة)."""


# ---------------------------------------------------------------- the picture

def _month(today: date) -> tuple[date, int, int]:
    return today.replace(day=1), today.day, calendar.monthrange(today.year, today.month)[1]


def _track(actual: float, target: float, elapsed: int, days: int) -> dict[str, Any]:
    if not target:
        return {"actual": actual, "target": 0, "pace": None, "projected": actual}
    expected = target * elapsed / days
    return {"actual": actual, "target": target, "pace": round(actual / expected * 100) if expected else None,
            "projected": round(actual / elapsed * days) if elapsed else actual}


def progress(s: Session, goals: settings.Goals) -> dict[str, Any]:
    """Month to date against the targets; pace 100 = exactly on track for the month."""
    today = clock.today()
    start, elapsed, days = _month(today)
    tot = state.totals(state.channel_kpis(s, start, today))
    leads = state.conversations_between(s, start, today)["leads"]
    return {"month": start.isoformat()[:7], "day": elapsed, "days": days, "focus": goals.focus,
            "leads": _track(leads, goals.monthly_leads, elapsed, days),
            "reach": _track(tot["reach"], goals.monthly_reach, elapsed, days),
            "engagement_rate": {"actual": tot["engagement_rate"], "target": goals.target_engagement_rate}}


def _by_channel(s: Session, *conds: Any) -> dict[str, int]:
    rows = s.execute(select(Conversation.channel, func.count()).where(*conds).group_by(Conversation.channel)).all()
    return {str(ch): int(n) for ch, n in rows}


def picture(s: Session, goals: settings.Goals) -> dict[str, Any]:
    """Everything القائد weighs, computed in code so the numbers it cites are exact."""
    today = clock.today()
    start_utc, _ = clock.day_bounds_utc(today.replace(day=1))
    camps = s.scalars(select(Campaign).where(Campaign.status.in_(("active", "paused")))).all()
    pending = s.execute(select(Approval.kind, func.count()).where(Approval.status == "pending")
                        .group_by(Approval.kind)).all()
    return {
        "progress": progress(s, goals),
        "campaigns": [{"id": c.id, "name": c.name, "status": c.status, "objective": c.objective,
                       "channels": c.channels, "posts_per_day": c.posts_per_day,
                       "daily_budget_cap": c.daily_budget_cap, "end_date": c.end_date,
                       **campaign_results(s, c)} for c in camps],
        "channels_7d": state.channel_kpis(s, today - timedelta(days=6), today),
        "leads_by_channel_month": _by_channel(s, Conversation.category == "lead",
                                              Conversation.created_at >= start_utc),
        "waiting_by_channel": _by_channel(s, Conversation.status.in_(WAITING)),
        "limits": limits.snapshot(s),
        "pending_approvals": {str(k): int(n) for k, n in pending},
        "pipeline": {str(st): int(n) for st, n in s.execute(
            select(Post.status, func.count()).group_by(Post.status)).all()},
        "recent_decisions": [{"at": d.get("at"), "assessment": d.get("assessment", "")[:160],
                              "actions": [a.get("label") for a in d.get("actions", [])]}
                             for d in decisions(s)[:5]],
    }


# ---------------------------------------------------------------- validating actions

def _campaign(s: Session, cid: str, *statuses: str) -> Campaign | None:
    camp = s.get(Campaign, cid) if cid else None
    return camp if camp is not None and camp.status in statuses else None


def _ended(camp: Campaign) -> bool:
    if not camp.end_date:
        return False
    try:
        return date.fromisoformat(camp.end_date) < clock.today()
    except ValueError:
        return True  # an unreadable end date is treated as over: never resume on a guess


def _label(s: Session, act: dict[str, Any]) -> str:
    camp = s.get(Campaign, act["campaign_id"]) if act["campaign_id"] else None
    dest = s.get(Campaign, act["to_campaign_id"]) if act["to_campaign_id"] else None
    name = f"«{camp.name}»" if camp else ""
    ch = CHANNEL_LABELS.get(act["channel"], "")
    v = act["value"]
    return {
        "pause_campaign": f"إيقاف {name} مؤقتًا",
        "resume_campaign": f"استئناف {name}",
        "shift_budget": f"نقل {v:g} يوميًا من {name} إلى «{dest.name if dest else ''}»",
        "set_campaign_posts": f"منشورات {name} اليومية إلى {int(v)}",
        "raise_channel_capacity": f"سعة {ch} اليومية بدون حملات إلى {int(v)}",
        "commission_content": f"{act['count']} منشورات جديدة على {ch}",
        "analyze_channel": f"تحليل أداء {ch}",
        "engage_channel": f"تفاعل فوري مع جمهور {ch}",
        "request_optimization": "مراجعة الحملات والليمت مع مدير الحملات",
        "request_proposal": "طلب حملة جديدة من مدير الحملات",
        "notify_owner": f"تنبيه المالك: {act['reason']}",
    }[act["type"]]


def _allowed(s: Session, act: dict[str, Any]) -> bool:
    kind, v, ch = act["type"], act["value"], act["channel"]
    if kind == "pause_campaign":
        return _campaign(s, act["campaign_id"], "active") is not None
    if kind == "resume_campaign":
        camp = _campaign(s, act["campaign_id"], "paused")
        return (camp is not None and camp.paused_by in AGENT_PAUSERS and not _ended(camp)
                and (not camp.budget_total or camp.spent < camp.budget_total))
    if kind == "shift_budget":
        src = _campaign(s, act["campaign_id"], "active")
        dest = _campaign(s, act["to_campaign_id"], "active")
        # Strictly less than the whole cap: a campaign cap of 0 means "no cap", the opposite of what a shift wants.
        return src is not None and dest is not None and src.id != dest.id and 0 < v < src.daily_budget_cap
    if kind == "set_campaign_posts":
        camp = _campaign(s, act["campaign_id"], "active")
        return camp is not None and 1 <= v <= MAX_CAMPAIGN_POSTS and int(v) != camp.posts_per_day
    if kind == "raise_channel_capacity":
        return bool(ch) and settings.get(s, "limits").organic_posts_per_day.get(ch, 0) < int(v) <= MAX_ORGANIC_POSTS
    if kind in ("commission_content", "analyze_channel", "engage_channel"):
        return bool(ch)
    if kind == "notify_owner":
        return bool(act["reason"])
    return True


def _basis(s: Session, act: dict[str, Any]) -> dict[str, Any]:
    """The values an action was decided on; a plan approved later runs only if they still hold."""
    out: dict[str, Any] = {}
    for key in ("campaign_id", "to_campaign_id"):
        camp = s.get(Campaign, act[key]) if act[key] else None
        if camp is not None:
            out[key] = [camp.status, camp.daily_budget_cap, camp.posts_per_day]
    if act["type"] == "raise_channel_capacity":
        out["organic"] = settings.get(s, "limits").organic_posts_per_day.get(act["channel"], 0)
    return out


def clean(s: Session, raw: Any) -> dict[str, Any] | None:
    """A model-proposed action, normalised and checked against the live state (None = not allowed now).
    The model's output is untrusted: any malformed value drops the action instead of failing the review."""
    try:
        return _clean(s, raw)
    except (TypeError, ValueError, OverflowError, AttributeError):
        return None


def _clean(s: Session, raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict) or not isinstance(raw.get("type"), str) or raw["type"] not in ACTIONS:
        return None
    value, count = float(raw.get("value") or 0), float(raw.get("count") or 0)
    if not (math.isfinite(value) and math.isfinite(count)) or abs(value) > 1e9:
        return None
    count = int(count)
    act = {**BLANK, **{k: raw[k] for k in BLANK if raw.get(k) is not None}, "type": raw["type"], "value": value}
    act = {**act, "channel": act["channel"] if act["channel"] in CHANNELS else "",
           "count": max(1, min(count, 5)) if act["type"] == "commission_content" else 0,
           "reason": text.clip(str(act["reason"]), 400), "brief": text.clip(str(act["brief"]), 1200),
           "expected": text.clip(str(act["expected"]), 300),
           "campaign_id": str(act["campaign_id"]), "to_campaign_id": str(act["to_campaign_id"])}
    if act["type"] == "commission_content":
        camp = _campaign(s, act["campaign_id"], "active")
        act = {**act, "campaign_id": camp.id if camp and act["channel"] in camp.channels else ""}
    if not _allowed(s, act):
        return None
    return {**act, "label": _label(s, act), "basis": _basis(s, act)}


# ---------------------------------------------------------------- carrying them out

def _limit_status(change: LimitChange) -> str:
    return {"applied": "done", "pending": "pending", "rejected": "rejected"}[change.status]


def _why(act: dict[str, Any]) -> str:
    return f"القائد: {act['reason']}" if act["reason"] else "قرار القائد"


def _pause(s: Session, act: dict[str, Any], by: str, _parent: str | None) -> str:
    camp = s.get(Campaign, act["campaign_id"])
    camp.status, camp.paused_by = "paused", "ceo"  # pausing only ever lowers spend
    events.record(s, "campaign.paused", f"القائد أوقف «{camp.name}» مؤقتًا", actor="ceo", ref_kind="campaign",
                  ref_id=camp.id, detail={"reason": act["reason"], "by": by})
    return "done"


def _resume(s: Session, act: dict[str, Any], by: str, _parent: str | None) -> str:
    camp = s.get(Campaign, act["campaign_id"])
    camp.status, camp.paused_by = "active", ""
    events.record(s, "campaign.resumed", f"القائد استأنف «{camp.name}»", actor="ceo", ref_kind="campaign",
                  ref_id=camp.id, detail={"reason": act["reason"], "by": by})
    return "done"


def _shift(s: Session, act: dict[str, Any], by: str, _parent: str | None) -> str:
    src, dest, amount = s.get(Campaign, act["campaign_id"]), s.get(Campaign, act["to_campaign_id"]), act["value"]
    # Lower first: if the raise then waits for approval, total spend only went down.
    limits.request_raise(s, key="campaign.daily_budget_cap", value=round(src.daily_budget_cap - amount, 2), by=by,
                         reason=_why(act), campaign_id=src.id, permission="intervene")
    change = limits.request_raise(s, key="campaign.daily_budget_cap", value=round(dest.daily_budget_cap + amount, 2),
                                  by=by, reason=_why(act), campaign_id=dest.id, permission="intervene")
    return _limit_status(change)


def _posts(s: Session, act: dict[str, Any], by: str, _parent: str | None) -> str:
    return _limit_status(limits.request_raise(s, key="campaign.posts_per_day", value=int(act["value"]), by=by,
                                              reason=_why(act), campaign_id=act["campaign_id"],
                                              permission="intervene"))


def _capacity(s: Session, act: dict[str, Any], by: str, _parent: str | None) -> str:
    return _limit_status(limits.request_raise(s, key="organic_posts_per_day", value=int(act["value"]), by=by,
                                              reason=_why(act), channel=act["channel"], permission="intervene"))


def _delegate(kind: str, title: Callable[[dict[str, Any]], str], fields: Callable[[dict[str, Any]], dict[str, Any]],
              *, once: bool = True) -> Callable[..., str]:
    def run(s: Session, act: dict[str, Any], _by: str, parent: str | None) -> str:
        owner = act["channel"] if kind.startswith("channel.") else kind.split(".")[0]
        if once and already_pending(s, kind, owner):
            return "skipped"
        enqueue(s, kind=kind, title=title(act), input=fields(act), channel=act["channel"] or None,
                parent_id=parent, origin="event", created_by="ceo", priority=3)
        return "done"
    return run


def _notify(s: Session, act: dict[str, Any], _by: str, _parent: str | None) -> str:
    events.notify(s, "القائد يحتاج قرارك", act["reason"], level="warning", kind="ceo", link="/approvals")
    return "done"


HANDLERS: dict[str, Callable[..., str]] = {
    "pause_campaign": _pause, "resume_campaign": _resume, "shift_budget": _shift, "set_campaign_posts": _posts,
    "raise_channel_capacity": _capacity, "notify_owner": _notify,
    "commission_content": _delegate(
        "content.create_post", lambda a: f"طلب القائد — {CHANNEL_LABELS[a['channel']]}",
        lambda a: {"brief": a["brief"] or a["reason"], "count": a["count"], "campaign_id": a["campaign_id"]},
        once=False),
    "analyze_channel": _delegate("channel.analyze", lambda a: f"تحليل أداء — {CHANNEL_LABELS[a['channel']]}",
                                 lambda a: {"focus": a["reason"]}),
    "engage_channel": _delegate("channel.engage", lambda a: f"تفاعل فوري — {CHANNEL_LABELS[a['channel']]}",
                                lambda a: {}),
    "request_optimization": _delegate("campaigns.optimize", lambda a: "مراجعة الحملات بطلب القائد",
                                      lambda a: {"focus": a["reason"]}),
    "request_proposal": _delegate("campaigns.propose", lambda a: "حملة جديدة بطلب القائد",
                                  lambda a: {"focus": a["brief"] or a["reason"]}),
}


def apply(s: Session, actions: list[dict[str, Any]], *, by: str, parent_id: str | None) -> list[dict[str, str]]:
    """Run actions now, re-checking each against the current state (it may have moved since the plan)."""
    out = []
    for raw in actions:
        act = clean(s, raw)
        stale = act is not None and isinstance(raw, dict) and "basis" in raw and raw["basis"] != act["basis"]
        if act is None or stale:
            out.append({"type": str(raw.get("type", "")) if isinstance(raw, dict) else "",
                        "label": str(raw.get("label") or "") if isinstance(raw, dict) else "", "status": "skipped",
                        "reason": "تغيّر الوضع منذ اتخاذ القرار ولم يعد الإجراء مناسبًا"})
            continue
        try:
            status = HANDLERS[act["type"]](s, act, by, parent_id)
        except (limits.LimitError, settings.SettingsError, ValueError) as exc:
            log.warning("steer action %s refused: %s", act["type"], exc)
            status = "rejected"
        out.append({"type": act["type"], "label": act["label"], "status": status, "reason": act["reason"]})
    return out


# ---------------------------------------------------------------- decision log and plans

def decisions(s: Session) -> list[dict[str, Any]]:
    agent = s.get(Agent, "ceo")
    return list(((agent.insights or {}) if agent else {}).get("decisions", []))


def used_today(s: Session) -> int:
    agent = s.get(Agent, "ceo")
    tally = ((agent.insights or {}) if agent else {}).get("interventions", {})
    return int(tally.get("count", 0)) if tally.get("day") == clock.today().isoformat() else 0


def log_decision(s: Session, *, source: str, mode: str, assessment: str, results: list[dict[str, str]],
                 goals: dict[str, Any] | None = None, counted: int = 0) -> None:
    agent = s.get(Agent, "ceo")
    if agent is None:
        return
    entry = {"at": iso(utcnow()), "source": source, "mode": mode, "assessment": text.clip(assessment, 600),
             "actions": results}
    insights = dict(agent.insights or {})
    tally = {"day": clock.today().isoformat(), "count": used_today(s) + counted}
    agent.insights = {**insights, "decisions": [entry, *insights.get("decisions", [])][:DECISIONS_KEPT],
                      "interventions": tally, **({"goals": goals} if goals is not None else {})}


def expire_plans(s: Session, source: str) -> None:
    """A newer reading from the same source supersedes its pending plan (a command never cancels a review's plan)."""
    for old in s.scalars(select(Approval).where(Approval.kind == "plan", Approval.status == "pending")).all():
        if (old.payload or {}).get("source", "steer") == source:
            old.status, old.decided_at, old.decided_by = "expired", utcnow(), "system"


def file_plan(s: Session, actions: list[dict[str, Any]], *, assessment: str, ref_id: str, source: str) -> Approval:
    expire_plans(s, source)
    return approvals.request(s, "plan", ref_id=ref_id, agent_id="ceo",
                             title=f"خطة القائد: {len(actions)} إجراءات لتحسين النتائج",
                             summary=text.clip(assessment, 600),
                             payload={"actions": actions, "assessment": assessment, "source": source})


def carry_out(s: Session, actions: list[dict[str, Any]], *, mode: str, room: int, ref_id: str, parent_id: str | None,
              assessment: str, source: str, goals: dict[str, Any] | None = None) -> dict[str, Any]:
    """Split by permission: delegated work and allowed changes run now; the rest becomes one plan or is only noted."""
    delegate_auto = policy.decide(s, "ceo", "delegate") == "auto"
    now: list[dict[str, Any]] = []
    held: list[dict[str, Any]] = []
    noted: list[dict[str, str]] = []
    for act in actions:
        change = act["type"] in CHANGES
        if (change and mode == "auto") or (not change and delegate_auto) or act["type"] == "notify_owner":
            now.append(act)
        elif (change and mode == "off") or not change:  # delegation switched off: noted, never queued for later
            noted.append({"type": act["type"], "label": act["label"], "status": "observed", "reason": act["reason"]})
        else:
            held.append(act)
    room = max(0, room)
    noted += [{"type": a["type"], "label": a["label"], "status": "deferred", "reason": a["reason"]} for a in now[room:]]
    now = now[:room]
    results = apply(s, now, by="ceo", parent_id=parent_id)
    if not held and any(a["type"] in CHANGES for a in now):
        expire_plans(s, source)  # changes already applied make an older pending plan from this source stale
    if held:
        file_plan(s, held, assessment=assessment, ref_id=ref_id, source=source)
        results += [{"type": a["type"], "label": a["label"], "status": "awaiting", "reason": a["reason"]} for a in held]
    results += noted
    used = sum(1 for r in results if r["status"] in ("done", "pending"))
    observed = any(n["status"] == "observed" for n in noted)
    shown = "approval" if held else "observe" if observed or (noted and not now) else "auto" if now else "steady"
    log_decision(s, source=source, mode=shown, assessment=assessment, results=results, goals=goals, counted=used)
    return {"mode": shown, "results": results}


def overview(s: Session) -> dict[str, Any]:
    """What the network page shows about القائد's steering: goals, live progress, mode and recent decisions."""
    goals = settings.get(s, "goals")
    return {"goals": goals.model_dump(mode="json"), "progress": progress(s, goals),
            "mode": policy.decide(s, "ceo", "intervene"), "used_today": used_today(s),
            "decisions": decisions(s)[:8]}


# ---------------------------------------------------------------- without a key: a rule-based reading

def _act(kind: str, reason: str, **fields: Any) -> dict[str, Any]:
    return {**BLANK, "type": kind, "reason": reason, **fields}


def _budget_moves(pic: dict[str, Any]) -> list[dict[str, Any]]:
    judged = sorted((c for c in pic["campaigns"] if c["status"] == "active" and c["spent"] > 0
                     and c["days_running"] >= MIN_DAYS_TO_JUDGE), key=lambda c: c["engagement_rate"])
    if len(judged) < 2:
        return []
    weak, strong = judged[0], judged[-1]
    step = pic["limits"]["limits"]["raise_authority"]["max_step_pct"] / 100
    # Stay inside one raise step so the receiving campaign's raise applies without waiting for approval.
    amount = round(min(weak["daily_budget_cap"] / 2, strong["daily_budget_cap"] * step), 2)
    if amount <= 0 or weak["engagement_rate"] * 2 > strong["engagement_rate"]:
        return []
    why = (f"تفاعل «{weak['name']}» {weak['engagement_rate']}٪ مقابل {strong['engagement_rate']}٪ "
           f"لـ«{strong['name']}» بعد {weak['days_running']} أيام")
    return [_act("shift_budget", why, campaign_id=weak["id"], to_campaign_id=strong["id"], value=amount,
                 expected="عائد أعلى بنفس الصرف الكلي")]


def simulate(pic: dict[str, Any], goals: settings.Goals) -> dict[str, Any]:
    prog, ch7 = pic["progress"], pic["channels_7d"]
    acts = _budget_moves(pic)
    best = max(CHANNELS, key=lambda ch: (ch7[ch]["engagement_rate"], ch7[ch]["reach"]))
    organic = pic["limits"]["organic"][best]
    if ch7[best]["engagement_rate"] >= goals.target_engagement_rate and organic["limit"] \
            and organic["used"] >= organic["limit"]:
        acts.append(_act("raise_channel_capacity", f"{CHANNEL_LABELS[best]} الأعلى تفاعلًا "
                         f"({ch7[best]['engagement_rate']}٪) وسعته اليوم مكتملة", channel=best,
                         value=organic["limit"] + 1, expected="وصول إضافي من القناة الرابحة"))
    pace = prog["leads"]["pace"]
    if pace is not None and pace < 80:
        acts.append(_act("commission_content", f"العملاء المحتملون {prog['leads']['actual']} من "
                         f"{prog['leads']['target']} (وتيرة {pace}٪)", channel=best, count=2,
                         brief="محتوى بدعوة واضحة ومباشرة للتواصل عبر الرسائل", expected="رفع الاستفسارات"))
        if not any(c["status"] == "active" for c in pic["campaigns"]):
            acts.append(_act("request_proposal", f"لا حملة نشطة ووتيرة العملاء {pace}٪",
                             brief="حملة تسد فجوة العملاء المحتملين لهذا الشهر"))
    waiting = max(pic["waiting_by_channel"].items(), key=lambda kv: kv[1], default=("", 0))
    if waiting[1] >= 5 and waiting[0] in CHANNELS:
        acts.append(_act("engage_channel", f"{waiting[1]} محادثات تنتظر الرد على {CHANNEL_LABELS[waiting[0]]}",
                         channel=waiting[0]))
    backlog = pic["pending_approvals"].get("post", 0)
    if backlog >= 5:
        acts.append(_act("notify_owner", f"{backlog} منشورات بانتظار اعتمادك وخط النشر متوقف عليها"))
    on_track = "على المسار" if pace is None or pace >= 95 else "متأخرون عن المسار"
    return {"assessment": f"اليوم {prog['day']} من {prog['days']}: العملاء المحتملون {prog['leads']['actual']} "
                          f"من {prog['leads']['target']} — {on_track}.",
            "risks": [], "actions": acts[:MAX_ACTIONS]}


@approvals.resolver("plan")
def _resolve_plan(s: Session, a: Approval, approved: bool) -> None:
    actions = list((a.payload or {}).get("actions", []))
    if approved:
        results = apply(s, actions, by=a.decided_by or "owner", parent_id=None)
    else:
        results = [{"type": str(x.get("type", "")), "label": str(x.get("label") or ""), "status": "declined",
                    "reason": str(x.get("reason") or "")} for x in actions]
    a.payload = {**(a.payload or {}), "results": results}
    log_decision(s, source=str((a.payload or {}).get("source") or "steer"),
                 mode="approved" if approved else "declined", assessment=a.summary, results=results)
