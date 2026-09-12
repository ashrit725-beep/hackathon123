"""Provider chain: Claude → GPT → Kimi, each with its own key; the chain is exactly what the settings expose."""
from shadowqa import llm
from shadowqa.config import settings


def test_provider_chain_follows_settings_and_keys(monkeypatch):
    monkeypatch.setattr(settings, "primary_model", "anthropic:claude-sonnet-4-6")
    monkeypatch.setattr(settings, "fallback_model", "openai:gpt-5.4")
    monkeypatch.setattr(settings, "tertiary_model", "kimi:kimi-k2.7-code-highspeed")
    monkeypatch.setattr(settings, "anthropic_key", "a")
    monkeypatch.setattr(settings, "openai_key", "o")
    monkeypatch.setattr(settings, "kimi_key", "k")
    monkeypatch.setattr(settings, "emergent_key", "")
    assert llm._providers() == [("anthropic", "claude-sonnet-4-6"), ("openai", "gpt-5.4"), ("kimi", "kimi-k2.7-code-highspeed")]
    assert settings.models == {"primary": "anthropic:claude-sonnet-4-6", "fallback": "openai:gpt-5.4", "tertiary": "kimi:kimi-k2.7-code-highspeed"}

    monkeypatch.setattr(settings, "kimi_key", "")
    assert [p for p, _ in llm._providers()] == ["anthropic", "openai"], "a provider without a key is skipped, never called"
    monkeypatch.setattr(settings, "tertiary_model", "")
    assert settings.models["tertiary"] is None


def test_kimi_session_is_openai_compatible_and_keeps_reasoning(monkeypatch):
    calls: list[dict] = []

    class _Msg:
        content = '{"ok": true}'
        reasoning_content = "thought"
        model_extra = {}

    class _Res:
        choices = [type("C", (), {"message": _Msg()})()]

    class _Completions:
        async def create(self, **kw):
            calls.append(kw)
            return _Res()

    class _Client:
        def __init__(self, **kw):
            calls.append({"init": kw})
            self.chat = type("Chat", (), {"completions": _Completions()})()

    monkeypatch.setattr(llm, "AsyncOpenAI", _Client)
    monkeypatch.setattr(settings, "kimi_key", "k")
    monkeypatch.setattr(settings, "kimi_base_url", "https://api.moonshot.ai/v1")
    send = llm._kimi_session("kimi-k2.7-code-highspeed", "SYS", 7000)
    import asyncio
    assert asyncio.run(send("hello")) == '{"ok": true}'
    assert asyncio.run(send("repair")) == '{"ok": true}'
    init, first, second = calls
    assert init["init"]["base_url"] == "https://api.moonshot.ai/v1" and init["init"]["api_key"] == "k"
    assert first["model"] == "kimi-k2.7-code-highspeed" and first["max_tokens"] == 16000 and "temperature" not in first
    assert first["messages"][0] == {"role": "system", "content": "SYS"}
    assert second["messages"][2] == {"role": "assistant", "content": '{"ok": true}', "reasoning_content": "thought"}
    assert second["messages"][3] == {"role": "user", "content": "repair"}
