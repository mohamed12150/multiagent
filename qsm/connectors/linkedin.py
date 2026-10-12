"""LinkedIn Posts API (versioned REST): text and image posts, social metadata, comments and replies."""
from __future__ import annotations

from datetime import date
from typing import Any
from urllib.parse import quote

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
)

P = "LinkedIn"
REST = "https://api.linkedin.com/rest"


# LinkedIn retires each monthly API version about 12 months after release (202510 stops on 2026-10-15).
API_VERSION = "202609"


def api_version(configured: str | None, today: date | None = None) -> str:
    """The configured version while LinkedIn still serves it; a retired one falls back to the current release."""
    day = today or date.today()
    oldest_live = f"{day.year - 1}{day.month:02d}"
    value = (configured or "").strip()
    return value if len(value) == 6 and value.isdigit() and value >= oldest_live else API_VERSION


class LinkedInConnector(Connector):
    provider = "linkedin"
    live = True

    def _headers(self) -> dict[str, str]:
        need(self.cfg, "access_token", "author_urn")
        return {"Authorization": f"Bearer {self.cfg['access_token']}",
                "LinkedIn-Version": api_version(self.cfg.get("api_version")),
                "X-Restli-Protocol-Version": "2.0.0"}

    @property
    def author(self) -> str:
        return str(self.cfg.get("author_urn", ""))

    async def test(self) -> AccountInfo:
        if ":organization:" in self.author:
            org_id = self.author.rsplit(":", 1)[-1]
            resp = await request(P, "GET", f"{REST}/organizations/{org_id}", headers=self._headers())
            d = resp.json()
            name = (d.get("localizedName") or d.get("vanityName") or "")
            followers = 0
            try:
                fr = await request(P, "GET", f"{REST}/networkSizes/{quote(self.author)}", headers=self._headers(),
                                   params={"edgeType": "COMPANY_FOLLOWED_BY_MEMBER"})
                followers = int(fr.json().get("firstDegreeSize", 0))
            except ConnectorError:
                pass
            return AccountInfo(name=name, handle=d.get("vanityName", ""), followers=followers)
        resp = await request(P, "GET", "https://api.linkedin.com/v2/userinfo",
                             headers={"Authorization": f"Bearer {self.cfg.get('access_token', '')}"})
        d = resp.json()
        return AccountInfo(name=d.get("name", ""), handle=d.get("email", ""))

    async def _upload_image(self, media: Any) -> str:
        init = await request(P, "POST", f"{REST}/images?action=initializeUpload", headers=self._headers(),
                             json={"initializeUploadRequest": {"owner": self.author}})
        value = init.json().get("value", {})
        url, urn = value.get("uploadUrl"), value.get("image")
        if not url or not urn:
            raise ConnectorError(f"{P}: تعذر بدء رفع الصورة")
        await request(P, "PUT", url, timeout=UPLOAD_TIMEOUT, content=media.path.read_bytes(),
                      headers={"Authorization": f"Bearer {self.cfg['access_token']}"})
        return str(urn)

    async def publish(self, post: OutboundPost) -> PublishResult:
        images = [m for m in post.media if m.kind == "image"][:9]
        body: dict[str, Any] = {
            "author": self.author, "commentary": post.text[:3000], "visibility": "PUBLIC",
            "distribution": {"feedDistribution": "MAIN_FEED", "targetEntities": [], "thirdPartyDistributionChannels": []},
            "lifecycleState": "PUBLISHED", "isReshareDisabledByAuthor": False}
        if len(images) == 1:
            body["content"] = {"media": {"id": await self._upload_image(images[0]), "altText": post.title[:120]}}
        elif len(images) > 1:
            body["content"] = {"multiImage": {"images": [{"id": await self._upload_image(m)} for m in images]}}
        resp = await request(P, "POST", f"{REST}/posts", headers=self._headers(), json=body)
        urn = resp.headers.get("x-restli-id", "")
        return PublishResult(external_id=urn, url=f"https://www.linkedin.com/feed/update/{urn}" if urn else "")

    async def metrics(self, external_ids: list[str]) -> dict[str, dict[str, int]]:
        out = {}
        for urn in external_ids:
            try:
                resp = await request(P, "GET", f"{REST}/socialMetadata/{quote(urn)}", headers=self._headers())
            except ConnectorError:
                continue
            d = resp.json()
            reactions = sum(int(v.get("count", 0)) for v in (d.get("reactionSummaries") or {}).values())
            comments = int((d.get("commentSummary") or {}).get("count", 0))
            out[urn] = {"likes": reactions, "comments": comments}
        return out

    async def inbox(self, since: Any) -> list[Inbound]:
        return []  # comments are read per post by the channel agent's engage step (see comments_for)

    async def comments_for(self, post_urn: str) -> list[Inbound]:
        resp = await request(P, "GET", f"{REST}/socialActions/{quote(post_urn)}/comments", headers=self._headers())
        out = []
        for c in resp.json().get("elements", []):
            urn = c.get("$URN") or c.get("commentUrn") or ""
            out.append(Inbound(external_ref=f"{post_urn}|{urn}", kind="comment",
                               text=(c.get("message") or {}).get("text", ""), external_id=urn,
                               handle=c.get("actor", ""), post_external_id=post_urn))
        return out

    async def reply(self, *, kind: str, external_ref: str, to: str, text: str) -> str:
        post_urn, _, comment_urn = external_ref.partition("|")
        body: dict[str, Any] = {"actor": self.author, "object": post_urn, "message": {"text": text[:1250]}}
        if comment_urn:
            body["parentComment"] = comment_urn
        resp = await request(P, "POST", f"{REST}/socialActions/{quote(post_urn)}/comments", headers=self._headers(),
                             json=body)
        return resp.headers.get("x-restli-id", "")
