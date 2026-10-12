"""Typed settings with defaults. Every section is a pydantic model, so a bad value is rejected at the boundary
and readers always get a complete, valid object (stored values are merged over the defaults)."""
from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError, field_validator
from sqlalchemy.orm import Session

from .db import utcnow
from .models import CHANNELS, Setting

HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class Product(BaseModel):
    name: str = Field(max_length=120)
    price: str = Field(default="", max_length=40)
    description: str = Field(default="", max_length=600)


class Brand(BaseModel):
    name: str = Field(default="شركتي", max_length=120)
    tagline: str = Field(default="", max_length=200)
    industry: str = Field(default="", max_length=120)
    description: str = Field(default="", max_length=2000)
    audience: str = Field(default="", max_length=1000)
    tone: str = Field(default="ودود، واثق، مختصر", max_length=300)
    dialect: str = Field(default="سعودي أبيض", max_length=60)
    values: str = Field(default="", max_length=600)
    dos: str = Field(default="", max_length=1000)
    donts: str = Field(default="لا وعود مبالغ فيها، لا أسعار غير معتمدة، لا ذكر للمنافسين بالاسم", max_length=1000)
    products: list[Product] = Field(default_factory=list, max_length=40)
    website: str = Field(default="", max_length=300)
    phone: str = Field(default="", max_length=40)
    base_hashtags: list[str] = Field(default_factory=list, max_length=20)


class Raise(BaseModel):
    """How far the campaign manager may raise limits on its own."""
    enabled: bool = True
    max_step_pct: int = Field(default=30, ge=0, le=200)
    ceiling_daily_ad_spend: float = Field(default=1000, ge=0)
    ceiling_organic_posts: int = Field(default=6, ge=0, le=50)
    ceiling_campaign_posts: int = Field(default=10, ge=0, le=100)


class Limits(BaseModel):
    organic_posts_per_day: dict[str, int] = Field(
        default_factory=lambda: {"tiktok": 2, "instagram": 2, "x": 4, "whatsapp": 1, "linkedin": 1})
    campaign_posts_per_day: int = Field(default=6, ge=0, le=100)
    daily_ad_spend_cap: float = Field(default=300, ge=0)
    monthly_ad_spend_cap: float = Field(default=6000, ge=0)
    replies_per_hour: int = Field(default=60, ge=0, le=2000)
    whatsapp_broadcast_per_day: int = Field(default=200, ge=0, le=100000)
    ai_daily_cost_cap_usd: float = Field(default=15, ge=0)
    raise_authority: Raise = Field(default_factory=Raise)

    @field_validator("organic_posts_per_day")
    @classmethod
    def _channels(cls, v: dict[str, int]) -> dict[str, int]:
        unknown = set(v) - set(CHANNELS)
        if unknown:
            raise ValueError(f"unknown channel: {', '.join(sorted(unknown))}")
        if any(n < 0 or n > 50 for n in v.values()):
            raise ValueError("daily posts must be between 0 and 50")
        return {c: int(v.get(c, 0)) for c in CHANNELS}


class Notify(BaseModel):
    owner_name: str = Field(default="", max_length=120)
    owner_whatsapp: str = Field(default="", pattern=r"^(\d{8,15})?$")  # E.164 digits without '+', e.g. 9665XXXXXXXX
    owner_emails: list[str] = Field(default_factory=list, max_length=5)
    report_time: str = Field(default="21:00", pattern=HHMM)
    report_channels: list[Literal["whatsapp", "email"]] = Field(default_factory=lambda: ["whatsapp", "email"])
    fix_channels: list[Literal["whatsapp", "email", "app"]] = Field(default_factory=lambda: ["app", "whatsapp"])
    approval_channels: list[Literal["whatsapp", "email", "app"]] = Field(default_factory=lambda: ["app"])
    quiet_start: str = Field(default="23:30", pattern=HHMM)
    quiet_end: str = Field(default="08:00", pattern=HHMM)
    whatsapp_template: str = Field(default="", max_length=60)  # approved utility template for out-of-window sends
    whatsapp_template_lang: str = Field(default="ar", pattern=r"^[a-z]{2}(_[A-Z]{2})?$")

    @field_validator("owner_emails")
    @classmethod
    def _emails(cls, v: list[str]) -> list[str]:
        cleaned = [e.strip().lower() for e in v if e.strip()]
        bad = [e for e in cleaned if not EMAIL.match(e)]
        if bad:
            raise ValueError(f"invalid email: {bad[0]}")
        return cleaned


class Autonomy(BaseModel):
    level: Literal["manual", "assisted", "autopilot"] = "assisted"


class General(BaseModel):
    timezone: str = Field(default="Asia/Riyadh", max_length=60)
    currency: str = Field(default="SAR", max_length=8)
    public_base_url: str = Field(default="", max_length=300,  # needed by Instagram/TikTok to pull media
                                 pattern=r"^(|https://[A-Za-z0-9.-]+(:\d{2,5})?|http://(localhost|127\.0\.0\.1)(:\d{2,5})?)$")
    send_window_start: str = Field(default="09:00", pattern=HHMM)
    send_window_end: str = Field(default="22:00", pattern=HHMM)


class Goals(BaseModel):
    """What القائد steers toward. Progress is measured month to date against these targets."""
    focus: Literal["leads", "sales", "engagement", "awareness"] = "leads"
    monthly_leads: int = Field(default=120, ge=0, le=1_000_000)
    monthly_reach: int = Field(default=150_000, ge=0, le=1_000_000_000)
    target_engagement_rate: float = Field(default=4.0, ge=0, le=100)
    max_daily_interventions: int = Field(default=8, ge=0, le=50)
    review_start: str = Field(default="08:00", pattern=HHMM)  # القائد reviews only inside working hours
    review_end: str = Field(default="23:00", pattern=HHMM)
    notes: str = Field(default="", max_length=1500)  # owner guidance, e.g. "ركّز على باقات الجمعة البيضاء"


class AI(BaseModel):
    web_research: bool = True
    fallbacks: bool = True


SECTIONS: dict[str, type[BaseModel]] = {
    "brand": Brand, "limits": Limits, "notify": Notify, "autonomy": Autonomy, "general": General, "ai": AI,
    "goals": Goals,
}


class SettingsError(ValueError):
    pass


def get(s: Session, key: str) -> Any:
    model = SECTIONS[key]
    row = s.get(Setting, key)
    stored = row.value if row is not None and isinstance(row.value, dict) else {}
    try:
        return model.model_validate(stored)
    except ValidationError:
        return model()  # a corrupted row never takes the platform down; Settings shows the defaults


def put(s: Session, key: str, value: dict[str, Any], *, by: str = "system") -> BaseModel:
    if key not in SECTIONS:
        raise SettingsError(f"unknown settings section: {key}")
    try:
        obj = SECTIONS[key].model_validate(value)
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(str(p) for p in first.get("loc", ()))
        raise SettingsError(f"{where}: {first.get('msg', 'invalid')}") from exc
    row = s.get(Setting, key)
    data = obj.model_dump(mode="json")
    if row is None:
        s.add(Setting(key=key, value=data, updated_by=by))
    else:
        row.value, row.updated_by, row.updated_at = data, by, utcnow()
    s.flush()
    return obj


def patch(s: Session, key: str, changes: dict[str, Any], *, by: str = "system") -> BaseModel:
    """Merge `changes` over the current values (a new dict — the current object is never mutated)."""
    current = get(s, key).model_dump(mode="json")
    return put(s, key, {**current, **changes}, by=by)


def all_sections(s: Session) -> dict[str, Any]:
    return {k: get(s, k).model_dump(mode="json") for k in SECTIONS}
