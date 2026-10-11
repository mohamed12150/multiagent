"""TikTok Content Posting API: direct-post videos by file upload, photo posts by URL, video stats.

Unaudited TikTok apps may only post privately (SELF_ONLY) — the creator-info query decides the privacy level."""
from __future__ import annotations

import asyncio
import math
from typing import Any

from .base import UPLOAD_TIMEOUT, AccountInfo, Connector, ConnectorError, OutboundPost, PublishResult, need, request

P = "TikTok"
API = "https://open.tiktokapis.com/v2"
MIN_CHUNK = 5 * 1024 * 1024
MAX_SINGLE = 64 * 1024 * 1024
CHUNK = 10 * 1024 * 1024
STATUS_POLLS = 40


def chunk_plan(size: int) -> tuple[int, int]:
    """(chunk_size, total_chunks) under TikTok's rules: one chunk up to 64 MB, else 10 MB chunks with the remainder
    folded into the last one."""
    if size <= MAX_SINGLE:
        return size, 1
    total = max(1, math.floor(size / CHUNK))
    return CHUNK, total


class TikTokConnector(Connector):
    provider = "tiktok"
    live = True

    def _headers(self) -> dict[str, str]:
        need(self.cfg, "access_token")
        return {"Authorization": f"Bearer {self.cfg['access_token']}", "Content-Type": "application/json; charset=UTF-8"}

    @staticmethod
    def _data(resp: Any) -> dict[str, Any]:
        body = resp.json()
        err = body.get("error") or {}
        if err.get("code") not in (None, "ok"):
            raise ConnectorError(f"{P}: {err.get('message') or err.get('code')}", auth=err.get("code") in (
                "access_token_invalid", "scope_not_authorized"))
        return body.get("data") or {}

    async def test(self) -> AccountInfo:
        resp = await request(P, "GET", f"{API}/user/info/", headers=self._headers(),
                             params={"fields": "open_id,display_name,username,follower_count,video_count"})
        u = self._data(resp).get("user", {})
        return AccountInfo(name=u.get("display_name", ""), handle="@" + u.get("username", ""),
                           followers=int(u.get("follower_count", 0)), extra={"videos": u.get("video_count", 0)})

    async def _privacy(self) -> str:
        resp = await request(P, "POST", f"{API}/post/publish/creator_info/query/", headers=self._headers(), json={})
        options = self._data(resp).get("privacy_level_options") or ["SELF_ONLY"]
        return "PUBLIC_TO_EVERYONE" if "PUBLIC_TO_EVERYONE" in options else options[0]

    async def _upload_video(self, media: Any, title: str, privacy: str) -> str:
        chunk_size, total = chunk_plan(media.size)
        init = await request(P, "POST", f"{API}/post/publish/video/init/", headers=self._headers(), json={
            "post_info": {"title": title[:2200], "privacy_level": privacy, "disable_comment": False,
                          "disable_duet": False, "disable_stitch": False},
            "source_info": {"source": "FILE_UPLOAD", "video_size": media.size, "chunk_size": chunk_size,
                            "total_chunk_count": total}})
        data = self._data(init)
        upload_url, publish_id = data.get("upload_url"), data.get("publish_id")
        if not upload_url or not publish_id:
            raise ConnectorError(f"{P}: لم يُرجع رابط الرفع")
        with media.path.open("rb") as fh:
            for i in range(total):
                start = i * chunk_size
                length = media.size - start if i == total - 1 else chunk_size
                fh.seek(start)
                blob = fh.read(length)
                await request(P, "PUT", upload_url, timeout=UPLOAD_TIMEOUT, content=blob, headers={
                    "Content-Type": media.mime or "video/mp4", "Content-Length": str(len(blob)),
                    "Content-Range": f"bytes {start}-{start + len(blob) - 1}/{media.size}"})
        return str(publish_id)

    async def _photo(self, post: OutboundPost, privacy: str) -> str:
        urls = [m.public_url for m in post.media if m.kind == "image" and m.public_url]
        if not urls:
            raise ConnectorError(f"{P}: صور تيك توك تتطلب رابطًا عامًا موثّقًا للنطاق")
        resp = await request(P, "POST", f"{API}/post/publish/content/init/", headers=self._headers(), json={
            "post_info": {"title": post.title[:90], "description": post.text[:4000], "privacy_level": privacy},
            "source_info": {"source": "PULL_FROM_URL", "photo_images": urls[:35], "photo_cover_index": 0},
            "post_mode": "DIRECT_POST", "media_type": "PHOTO"})
        return str(self._data(resp).get("publish_id", ""))

    async def _wait(self, publish_id: str) -> str:
        for _ in range(STATUS_POLLS):
            resp = await request(P, "POST", f"{API}/post/publish/status/fetch/", headers=self._headers(),
                                 json={"publish_id": publish_id})
            d = self._data(resp)
            status = d.get("status")
            if status == "PUBLISH_COMPLETE":
                ids = d.get("publicaly_available_post_id") or d.get("publicly_available_post_id") or []
                return str(ids[0]) if ids else publish_id
            if status == "FAILED":
                raise ConnectorError(f"{P}: فشل النشر — {d.get('fail_reason', '')}")
            await asyncio.sleep(5)
        return publish_id  # still processing; metrics sync resolves it later

    async def publish(self, post: OutboundPost) -> PublishResult:
        if not post.media:
            raise ConnectorError(f"{P}: يحتاج المنشور فيديو أو صورًا من المكتبة")
        privacy = await self._privacy()
        video = next((m for m in post.media if m.kind == "video"), None)
        publish_id = await self._upload_video(video, post.text, privacy) if video else await self._photo(post, privacy)
        post_id = await self._wait(publish_id)
        return PublishResult(external_id=post_id, detail={"privacy": privacy, "publish_id": publish_id})

    async def metrics(self, external_ids: list[str]) -> dict[str, dict[str, int]]:
        ids = [i for i in external_ids if i.isdigit()]
        if not ids:
            return {}
        resp = await request(P, "POST", f"{API}/video/query/", headers=self._headers(),
                             params={"fields": "id,view_count,like_count,comment_count,share_count"},
                             json={"filters": {"video_ids": ids[:20]}})
        out = {}
        for v in self._data(resp).get("videos", []):
            out[str(v["id"])] = {"views": int(v.get("view_count", 0)), "reach": int(v.get("view_count", 0)),
                                 "likes": int(v.get("like_count", 0)), "comments": int(v.get("comment_count", 0)),
                                 "shares": int(v.get("share_count", 0))}
        return out

    async def refresh(self) -> dict[str, Any] | None:
        if not self.cfg.get("refresh_token") or not self.cfg.get("client_key"):
            return None
        resp = await request(P, "POST", f"{API}/oauth/token/", headers={
            "Content-Type": "application/x-www-form-urlencoded"}, data={
            "client_key": self.cfg["client_key"], "client_secret": self.cfg.get("client_secret", ""),
            "grant_type": "refresh_token", "refresh_token": self.cfg["refresh_token"]})
        d = resp.json()
        if "access_token" not in d:
            raise ConnectorError(f"{P}: تعذر تجديد الرمز — {d.get('error_description', '')}", auth=True)
        return {"access_token": d["access_token"], "refresh_token": d.get("refresh_token", self.cfg["refresh_token"]),
                "expires_in": int(d.get("expires_in", 86400))}
