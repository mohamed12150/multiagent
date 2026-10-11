"""X API v2: tweets and threads with media, public metrics, mentions and replies (OAuth 2.0 user context)."""
from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

from .base import (
    UPLOAD_TIMEOUT,
    AccountInfo,
    Connector,
    ConnectorError,
    Inbound,
    OutboundPost,
    PublishResult,
    need,
    request,
    split_text,
)

P = "X"
API = "https://api.x.com/2"
TWEET_LIMIT = 280
CHUNK = 4 * 1024 * 1024


class XConnector(Connector):
    provider = "x"
    live = True

    def _headers(self) -> dict[str, str]:
        need(self.cfg, "access_token")
        return {"Authorization": f"Bearer {self.cfg['access_token']}"}

    async def _me(self) -> dict[str, Any]:
        resp = await request(P, "GET", f"{API}/users/me", headers=self._headers(),
                             params={"user.fields": "public_metrics,username,name"})
        return resp.json().get("data", {})

    async def test(self) -> AccountInfo:
        me = await self._me()
        pm = me.get("public_metrics", {})
        return AccountInfo(name=me.get("name", ""), handle="@" + me.get("username", ""),
                           followers=int(pm.get("followers_count", 0)), extra={"user_id": me.get("id", "")})

    async def _upload(self, media: Any) -> str:
        category = "tweet_video" if media.kind == "video" else "tweet_image"
        init = await request(P, "POST", f"{API}/media/upload/initialize", headers=self._headers(),
                             json={"media_type": media.mime, "total_bytes": media.size, "media_category": category})
        media_id = str(init.json().get("data", {}).get("id", ""))
        if not media_id:
            raise ConnectorError(f"{P}: تعذر بدء رفع الوسائط")
        with media.path.open("rb") as fh:
            index = 0
            while chunk := fh.read(CHUNK):
                await request(P, "POST", f"{API}/media/upload/{media_id}/append", headers=self._headers(),
                              timeout=UPLOAD_TIMEOUT, data={"segment_index": str(index)},
                              files={"media": ("chunk", chunk, "application/octet-stream")})
                index += 1
        fin = await request(P, "POST", f"{API}/media/upload/{media_id}/finalize", headers=self._headers())
        info = fin.json().get("data", {}).get("processing_info")
        for _ in range(30):
            if not info or info.get("state") in ("succeeded", None):
                break
            if info.get("state") == "failed":
                raise ConnectorError(f"{P}: فشلت معالجة الفيديو")
            await asyncio.sleep(int(info.get("check_after_secs", 3)))
            st = await request(P, "GET", f"{API}/media/upload", headers=self._headers(),
                               params={"command": "STATUS", "media_id": media_id})
            info = st.json().get("data", {}).get("processing_info")
        return media_id

    async def _tweet(self, text: str, *, media_ids: list[str] | None = None, reply_to: str = "") -> str:
        body: dict[str, Any] = {"text": text}
        if media_ids:
            body["media"] = {"media_ids": media_ids}
        if reply_to:
            body["reply"] = {"in_reply_to_tweet_id": reply_to}
        resp = await request(P, "POST", f"{API}/tweets", headers=self._headers(), json=body)
        return str(resp.json().get("data", {}).get("id", ""))

    async def publish(self, post: OutboundPost) -> PublishResult:
        media_ids = [await self._upload(m) for m in post.media[:4]]
        parts = split_text(post.text, TWEET_LIMIT)
        first = await self._tweet(parts[0], media_ids=media_ids)
        prev = first
        for part in parts[1:]:
            prev = await self._tweet(part, reply_to=prev)
        me = await self._me()
        url = f"https://x.com/{me.get('username', 'i')}/status/{first}" if first else ""
        return PublishResult(external_id=first, url=url, detail={"thread": len(parts)})

    async def metrics(self, external_ids: list[str]) -> dict[str, dict[str, int]]:
        if not external_ids:
            return {}
        resp = await request(P, "GET", f"{API}/tweets", headers=self._headers(),
                             params={"ids": ",".join(external_ids[:100]), "tweet.fields": "public_metrics"})
        out = {}
        for t in resp.json().get("data", []):
            pm = t.get("public_metrics", {})
            out[str(t["id"])] = {"views": int(pm.get("impression_count", 0)), "likes": int(pm.get("like_count", 0)),
                                 "comments": int(pm.get("reply_count", 0)),
                                 "shares": int(pm.get("retweet_count", 0)) + int(pm.get("quote_count", 0)),
                                 "saves": int(pm.get("bookmark_count", 0)),
                                 "reach": int(pm.get("impression_count", 0))}
        return out

    async def inbox(self, since: datetime | None) -> list[Inbound]:
        me = await self._me()
        params: dict[str, Any] = {"expansions": "author_id", "user.fields": "username,name",
                                  "tweet.fields": "created_at,conversation_id", "max_results": 20}
        if since:
            params["start_time"] = since.strftime("%Y-%m-%dT%H:%M:%SZ")
        resp = await request(P, "GET", f"{API}/users/{me.get('id')}/mentions", headers=self._headers(), params=params)
        body = resp.json()
        users = {u["id"]: u for u in body.get("includes", {}).get("users", [])}
        out = []
        for t in body.get("data", []):
            u = users.get(t.get("author_id"), {})
            out.append(Inbound(external_ref=str(t["id"]), kind="comment", text=t.get("text", ""),
                               external_id=str(t["id"]), handle="@" + u.get("username", ""), name=u.get("name", ""),
                               post_external_id=str(t.get("conversation_id", ""))))
        return out

    async def reply(self, *, kind: str, external_ref: str, to: str, text: str) -> str:
        return await self._tweet(text[:TWEET_LIMIT], reply_to=external_ref)

    async def refresh(self) -> dict[str, Any] | None:
        if not self.cfg.get("refresh_token") or not self.cfg.get("client_id"):
            return None
        auth = (self.cfg["client_id"], self.cfg["client_secret"]) if self.cfg.get("client_secret") else None
        resp = await request(P, "POST", f"{API}/oauth2/token", auth=auth,
                             data={"grant_type": "refresh_token", "refresh_token": self.cfg["refresh_token"],
                                   "client_id": self.cfg["client_id"]})
        d = resp.json()
        return {"access_token": d["access_token"], "refresh_token": d.get("refresh_token", self.cfg["refresh_token"]),
                "expires_in": int(d.get("expires_in", 7200))}
