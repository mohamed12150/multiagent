"""The live Claude path with a fake SDK client: request shape (model, effort, structured output, fallbacks, caching),
web research two-step, refusal and error mapping."""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest


class FakeStream:
    def __init__(self, msg: Any):
        self.msg = msg

    async def __aenter__(self) -> FakeStream:
        return self

    async def __aexit__(self, *a: Any) -> None:
        return None

    async def get_final_message(self) -> Any:
        return self.msg


def message(text: str = "", *, stop: str = "end_turn", blocks: list[Any] | None = None, searches: int = 0) -> Any:
    content = blocks if blocks is not None else [SimpleNamespace(type="text", text=text)]
    usage = SimpleNamespace(input_tokens=1000, output_tokens=500, cache_read_input_tokens=200,
                            cache_creation_input_tokens=0, server_tool_use=SimpleNamespace(web_search_requests=searches))
    return SimpleNamespace(content=content, stop_reason=stop, usage=usage, model="claude-opus-5-5")


class FakeClient:
    def __init__(self, replies: list[Any]):
        self.replies = replies
        self.calls: list[dict[str, Any]] = []
        outer = self

        class Messages:
            def stream(self, **kw: Any) -> FakeStream:
                outer.calls.append({"beta": False, **kw})
                return FakeStream(outer.replies.pop(0))

        class BetaMessages:
            def stream(self, **kw: Any) -> FakeStream:
                outer.calls.append({"beta": True, **kw})
                reply = outer.replies.pop(0)
                if isinstance(reply, Exception):
                    raise reply
                return FakeStream(reply)

        self.messages = Messages()
        self.beta = SimpleNamespace(messages=BetaMessages())


@pytest.fixture()
def live(env, monkeypatch: pytest.MonkeyPatch):
    from qsm import db, vault
    from qsm.ai import client
    from qsm.models import Connection

    with db.session() as s:
        vault.put(s, "anthropic.api_key", "sk-ant-test-1111")
        s.get(Connection, "anthropic").mode = "live"

    def install(replies: list[Any]) -> FakeClient:
        fake = FakeClient(replies)
        monkeypatch.setattr(client, "_client", lambda key: fake)
        return fake
    return install


def gen(**kw: Any) -> Any:
    from qsm.ai import client

    base = {"agent_id": "ceo", "model": "claude-opus-5-5", "effort": "high", "system_static": "ثابت",
            "system_dynamic": "متغير", "prompt": "اقترح", "simulate": lambda: {"never": True}}
    return asyncio.run(client.generate(**{**base, **kw}))


def test_structured_call_shape(live) -> None:
    fake = live([message(json.dumps({"reply": "تم"}))])
    res = gen(schema={"type": "object", "properties": {"reply": {"type": "string"}}}, max_tokens=2000)
    assert res.data == {"reply": "تم"} and not res.simulated
    call = fake.calls[0]
    assert call["beta"] is True and call["fallbacks"] == "default" and call["betas"] == ["server-side-fallback-2026-07-01"]
    assert call["model"] == "claude-opus-5-5" and "thinking" not in call and "temperature" not in call
    assert call["output_config"]["effort"] == "high"
    fmt = call["output_config"]["format"]
    assert fmt["type"] == "json_schema" and fmt["schema"]["additionalProperties"] is False
    assert call["max_tokens"] == 2000 + 8000  # visible budget + thinking headroom for "high"
    assert call["system"][0]["cache_control"] == {"type": "ephemeral"} and call["system"][1]["text"] == "متغير"
    assert res.cost_usd == pytest.approx((1000 * 4 + 500 * 20 + 200 * 0.2) / 1e6)


def test_fallbacks_off_uses_plain_endpoint(live) -> None:
    from qsm import db, settings

    with db.session() as s:
        settings.put(s, "ai", {"web_research": True, "fallbacks": False})
    fake = live([message("نص")])
    assert gen().text == "نص"
    assert fake.calls[0]["beta"] is False


def test_bad_request_with_fallbacks_retries_without(live) -> None:
    import anthropic
    import httpx

    err = anthropic.BadRequestError("bad", response=httpx.Response(400, request=httpx.Request("POST", "https://a")),
                                    body=None)
    fake = live([err, message("ok")])
    assert gen().text == "ok"
    assert [c["beta"] for c in fake.calls] == [True, False]


def test_web_research_is_a_separate_first_call(live) -> None:
    search_block = SimpleNamespace(type="web_search_tool_result",
                                   content=[SimpleNamespace(url="https://news.example/sa", title="خبر")])
    research = message(blocks=[search_block, SimpleNamespace(type="text", text="نتائج البحث")], searches=3)
    final = message(json.dumps({"ok": True}))
    fake = live([research, final])
    res = gen(schema={"type": "object", "properties": {"ok": {"type": "boolean"}}}, web_search=True)
    assert res.sources == ({"url": "https://news.example/sa", "title": "خبر"},) and res.web_searches == 3
    assert fake.calls[0]["tools"][0]["type"] == "web_search_20260209" and "format" not in fake.calls[0]["output_config"]
    assert "<untrusted>" in fake.calls[1]["messages"][0]["content"] and "tools" not in fake.calls[1]


def test_pause_turn_is_resumed(live) -> None:
    paused = message(blocks=[SimpleNamespace(type="text", text="…")], stop="pause_turn")
    done = message(blocks=[SimpleNamespace(type="text", text="خلاصة")])
    fake = live([paused, done, message("{}")])
    gen(schema={"type": "object", "properties": {}}, web_search=True)
    second = fake.calls[1]["messages"]
    assert second[-1]["role"] == "assistant" and len(second) == 2  # resumed without a new user turn


def test_refusal_and_truncation(live) -> None:
    from qsm.ai import client

    live([message("", stop="refusal")])
    with pytest.raises(client.AIRefusal):
        gen()
    live([message('{"cut": ')])
    with pytest.raises(client.AIError) as err:
        gen(schema={"type": "object", "properties": {"cut": {"type": "string"}}})
    assert err.value.transient


def test_error_mapping() -> None:
    import anthropic
    import httpx

    from qsm.ai.client import _map_error

    req = httpx.Request("POST", "https://a")
    assert "غير صالح" in str(_map_error(anthropic.AuthenticationError("x", response=httpx.Response(401, request=req), body=None)))
    assert _map_error(anthropic.RateLimitError("x", response=httpx.Response(429, request=req), body=None)).transient
    assert _map_error(anthropic.APIConnectionError(request=req)).transient
    assert _map_error(anthropic.InternalServerError("x", response=httpx.Response(500, request=req), body=None)).transient
