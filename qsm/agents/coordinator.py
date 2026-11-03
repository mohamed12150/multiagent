"""المنسّق — chooses when and where each approved piece goes out, and writes the exact daily report that reaches
the owner on WhatsApp and email."""
from __future__ import annotations

import contextlib
from datetime import datetime, time, timedelta
from typing import Any

from sqlalchemy import func, select

from .. import db, events, settings
from ..ai import client as ai
from ..db import utcnow
from ..engine import clock, limits, notify, policy, reports
from ..models import CHANNELS, Agent, Campaign, Post, Report
from . import state, text
from .registry import CHANNEL_LABELS
from .runtime import Ctx, skill

LOOKAHEAD_DAYS = 7
MIN_LEAD = timedelta(minutes=10)
STAGGER = {"tiktok": 0, "instagram": 15, "x": 30, "linkedin": 45, "whatsapp": 5}
DEFAULT_HOURS: dict[str, list[int]] = {"tiktok": [19, 21, 16, 13], "instagram": [20, 13, 22, 17],
                                       "x": [9, 12, 18, 21], "linkedin": [9, 12, 17], "whatsapp": [11, 19, 16]}


def _hours(s: Any, channel: str) -> list[int]:
    agent = s.get(Agent, channel)
    best = [int(h) for h in ((agent.insights or {}).get("best_hours") or []) if 0 <= int(h) <= 23] if agent else []
    return list(dict.fromkeys([*best, *DEFAULT_HOURS[channel]]))


def _taken(s: Any) -> set[tuple[str, str, int]]:
    start = utcnow() - timedelta(hours=1)
    rows = s.execute(select(Post.channel, Post.scheduled_at).where(
        Post.status.in_(("scheduled", "approved")), Post.scheduled_at.is_not(None), Post.scheduled_at >= start)).all()
    out = set()
    for ch, at in rows:
        local = clock.to_local(at)
        out.add((ch, local.date().isoformat(), local.hour))
    return out


def find_slot(s: Any, post: Post, taken: set[tuple[str, str, int]], general: settings.General) -> datetime | None:
    zone = clock.tz()
    now = clock.now_local(zone)
    for offset in range(LOOKAHEAD_DAYS):
        day = now.date() + timedelta(days=offset)
        if limits.room_for(s, post, day).remaining <= 0:
            continue
        for hour in _hours(s, post.channel):
            if (post.channel, day.isoformat(), hour) in taken:
                continue
            slot = datetime.combine(day, time(hour, STAGGER[post.channel]), tzinfo=zone)
            if slot < now + MIN_LEAD:
                continue
            if post.channel == "whatsapp" and not clock.in_window(general.send_window_start, general.send_window_end,
                                                                   slot):
                continue
            return clock.to_utc(slot, zone)
    return None


@skill("coordinator.distribute")
async def distribute(ctx: Ctx) -> dict[str, Any]:
    decision = ctx.decide("schedule")
    if decision == "off":
        return {"summary": "الجدولة التلقائية موقوفة — جدول المحتوى يدويًا", "quiet": True}
    scheduled, waiting = [], 0
    with db.session() as s:
        general = settings.get(s, "general")
        posts = list(s.scalars(select(Post).where(Post.status == "approved", Post.scheduled_at.is_(None))
                               .order_by(Post.campaign_id.is_(None), Post.created_at)).all())
        taken = _taken(s)
        for post in posts:
            slot = find_slot(s, post, taken, general)
            if slot is None:
                waiting += 1
                post.review_note = "لا توجد سعة نشر خلال 7 أيام — ارفع الليمت أو أعد الترتيب"
                continue
            post.scheduled_at = slot
            if decision == "auto":
                post.status, post.review_note = "scheduled", ""
            else:
                post.review_note = "وقت مقترح من المنسق — اعتمد الجدولة"
            local = clock.to_local(slot)
            taken.add((post.channel, local.date().isoformat(), local.hour))
            s.flush()
            scheduled.append(f"{CHANNEL_LABELS[post.channel]} {clock.human(slot)}")
        if scheduled:
            events.record(s, "content.scheduled", f"المنسّق جدول {text.posts_ar(len(scheduled))} في أفضل الأوقات",
                          actor="coordinator",
                          detail={"slots": scheduled})
    if not posts:
        return {"summary": "لا يوجد محتوى معتمد بانتظار الجدولة", "quiet": True}
    tail = f" — {waiting} بلا سعة نشر" if waiting else ""
    return {"summary": f"جدولت {text.posts_ar(len(scheduled))}{tail}", "slots": scheduled}


REPORT_SCHEMA: dict[str, Any] = {"type": "object", "properties": {
    "headline": {"type": "string", "description": "عنوان اليوم في جملة واحدة بالأرقام"},
    "summary": {"type": "string", "description": "ملخص تنفيذي 3-5 جمل"},
    "highlights": {"type": "array", "items": {"type": "string"}},
    "issues": {"type": "array", "items": {"type": "string"}},
    "recommendations": {"type": "array", "items": {"type": "string"}},
    "tomorrow": {"type": "array", "items": {"type": "string"}},
    "channel_notes": {"type": "array", "items": {"type": "object", "properties": {
        "channel": {"type": "string", "enum": list(CHANNELS)}, "note": {"type": "string"}}}},
}}


def gather(s: Any, day: Any) -> dict[str, Any]:
    prev = day - timedelta(days=1)
    kpis = state.channel_kpis(s, day, day)
    prev_kpis = state.channel_kpis(s, prev, prev)
    start, end = clock.day_bounds_utc(day + timedelta(days=1))
    tomorrow = int(s.scalar(select(func.count()).select_from(Post).where(
        Post.status == "scheduled", Post.scheduled_at >= start, Post.scheduled_at < end)) or 0)
    pending_review = int(s.scalar(select(func.count()).select_from(Post).where(Post.status == "review")) or 0)
    campaigns = [{"name": c.name, "status": c.status, "spent": round(c.spent, 2), "budget": c.budget_total,
                  "channels": c.channels} for c in s.scalars(select(Campaign).where(Campaign.status == "active"))]
    followers_delta = {}
    for ch in CHANNELS:
        agent = s.get(Agent, ch)
        hist = (agent.insights or {}).get("followers_history", {}) if agent else {}
        today_n, prev_n = hist.get(day.isoformat()), hist.get(prev.isoformat())
        followers_delta[ch] = (today_n - prev_n) if isinstance(today_n, int) and isinstance(prev_n, int) else None
    return {
        "day": day.isoformat(), "channels": kpis, "totals": state.totals(kpis), "previous": state.totals(prev_kpis),
        "followers_delta": followers_delta, "conversations": state.conversations_between(s, day, day),
        "top_posts": state.top_posts(s, day, day), "tasks": state.task_stats(s, day, day),
        "incidents": state.incidents_between(s, day, day), "spend_today": limits.spend_between(s, day, day),
        "scheduled_tomorrow": tomorrow, "pending_review": pending_review, "campaigns": campaigns,
    }


def simulate_report(data: dict[str, Any]) -> dict[str, Any]:
    t, p = data["totals"], data["previous"]
    tomorrow = int(data["scheduled_tomorrow"])
    best = max(data["channels"].items(), key=lambda kv: kv[1]["engagement"])
    diff = t["engagement"] - p["engagement"]
    trend = f"ارتفع التفاعل {diff:+d}" if diff else "التفاعل مستقر"
    conv = data["conversations"]
    highlights = [f"نشرنا {text.posts_ar(t['posts'])} ووصلنا إلى {t['reach']:,} شخص",
                  f"أفضل قناة اليوم: {CHANNEL_LABELS[best[0]]} بتفاعل {best[1]['engagement']:,}",
                  f"ردّ الفريق على {conv['replies']} رسالة، ورصد {conv['leads']} فرص بيع"]
    issues = []
    if conv["complaints"]:
        issues.append(f"{conv['complaints']} شكوى تحتاج متابعتك")
    if data["pending_review"]:
        issues.append(f"{data['pending_review']} منشورات بانتظار اعتمادك")
    if data["incidents"].get("needs_owner"):
        issues.append("عطل يحتاج تدخلك — راجع صفحة الحارس")
    return {
        "headline": f"{text.posts_ar(t['posts'])} · {t['reach']:,} وصول · {t['engagement']:,} تفاعل، {trend}",
        "summary": f"يوم {'جيد' if diff >= 0 else 'أهدأ من أمس'}: معدل التفاعل {t['engagement_rate']}٪. "
                   f"{CHANNEL_LABELS[best[0]]} قادت الأداء"
                   + (f"، و{text.posts_ar(tomorrow)} مجدولة لبكرة." if tomorrow else "، ولا منشورات مجدولة لبكرة بعد."),
        "highlights": highlights, "issues": issues or ["لا توجد مشاكل مفتوحة"],
        "recommendations": [f"ضاعف المحتوى على {CHANNEL_LABELS[best[0]]} بنفس الزاوية الناجحة",
                            "حوّل فرص البيع لمكالمة خلال 24 ساعة"],
        "tomorrow": [f"نشر {text.posts_ar(tomorrow)} مجدولة" if tomorrow else "تجهيز محتوى الغد واعتماده صباحًا",
                     "متابعة الرسائل كل 15 دقيقة"],
        "channel_notes": [{"channel": ch, "note": f"{v['posts']} منشور · تفاعل {v['engagement']:,} · "
                                                  f"{v['engagement_rate']}٪"} for ch, v in data["channels"].items()],
    }


@skill("coordinator.daily_report")
async def daily_report(ctx: Ctx) -> dict[str, Any]:
    day = clock.today()
    if ctx.input.get("day"):
        with contextlib.suppress(ValueError):
            day = datetime.fromisoformat(str(ctx.input["day"])).date()
    with db.session() as s:
        data = gather(s, day)
        data["ai_cost_usd"] = round(ai.usage_summary(1)["cost_usd"], 4)
        base_url = (settings.get(s, "general").public_base_url or "").rstrip("/")
    ctx.progress("يجمع أرقام الوكلاء ويكتب تقرير اليوم")
    prompt = (f"اكتب تقرير الإنجاز اليومي للمالك ليوم {day.isoformat()} من هذه الأرقام الدقيقة فقط "
              f"(لا تخترع أي رقم، واستخدم الأرقام كما هي):\n{state.compact(data)}\n\n"
              "اجعل الإنجازات والملاحظات محددة بالأرقام، والتوصيات قابلة للتنفيذ غدًا.")
    result = await ctx.ai(prompt=prompt, schema=REPORT_SCHEMA, max_tokens=2500, simulate=lambda: simulate_report(data))
    sections = result.data or simulate_report(data)
    with db.session() as s:
        report = Report(day=day.isoformat(), kind="daily", title=f"تقرير الإنجاز ليوم {day.isoformat()}",
                        headline=text.clip(sections.get("headline", ""), 400),
                        summary=sections.get("summary", ""), data=data,
                        sections={k: sections.get(k, []) for k in ("highlights", "issues", "recommendations",
                                                                   "tomorrow", "channel_notes")}
                        | {"simulated": result.simulated})
        s.add(report)
        s.flush()
        report_id = report.id
        send = policy.decide(s, "coordinator", "send_reports") == "auto"
        events.record(s, "report.created", f"المنسّق أصدر {report.title}", actor="coordinator", ref_kind="report",
                      ref_id=report.id)
        wa = reports.whatsapp_text(report, base_url)
        html = reports.email_html(report, base_url)
    deliveries: list[dict[str, Any]] = []
    if send:
        deliveries = await notify.deliver("report", subject=f"تقرير الإنجاز اليومي ليوم {day.isoformat()}", text=wa,
                                          html=html)
    with db.session() as s:
        row = s.get(Report, report_id)
        row.deliveries = deliveries
        events.notify(s, "تقرير اليوم جاهز", row.headline, level="success", kind="report", link=f"/reports/{report_id}")
    sent = [d for d in deliveries if d.get("status") in ("sent", "sandbox")]
    return {"summary": f"أصدر تقرير اليوم وأرسله عبر {len(sent)} قناة" if send else "أصدر تقرير اليوم (الإرسال موقوف)",
            "report_id": report_id}
