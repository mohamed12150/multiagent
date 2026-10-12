"""The two models the network runs on, with published prices (USD per million tokens, read 2026-10-12 from
https://platform.claude.com/docs/en/about-claude/pricing — Sonnet 5.5 cache reads fell to 0.10 on 2026-10-07).
Opus 5.5 decides; Sonnet 5.5 writes and operates."""
from __future__ import annotations

from typing import Any

OPUS = "claude-opus-5-5"
SONNET = "claude-sonnet-5-5"
EFFORTS = ("low", "medium", "high", "xhigh")
WEB_SEARCH_USD = 0.01  # $10 per 1,000 searches

MODELS: dict[str, dict[str, Any]] = {
    OPUS: {"label": "Claude Opus 5.5", "role": "القرار والتخطيط والاستراتيجية", "input": 4.0, "output": 20.0,
           "cache_read": 0.20, "cache_write": 5.0, "default_effort": "medium"},
    SONNET: {"label": "Claude Sonnet 5.5", "role": "الكتابة والتشغيل والتفاعل السريع", "input": 2.0, "output": 10.0,
             "cache_read": 0.10, "cache_write": 2.5, "default_effort": "high"},
}

# Thinking tokens count toward max_tokens: the visible budget gets headroom by effort.
THINKING_HEADROOM = {"low": 2000, "medium": 4000, "high": 8000, "xhigh": 12000}


def cost_usd(model: str, *, input_tokens: int, output_tokens: int, cache_read: int = 0, cache_write: int = 0,
             web_searches: int = 0) -> float:
    p = MODELS.get(model, MODELS[SONNET])
    total = (input_tokens * p["input"] + output_tokens * p["output"] + cache_read * p["cache_read"]
             + cache_write * p["cache_write"]) / 1_000_000
    return round(total + web_searches * WEB_SEARCH_USD, 6)


def catalog() -> list[dict[str, Any]]:
    return [{"id": mid, **{k: v for k, v in m.items()}} for mid, m in MODELS.items()]
