"""مدير الحملات — reads the market and the competitors, proposes campaigns with budgets and KPIs, watches active
campaigns, and raises limits within the authority the owner granted."""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from sqlalchemy import select

from .. import db, events, settings
from ..db import utcnow
from ..engine import approvals, clock, limits, policy
from ..models import CHANNELS, Approval, Campaign, Competitor, Post
from . import prompts, state, text
from .registry import CHANNEL_LABELS
from .runtime import Ctx, enqueue, skill

OBJECTIVES = ("awareness", "engagement", "leads", "sales")
OBJECTIVE_LABELS = {"awareness": "الوعي", "engagement": "التفاعل", "leads": "العملاء المحتملون", "sales": "المبيعات"}
MAX_PROPOSALS = 3
CHANGE_LABELS = {"applied": "رُفع", "pending": "بانتظار اعتمادك", "rejected": "مرفوض"}

ANALYSIS_SCHEMA: dict[str, Any] = {"type": "object", "properties": {
    "positioning": {"type": "string"},
    "strengths": {"type": "array", "items": {"type": "string"}},
    "weaknesses": {"type": "array", "items": {"type": "string"}},
    "content_patterns": {"type": "array", "items": {"type": "string"}},
    "offers": {"type": "array", "items": {"type": "string"}},
    "opportunities": {"type": "array", "items": {"type": "string"}, "description": "فرص لنا من نقاط ضعفهم"},
    "threat": {"type": "string", "enum": ["low", "medium", "high"]}}}

PROPOSAL_SCHEMA: dict[str, Any] = {"type": "object", "properties": {"proposals": {"type": "array", "items": {
    "type": "object", "properties": {
        "name": {"type": "string"},
        "objective": {"type": "string", "enum": list(OBJECTIVES)},
        "rationale": {"type": "string", "description": "لماذا الآن ولماذا هذه الحملة — مبنية على البيانات"},
        "audience": {"type": "string"},
        "offer": {"type": "string"},
        "channels": {"type": "array", "items": {"type": "string", "enum": list(CHANNELS)}},
        "duration_days": {"type": "integer"},
        "budget_total": {"type": "number"},
        "daily_budget_cap": {"type": "number"},
        "posts_per_day": {"type": "integer"},
        "content_pillars": {"type": "array", "items": {"type": "string"}},
        "kpis": {"type": "object", "properties": {"reach": {"type": "integer"}, "engagement_rate": {"type": "number"},
                                                  "leads": {"type": "integer"}, "sales": {"type": "integer"}}},
        "expected": {"type": "string"},
        "risks": {"type": "string"},
        "first_posts": {"type": "array", "items": {"type": "object", "properties": {
            "channel": {"type": "string", "enum": list(CHANNELS)}, "brief": {"type": "string"}}}},
    }}}}}

OPTIMIZE_SCHEMA: dict[str, Any] = {"type": "object", "properties": {
    "assessment": {"type": "string"},
    "actions": {"type": "array", "items": {"type": "object", "properties": {
        "campaign_id": {"type": "string"},
        "type": {"type": "string", "enum": ["continue", "raise_posts", "lower_posts", "raise_budget", "pause"]},
        "value": {"type": "number"},
        "reason": {"type": "string"}}}},
    "limit_requests": {"type": "array", "items": {"type": "object", "properties": {
        "key": {"type": "string", "enum": sorted(limits.RAISABLE)},
        "channel": {"type": "string", "enum": ["", *CHANNELS]},
        "value": {"type": "number"},
        "reason": {"type": "string"}}}}}}


def _research_allowed(ctx: Ctx) -> bool:
    return ctx.decide("web_research") == "auto"


@skill("campaigns.analyze_competitors")
async def analyze_competitors(ctx: Ctx) -> dict[str, Any]:
    with db.session() as s:
        q = select(Competitor)
        if ctx.input.get("competitor_id"):
            q = q.where(Competitor.id == ctx.input["competitor_id"])
        rivals = [{"id": c.id, "name": c.name, "website": c.website, "handles": c.handles, "notes": c.notes}
                  for c in s.scalars(q.order_by(Competitor.created_at)).all()]
        brand = settings.get(s, "brand")
    if not rivals:
        return {"summary": "لا يوجد منافسون مسجّلون — أضفهم من صفحة الحملات › المنافسون"}
    done = []
    for rival in rivals[:6]:
        ctx.progress(f"يحلل المنافس {rival['name']}")
        prompt = (f"حلل هذا المنافس لشركة {brand.name} ({brand.industry}) في السوق السعودي:\n"
                  f"{prompts.untrusted(state.compact(rival))}\n"
                  "ركّز على: تموضعه، أنماط محتواه على المنصات، عروضه، نقاط قوته وضعفه، والفرص التي نستغلها.")

        def sim(r: dict[str, Any] = rival) -> dict[str, Any]:
            return {"positioning": f"{r['name']} يركز على السعر والانتشار الواسع",
                    "strengths": ["حضور قوي على تيك توك", "عروض موسمية متكررة"],
                    "weaknesses": ["ردود بطيئة على العملاء", "محتوى مكرر بلا قصة"],
                    "content_patterns": ["فيديوهات منتجات قصيرة", "مسابقات"],
                    "offers": ["خصم 15٪ في المواسم"],
                    "opportunities": ["تميّز بخدمة عملاء سريعة وواضحة", "محتوى قصص عملاء حقيقية"],
                    "threat": "medium"}

        result = await ctx.ai(prompt=prompt, schema=ANALYSIS_SCHEMA, max_tokens=2000, simulate=sim,
                              web_search=_research_allowed(ctx), max_searches=4)
        with db.session() as s:
            row = s.get(Competitor, rival["id"])
            if row is not None:
                row.analysis = {**(result.data or {}), "sources": list(result.sources), "simulated": result.simulated}
                row.analyzed_at = utcnow()
        done.append(rival["name"])
    return {"summary": f"حلّل {len(done)} منافسين: {'، '.join(done)}"}


def _simulate_proposals(overview: dict[str, Any], brand: settings.Brand, occasions: list[dict[str, str]],
                        focus: str) -> dict[str, Any]:
    best = sorted(overview["channels"].items(), key=lambda kv: kv[1]["engagement_rate"], reverse=True)
    chans = [c for c, _ in best[:3]] or ["instagram", "tiktok"]
    product = brand.products[0].name if brand.products else brand.name
    occasion = occasions[0]["name"] if occasions else "الموسم الحالي"
    lim = overview["limits"]["limits"]
    daily = round(min(lim["daily_ad_spend_cap"] * 0.6, 250), 0)
    return {"proposals": [{
        "name": f"حملة {occasion} — {product}", "objective": "sales",
        "rationale": f"{focus + ' — ' if focus else ''}{occasion} بعد {occasions[0]['in_days'] if occasions else 'أيام'} "
                     f"يوم، و{CHANNEL_LABELS[chans[0]]} الأعلى تفاعلًا لدينا هذا الأسبوع؛ المنافسون يركزون على السعر "
                     "فنتميز بالقيمة والخدمة.",
        "audience": brand.audience or "العملاء في الرياض وجدة 25-44",
        "offer": f"عرض محدود على {product} لمدة {14} يوم",
        "channels": chans, "duration_days": 14, "budget_total": daily * 14, "daily_budget_cap": daily,
        "posts_per_day": 3, "content_pillars": ["قصص عملاء", "عرض المنتج أثناء الاستخدام", "عدّ تنازلي للعرض"],
        "kpis": {"reach": 60000, "engagement_rate": 4.5, "leads": 120, "sales": 35},
        "expected": "زيادة الاستفسارات 30٪ خلال أسبوعين", "risks": "تشبع الجمهور بالعروض الموسمية",
        "first_posts": [{"channel": c, "brief": f"إعلان انطلاق {occasion} مع {product}"} for c in chans]}]}


@skill("campaigns.propose")
async def propose(ctx: Ctx) -> dict[str, Any]:
    focus = str(ctx.input.get("focus") or ctx.input.get("brief") or "")
    with db.session() as s:
        overview = state.overview(s, days=14)
        rivals = [{"name": c.name, "analysis": c.analysis} for c in s.scalars(select(Competitor)).all()]
        brand = settings.get(s, "brand")
        occasions = text.upcoming_occasions(clock.today())
    ctx.progress("يدرس السوق والمنافسين ليقترح حملة")
    prompt = (f"اقترح حتى {MAX_PROPOSALS} حملات تسويقية ترفع المبيعات لـ {brand.name}.\n"
              f"{('تركيز المالك: ' + focus) if focus else ''}\n"
              f"أداؤنا آخر 14 يوم:\n{state.compact(overview)}\n"
              f"تحليل المنافسين:\n{prompts.untrusted(state.compact(rivals))}\n"
              f"المناسبات السعودية القادمة: {occasions}\n\n"
              "لكل حملة: سبب مبني على البيانات، جمهور، عرض لا يخترع أسعارًا، قنوات (اختر الأعلى عائدًا)، مدة، "
              "ميزانية يومية لا تتجاوز سقف الصرف اليومي، منشورات يومية، محاور محتوى، مؤشرات أداء رقمية، "
              "وأول منشورات الانطلاق.")
    result = await ctx.ai(prompt=prompt, schema=PROPOSAL_SCHEMA, max_tokens=5000,
                          web_search=_research_allowed(ctx), max_searches=5,
                          simulate=lambda: _simulate_proposals(overview, brand, occasions, focus))
    created = []
    with db.session() as s:
        cap = settings.get(s, "limits").daily_ad_spend_cap
        auto = policy.decide(s, "campaigns", "launch_campaign") == "auto"
        for p in (result.data or {}).get("proposals", [])[:MAX_PROPOSALS]:
            start = clock.today() + timedelta(days=1)
            days = max(1, min(int(p.get("duration_days") or 14), 90))
            daily = round(min(float(p.get("daily_budget_cap") or 0), cap), 2)
            camp = Campaign(
                name=text.clip(p.get("name") or "حملة مقترحة", 160),
                objective=p.get("objective") if p.get("objective") in OBJECTIVES else "sales",
                status="proposed", channels=[c for c in p.get("channels", []) if c in CHANNELS] or ["instagram"],
                audience=p.get("audience", ""), offer=p.get("offer", ""),
                budget_total=round(min(float(p.get("budget_total") or daily * days), daily * days), 2),
                daily_budget_cap=daily, posts_per_day=max(1, min(int(p.get("posts_per_day") or 2), 20)),
                start_date=start.isoformat(), end_date=(start + timedelta(days=days - 1)).isoformat(),
                kpis=p.get("kpis") or {}, created_by="campaigns",
                proposal={k: p.get(k) for k in ("rationale", "content_pillars", "expected", "risks", "first_posts")}
                | {"sources": list(result.sources), "simulated": result.simulated})
            s.add(camp)
            s.flush()
            if auto:
                activate(s, camp, by="campaigns")
            else:
                approvals.request(s, "campaign", ref_id=camp.id, agent_id="campaigns", title=f"حملة مقترحة: {camp.name}",
                                  summary=text.clip(camp.proposal.get("rationale") or "", 400),
                                  payload={"budget_total": camp.budget_total, "channels": camp.channels})
            created.append(camp.name)
        if created:
            events.record(s, "campaign.proposed", f"مدير الحملات اقترح: {'، '.join(created)}", actor="campaigns")
    if not created:
        return {"summary": "لم يجد مدير الحملات فرصة تستحق حملة الآن"}
    return {"summary": f"اقترح {len(created)} حملة: {'، '.join(created)}"}


def activate(s: Any, camp: Campaign, *, by: str) -> None:
    """Approved/auto-launched: the campaign goes live and the launch posts are commissioned."""
    camp.status, camp.approved_by = "active", by
    if not camp.start_date or date.fromisoformat(camp.start_date) < clock.today():
        camp.start_date = clock.today().isoformat()
    first = camp.proposal.get("first_posts") or [{"channel": c, "brief": f"انطلاق {camp.name}"} for c in camp.channels]
    for item in first[:6]:
        if item.get("channel") in CHANNELS:
            enqueue(s, kind="content.create_post", title=f"انطلاق الحملة — {CHANNEL_LABELS[item['channel']]}",
                    input={"brief": item.get("brief", ""), "count": 1, "campaign_id": camp.id,
                           "channel": item["channel"]}, created_by="campaigns", origin="event", priority=3)
    events.record(s, "campaign.activated", f"انطلقت الحملة: {camp.name}", actor=by, ref_kind="campaign", ref_id=camp.id)


@approvals.resolver("campaign")
def _resolve_campaign(s: Any, a: Approval, approved: bool) -> None:
    camp = s.get(Campaign, a.ref_id)
    if camp is None or camp.status != "proposed":
        return
    if approved:
        activate(s, camp, by=a.decided_by or "owner")
    else:
        camp.status = "rejected"


def campaign_results(s: Any, camp: Campaign) -> dict[str, Any]:
    posts = list(s.scalars(select(Post).where(Post.campaign_id == camp.id, Post.status == "published")).all())
    m = state._sum(posts)
    days = (clock.today() - date.fromisoformat(camp.start_date)).days + 1 if camp.start_date else 1
    return {"posts": len(posts), **m, "engagement": state.engagement(m), "engagement_rate": state.rate(m),
            "days_running": max(1, days), "spent": round(camp.spent, 2), "budget_total": camp.budget_total,
            "room_today": limits.campaign_room(s, camp).remaining}


def _simulate_optimize(results: dict[str, dict[str, Any]], snap: dict[str, Any]) -> dict[str, Any]:
    actions, requests = [], []
    for cid, r in results.items():
        if r["engagement_rate"] >= 4 and r["room_today"] == 0:
            actions.append({"campaign_id": cid, "type": "raise_posts", "value": 1,
                            "reason": f"تفاعل {r['engagement_rate']}٪ أعلى من المستهدف والسعة مكتملة"})
        else:
            actions.append({"campaign_id": cid, "type": "continue", "value": 0, "reason": "الأداء ضمن المتوقع"})
    for ch, v in snap["organic"].items():
        if v["limit"] and v["used"] >= v["limit"]:
            requests.append({"key": "organic_posts_per_day", "channel": ch, "value": v["limit"] + 1,
                             "reason": f"سعة {CHANNEL_LABELS[ch]} اليومية مكتملة والتفاعل جيد"})
            break
    return {"assessment": "الحملات تسير وفق الخطة" if results else "لا حملات نشطة — تمت مراجعة السعة اليومية",
            "actions": actions, "limit_requests": requests}


@skill("campaigns.optimize")
async def optimize(ctx: Ctx) -> dict[str, Any]:
    with db.session() as s:
        active = list(s.scalars(select(Campaign).where(Campaign.status == "active")).all())
        results = {c.id: campaign_results(s, c) for c in active}
        names = {c.id: c.name for c in active}
        snap = limits.snapshot(s)
        auth = settings.get(s, "limits").raise_authority.model_dump()
    ctx.progress("يراجع أداء الحملات والليمت")
    prompt = (f"راجع الحملات النشطة واتخذ قرارات تحسين:\n{state.compact({'campaigns': results, 'names': names})}\n"
              f"الاستخدام مقابل الليمت اليوم:\n{state.compact(snap)}\n"
              f"صلاحيتك لرفع الليمت: {auth}\n"
              "ارفع فقط ما يثبت عائده بالأرقام، وأوقف ما يستنزف الميزانية بلا نتيجة.")
    result = await ctx.ai(prompt=prompt, schema=OPTIMIZE_SCHEMA, max_tokens=2500,
                          simulate=lambda: _simulate_optimize(results, snap))
    d = result.data or {}
    applied: list[str] = []
    with db.session() as s:
        for act in d.get("actions", []):
            camp = s.get(Campaign, act.get("campaign_id") or "")
            if camp is None or camp.status != "active":
                continue
            kind, value = act.get("type"), float(act.get("value") or 0)
            if kind in ("raise_posts", "lower_posts"):
                step = max(1, int(value or 1))
                new = camp.posts_per_day + step if kind == "raise_posts" else max(1, camp.posts_per_day - step)
                change = limits.request_raise(s, key="campaign.posts_per_day", value=new, by="campaigns",
                                              reason=act.get("reason", ""), campaign_id=camp.id)
                applied.append(f"منشورات «{camp.name}» إلى {new}/يوم: {CHANGE_LABELS[change.status]}")
            elif kind == "raise_budget" and value > camp.daily_budget_cap:
                change = limits.request_raise(s, key="campaign.daily_budget_cap", value=value, by="campaigns",
                                              reason=act.get("reason", ""), campaign_id=camp.id)
                applied.append(f"سقف «{camp.name}» اليومي إلى {value:g}: {CHANGE_LABELS[change.status]}")
            elif kind == "pause":
                camp.status, camp.paused_by = "paused", "campaigns"  # pausing only reduces spend
                applied.append(f"أوقف «{camp.name}» مؤقتًا: {act.get('reason', '')}")
        for req in d.get("limit_requests", [])[:3]:
            try:
                change = limits.request_raise(s, key=req.get("key", ""), value=float(req.get("value") or 0),
                                              by="campaigns", reason=req.get("reason", ""),
                                              channel=req.get("channel") or None)
            except limits.LimitError:
                continue
            applied.append(f"{limits.label(req['key'], req.get('channel') or None)}: {CHANGE_LABELS[change.status]}")
    summary = text.clip(str(d.get("assessment") or "تمت المراجعة"), 200)
    if applied:
        summary += " — " + "؛ ".join(applied[:4])
    return {"summary": summary, "applied": applied}
