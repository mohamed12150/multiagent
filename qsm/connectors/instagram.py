"""Instagram Graph API (Instagram API with Facebook Login): publish, insights, comments.

Instagram pulls media from a public URL — Settings › عام › الرابط العام must point at this server."""
from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime
from typing import Any

from .base import AccountInfo, Connector, ConnectorError, Inbound, OutboundPost, PublishResult, need, request

P = "Instagram"
CONTAINER_POLL_S = 5
CONTAINER_POLL_MAX = 36  # 3 minutes for a reel to finish processing


class InstagramConnector(Connector):
    provider = "instagram"
    live = True

    @property
    def base(self) -> str:
        return f"https://graph.facebook.com/{self.cfg.get('graph_version') or 'v24.0'}"

    def _headers(self) -> dict[str, str]:
        """The token travels in a header, never in the URL (URLs end up in logs and proxies)."""
        need(self.cfg, "ig_user_id", "access_token")
        return {"Authorization": f"Bearer {self.cfg['access_token']}"}

    async def _get(self, path: str, **params: Any) -> dict[str, Any]:
        resp = await request(P, "GET", f"{self.base}/{path}", params=params, headers=self._headers())
        return resp.json()

    async def _post(self, path: str, **data: Any) -> dict[str, Any]:
        resp = await request(P, "POST", f"{self.base}/{path}", data=data, headers=self._headers())
        return resp.json()

    async def test(self) -> AccountInfo:
        need(self.cfg, "ig_user_id", "access_token")
        me = await self._get(self.cfg["ig_user_id"], fields="username,name,followers_count,media_count")
        return AccountInfo(name=me.get("name", ""), handle="@" + me.get("username", ""),
                           followers=int(me.get("followers_count", 0)), extra={"media": me.get("media_count", 0)})

    async def _wait_ready(self, container_id: str) -> None:
        for _ in range(CONTAINER_POLL_MAX):
            st = await self._get(container_id, fields="status_code,status")
            code = st.get("status_code")
            if code == "FINISHED":
                return
            if code in ("ERROR", "EXPIRED"):
                raise ConnectorError(f"{P}: فشلت معالجة الوسائط — {st.get('status', code)}")
            await asyncio.sleep(CONTAINER_POLL_S)
        raise ConnectorError(f"{P}: تأخرت معالجة الفيديو — ستُعاد المحاولة", transient=True)

    async def _container(self, media: Any, *, caption: str | None, item: bool = False, fmt: str = "post") -> str:
        if not media.public_url:
            raise ConnectorError(f"{P}: يتطلب رابطًا عامًا للوسائط — اضبط «الرابط العام» في الإعدادات")
        data: dict[str, Any] = {}
        if caption is not None:
            data["caption"] = caption
        if item:
            data["is_carousel_item"] = "true"
        if media.kind == "video":
            data["media_type"] = "STORIES" if fmt == "story" else ("VIDEO" if item else "REELS")
            data["video_url"] = media.public_url
        else:
            if fmt == "story":
                data["media_type"] = "STORIES"
            data["image_url"] = media.public_url
        res = await self._post(f"{self.cfg['ig_user_id']}/media", **data)
        cid = res.get("id")
        if not cid:
            raise ConnectorError(f"{P}: لم يُنشأ حاوي الوسائط")
        if media.kind == "video":
            await self._wait_ready(cid)
        return str(cid)

    async def publish(self, post: OutboundPost) -> PublishResult:
        need(self.cfg, "ig_user_id", "access_token")
        if not post.media:
            raise ConnectorError(f"{P}: المنشور يحتاج صورة أو مقطعًا من المكتبة")
        if len(post.media) > 1 and post.format != "story":
            children = [await self._container(m, caption=None, item=True) for m in post.media[:10]]
            res = await self._post(f"{self.cfg['ig_user_id']}/media", media_type="CAROUSEL", caption=post.text,
                                   children=",".join(children))
            creation = str(res["id"])
        else:
            caption = None if post.format == "story" else post.text
            creation = await self._container(post.media[0], caption=caption, fmt=post.format)
        published = await self._post(f"{self.cfg['ig_user_id']}/media_publish", creation_id=creation)
        media_id = str(published.get("id", ""))
        link = ""
        with contextlib.suppress(ConnectorError):
            link = (await self._get(media_id, fields="permalink")).get("permalink", "")
        return PublishResult(external_id=media_id, url=link)

    async def metrics(self, external_ids: list[str]) -> dict[str, dict[str, int]]:
        out: dict[str, dict[str, int]] = {}
        for mid in external_ids:
            try:
                base = await self._get(mid, fields="like_count,comments_count")
                m = {"likes": int(base.get("like_count", 0)), "comments": int(base.get("comments_count", 0))}
                ins = await self._get(f"{mid}/insights", metric="reach,saved,shares,views")
                for row in ins.get("data", []):
                    val = (row.get("values") or [{}])[0].get("value", 0)
                    key = {"saved": "saves"}.get(row.get("name"), row.get("name"))
                    m[key] = int(val or 0)
                out[mid] = m
            except ConnectorError:
                continue
        return out

    async def inbox(self, since: datetime | None) -> list[Inbound]:
        need(self.cfg, "ig_user_id", "access_token")
        data = await self._get(f"{self.cfg['ig_user_id']}/media",
                               fields="id,comments.limit(25){id,text,username,timestamp}", limit=8)
        out: list[Inbound] = []
        for media in data.get("data", []):
            for c in (media.get("comments") or {}).get("data", []):
                at = _ts(c.get("timestamp"))
                if since and at and at <= since:
                    continue
                out.append(Inbound(external_ref=str(c["id"]), kind="comment", text=c.get("text", ""),
                                   external_id=str(c["id"]), handle="@" + c.get("username", ""),
                                   post_external_id=str(media["id"]), at=at))
        return out

    async def reply(self, *, kind: str, external_ref: str, to: str, text: str) -> str:
        if kind == "comment":
            res = await self._post(f"{external_ref}/replies", message=text)
            return str(res.get("id", ""))
        need(self.cfg, "page_id")
        resp = await request(P, "POST", f"{self.base}/{self.cfg['page_id']}/messages",
                             headers=self._headers(), json={"recipient": {"id": to}, "message": {"text": text}})
        return str(resp.json().get("message_id", ""))


def _ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(value[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None
