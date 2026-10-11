"""Imports every skill module so its handlers and approval resolvers register (called once at startup)."""
from __future__ import annotations


def load_all() -> None:
    from ..engine import limits  # noqa: F401  (limit-raise resolver)
    from . import campaigns, ceo, channels, community, content, coordinator, guardian  # noqa: F401
