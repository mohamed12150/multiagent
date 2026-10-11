"""SMTP delivery for reports and alerts (stdlib smtplib in a worker thread)."""
from __future__ import annotations

import asyncio
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import Any

from .base import AccountInfo, Connector, ConnectorError, need

P = "SMTP"
TIMEOUT_S = 30


class EmailConnector(Connector):
    provider = "email"
    live = True

    def _connect(self) -> smtplib.SMTP:
        need(self.cfg, "smtp_host", "username", "password", "from_address")
        host, port = self.cfg["smtp_host"], int(self.cfg.get("smtp_port") or 587)
        ctx = ssl.create_default_context()
        try:
            if (self.cfg.get("security") or "starttls") == "ssl":
                conn: smtplib.SMTP = smtplib.SMTP_SSL(host, port, timeout=TIMEOUT_S, context=ctx)
            else:
                conn = smtplib.SMTP(host, port, timeout=TIMEOUT_S)
                conn.starttls(context=ctx)
            conn.login(self.cfg["username"], self.cfg["password"])
        except smtplib.SMTPAuthenticationError as exc:
            raise ConnectorError(f"{P}: بيانات الدخول مرفوضة", auth=True) from exc
        except (OSError, smtplib.SMTPException) as exc:
            raise ConnectorError(f"{P}: تعذر الاتصال بالخادم ({exc.__class__.__name__})", transient=True) from exc
        return conn

    def _test_sync(self) -> AccountInfo:
        conn = self._connect()
        conn.quit()
        return AccountInfo(name=self.cfg.get("from_name", ""), handle=self.cfg["from_address"])

    async def test(self) -> AccountInfo:
        return await asyncio.to_thread(self._test_sync)

    def _send_sync(self, to: str, subject: str, text: str, html: str) -> str:
        msg = EmailMessage()
        msg["From"] = formataddr((self.cfg.get("from_name") or "Qhub Smart Marketing", self.cfg["from_address"]))
        msg["To"] = to
        msg["Subject"] = subject
        msg["Message-ID"] = make_msgid(domain=self.cfg["from_address"].split("@")[-1])
        msg.set_content(text or " ")
        if html:
            msg.add_alternative(html, subtype="html")
        conn = self._connect()
        try:
            conn.send_message(msg)
        except smtplib.SMTPException as exc:
            raise ConnectorError(f"{P}: رُفضت الرسالة ({exc.__class__.__name__})") from exc
        finally:
            conn.quit()
        return str(msg["Message-ID"])

    async def send(self, *, to: str, text: str, subject: str = "", html: str = "",
                   template: dict[str, Any] | None = None) -> str:
        return await asyncio.to_thread(self._send_sync, to, subject or "Qhub Smart Marketing", text, html)
