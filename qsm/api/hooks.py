"""Meta webhooks (WhatsApp messages, Instagram comments and DMs). Every POST must carry a valid
X-Hub-Signature-256 made with the app secret; without a configured secret nothing is accepted."""
from __future__ import annotations

import hashlib
import hmac
import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import PlainTextResponse

from .. import connectors, db, vault
from ..agents.channels import ingest
from ..agents.registry import CHANNEL_LABELS
from ..agents.runtime import already_pending, enqueue
from ..connectors.base import Inbound
from .deps import ApiError, ok

log = logging.getLogger("qsm.hooks")
router = APIRouter(prefix="/api/hooks", tags=["hooks"])
MAX_BODY = 1024 * 1024


@router.get("/meta", response_class=PlainTextResponse)
def verify(mode: str = Query("", alias="hub.mode"), token: str = Query("", alias="hub.verify_token"),
           challenge: str = Query("", alias="hub.challenge")) -> str:
    with db.session() as s:
        expected = vault.get(s, "meta.verify_token") or ""
    if mode != "subscribe" or not expected or not hmac.compare_digest(token.encode(), expected.encode()):
        raise ApiError(403, "bad_token", "verify token mismatch")
    return challenge


def _secrets() -> list[str]:
    with db.session() as s:
        return [v for v in (connectors.config_for(s, "whatsapp").get("app_secret"),
                            connectors.config_for(s, "instagram").get("app_secret")) if v]


def signature_ok(raw: bytes, header: str, secrets_: list[str]) -> bool:
    if not header.startswith("sha256="):
        return False
    given = header.removeprefix("sha256=")
    given_b = given.encode("utf-8", "replace")
    return any(hmac.compare_digest(hmac.new(sec.encode(), raw, hashlib.sha256).hexdigest().encode(), given_b)
               for sec in secrets_)


def _ts(value: Any) -> datetime | None:
    try:
        return datetime.fromtimestamp(int(value), UTC).replace(tzinfo=None) if value else None
    except (TypeError, ValueError, OverflowError):
        return None


def parse(payload: dict[str, Any]) -> dict[str, list[Inbound]]:
    out: dict[str, list[Inbound]] = {"whatsapp": [], "instagram": []}
    obj = payload.get("object")
    for entry in payload.get("entry", []) or []:
        if obj == "whatsapp_business_account":
            for change in entry.get("changes", []) or []:
                value = change.get("value") or {}
                names = {c.get("wa_id"): (c.get("profile") or {}).get("name", "") for c in value.get("contacts", []) or []}
                for m in value.get("messages", []) or []:
                    body = (m.get("text") or {}).get("body") or (m.get("button") or {}).get("text") or \
                        ((m.get("interactive") or {}).get("button_reply") or {}).get("title") or ""
                    if not body and m.get("type") in ("image", "video", "audio", "document"):
                        body = f"[{m['type']}]"
                    phone = str(m.get("from", ""))
                    out["whatsapp"].append(Inbound(external_ref=f"wa:{phone}", kind="whatsapp", text=body,
                                                   external_id=str(m.get("id", "")), handle=phone, phone=phone,
                                                   name=names.get(phone, ""), at=_ts(m.get("timestamp"))))
        elif obj == "instagram":
            for change in entry.get("changes", []) or []:
                if change.get("field") != "comments":
                    continue
                v = change.get("value") or {}
                out["instagram"].append(Inbound(external_ref=str(v.get("id", "")), kind="comment", text=v.get("text", ""),
                                                external_id=str(v.get("id", "")),
                                                handle="@" + (v.get("from") or {}).get("username", ""),
                                                post_external_id=str((v.get("media") or {}).get("id", ""))))
            for msg in entry.get("messaging", []) or []:
                m = msg.get("message") or {}
                if m.get("is_echo") or not m.get("text"):
                    continue
                sender = str((msg.get("sender") or {}).get("id", ""))
                out["instagram"].append(Inbound(external_ref=f"igdm:{sender}", kind="dm", text=m["text"],
                                                external_id=str(m.get("mid", "")), handle=sender,
                                                at=_ts(int(msg.get("timestamp", 0)) // 1000)))
    return out


@router.post("/meta")
async def receive(request: Request) -> dict:
    raw = await request.body()
    if len(raw) > MAX_BODY:
        raise ApiError(413, "too_large", "payload too large")
    secrets_ = _secrets()
    if not secrets_:
        raise ApiError(403, "no_secret", "configure the Meta app secret first")
    if not signature_ok(raw, request.headers.get("x-hub-signature-256", ""), secrets_):
        raise ApiError(403, "bad_signature", "signature mismatch")
    try:
        payload = await request.json()
    except ValueError as exc:
        raise ApiError(400, "bad_json", "invalid json") from exc
    received = 0
    for channel, items in parse(payload).items():
        if not items:
            continue
        with db.session() as s:
            needs, confirmations = ingest(s, channel, items)
            received += len(items)
            for conv_id in needs:
                if not already_pending(s, "content.reply", "content", "conversation_id", conv_id):
                    enqueue(s, kind="content.reply", title=f"رد على عميل — {CHANNEL_LABELS[channel]}",
                            input={"conversation_id": conv_id}, created_by=channel, origin="event", priority=2)
            for message_id in confirmations:
                enqueue(s, kind="content.send_reply", title="تأكيد الاشتراك", input={"message_id": message_id},
                        created_by=channel, origin="event", priority=1)
    return ok({"received": received})
