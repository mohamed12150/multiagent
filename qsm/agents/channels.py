"""The five channel agents — one shared playbook, specialised by channel: publish on time within the limits,
pull comments and messages in, sync metrics, and learn what works (best hours, formats)."""
from __future__ import annotations

import re
import unicodedata
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select

from .. import connectors, db, events, settings
from ..connectors.base import ConnectorError, Inbound, OutboundPost
from ..connectors.sandbox import metrics_at
from ..db import iso, utcnow
from ..engine import clock, limits, media, policy
from ..models import CHANNELS, Agent, Asset, Campaign, Connection, Contact, Conversation, Message, Post
from . import state, text
from .community import send_message
from .registry import CHANNEL_LABELS
from .runtime import Ctx, SkillError, already_pending, enqueue, skill

MAX_PER_RUN = 10
RETRY_MINUTES = 10
MAX_PUBLISH_ATTEMPTS = 3
METRICS_DAYS = 10
ANALYZE_DAYS = 21
HISTORY_DAYS = 60
# Normalised (hamza-folded, lower-case) whole phrases; see _consent_keyword.
OPT_IN = {"اشتراك", "اشترك", "اوافق", "موافق", "subscribe", "نعم اشترك", "اوافق على الاشتراك", "ابي اشترك",
          "ابغى اشترك", "نعم"}
# Opt-out: unambiguous stems match word starts ("اوقفوا", "stopp"); short or ambiguous words match whole tokens only
# ("الغالي" must never opt anyone out).
OPT_OUT_STEMS = ("ايقاف", "اوقف", "توقف", "stop", "unsubscribe")
OPT_OUT_WORDS = {"وقف", "وقفوا", "الغاء", "الغي", "الغوا", "الغ", "بطلوا", "لاترسلون", "لاترسلوا"}


def _channel(ctx: Ctx) -> str:
    ch = ctx.input.get("channel")
    if ch not in CHANNELS:
        raise SkillError("القناة غير محددة")
    return str(ch)


def compose(post: Post) -> str:
    tags = " ".join(post.hashtags or [])
    body = post.caption.strip()
    if post.cta and post.cta not in body and post.channel != "x":
        body = f"{body}\n\n{post.cta}"
    return f"{body}\n\n{tags}".strip() if tags and post.channel != "whatsapp" else body


def _recipients(s: Any, cfg: dict[str, Any], cap: int) -> tuple[str, ...]:
    """Opted-in WhatsApp subscribers only; without an approved template, only those inside the 24h window."""
    q = select(Contact.phone).where(Contact.channel == "whatsapp", Contact.opted_in.is_(True), Contact.phone != "")
    if not cfg.get("broadcast_template"):
        q = q.where(Contact.last_seen_at >= utcnow() - timedelta(hours=24))
    return tuple(s.scalars(q.limit(max(cap, 0))).all())


def _published_today(s: Any, post: Post) -> int:
    start, end = clock.day_bounds_utc(clock.today())
    q = select(Post.id).where(Post.status == "published", Post.published_at >= start, Post.published_at < end)
    q = q.where(Post.campaign_id == post.campaign_id) if post.campaign_id else q.where(
        Post.campaign_id.is_(None), Post.channel == post.channel)
    return len(s.scalars(q).all())


def _prepare(s: Any, post: Post) -> tuple[OutboundPost | None, str]:
    """Checks before going out. Returns (payload, reason-if-held)."""
    room = limits.room_for(s, post)
    if _published_today(s, post) >= room.limit:
        return None, "اكتمل ليمت اليوم"
    general = settings.get(s, "general")
    if post.channel == "whatsapp" and not clock.in_window(general.send_window_start, general.send_window_end):
        return None, "خارج نافذة الإرسال المسموحة"
    files = media.media_files(s, post.asset_ids or [])
    if post.channel in ("instagram", "tiktok") and not files:
        return None, "لا توجد وسائط معتمدة مرفقة"
    recipients: tuple[str, ...] = ()
    if post.channel == "whatsapp":
        cfg = connectors.config_for(s, "whatsapp")
        recipients = _recipients(s, cfg, settings.get(s, "limits").whatsapp_broadcast_per_day)
        if not recipients:
            return None, "لا يوجد مشتركون موافقون ضمن نافذة الإرسال"
    return OutboundPost(post_id=post.id, channel=post.channel, format=post.format, text=compose(post),
                        title=post.title, media=files, recipients=recipients), ""


def _hold(post: Post, reason: str) -> None:
    post.status, post.scheduled_at, post.review_note = "approved", None, reason


async def publish_one(post_id: str) -> str:
    with db.session() as s:
        post = s.get(Post, post_id)
        if post is None or post.status != "scheduled":
            return "skipped"
        payload, reason = _prepare(s, post)
        if payload is None:
            _hold(post, reason)
            return f"held: {reason}"
        spend = post.promoted_budget or 0.0
        if spend:
            campaign = s.get(Campaign, post.campaign_id) if post.campaign_id else None
            ok, why = limits.can_spend(s, spend, campaign)
            if not ok or policy.decide(s, post.channel, "spend") != "auto":
                post.promoted_budget, spend = 0.0, 0.0
                post.review_note = f"نُشر دون ترويج — {why or 'صرف الميزانية يحتاج اعتمادك'}"
        post.status, post.attempts = "publishing", (post.attempts or 0) + 1
        channel = post.channel
    conn = connectors.build(channel)
    try:
        res = await conn.publish(payload)
    except ConnectorError as exc:
        return _publish_failed(post_id, exc)
    with db.session() as s:
        post = s.get(Post, post_id)
        post.status, post.published_at, post.error = "published", utcnow(), ""
        post.external_id, post.external_url = res.external_id, res.url
        post.metrics = {"sandbox": True} if not conn.live else {}
        if channel == "whatsapp":
            post.metrics = {**post.metrics, "recipients": int(res.detail.get("sent", len(payload.recipients)))}
        for aid in post.asset_ids or []:
            asset = s.get(Asset, aid)
            if asset is not None:
                asset.used_count = (asset.used_count or 0) + 1
        if post.campaign_id and post.promoted_budget:
            if conn.live:
                # Paid boosting goes through each platform's Ads API, which is not connected: nothing was spent.
                post.promoted_budget = 0.0
                post.review_note = "نُشر عضويًا — الترويج المدفوع يحتاج ربط حساب الإعلانات"
            else:
                camp = s.get(Campaign, post.campaign_id)
                if camp is not None:  # sandbox: simulated spend, labelled as such in the UI
                    camp.spent = round((camp.spent or 0) + post.promoted_budget, 2)
        extra = f" إلى {res.detail.get('sent', len(payload.recipients))} مشترك" if channel == "whatsapp" else ""
        events.record(s, "post.published", f"{CHANNEL_LABELS[channel]}: نُشر «{text.clip(post.title or post.caption, 60)}»{extra}",
                      actor=channel, ref_kind="post", ref_id=post.id, detail={"sandbox": not conn.live})
    return "published"


def _publish_failed(post_id: str, exc: ConnectorError) -> str:
    with db.session() as s:
        post = s.get(Post, post_id)
        post.error = str(exc)[:2000]
        if exc.auth:
            post.status = "failed"
            conn = s.get(Connection, post.channel)
            if conn is not None:
                conn.status, conn.last_error = "error", str(exc)[:500]
        elif exc.transient and (post.attempts or 0) < MAX_PUBLISH_ATTEMPTS:
            post.status = "scheduled"
            post.scheduled_at = utcnow() + timedelta(minutes=RETRY_MINUTES * post.attempts)
        else:
            post.status = "failed"
        events.record(s, "post.failed", f"{CHANNEL_LABELS[post.channel]}: تعذر النشر — {str(exc)[:140]}",
                      actor=post.channel, ref_kind="post", ref_id=post.id)
        return post.status


@skill("channel.publish")
async def publish(ctx: Ctx) -> dict[str, Any]:
    ch = _channel(ctx)
    with db.session() as s:
        due = list(s.scalars(select(Post.id).where(Post.channel == ch, Post.status == "scheduled",
                                                   Post.scheduled_at <= utcnow())
                            .order_by(Post.scheduled_at).limit(MAX_PER_RUN)).all())
    if not due:
        return {"summary": "لا يوجد ما يُنشر الآن", "quiet": True}
    ctx.progress(f"ينشر {len(due)} منشور")
    outcomes = [await publish_one(pid) for pid in due]
    ok = outcomes.count("published")
    held = [o for o in outcomes if o.startswith("held")]
    if held:
        ctx.spawn("coordinator.distribute", "إعادة جدولة ما تعذر نشره اليوم", {}, priority=6)
    return {"summary": f"نُشر {ok} من {len(due)}" + (f" — {len(held)} مؤجل ({held[0][6:]})" if held else ""),
            "outcomes": outcomes}


# ---------------------------------------------------------------- engagement

def _contact(s: Any, channel: str, item: Inbound) -> Contact:
    key_phone = item.phone.strip()
    q = select(Contact).where(Contact.channel == channel)
    q = q.where(Contact.phone == key_phone) if key_phone else q.where(Contact.handle == item.handle)
    contact = s.scalars(q.limit(1)).first()
    if contact is None:
        contact = Contact(channel=channel, handle=item.handle, name=item.name, phone=key_phone)
        s.add(contact)
        s.flush()
    contact.last_seen_at = utcnow()
    if item.name and not contact.name:
        contact.name = item.name
    return contact


NEGATIONS = ("لا", "ما", "مو", "مب", "ماني", "مابي", "ماابي", "not", "dont", "don't", "no")


def _tokens(message: str) -> list[str]:
    cleaned = re.sub(r"[^\w\s']", " ", unicodedata.normalize("NFKC", message).lower())
    return cleaned.replace("أ", "ا").replace("إ", "ا").split()


def _consent_keyword(contact: Contact, message: str) -> str | None:
    """WhatsApp subscription keywords — explicit, provable consent (time + source recorded).

    Any stop word anywhere opts out (whatever the length). Opting in needs a short message that is exactly a
    subscription phrase with no negation — "unsubscribe", "لا أوافق", "ما ابغى اشترك" never opt anyone in."""
    words = _tokens(message)
    if any(w.startswith(OPT_OUT_STEMS) or w in OPT_OUT_WORDS for w in words) or "لا ترسل" in " ".join(words):
        contact.opted_in, contact.opt_source = False, "whatsapp:opt_out"
        return "تم إيقاف الرسائل التسويقية. نسعد بخدمتك متى احتجتنا 🌷"
    if 0 < len(words) <= 3 and not any(w in NEGATIONS for w in words) and " ".join(words) in OPT_IN:
        contact.opted_in, contact.opted_in_at, contact.opt_source = True, utcnow(), "whatsapp:keyword"
        return "تم اشتراكك في عروضنا وأخبارنا ✅ لإيقافها في أي وقت أرسل «إيقاف»."
    return None


def ingest(s: Any, channel: str, items: list[Inbound]) -> tuple[set[str], list[str]]:
    """Store inbound messages (deduplicated). Returns (conversation ids needing a reply, ids of queued consent
    confirmations to send)."""
    needs_reply: set[str] = set()
    confirmations: list[str] = []
    for item in items:
        if not item.text.strip():
            continue
        if item.external_id and s.scalar(select(Message.id).where(Message.external_id == item.external_id).limit(1)):
            continue
        contact = _contact(s, channel, item)
        conv = s.scalars(select(Conversation).where(Conversation.channel == channel,
                                                    Conversation.external_ref == item.external_ref)
                         .order_by(Conversation.created_at.desc()).limit(1)).first()
        if conv is None or conv.status == "closed":
            post_id = None
            if item.post_external_id:
                post_id = s.scalar(select(Post.id).where(Post.external_id == item.post_external_id).limit(1))
            conv = Conversation(channel=channel, kind=item.kind, contact_id=contact.id, external_ref=item.external_ref,
                                post_id=post_id)
            s.add(conv)
            s.flush()
        s.add(Message(conversation_id=conv.id, direction="in", author="contact", text=item.text[:4000],
                      external_id=item.external_id, created_at=item.at or utcnow()))
        conv.unread, conv.last_message_at = (conv.unread or 0) + 1, utcnow()
        if conv.status == "answered":
            conv.status = "open"
        confirm = _consent_keyword(contact, item.text) if channel == "whatsapp" else None
        if confirm:
            reply = Message(conversation_id=conv.id, direction="out", author=channel, text=confirm, status="queued",
                            meta={"consent": True})
            s.add(reply)
            s.flush()
            confirmations.append(reply.id)
            conv.status = "answered"
        else:
            needs_reply.add(conv.id)
        events.publish("inbox", {"conversation_id": conv.id, "channel": channel, "preview": text.clip(item.text, 80)})
    return needs_reply, confirmations


@skill("channel.engage")
async def engage(ctx: Ctx) -> dict[str, Any]:
    ch = _channel(ctx)
    with db.session() as s:
        agent = s.get(Agent, ch)
        last = (agent.insights or {}).get("last_inbox_at")
        recent = list(s.scalars(select(Post.external_id).where(
            Post.channel == ch, Post.status == "published", Post.external_id != "")
            .order_by(Post.published_at.desc()).limit(5)).all())
    since = None
    if last:
        try:
            since = datetime.fromisoformat(str(last).rstrip("Z"))
        except ValueError:
            since = None
    ctx.progress("يجلب التعليقات والرسائل الجديدة")
    conn = connectors.build(ch)
    items = await conn.inbox(since)
    if ch == "linkedin" and conn.live:
        for urn in recent:
            items.extend(await conn.comments_for(urn))  # type: ignore[attr-defined]
    with db.session() as s:
        needs, confirmations = ingest(s, ch, items)
        agent = s.get(Agent, ch)
        agent.insights = {**(agent.insights or {}), "last_inbox_at": iso(utcnow())}
        for conv_id in needs:
            if not already_pending(s, "content.reply", "content", "conversation_id", conv_id):
                enqueue(s, kind="content.reply", title=f"رد على عميل — {CHANNEL_LABELS[ch]}",
                        input={"conversation_id": conv_id}, created_by=ch, origin="event", priority=2)
    for mid in confirmations:
        try:
            await send_message(mid)
        except ConnectorError:
            continue
    if not items:
        return {"summary": "لا رسائل جديدة", "quiet": True}
    return {"summary": f"{len(items)} رسالة جديدة — {len(needs)} محادثة للرد"
                       + (f"، {len(confirmations)} تحديث اشتراك" if confirmations else "")}


# ---------------------------------------------------------------- metrics & learning

@skill("channel.metrics")
async def metrics(ctx: Ctx) -> dict[str, Any]:
    ch = _channel(ctx)
    since = utcnow() - timedelta(days=METRICS_DAYS)
    with db.session() as s:
        rows = [(p.id, p.external_id, p.published_at, bool((p.metrics or {}).get("sandbox")))
                for p in s.scalars(select(Post).where(Post.channel == ch, Post.status == "published",
                                                      Post.published_at >= since, Post.external_id != "")).all()]
    conn = connectors.build(ch)
    live_ids = [ext for _, ext, _, sbx in rows if not sbx]
    fetched = await conn.metrics(live_ids) if conn.live and live_ids else {}
    account = await conn.account()
    today = clock.today().isoformat()
    with db.session() as s:
        updated = 0
        for pid, ext, at, sbx in rows:
            post = s.get(Post, pid)
            if sbx:
                post.metrics = {**(post.metrics or {}), **metrics_at(ch, ext, at), "sandbox": True}
                updated += 1
            elif ext in fetched:
                post.metrics = {**(post.metrics or {}), **fetched[ext]}
                updated += 1
        agent = s.get(Agent, ch)
        history = dict((agent.insights or {}).get("followers_history", {}))
        history[today] = account.followers
        history = dict(sorted(history.items())[-HISTORY_DAYS:])
        agent.insights = {**(agent.insights or {}), "followers": account.followers, "followers_history": history,
                          "metrics_at": iso(utcnow())}
        conn_row = s.get(Connection, ch)
        if conn_row is not None:
            conn_row.account = {"name": account.name, "handle": account.handle, "followers": account.followers,
                                "sandbox": not conn.live}
    events.publish("metrics", {"channel": ch})
    return {"summary": f"حدّث مؤشرات {updated} منشور — المتابعون {account.followers:,}"}


ANALYZE_SCHEMA: dict[str, Any] = {"type": "object", "properties": {
    "summary": {"type": "string", "description": "ما تعلمته في 2-3 جمل"},
    "best_hours": {"type": "array", "items": {"type": "integer"}},
    "best_formats": {"type": "array", "items": {"type": "string"}},
    "recommendations": {"type": "array", "items": {"type": "string"}},
    "content_ideas": {"type": "array", "items": {"type": "string"}}}}


def channel_stats(posts: list[Post]) -> dict[str, Any]:
    by_hour: dict[int, list[int]] = defaultdict(list)
    by_format: dict[str, list[int]] = defaultdict(list)
    for p in posts:
        eng = state.engagement(p.metrics or {})
        if p.published_at:
            by_hour[clock.to_local(p.published_at).hour].append(eng)
        by_format[p.format].append(eng)
    avg = {h: round(sum(v) / len(v), 1) for h, v in by_hour.items()}
    fmt = {f: round(sum(v) / len(v), 1) for f, v in by_format.items()}
    top = sorted(posts, key=lambda p: state.engagement(p.metrics or {}), reverse=True)[:3]
    m = state._sum(posts)
    return {"posts": len(posts), "avg_by_hour": dict(sorted(avg.items())), "avg_by_format": fmt,
            "engagement_rate": state.rate(m), "reach": m["reach"],
            "top": [{"title": p.title or text.clip(p.caption, 60), "format": p.format,
                     "engagement": state.engagement(p.metrics or {})} for p in top]}


@skill("channel.analyze")
async def analyze(ctx: Ctx) -> dict[str, Any]:
    ch = _channel(ctx)
    since = utcnow() - timedelta(days=ANALYZE_DAYS)
    with db.session() as s:
        posts = list(s.scalars(select(Post).where(Post.channel == ch, Post.status == "published",
                                                  Post.published_at >= since)).all())
        stats = channel_stats(posts)
        convs = [c for c in s.scalars(select(Conversation.category).where(
            Conversation.channel == ch, Conversation.created_at >= since)).all() if c]
    stats["conversations"] = {c: convs.count(c) for c in set(convs) if c}
    ctx.progress(f"يحلل أداء {CHANNEL_LABELS[ch]}")

    def sim() -> dict[str, Any]:
        hours = sorted(stats["avg_by_hour"], key=lambda h: stats["avg_by_hour"][h], reverse=True)[:3]
        formats = sorted(stats["avg_by_format"], key=lambda f: stats["avg_by_format"][f], reverse=True)[:2]
        return {"summary": (f"{stats['posts']} منشور خلال 3 أسابيع بمعدل تفاعل {stats['engagement_rate']}٪. "
                            f"أفضل أداء في الساعات {hours or 'المسائية'}.") if posts else
                "لا توجد بيانات كافية بعد — سأبدأ بأوقات الذروة المعتادة للسوق السعودي.",
                "best_hours": hours or [20, 21], "best_formats": formats or ["reel"],
                "recommendations": ["كرر الزاوية الأعلى تفاعلًا مرتين أسبوعيًا", "ابدأ كل فيديو بسؤال مباشر"],
                "content_ideas": ["قصة عميل في 20 ثانية", "خلف الكواليس لتجهيز الطلبات"]}

    result = await ctx.ai(prompt=(f"حلل أداء قناة {CHANNEL_LABELS[ch]} من هذه الأرقام:\n{state.compact(stats)}\n"
                                  "استخرج أفضل الساعات (بتوقيت الرياض) والصيغ، وتوصيات وأفكار محتوى محددة."),
                          schema=ANALYZE_SCHEMA, max_tokens=1800, simulate=sim)
    d = result.data or {}
    with db.session() as s:
        agent = s.get(Agent, ch)
        agent.insights = {**(agent.insights or {}), "summary": d.get("summary", ""),
                          "best_hours": [h for h in d.get("best_hours", []) if isinstance(h, int) and 0 <= h <= 23][:4],
                          "best_formats": d.get("best_formats", [])[:4],
                          "recommendations": d.get("recommendations", [])[:5],
                          "ideas": d.get("content_ideas", [])[:6], "stats": stats, "analyzed_at": iso(utcnow()),
                          "simulated": result.simulated}
    return {"summary": text.clip(str(d.get("summary", "")), 220)}
