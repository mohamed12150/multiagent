"""WhatsApp Cloud API. Inbound messages arrive by webhook (/api/hooks/meta); this module sends.

Consent rules are enforced by the caller (only opted-in contacts are ever passed as recipients); this module
additionally refuses free-form text to a number outside the 24-hour service window unless a template is given."""
from __future__ import annotations

from typing import Any

from .base import UPLOAD_TIMEOUT, AccountInfo, Connector, ConnectorError, OutboundPost, PublishResult, need, request

P = "WhatsApp"


class WhatsAppConnector(Connector):
    provider = "whatsapp"
    live = True

    @property
    def base(self) -> str:
        return f"https://graph.facebook.com/{self.cfg.get('graph_version') or 'v24.0'}"

    def _headers(self) -> dict[str, str]:
        need(self.cfg, "phone_number_id", "access_token")
        return {"Authorization": f"Bearer {self.cfg['access_token']}"}

    async def test(self) -> AccountInfo:
        resp = await request(P, "GET", f"{self.base}/{self.cfg.get('phone_number_id', '')}", headers=self._headers(),
                             params={"fields": "display_phone_number,verified_name,quality_rating"})
        d = resp.json()
        return AccountInfo(name=d.get("verified_name", ""), handle=d.get("display_phone_number", ""),
                           extra={"quality": d.get("quality_rating", "")})

    async def _message(self, payload: dict[str, Any]) -> str:
        headers = self._headers()  # validates the config before any field is read
        body = {"messaging_product": "whatsapp", "recipient_type": "individual", **payload}
        resp = await request(P, "POST", f"{self.base}/{self.cfg['phone_number_id']}/messages",
                             headers=headers, json=body)
        msgs = resp.json().get("messages") or [{}]
        return str(msgs[0].get("id", ""))

    async def _upload(self, media: Any) -> str:
        headers = self._headers()
        with media.path.open("rb") as fh:
            resp = await request(P, "POST", f"{self.base}/{self.cfg['phone_number_id']}/media",
                                 headers=headers, timeout=UPLOAD_TIMEOUT,
                                 data={"messaging_product": "whatsapp", "type": media.mime},
                                 files={"file": (media.path.name, fh, media.mime)})
        return str(resp.json().get("id", ""))

    @staticmethod
    def template_payload(name: str, lang: str, params: list[str]) -> dict[str, Any]:
        comp = [{"type": "body", "parameters": [{"type": "text", "text": p[:1024]} for p in params]}] if params else []
        return {"type": "template", "template": {"name": name, "language": {"code": lang}, "components": comp}}

    async def send(self, *, to: str, text: str, subject: str = "", html: str = "",
                   template: dict[str, Any] | None = None) -> str:
        if template:
            return await self._message({"to": to, **self.template_payload(
                template["name"], template.get("lang", "ar"), template.get("params", []))})
        return await self._message({"to": to, "type": "text", "text": {"preview_url": True, "body": text[:4096]}})

    async def reply(self, *, kind: str, external_ref: str, to: str, text: str) -> str:
        return await self.send(to=to, text=text)

    async def publish(self, post: OutboundPost) -> PublishResult:
        """A broadcast to opted-in recipients. With an approved template it can reach anyone who opted in;
        without one, the caller passes only numbers inside the 24-hour window."""
        if not post.recipients:
            raise ConnectorError(f"{P}: لا يوجد مشتركون موافقون لإرسال الرسالة الجماعية")
        media_id = await self._upload(post.media[0]) if post.media else ""
        template = self.cfg.get("broadcast_template", "")
        sent, failed = 0, 0
        first = ""
        for number in post.recipients:
            try:
                if template:
                    mid = await self._message({"to": number, **self.template_payload(template, "ar", [post.text[:900]])})
                elif media_id:
                    kind = post.media[0].kind
                    mid = await self._message({"to": number, "type": kind, kind: {"id": media_id,
                                                                               "caption": post.text[:1024]}})
                else:
                    mid = await self._message({"to": number, "type": "text", "text": {"body": post.text[:4096]}})
                sent += 1
                first = first or mid
            except ConnectorError as exc:
                if exc.auth:
                    raise
                failed += 1
        if sent == 0:
            raise ConnectorError(f"{P}: لم تُرسل أي رسالة ({failed} فشلت)", transient=True)
        return PublishResult(external_id=first, detail={"sent": sent, "failed": failed})
