"""Connector registry: `build(provider)` returns the live client when the connection is live and configured,
otherwise the sandbox — so every agent calls one interface and never branches on mode."""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy.orm import Session

from .. import db, vault
from ..models import Connection
from . import catalog
from .base import Connector, ConnectorError
from .email import EmailConnector
from .instagram import InstagramConnector
from .linkedin import LinkedInConnector
from .sandbox import SandboxConnector
from .tiktok import TikTokConnector
from .whatsapp import WhatsAppConnector
from .x import XConnector

LIVE: dict[str, type[Connector]] = {
    "instagram": InstagramConnector, "tiktok": TikTokConnector, "x": XConnector, "whatsapp": WhatsAppConnector,
    "linkedin": LinkedInConnector, "email": EmailConnector,
}

__all__ = ["Connector", "ConnectorError", "build", "config_for", "ensure_rows", "is_live", "store_refresh"]


def ensure_rows(s: Session) -> None:
    for provider in catalog.ORDER:
        if s.get(Connection, provider) is None:
            s.add(Connection(id=provider, mode="sandbox", status="not_configured", config=catalog.defaults(provider)))


def config_for(s: Session, provider: str) -> dict[str, Any]:
    """Plain fields + decrypted secrets. Server-side only."""
    conn = s.get(Connection, provider)
    cfg: dict[str, Any] = {**catalog.defaults(provider), **((conn.config if conn else None) or {})}
    for key in catalog.secret_fields(provider):
        value = vault.get(s, f"{provider}.{key}")
        if value:
            cfg[key] = value
    return cfg


def is_live(s: Session, provider: str) -> bool:
    conn = s.get(Connection, provider)
    return bool(conn and conn.mode == "live" and conn.status != "paused" and provider in LIVE)


def build(provider: str, *, force_live: bool = False) -> Connector:
    with db.session() as s:
        live = force_live or is_live(s, provider)
        cfg = config_for(s, provider) if live else {}
    if live and provider in LIVE:
        return LIVE[provider](cfg)
    return SandboxConnector(provider, cfg)


def store_refresh(s: Session, provider: str, tokens: dict[str, Any]) -> None:
    """Persist refreshed OAuth tokens (new values replace old ones in the vault)."""
    for key in ("access_token", "refresh_token"):
        if tokens.get(key):
            vault.put(s, f"{provider}.{key}", str(tokens[key]))
    conn = s.get(Connection, provider)
    if conn is not None and tokens.get("expires_in"):
        conn.token_expires_at = db.utcnow() + timedelta(seconds=int(tokens["expires_in"]))
