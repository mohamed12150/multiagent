"""صانع المحتوى — picks approved media from the library, writes the script, caption and hashtags per channel,
revises on the owner's notes, describes new uploads, and answers customers in the brand's voice."""
from __future__ import annotations

import base64
from typing import Any

from sqlalchemy import select

from .. import db, events, settings
from ..engine import approvals, media, policy
from ..models import CHANNELS, Agent, Asset, Campaign, Post
from . import prompts, text
from .guard import risky as community_risky
from .registry import CHANNEL_LABELS
from .runtime import Ctx, SkillError, skill

MAX_CANDIDATES = 30
FORMATS: dict[str, tuple[str, ...]] = {
    "tiktok": ("video", "photo"), "instagram": ("reel", "post", "carousel", "story"), "x": ("post", "thread"),
    "linkedin": ("post", "article"), "whatsapp": ("broadcast",),
}
NEEDS_MEDIA = {"tiktok", "instagram"}
VIDEO_FIRST = {"tiktok"}
STYLE: dict[str, str] = {
    "tiktok": "سكربت فيديو 15-35 ثانية: خطّاف في أول ثانيتين، مشاهد مرقّمة بالتوقيت، نص على الشاشة، دعوة للتعليق. "
              "الوصف قصير جدًا مع 3-5 هاشتاقات.",
    "instagram": "ريلز أو صورة: أول سطر يوقف التمرير، فقرات قصيرة، دعوة للحفظ أو الإرسال، 5-10 هاشتاقات.",
    "x": "تغريدة حادة لا تتجاوز 260 حرفًا أو سلسلة قصيرة، رأي أو رقم أو سؤال، 1-2 هاشتاق.",
    "linkedin": "منشور مهني بقصة أو درس عملي، سطر افتتاحي قوي، بلا مبالغة، 3 هاشتاقات.",
    "whatsapp": "رسالة جماعية ودودة قصيرة للمشتركين، قيمة واضحة ودعوة واحدة، بلا هاشتاقات، مع خيار إيقاف الرسائل.",
}


def _post_schema(channel: str) -> dict[str, Any]:
    return {"type": "object", "properties": {"posts": {"type": "array", "items": {"type": "object", "properties": {
        "title": {"type": "string", "description": "عنوان داخلي قصير"},
        "format": {"type": "string", "enum": list(FORMATS[channel])},
        "caption": {"type": "string"},
        "script": {"type": "string", "description": "سكربت الفيديو أو نص التصميم؛ فارغ إن لم يلزم"},
        "hashtags": {"type": "array", "items": {"type": "string"}},
        "cta": {"type": "string"},
        "asset_ids": {"type": "array", "items": {"type": "string"}},
        "why": {"type": "string", "description": "لماذا سينجح هذا المحتوى"},
    }}}}}


def _candidates(s: Any, channel: str) -> list[Asset]:
    q = select(Asset).where(Asset.status == "approved")
    rows = list(s.scalars(q.order_by(Asset.used_count, Asset.created_at.desc()).limit(MAX_CANDIDATES * 2)).all())
    if channel in VIDEO_FIRST:
        rows.sort(key=lambda a: (a.kind != "video", a.used_count))
    return rows[:MAX_CANDIDATES]


def _asset_line(a: Asset) -> str:
    dims = f"{a.width}x{a.height}" if a.width else ""
    dur = f" {a.duration_s:.0f}ث" if a.kind == "video" and a.duration_s else ""
    tags = "، ".join(a.tags or [])
    return f"- {a.id} | {a.kind}{dur} {dims} | {a.title} | {text.clip(a.description, 160)} | وسوم: {tags}"


def _simulate_posts(channel: str, brief: str, count: int, assets: list[Asset], brand: settings.Brand,
                    campaign: Campaign | None) -> dict[str, Any]:
    product = brand.products[0].name if brand.products else brand.name
    hook = {"tiktok": "وقف! هذي الحركة تفرق معك 👇", "instagram": "احفظ هذا المنشور قبل لا يضيع 📌",
            "x": "رأي سريع:", "linkedin": "درس تعلمناه هذا الأسبوع:", "whatsapp": "مرحبًا 👋"}[channel]
    posts = []
    for i in range(count):
        asset = assets[i % len(assets)] if assets else None
        angle = ("نصيحة عملية", "قصة عميل", "سؤال للجمهور", "خلف الكواليس", "مقارنة قبل/بعد")[i % 5]
        title = f"{angle} — {product}"
        caption = (f"{hook}\n{brief or ('كيف يسهّل ' + product + ' يومك')}.\n"
                   f"{'من ' + campaign.name + ': ' if campaign else ''}جرّبه اليوم وخلك أول من يستفيد.")
        script = ""
        if channel in ("tiktok", "instagram"):
            script = ("[0-2ث] خطّاف: سؤال مباشر على الشاشة\n[2-8ث] المشكلة بلقطة قريبة\n"
                      f"[8-20ث] الحل: {product} أثناء الاستخدام\n[20-28ث] النتيجة + نص: «جرّبه اليوم»\n"
                      "[28-30ث] الشعار ودعوة للتعليق")
        tags = list(dict.fromkeys([*brand.base_hashtags, "#السعودية", "#الرياض"]))[:6]
        fmt = FORMATS[channel][0] if not asset or asset.kind == "video" or channel != "instagram" else "post"
        posts.append({"title": title, "format": fmt, "caption": caption if channel != "whatsapp"
                      else f"{caption}\n\nلإيقاف الرسائل أرسل «إيقاف».", "script": script,
                      "hashtags": [] if channel == "whatsapp" else tags, "cta": "تواصل معنا الآن",
                      "asset_ids": [asset.id] if asset else [], "why": f"زاوية «{angle}» تحقق تفاعلًا أعلى على "
                                                                        f"{CHANNEL_LABELS[channel]}"})
    return {"posts": posts}


def _status_for(s: Any, channel: str) -> str:
    action = "broadcast" if channel == "whatsapp" else "publish"
    decision = policy.decide(s, channel, action)
    if channel == "whatsapp" and decision == "auto":
        decision = policy.decide(s, channel, "publish")
    return "approved" if decision == "auto" else "review"


def file_for_review(s: Any, post: Post, agent_id: str = "content") -> None:
    approvals.request(s, "post", ref_id=post.id, agent_id=agent_id,
                      title=f"{CHANNEL_LABELS[post.channel]}: {post.title or text.clip(post.caption, 60)}",
                      summary=text.clip(post.caption, 300),
                      payload={"channel": post.channel, "format": post.format, "assets": post.asset_ids})


@skill("content.create_post")
async def create_post(ctx: Ctx) -> dict[str, Any]:
    channel = ctx.input.get("channel")
    if channel not in CHANNELS:
        raise SkillError("القناة غير محددة")
    if ctx.decide("create_content") == "off":
        raise SkillError("صلاحية إنشاء المحتوى موقوفة")
    count = max(1, min(int(ctx.input.get("count") or 1), 5))
    brief = str(ctx.input.get("brief") or "")
    with db.session() as s:
        brand = settings.get(s, "brand")
        campaign = s.get(Campaign, ctx.input.get("campaign_id") or "") if ctx.input.get("campaign_id") else None
        assets = _candidates(s, channel) if policy.decide(s, "content", "use_library") != "off" else []
        agent = s.get(Agent, channel)
        insight = dict(agent.insights or {}) if agent else {}
    ctx.progress(f"يكتب {count} منشور لـ {CHANNEL_LABELS[channel]}")
    library = "\n".join(_asset_line(a) for a in assets) or "(لا توجد ملفات معتمدة في المكتبة)"
    camp = ""
    if campaign is not None:
        camp = (f"الحملة: {campaign.name} — الهدف {campaign.objective}\nالجمهور: {campaign.audience}\n"
                f"العرض: {campaign.offer}\nمحاور: {campaign.proposal.get('content_pillars', [])}")
    prompt = (f"اكتب {count} منشور لقناة {CHANNEL_LABELS[channel]}.\nالفكرة: {brief or 'اختر الأنسب للعلامة اليوم'}\n"
              f"{camp}\nأسلوب القناة: {STYLE[channel]}\n"
              f"ما تعلّمه وكيل القناة: {text.clip(str(insight.get('summary', '')), 600)}\n\n"
              f"ملفات المكتبة المعتمدة (اختر منها بالمعرّف فقط، ولا تخترع معرّفات):\n{prompts.untrusted(library)}\n\n"
              "لكل منشور اختر الملف الأنسب لموضوعه (صورة أو مقطع)، واكتب السكربت إن كان فيديو. "
              "لا تكرر نفس الملف في منشورين.")
    result = await ctx.ai(prompt=prompt, schema=_post_schema(channel), max_tokens=3500,
                          simulate=lambda: _simulate_posts(channel, brief, count, assets, brand, campaign))
    valid_ids = {a.id for a in assets}
    created, review = [], 0
    with db.session() as s:
        status = _status_for(s, channel)
        for item in (result.data or {}).get("posts", [])[:count]:
            ids = [i for i in item.get("asset_ids", []) if i in valid_ids][:10]
            fmt = item.get("format") if item.get("format") in FORMATS[channel] else FORMATS[channel][0]
            st = status
            note = ""
            if channel in NEEDS_MEDIA and not ids:
                st, note = "draft", "يحتاج صورة أو مقطعًا معتمدًا من المكتبة قبل النشر"
            budget = 0.0
            if campaign is not None and campaign.daily_budget_cap and campaign.posts_per_day:
                budget = round(campaign.daily_budget_cap / max(campaign.posts_per_day, 1), 2)
            if st == "approved":
                hold = community_risky(f"{item.get('caption') or ''}\n{item.get('cta') or ''}", brand)
                if hold:
                    st, note = "review", f"أُوقف للاعتماد: {hold}"
            post = Post(channel=channel, format=fmt, status=st, title=text.clip(item.get("title") or "", 200),
                        brief=brief, caption=item.get("caption") or "", script=item.get("script") or "",
                        hashtags=[h if h.startswith("#") else f"#{h}" for h in item.get("hashtags", [])][:15],
                        cta=text.clip(item.get("cta") or "", 200), asset_ids=ids,
                        campaign_id=campaign.id if campaign else None, author_agent="content", review_note=note,
                        promoted_budget=budget)
            s.add(post)
            s.flush()
            if st == "review":
                file_for_review(s, post)
                review += 1
            created.append(post.id)
        if created:
            events.record(s, "content.created", f"صانع المحتوى كتب {text.posts_ar(len(created))} لقناة {CHANNEL_LABELS[channel]}"
                          + (f"، {review} بانتظار اعتمادك" if review else ""),
                          actor="content", ref_kind="post", ref_id=created[0], detail={"posts": created})
    if created and review < len(created):
        ctx.spawn("coordinator.distribute", "جدولة المحتوى المعتمد", {}, priority=4)
    parts = [f"{text.posts_ar(len(created))} لقناة {CHANNEL_LABELS[channel]}"]
    if review:
        parts.append(f"{review} بانتظار اعتمادك")
    return {"summary": " — ".join(parts), "posts": created}


REVISE_SCHEMA: dict[str, Any] = {"type": "object", "properties": {
    "title": {"type": "string"}, "caption": {"type": "string"}, "script": {"type": "string"},
    "hashtags": {"type": "array", "items": {"type": "string"}}, "cta": {"type": "string"},
    "changes": {"type": "string", "description": "ما الذي تغيّر"}}}


@skill("content.revise")
async def revise(ctx: Ctx) -> dict[str, Any]:
    with db.session() as s:
        post = s.get(Post, ctx.input.get("post_id") or "")
        if post is None:
            raise SkillError("المنشور غير موجود")
        snap = {"channel": post.channel, "title": post.title, "caption": post.caption, "script": post.script,
                "hashtags": post.hashtags, "cta": post.cta}
    note = str(ctx.input.get("note") or "حسّن الصياغة")
    ctx.progress("يعدّل المحتوى حسب ملاحظاتك")
    prompt = (f"عدّل هذا المحتوى حسب ملاحظة المالك.\nالملاحظة: {note}\nالمحتوى الحالي:\n{snap}\n"
              f"أسلوب القناة: {STYLE[snap['channel']]}")

    def sim() -> dict[str, Any]:
        return {**snap, "caption": f"{snap['caption']}\n\n(نسخة معدّلة: {note})", "changes": f"طبّقت الملاحظة: {note}"}

    result = await ctx.ai(prompt=prompt, schema=REVISE_SCHEMA, max_tokens=2500, simulate=sim)
    data = result.data or {}
    with db.session() as s:
        post = s.get(Post, ctx.input["post_id"])
        if post is None:
            raise SkillError("المنشور حُذف أثناء التعديل")
        post.title = text.clip(data.get("title") or post.title, 200)
        post.caption = data.get("caption") or post.caption
        post.script = data.get("script", post.script)
        post.hashtags = data.get("hashtags") or post.hashtags
        post.cta = text.clip(data.get("cta") or post.cta, 200)
        post.version = (post.version or 1) + 1
        post.review_note = ""
        post.status = _status_for(s, post.channel)
        if post.status == "review":
            file_for_review(s, post)
    if post.status == "approved":
        ctx.spawn("coordinator.distribute", "جدولة المحتوى المعدّل", {}, priority=4)
    return {"summary": f"عُدّل المنشور (نسخة {post.version}): {text.clip(str(data.get('changes', '')), 120)}",
            "post_id": post.id}


DESCRIBE_SCHEMA: dict[str, Any] = {"type": "object", "properties": {
    "title": {"type": "string"}, "description": {"type": "string"},
    "tags": {"type": "array", "items": {"type": "string"}},
    "channels": {"type": "array", "items": {"type": "string", "enum": list(CHANNELS)}},
    "mood": {"type": "string"}}}
MAX_VISION_BYTES = 4 * 1024 * 1024


@skill("content.describe_asset")
async def describe_asset(ctx: Ctx) -> dict[str, Any]:
    with db.session() as s:
        asset = s.get(Asset, ctx.input.get("asset_id") or "")
        if asset is None:
            raise SkillError("الملف غير موجود")
        title, kind = asset.title, asset.kind
        source = media.thumb_path(asset) if asset.has_thumb else media.file_path(asset)
        mime = "image/jpeg" if asset.has_thumb else asset.mime
    content: list[dict[str, Any]] | str
    if source.exists() and source.stat().st_size <= MAX_VISION_BYTES and mime.startswith("image/"):
        data = base64.standard_b64encode(source.read_bytes()).decode()
        content = [{"type": "image", "source": {"type": "base64", "media_type": mime, "data": data}},
                   {"type": "text", "text": f"صف هذا {'الإطار من مقطع فيديو' if kind == 'video' else 'التصميم'} "
                                            "لمكتبة تسويقية: عنوان قصير، وصف يساعد في اختياره لاحقًا، 5-8 وسوم عربية، "
                                            "القنوات الأنسب، والطابع."}]
    else:
        content = f"اقترح وصفًا ووسومًا لملف بعنوان «{title}» من نوع {kind}."
    ctx.progress("يصف ملفًا جديدًا في المكتبة")

    def sim() -> dict[str, Any]:
        words = [w for w in title.replace("_", " ").replace("-", " ").split() if len(w) > 1][:4]
        return {"title": title, "description": f"{'مقطع' if kind == 'video' else 'تصميم'} بعنوان «{title}» جاهز للاستخدام",
                "tags": words or ["عام"], "channels": ["tiktok", "instagram"] if kind == "video" else
                ["instagram", "x", "linkedin"], "mood": "احترافي"}

    result = await ctx.ai(prompt=content, schema=DESCRIBE_SCHEMA, max_tokens=800, simulate=sim)
    d = result.data or {}
    with db.session() as s:
        asset = s.get(Asset, ctx.input["asset_id"])
        if asset is None:
            return {"summary": "حُذف الملف"}
        if not asset.description:
            asset.description = text.clip(d.get("description", ""), 1000)
        asset.tags = list(dict.fromkeys([*(asset.tags or []), *[t.strip("# ") for t in d.get("tags", [])]]))[:15]
        asset.ai_described = True
    return {"summary": f"وُصف الملف «{title}»", "tags": d.get("tags", []), "channels": d.get("channels", [])}
