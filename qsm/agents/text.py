"""Small language helpers shared by the agents and their simulations."""
from __future__ import annotations

import re
from datetime import date, timedelta

from ..models import CHANNELS

CHANNEL_WORDS: dict[str, tuple[str, ...]] = {
    "tiktok": ("تيك توك", "تيكتوك", "التيك", "tiktok"),
    "instagram": ("انستقرام", "إنستقرام", "انستغرام", "إنستغرام", "انستا", "instagram", "ريلز"),
    "x": ("تويتر", "اكس", "إكس", "twitter", "تغريد"),
    "whatsapp": ("واتساب", "واتس", "whatsapp"),
    "linkedin": ("لينكدإن", "لينكد", "linkedin"),
}

# Approximate Hijri-based dates are marked; fixed national days are exact.
OCCASIONS: tuple[tuple[str, str], ...] = (
    ("2026-11-11", "عروض 11.11"),
    ("2026-11-27", "الجمعة البيضاء"),
    ("2026-12-31", "نهاية السنة الميلادية"),
    ("2027-01-15", "موسم الرياض (ذروة الفعاليات)"),
    ("2027-02-08", "بداية رمضان 1448 (تقريبي)"),
    ("2027-02-22", "يوم التأسيس"),
    ("2027-03-10", "عيد الفطر (تقريبي)"),
    ("2027-03-11", "يوم العلم"),
    ("2027-05-17", "عيد الأضحى (تقريبي)"),
    ("2027-06-15", "بداية الإجازة الصيفية"),
    ("2027-08-22", "العودة للمدارس"),
    ("2027-09-23", "اليوم الوطني السعودي 97"),
    ("2027-11-26", "الجمعة البيضاء"),
    ("2028-01-28", "بداية رمضان 1449 (تقريبي)"),
)


def detect_channels(text: str) -> list[str]:
    lower = f" {text.lower()} "
    found = [ch for ch, words in CHANNEL_WORDS.items() if any(w in lower for w in words)]
    if re.search(r"(^|\s)x(\s|$)", lower) and "x" not in found:
        found.append("x")
    return [c for c in CHANNELS if c in found]


def upcoming_occasions(today: date, days: int = 75) -> list[dict[str, str]]:
    end = today + timedelta(days=days)
    out = []
    for iso_day, name in OCCASIONS:
        d = date.fromisoformat(iso_day)
        if today <= d <= end:
            out.append({"date": iso_day, "name": name, "in_days": str((d - today).days)})
    return out


def has_any(text: str, *words: str) -> bool:
    return any(w in text for w in words)


def count_ar(n: int, one: str, two: str, few: str, many: str) -> str:
    """Arabic number agreement: 1 منشور · 2 منشوران · 3-10 منشورات · 11+ منشورًا."""
    if n == 0:
        return f"لا {few}"
    if n == 1:
        return one
    if n == 2:
        return two
    if 3 <= n % 100 <= 10:
        return f"{n} {few}"
    return f"{n} {many}"


def posts_ar(n: int) -> str:
    return count_ar(n, "منشور واحد", "منشوران", "منشورات", "منشورًا")


def clip(text: str, n: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"
