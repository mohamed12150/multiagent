"""Local time for a Saudi company: schedules, "today" and send windows are in the configured timezone
(default Asia/Riyadh); storage is naive UTC."""
from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .. import db, settings

DEFAULT_TZ = "Asia/Riyadh"
WEEKDAYS_AR = ("الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت", "الأحد")


def tz() -> ZoneInfo:
    with db.session() as s:
        name = settings.get(s, "general").timezone
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo(DEFAULT_TZ)


def to_local(utc_naive: datetime, zone: ZoneInfo | None = None) -> datetime:
    return utc_naive.replace(tzinfo=UTC).astimezone(zone or tz())


def to_utc(local: datetime, zone: ZoneInfo | None = None) -> datetime:
    aware = local if local.tzinfo else local.replace(tzinfo=zone or tz())
    return aware.astimezone(UTC).replace(tzinfo=None)


def now_local(zone: ZoneInfo | None = None) -> datetime:
    return to_local(db.utcnow(), zone)


def today(zone: ZoneInfo | None = None) -> date:
    return now_local(zone).date()


def day_bounds_utc(day: date, zone: ZoneInfo | None = None) -> tuple[datetime, datetime]:
    """[start, end) of a local calendar day, as naive UTC."""
    z = zone or tz()
    start = to_utc(datetime.combine(day, time.min, tzinfo=z))
    return start, start + timedelta(days=1)


def parse_hhmm(value: str) -> time:
    hh, mm = value.split(":")
    return time(int(hh), int(mm))


def in_window(start: str, end: str, at: datetime | None = None) -> bool:
    """Is local time `at` inside [start, end)? Windows may wrap midnight."""
    t = (at or now_local()).time()
    a, b = parse_hhmm(start), parse_hhmm(end)
    return a <= t < b if a <= b else (t >= a or t < b)


def human(utc_naive: datetime | None) -> str:
    if utc_naive is None:
        return ""
    local = to_local(utc_naive)
    return f"{WEEKDAYS_AR[local.weekday()]} {local:%Y-%m-%d %H:%M}"
