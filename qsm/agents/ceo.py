"""القائد — turns the owner's commands into delegated work and direct interventions, plans each day's content, and
every few hours steers the month toward the owner's goals on its own (see `steer`)."""
from __future__ import annotations

from typing import Any

from sqlalchemy import select

from .. import db, settings
from ..engine import clock, limits, policy
from ..models import CHANNELS, Campaign
from . import prompts, state, steer, text
from .registry import BY_ID, CHANNEL_LABELS, DELEGATABLE
from .runtime import Ctx, SkillError, skill

MAX_TASKS = 8
MAX_POSTS_PER_TASK = 5

SKILL_GUIDE = """المهارات التي تستطيع تكليف الفريق بها:
- campaigns.propose: مدير الحملات يقترح حملة (brief = التركيز أو المناسبة).
- campaigns.analyze_competitors: مدير الحملات يحلل المنافسين.
- campaigns.optimize: مدير الحملات يراجع الحملات النشطة والميزانيات والليمت.
- content.create_post: صانع المحتوى يكتب منشورات من المكتبة (channel مطلوب، count من 1 إلى 5، brief = الفكرة، campaign_id اختياري).
- coordinator.distribute: المنسق يجدول المحتوى المعتمد في أفضل الأوقات.
- coordinator.daily_report: المنسق يصدر تقرير اليوم ويرسله.
- channel.analyze: وكيل القناة يحلل الأداء (channel مطلوب).
- channel.engage: وكيل القناة يجلب التعليقات والرسائل ويرد (channel مطلوب).
- guardian.sweep: الحارس يفحص النظام."""

PLAN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "reply": {"type": "string", "description": "ردك على المالك: ماذا فهمت وماذا ستفعل (2-4 جمل)"},
        "tasks": {"type": "array", "items": {"type": "object", "properties": {
            "skill": {"type": "string", "enum": list(DELEGATABLE)},
            "title": {"type": "string"},
            "channel": {"type": "string", "enum": ["", *CHANNELS]},
            "brief": {"type": "string"},
            "count": {"type": "integer"},
            "campaign_id": {"type": "string"},
        }}},
        "interventions": {"type": "array", "description": "تعديلات مباشرة على الحملات والسعة إن طلبها الأمر",
                          "items": steer.ACTION_ITEM},
    },
}

DAY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "focus": {"type": "string", "description": "محور اليوم في جملة"},
        "items": {"type": "array", "items": {"type": "object", "properties": {
            "channel": {"type": "string", "enum": list(CHANNELS)},
            "brief": {"type": "string"},
            "count": {"type": "integer"},
            "campaign_id": {"type": "string"},
        }}},
    },
}


def _simulate_plan(command: str, campaigns: list[dict[str, Any]]) -> dict[str, Any]:
    chans = text.detect_channels(command)
    tasks: list[dict[str, Any]] = []

    def add(sk: str, title: str, channel: str = "", brief: str = "", count: int = 1) -> None:
        tasks.append({"skill": sk, "title": title, "channel": channel, "brief": brief or command, "count": count,
                      "campaign_id": ""})

    if text.has_any(command, "حملة", "حملات", "ترويج", "عرض", "مبيعات"):
        add("campaigns.propose", "اقتراح حملة مبنية على السوق والمنافسين")
    if text.has_any(command, "منافس", "السوق"):
        add("campaigns.analyze_competitors", "تحليل المنافسين")
    if text.has_any(command, "محتوى", "منشور", "بوست", "سكربت", "فيديو", "ريلز", "تغريد", "انشر", "اكتب"):
        for ch in chans or ["instagram", "tiktok"]:
            add("content.create_post", f"كتابة محتوى {CHANNEL_LABELS[ch]}", ch, count=2)
        add("coordinator.distribute", "جدولة المحتوى المعتمد")
    if text.has_any(command, "حلل", "تحليل", "أداء", "اداء"):
        for ch in chans or list(CHANNELS):
            add("channel.analyze", f"تحليل أداء {CHANNEL_LABELS[ch]}", ch)
    if text.has_any(command, "رد", "تعليقات", "رسائل", "عملاء", "تفاعل"):
        for ch in chans or list(CHANNELS):
            add("channel.engage", f"التفاعل مع جمهور {CHANNEL_LABELS[ch]}", ch)
    if text.has_any(command, "تقرير"):
        add("coordinator.daily_report", "إصدار تقرير اليوم")
    if text.has_any(command, "فحص", "النظام", "أخطاء", "اخطاء", "عطل"):
        add("guardian.sweep", "فحص شامل للنظام")
    if not tasks:
        add("campaigns.propose", "اقتراح حملة تخدم الطلب")
        add("content.create_post", "محتوى إنستقرام يخدم الطلب", "instagram", count=1)
    names = "، ".join(dict.fromkeys(BY_ID[_owner(t)].name for t in tasks))
    return {"reply": f"تم. وزّعت أمرك على {names}. سأتابع التنفيذ وأرفع لك ما يحتاج اعتمادك.",
            "tasks": tasks[:MAX_TASKS], "interventions": _simulate_interventions(command, campaigns)}


def _simulate_interventions(command: str, campaigns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Without a key: honour an explicit "pause/stop campaign X" order when the campaign is named."""
    if not text.has_any(command, "أوقف", "اوقف", "إيقاف", "ايقاف"):
        return []
    named = [c for c in campaigns if c["status"] == "active" and c["name"] and c["name"] in command]
    return [{**steer.BLANK, "type": "pause_campaign", "campaign_id": c["id"], "reason": "بأمر المالك"}
            for c in named[:2]]


def _owner(task: dict[str, Any]) -> str:
    sk = task["skill"]
    return task["channel"] if sk.startswith("channel.") else {"campaigns": "campaigns", "content": "content",
                                                               "coordinator": "coordinator",
                                                               "guardian": "guardian"}[sk.split(".")[0]]


def _valid(task: dict[str, Any], campaign_ids: set[str]) -> dict[str, Any] | None:
    sk = task.get("skill")
    if sk not in DELEGATABLE:
        return None
    channel = task.get("channel") or ""
    if (sk.startswith("channel.") or sk == "content.create_post") and channel not in CHANNELS:
        return None
    cid = task.get("campaign_id") or ""
    return {"skill": sk, "title": text.clip(task.get("title") or sk, 200), "channel": channel,
            "brief": text.clip(task.get("brief") or "", 1500),
            "count": max(1, min(int(task.get("count") or 1), MAX_POSTS_PER_TASK)),
            "campaign_id": cid if cid in campaign_ids else ""}


@skill("ceo.command")
async def command(ctx: Ctx) -> dict[str, Any]:
    order = str(ctx.input.get("text") or "").strip()
    if not order:
        raise SkillError("الأمر فارغ")
    with db.session() as s:
        overview = state.overview(s, days=7)
        goals = settings.get(s, "goals")
        month = steer.progress(s, goals)
    campaigns = overview["campaigns"]
    ctx.progress("يحلل الأمر ويوزّع المهام")
    prompt = (f"أمر المالك:\n{order}\n\nفريقك:\n{prompts.roster()}\n\n{SKILL_GUIDE}\n\n"
              f"وتستطيع التدخل مباشرة (interventions) دون تكليف أحد:\n{steer.ACTION_GUIDE}\n\n"
              f"أهداف الشهر والتقدم نحوها:\n{state.compact(month)}\n"
              f"صورة العمل (آخر 7 أيام):\n{state.compact(overview)}\n\n"
              f"حوّل الأمر إلى أقل عدد من المهام يحقق الهدف (حد أقصى {MAX_TASKS}). لا تكلّف بما لا يلزم. "
              "إن طلب المالك تعديلًا على حملة أو سعة قناة فنفّذه في interventions بدل تكليف مدير الحملات. "
              "إن كان الأمر سؤالًا عن الأرقام فأجب في reply من صورة العمل ولا تُنشئ مهام.")
    result = await ctx.ai(prompt=prompt, schema=PLAN_SCHEMA, max_tokens=2500,
                          simulate=lambda: _simulate_plan(order, campaigns))
    plan = result.data or {}
    ids = {c["id"] for c in campaigns}
    tasks = [t for t in (_valid(t, ids) for t in plan.get("tasks", [])[:MAX_TASKS]) if t]
    if any(t["skill"] == "content.create_post" for t in tasks):
        # The content agent hands its own output to the coordinator; a parallel distribute would run too early.
        tasks = [t for t in tasks if t["skill"] != "coordinator.distribute"]
    for t in tasks:
        inp = {"brief": t["brief"], "count": t["count"], "campaign_id": t["campaign_id"], "focus": t["brief"]}
        ctx.spawn(t["skill"], t["title"], inp, channel=t["channel"] or None, priority=3)
    reply = str(plan.get("reply") or "تم استلام الأمر.")
    done = _intervene_on_order(ctx, plan.get("interventions") or [], reply)
    if done:
        reply += "\n" + "؛ ".join(f"{r['label']} ({STATUS_WORDS.get(r['status'], r['status'])})" for r in done)
    return {"summary": reply, "plan": tasks, "interventions": done, "_wait_children": bool(tasks)}


STATUS_WORDS = {"done": "نُفّذ", "pending": "بانتظار اعتمادك", "awaiting": "في خطة بانتظار اعتمادك",
                "rejected": "خارج الصلاحية", "skipped": "لم يعد مناسبًا", "observed": "التدخل موقوف",
                "deferred": "أُجّل"}


def _intervene_on_order(ctx: Ctx, raw: list[Any], reply: str) -> list[dict[str, str]]:
    """Interventions in a command follow the same `intervene` rules; a member without the campaigns capability
    cannot make القائد act on campaigns directly — their order becomes a plan for someone who can."""
    with db.session() as s:
        acts = [a for a in (steer.clean(s, r) for r in raw[:steer.MAX_ACTIONS]) if a and a["type"] in steer.CHANGES]
        if not acts:
            return []
        mode = policy.decide(s, "ceo", "intervene")
        if mode == "auto" and not ctx.input.get("can_steer"):
            mode = "approve"
        out = steer.carry_out(s, acts, mode=mode, room=steer.MAX_ACTIONS, ref_id=ctx.task_id,
                              parent_id=ctx.task_id, assessment=f"بأمر: {text.clip(reply, 300)}", source="command")
    return list(out["results"])


def _simulate_day(rooms: dict[str, int], brand: settings.Brand, campaigns: list[Campaign]) -> dict[str, Any]:
    products = [p.name for p in brand.products] or [brand.name]
    items = []
    for i, (ch, room) in enumerate(rooms.items()):
        if room <= 0:
            continue
        campaign = campaigns[i % len(campaigns)] if campaigns else None
        topic = products[i % len(products)]
        items.append({"channel": ch, "count": min(room, 2), "campaign_id": campaign.id if campaign else "",
                      "brief": f"محتوى عن {topic} بأسلوب {('قصة عميل' if i % 2 else 'نصيحة عملية')}"})
    return {"focus": f"تعزيز الحضور حول {products[0]} مع دعوة واضحة للتواصل", "items": items}


@skill("ceo.plan_day")
async def plan_day(ctx: Ctx) -> dict[str, Any]:
    with db.session() as s:
        rooms = {ch: limits.organic_room(s, ch).remaining for ch in CHANNELS}
        active = list(s.scalars(select(Campaign).where(Campaign.status == "active")).all())
        camp_rooms = {c.id: limits.campaign_room(s, c).remaining for c in active}
        brand = settings.get(s, "brand")
        overview = state.overview(s, days=7)
        occasions = text.upcoming_occasions(clock.today())
        month = steer.progress(s, settings.get(s, "goals"))
    if not any(rooms.values()) and not any(camp_rooms.values()):
        return {"summary": "لا توجد سعة نشر متبقية اليوم — الليمت مكتمل", "items": []}
    ctx.progress("يخطط لمحتوى اليوم")
    prompt = (f"خطط محتوى اليوم. السعة المتبقية للمنشورات بدون حملات: {rooms}\n"
              f"الحملات النشطة وسعتها: {[{'id': c.id, 'name': c.name, 'channels': c.channels, 'room': camp_rooms[c.id]} for c in active]}\n"
              f"المناسبات القادمة: {occasions}\n"
              f"هدف الشهر ({steer.FOCUS_LABELS[month['focus']]}) والتقدم نحوه: {state.compact(month)}\n"
              f"صورة العمل:\n{state.compact(overview)}\n\n"
              "اجعل كل منشور يخدم هدف الشهر مباشرة؛ إن كانت الوتيرة متأخرة فقدّم ما يثبت أنه يجلب النتيجة.\n"
              "لكل قناة لديها سعة: حدد فكرة محددة (brief) وعدد المنشورات (لا يتجاوز السعة)، واربطها بحملة نشطة إن "
              "كانت القناة ضمنها. نوّع الزوايا ولا تكرر فكرة الأمس.")
    result = await ctx.ai(prompt=prompt, schema=DAY_SCHEMA, max_tokens=2000,
                          simulate=lambda: _simulate_day(rooms, brand, active))
    plan = result.data or {}
    spawned = 0
    for item in plan.get("items", []):
        ch = item.get("channel")
        if ch not in CHANNELS:
            continue
        cid = item.get("campaign_id") or ""
        room = camp_rooms.get(cid, 0) if cid in camp_rooms else rooms.get(ch, 0)
        count = max(0, min(int(item.get("count") or 1), room, MAX_POSTS_PER_TASK))
        if count == 0:
            continue
        if cid in camp_rooms:
            camp_rooms[cid] -= count
        else:
            rooms[ch] -= count
            cid = ""
        ctx.spawn("content.create_post", f"محتوى اليوم — {CHANNEL_LABELS[ch]}",
                  {"brief": text.clip(item.get("brief") or "", 1200), "count": count, "campaign_id": cid},
                  channel=ch, priority=4)
        spawned += count
    focus = str(plan.get("focus") or "")
    return {"summary": f"خطة اليوم: {focus} — {spawned} منشورات قيد الكتابة", "focus": focus,
            "_wait_children": spawned > 0}


@skill("ceo.steer")
async def steer_month(ctx: Ctx) -> dict[str, Any]:
    """Measure the month against the goals and act: the CEO's own decisions, not proposals."""
    with db.session() as s:
        goals = settings.get(s, "goals")
        pic = steer.picture(s, goals)
        room = goals.max_daily_interventions - steer.used_today(s)
    ctx.progress("يقيس الشهر مقابل الأهداف ويقرر")
    guidance = f"توجيهات المالك: {goals.notes}\n" if goals.notes.strip() else ""
    prompt = (f"أنت صاحب القرار في بلوغ أهداف هذا الشهر. هدف التركيز: {steer.FOCUS_LABELS[goals.focus]}.\n"
              f"{guidance}الصورة الكاملة (أرقام محسوبة بدقة):\n{state.compact(pic)}\n\n{steer.ACTION_GUIDE}\n\n"
              "قواعد القرار:\n"
              f"- لا تحكم على حملة عمرها أقل من {steer.MIN_DAYS_TO_JUDGE} أيام.\n"
              "- كل إجراء يستند إلى رقم من الصورة تذكره في reason، وتذكر أثره المتوقع في expected.\n"
              "- انقل الميزانية من الأضعف عائدًا إلى الأقوى بدل زيادة الصرف الكلي، وارفع السعة لما أثبت عائده فقط.\n"
              "- لا تكرر قرارًا من recent_decisions ما لم تتغير الأرقام منذ اتخاذه.\n"
              "- إن كان كل شيء على المسار فاكتفِ بالتقييم بلا إجراءات.\n"
              f"- حد أقصى {steer.MAX_ACTIONS} إجراءات، والمتبقي لك اليوم {max(0, room)} تدخلات.")
    result = await ctx.ai(prompt=prompt, schema=steer.STEER_SCHEMA, max_tokens=3500,
                          simulate=lambda: steer.simulate(pic, goals))
    d = result.data or {}
    assessment = text.clip(str(d.get("assessment") or "تمت مراجعة الأداء"), 600)
    with db.session() as s:
        # Mode and room are read again after the model's answer: the owner may have changed them meanwhile.
        mode = policy.decide(s, "ceo", "intervene")
        room = settings.get(s, "goals").max_daily_interventions - steer.used_today(s)
        acts = [a for a in (steer.clean(s, r) for r in (d.get("actions") or [])[:steer.MAX_ACTIONS]) if a]
        out = steer.carry_out(s, acts, mode=mode, room=room, ref_id=ctx.task_id, parent_id=ctx.task_id,
                              assessment=assessment, source="steer", goals=pic["progress"])
    lines = [f"{r['label']} ({STATUS_WORDS.get(r['status'], r['status'])})" for r in out["results"]]
    summary = assessment + (" — " + "؛ ".join(lines[:4]) if lines else "")
    return {"summary": summary, "assessment": assessment, "risks": d.get("risks") or [], "mode": out["mode"],
            "actions": out["results"]}
