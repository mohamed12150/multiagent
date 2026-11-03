"""Live connectors against a recorded fake transport: request shapes follow each platform's documented API."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from qsm.connectors.base import ConnectorError, MediaFile, OutboundPost


@dataclass
class FakeResp:
    data: Any = None
    status_code: int = 200
    headers: dict[str, str] = field(default_factory=dict)

    def json(self) -> Any:
        return self.data


class Recorder:
    def __init__(self, routes: list[tuple[str, str, Any]]):
        self.routes = routes  # (method, url-substring, response | callable)
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    async def __call__(self, provider: str, method: str, url: str, **kw: Any) -> FakeResp:
        self.calls.append((method, url, kw))
        for m, frag, resp in self.routes:
            if m == method and frag in url:
                return resp(kw) if callable(resp) else resp
        raise AssertionError(f"unexpected {method} {url}")


def media(tmp_path: Path, kind: str = "image", size: int = 64) -> MediaFile:
    p = tmp_path / ("a.mp4" if kind == "video" else "a.png")
    p.write_bytes(b"0" * size)
    return MediaFile(path=p, mime="video/mp4" if kind == "video" else "image/png", kind=kind, size=size,
                     public_url="https://mk.example.sa/m/a?sig=1")


def run(coro):
    return asyncio.run(coro)


def test_instagram_image_publish_and_comments(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from qsm.connectors import instagram

    rec = Recorder([
        ("POST", "/17841/media_publish", FakeResp({"id": "MEDIA9"})),
        ("POST", "/17841/media", FakeResp({"id": "CONT1"})),
        ("GET", "/MEDIA9", FakeResp({"permalink": "https://instagram.com/p/x"})),
        ("GET", "/17841/media", FakeResp({"data": [{"id": "MEDIA9", "comments": {"data": [
            {"id": "c1", "text": "كم السعر؟", "username": "sara", "timestamp": "2026-10-07T10:00:00+0000"}]}}]})),
        ("POST", "/c1/replies", FakeResp({"id": "r1"})),
    ])
    monkeypatch.setattr(instagram, "request", rec)
    c = instagram.InstagramConnector({"ig_user_id": "17841", "access_token": "T"})
    res = run(c.publish(OutboundPost(post_id="p", channel="instagram", format="post", text="نص", media=(media(tmp_path),))))
    assert res.external_id == "MEDIA9" and res.url.endswith("/p/x")
    create = rec.calls[0]
    assert create[2]["data"]["image_url"].startswith("https://") and create[2]["data"]["caption"] == "نص"
    assert "graph.facebook.com/v24.0" in create[1]
    items = run(c.inbox(None))
    assert items[0].text == "كم السعر؟" and items[0].post_external_id == "MEDIA9"
    assert run(c.reply(kind="comment", external_ref="c1", to="", text="أهلًا")) == "r1"


def test_instagram_needs_public_media(tmp_path: Path) -> None:
    from qsm.connectors.instagram import InstagramConnector

    m = MediaFile(path=tmp_path / "x.png", mime="image/png", kind="image", size=1, public_url="")
    with pytest.raises(ConnectorError):
        run(InstagramConnector({"ig_user_id": "1", "access_token": "T"}).publish(
            OutboundPost(post_id="p", channel="instagram", format="post", text="t", media=(m,))))


def test_instagram_reel_waits_for_processing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from qsm.connectors import instagram

    states = iter(["IN_PROGRESS", "FINISHED"])
    rec = Recorder([
        ("POST", "/1/media_publish", FakeResp({"id": "R1"})),
        ("POST", "/1/media", FakeResp({"id": "C1"})),
        ("GET", "/C1", lambda kw: FakeResp({"status_code": next(states)})),
        ("GET", "/R1", FakeResp({"permalink": ""})),
    ])
    monkeypatch.setattr(instagram, "request", rec)
    monkeypatch.setattr(instagram, "CONTAINER_POLL_S", 0)
    c = instagram.InstagramConnector({"ig_user_id": "1", "access_token": "T"})
    res = run(c.publish(OutboundPost(post_id="p", channel="instagram", format="reel", text="t",
                                     media=(media(tmp_path, "video"),))))
    assert res.external_id == "R1"
    assert rec.calls[0][2]["data"]["media_type"] == "REELS"


def test_whatsapp_template_and_broadcast(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from qsm.connectors import whatsapp

    rec = Recorder([("POST", "/PN/messages", FakeResp({"messages": [{"id": "wamid.X"}]}))])
    monkeypatch.setattr(whatsapp, "request", rec)
    c = whatsapp.WhatsAppConnector({"phone_number_id": "PN", "access_token": "T"})
    assert run(c.send(to="9665", text="", template={"name": "daily_report", "params": ["ملخص"]})) == "wamid.X"
    body = rec.calls[0][2]["json"]
    assert body["type"] == "template" and body["template"]["language"]["code"] == "ar"
    assert body["template"]["components"][0]["parameters"][0]["text"] == "ملخص"
    res = run(c.publish(OutboundPost(post_id="p", channel="whatsapp", format="broadcast", text="عرض",
                                     recipients=("9661", "9662"))))
    assert res.detail == {"sent": 2, "failed": 0}
    with pytest.raises(ConnectorError):
        run(c.publish(OutboundPost(post_id="p", channel="whatsapp", format="broadcast", text="x")))


def test_x_thread_with_media(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from qsm.connectors import x

    ids = iter(["T1", "T2", "T3", "T4"])
    rec = Recorder([
        ("POST", "/media/upload/initialize", FakeResp({"data": {"id": "M1"}})),
        ("POST", "/media/upload/M1/append", FakeResp({})),
        ("POST", "/media/upload/M1/finalize", FakeResp({"data": {}})),
        ("POST", "/2/tweets", lambda kw: FakeResp({"data": {"id": next(ids)}})),
        ("GET", "/users/me", FakeResp({"data": {"id": "U", "username": "brand", "public_metrics": {"followers_count": 5}}})),
        ("GET", "/2/tweets", FakeResp({"data": [{"id": "T1", "public_metrics": {"impression_count": 900, "like_count": 30,
                                                                              "reply_count": 2, "retweet_count": 3,
                                                                              "quote_count": 1, "bookmark_count": 4}}]})),
    ])
    monkeypatch.setattr(x, "request", rec)
    c = x.XConnector({"access_token": "T"})
    long_text = "\n".join(["سطر طويل من التغريدة الأولى " * 4] * 4)
    res = run(c.publish(OutboundPost(post_id="p", channel="x", format="thread", text=long_text, media=(media(tmp_path),))))
    assert res.external_id == "T1" and res.url == "https://x.com/brand/status/T1" and res.detail["thread"] > 1
    tweets = [k for m, u, k in rec.calls if m == "POST" and u.endswith("/2/tweets")]
    assert tweets[0]["json"]["media"]["media_ids"] == ["M1"]
    assert tweets[1]["json"]["reply"]["in_reply_to_tweet_id"] == "T1"
    m = run(c.metrics(["T1"]))["T1"]
    assert m["views"] == 900 and m["shares"] == 4 and m["saves"] == 4


def test_tiktok_file_upload_flow(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from qsm.connectors import tiktok

    rec = Recorder([
        ("POST", "/creator_info/query/", FakeResp({"data": {"privacy_level_options": ["SELF_ONLY"]}, "error": {"code": "ok"}})),
        ("POST", "/post/publish/video/init/", FakeResp({"data": {"publish_id": "PUB", "upload_url": "https://up.tt/x"},
                                                        "error": {"code": "ok"}})),
        ("PUT", "https://up.tt/x", FakeResp({})),
        ("POST", "/status/fetch/", FakeResp({"data": {"status": "PUBLISH_COMPLETE", "publicaly_available_post_id": [777]},
                                             "error": {"code": "ok"}})),
    ])
    monkeypatch.setattr(tiktok, "request", rec)
    c = tiktok.TikTokConnector({"access_token": "T"})
    res = run(c.publish(OutboundPost(post_id="p", channel="tiktok", format="video", text="وصف",
                                     media=(media(tmp_path, "video", 1000),))))
    assert res.external_id == "777" and res.detail["privacy"] == "SELF_ONLY"
    init = next(k for m, u, k in rec.calls if "video/init" in u)["json"]
    assert init["source_info"] == {"source": "FILE_UPLOAD", "video_size": 1000, "chunk_size": 1000, "total_chunk_count": 1}
    put = next(k for m, u, k in rec.calls if m == "PUT")
    assert put["headers"]["Content-Range"] == "bytes 0-999/1000"


def test_tiktok_api_error_maps_to_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    from qsm.connectors import tiktok

    rec = Recorder([("GET", "/user/info/", FakeResp({"error": {"code": "access_token_invalid", "message": "expired"}}))])
    monkeypatch.setattr(tiktok, "request", rec)
    with pytest.raises(ConnectorError) as err:
        run(tiktok.TikTokConnector({"access_token": "T"}).test())
    assert err.value.auth


def test_linkedin_image_post(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from qsm.connectors import linkedin

    rec = Recorder([
        ("POST", "/images?action=initializeUpload", FakeResp({"value": {"uploadUrl": "https://up.li/1", "image": "urn:li:image:9"}})),
        ("PUT", "https://up.li/1", FakeResp({})),
        ("POST", "/rest/posts", FakeResp({}, headers={"x-restli-id": "urn:li:share:5"})),
    ])
    monkeypatch.setattr(linkedin, "request", rec)
    c = linkedin.LinkedInConnector({"access_token": "T", "author_urn": "urn:li:organization:1"})
    res = run(c.publish(OutboundPost(post_id="p", channel="linkedin", format="post", text="نص", title="عنوان",
                                     media=(media(tmp_path),))))
    assert res.external_id == "urn:li:share:5" and res.url.endswith("urn:li:share:5")
    post = next(k for m, u, k in rec.calls if u.endswith("/rest/posts"))
    assert post["json"]["content"]["media"]["id"] == "urn:li:image:9"
    assert post["headers"]["LinkedIn-Version"] == linkedin.API_VERSION


def test_retired_linkedin_version_falls_back_to_current() -> None:
    from datetime import date

    from qsm.connectors.linkedin import API_VERSION, api_version

    today = date(2026, 10, 12)
    assert api_version("202509", today) == API_VERSION  # retired before 202510
    assert api_version("202510", today) == "202510"  # still served until 2026-10-15
    assert api_version("202606", today) == "202606"
    assert api_version("", today) == API_VERSION
    assert api_version("2026-9", today) == API_VERSION


def test_check_maps_http_errors() -> None:
    import httpx

    from qsm.connectors.base import check

    req = httpx.Request("GET", "https://x")
    with pytest.raises(ConnectorError) as e401:
        check(httpx.Response(401, json={"error": {"message": "bad token"}}, request=req), "P")
    assert e401.value.auth and "bad token" in str(e401.value)
    with pytest.raises(ConnectorError) as e503:
        check(httpx.Response(503, text="busy", request=req), "P")
    assert e503.value.transient
    with pytest.raises(ConnectorError) as e400:
        check(httpx.Response(400, json={"errors": [{"message": "dup"}]}, request=req), "P")
    assert not e400.value.transient and "dup" in str(e400.value)


def test_missing_config_is_reported(env) -> None:
    from qsm.connectors.whatsapp import WhatsAppConnector

    with pytest.raises(ConnectorError) as err:
        run(WhatsAppConnector({}).send(to="1", text="x"))
    assert "phone_number_id" in str(err.value)


def test_email_connector_uses_smtp(monkeypatch: pytest.MonkeyPatch) -> None:
    from qsm.connectors import email

    sent: list[Any] = []

    class FakeSMTP:
        def __init__(self, host: str, port: int, timeout: int):
            self.host = host

        def starttls(self, context: Any) -> None:
            pass

        def login(self, u: str, p: str) -> None:
            pass

        def send_message(self, msg: Any) -> None:
            sent.append(msg)

        def quit(self) -> None:
            pass

    monkeypatch.setattr(email.smtplib, "SMTP", FakeSMTP)
    c = email.EmailConnector({"smtp_host": "smtp.example", "username": "u", "password": "p",
                              "from_address": "mk@example.sa"})
    mid = run(c.send(to="o@example.sa", subject="تقرير", text="نص", html="<b>x</b>"))
    assert mid and sent[0]["To"] == "o@example.sa" and sent[0]["Subject"] == "تقرير"
    assert run(c.test()).handle == "mk@example.sa"
