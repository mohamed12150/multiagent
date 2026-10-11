"""Sandbox: every channel behaves like the real thing on simulated data, so the network runs end to end before
any key is added. Everything it produces is marked `sandbox` and labelled «محاكاة» in the UI."""
from __future__ import annotations

import hashlib
import math
import random
from datetime import datetime, timedelta

from ..db import new_id, utcnow
from .base import AccountInfo, Connector, Inbound, OutboundPost, PublishResult

# Typical first-72h reach per post for a small Saudi business account, by channel.
BASE_REACH = {"tiktok": 2600, "instagram": 1200, "x": 900, "linkedin": 420, "whatsapp": 160}
ENGAGE_RATE = {"tiktok": 0.085, "instagram": 0.055, "x": 0.03, "linkedin": 0.045, "whatsapp": 0.32}
FOLLOWERS = {"tiktok": 8400, "instagram": 12600, "x": 5300, "linkedin": 2100, "whatsapp": 940}
INBOUND_CHANCE = {"tiktok": 0.55, "instagram": 0.6, "x": 0.4, "linkedin": 0.25, "whatsapp": 0.7}

SAMPLES: tuple[tuple[str, str], ...] = (
    ("inquiry", "السلام عليكم، كم السعر؟ وهل فيه توصيل للرياض؟"),
    ("inquiry", "متى تفتحون؟ وهل عندكم فرع في جدة؟"),
    ("inquiry", "ممكن تفاصيل أكثر عن العرض؟"),
    ("lead", "أبغى أطلب لشركتنا كمية، مين أكلم؟"),
    ("lead", "مهتم جدًا، أرسلوا لي التفاصيل على الخاص"),
    ("praise", "ما شاء الله شغل مرتب 👏 كملوا"),
    ("praise", "جربت المنتج وطلع أحسن من توقعي، شكرًا لكم"),
    ("complaint", "طلبي متأخر من ثلاث أيام وما أحد يرد علي!"),
    ("complaint", "المنتج وصلني فيه عيب، وش الحل؟"),
    ("other", "🔥🔥🔥"),
)
NAMES = ("عبدالله", "نورة", "فيصل", "سارة", "محمد", "ريم", "خالد", "هند", "تركي", "لمى", "سلطان", "جود")


def _seed(text: str) -> int:
    return int(hashlib.sha256(text.encode()).hexdigest()[:8], 16)


class SandboxConnector(Connector):
    live = False

    def __init__(self, provider: str, cfg: dict | None = None):
        super().__init__(cfg or {})
        self.provider = provider

    async def test(self) -> AccountInfo:
        return await self.account()

    async def account(self) -> AccountInfo:
        days = (utcnow() - datetime(2026, 1, 1)).days
        growth = int(FOLLOWERS.get(self.provider, 1000) * (1 + days * 0.0011))
        return AccountInfo(name="حساب تجريبي", handle=f"@qhub_{self.provider}", followers=growth,
                           extra={"sandbox": True})

    async def publish(self, post: OutboundPost) -> PublishResult:
        ext = f"sbx_{self.provider}_{new_id()[:10]}"
        detail = {"sandbox": True}
        if post.recipients:
            detail["recipients"] = len(post.recipients)
        return PublishResult(external_id=ext, url="", detail=detail)

    async def metrics(self, external_ids: list[str]) -> dict[str, dict[str, int]]:
        return {ext: self._metrics_for(ext) for ext in external_ids}

    def _metrics_for(self, ext: str, published_at: datetime | None = None) -> dict[str, int]:
        rnd = random.Random(_seed(ext))
        quality = rnd.uniform(0.45, 1.9)
        # Growth curve: ~60% of 72h reach in the first 12h. Published time is encoded in the age the caller tracks;
        # without it the ext id's hash spreads posts across the curve deterministically.
        age_h = (utcnow() - published_at).total_seconds() / 3600 if published_at else rnd.uniform(6, 72)
        curve = min(1.0, math.log1p(max(age_h, 0.1)) / math.log1p(72))
        reach = int(BASE_REACH.get(self.provider, 800) * quality * curve)
        eng = ENGAGE_RATE.get(self.provider, 0.04) * rnd.uniform(0.6, 1.5)
        likes = int(reach * eng * 0.72)
        comments = int(reach * eng * 0.09)
        shares = int(reach * eng * 0.11)
        saves = int(reach * eng * 0.08)
        clicks = int(reach * rnd.uniform(0.004, 0.018))
        views = int(reach * (1.7 if self.provider in ("tiktok", "instagram") else 1.2))
        return {"reach": reach, "views": views, "likes": likes, "comments": comments, "shares": shares,
                "saves": saves, "clicks": clicks}

    async def inbox(self, since: datetime | None) -> list[Inbound]:
        rnd = random.Random()
        if rnd.random() > INBOUND_CHANCE.get(self.provider, 0.3):
            return []
        out = []
        for _ in range(rnd.choice((1, 1, 2))):
            category, text = rnd.choice(SAMPLES)
            name = rnd.choice(NAMES)
            kind = "whatsapp" if self.provider == "whatsapp" else rnd.choice(("comment", "comment", "dm"))
            phone = f"9665{rnd.randint(10000000, 99999999)}" if self.provider == "whatsapp" else ""
            handle = phone or f"@user{rnd.randint(1000, 9999)}"
            out.append(Inbound(external_ref=f"sbx_thread_{handle}", kind=kind, text=text,
                               external_id=f"sbx_msg_{new_id()[:12]}", handle=handle, name=name, phone=phone,
                               at=utcnow() - timedelta(minutes=rnd.randint(0, 14))))
        return out

    async def reply(self, *, kind: str, external_ref: str, to: str, text: str) -> str:
        return f"sbx_reply_{new_id()[:10]}"

    async def send(self, *, to: str, text: str, subject: str = "", html: str = "",
                   template: dict | None = None) -> str:
        return f"sbx_send_{new_id()[:10]}"


def metrics_at(provider: str, ext: str, published_at: datetime | None) -> dict[str, int]:
    """Deterministic sandbox metrics for a post published at `published_at`."""
    return SandboxConnector(provider)._metrics_for(ext, published_at)
