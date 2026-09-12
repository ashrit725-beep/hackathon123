"""LLM client with provider fallback (Claude → GPT → Kimi) and strict JSON extraction."""
import json
import re
import time
import uuid

from emergentintegrations.llm.chat import LlmChat, UserMessage
from openai import AsyncOpenAI

from .config import settings
from .db import llm_log, now_iso


class LLMUnavailable(Exception):
    pass


def _providers() -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for spec in settings.model_chain:
        if spec and ":" in spec:
            provider, model = spec.split(":", 1)
            if settings.key_for(provider):
                out.append((provider, model))
    return out


def _llmchat_session(provider: str, model: str, system: str, max_tokens: int):
    """Anthropic / OpenAI through emergentintegrations with the user's own provider key."""
    chat = LlmChat(api_key=settings.key_for(provider), session_id=f"sqa-{uuid.uuid4()}", system_message=system)
    params = {"max_tokens": max_tokens}
    if not (provider == "openai" and model.startswith("gpt-5")):
        params["temperature"] = 0.1  # gpt-5 family accepts only the default temperature
    chat.with_model(provider, model).with_params(**params)

    async def send(text: str) -> str:
        return await chat.send_message(UserMessage(text=text))

    return send


def _kimi_session(model: str, system: str, max_tokens: int):
    """Kimi (Moonshot) through its OpenAI-compatible endpoint; thinking models need headroom and no temperature override."""
    client = AsyncOpenAI(api_key=settings.kimi_key, base_url=settings.kimi_base_url, timeout=180.0, max_retries=1)
    messages: list[dict] = [{"role": "system", "content": system}]

    async def send(text: str) -> str:
        messages.append({"role": "user", "content": text})
        res = await client.chat.completions.create(model=model, messages=messages, max_tokens=max(max_tokens, 16000))
        msg = res.choices[0].message
        content = msg.content or ""
        reasoning = getattr(msg, "reasoning_content", None) or (msg.model_extra or {}).get("reasoning_content")
        # K2.7-code preserves thinking across turns: echo reasoning_content back on the repair round.
        messages.append({"role": "assistant", "content": content, **({"reasoning_content": reasoning} if reasoning else {})})
        return content

    return send


def _session(provider: str, model: str, system: str, max_tokens: int):
    return _kimi_session(model, system, max_tokens) if provider == "kimi" else _llmchat_session(provider, model, system, max_tokens)


def _balanced_objects(text: str) -> list[str]:
    """Top-level {...} spans, scanning with string awareness; longest first."""
    spans: list[str] = []
    depth, start, in_str, esc = 0, -1, False, False
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}" and depth:
            depth -= 1
            if depth == 0 and start >= 0:
                spans.append(text[start:i + 1])
    return sorted(spans, key=len, reverse=True)


def _loads(candidate: str) -> dict:
    try:
        return json.loads(candidate, strict=False)
    except json.JSONDecodeError:
        return json.loads(re.sub(r",\s*([}\]])", r"\1", candidate), strict=False)


def extract_json(text: str) -> dict:
    """Models reason before answering and fence their JSON; accept prose + fences, take the object that parses."""
    text = text.strip()
    candidates: list[str] = []
    fenced = re.findall(r"```(?:json)?\s*([\s\S]*?)```", text)
    candidates.extend(reversed(fenced))  # the final fenced block is the answer
    candidates.append(re.sub(r"^```(?:json)?\s*|\s*```$", "", text))
    candidates.extend(_balanced_objects(text))
    last_error: Exception | None = None
    for cand in candidates:
        cand = cand.strip()
        if not cand.startswith("{"):
            continue
        try:
            data = _loads(cand)
        except (json.JSONDecodeError, ValueError) as exc:
            last_error = exc
            continue
        if isinstance(data, dict):
            return data
    raise ValueError(f"no JSON object in model response ({last_error})" if last_error else "no JSON object in model response")


REPAIR_NOTE = "Your previous reply could not be parsed as JSON ({error}). Reply again with ONLY the JSON object — no prose, no markdown fences."


async def complete_json(system: str, user: str, purpose: str, incident_id: str | None = None, max_tokens: int = 7000) -> tuple[dict, dict]:
    errors: list[str] = []
    for provider, model in _providers():
        started = time.time()
        try:
            send = _session(provider, model, system, max_tokens)
            text = await send(user)
            repaired = False
            try:
                data = extract_json(text)
            except ValueError as parse_exc:
                # One in-conversation repair round with the same provider before falling back to the next one.
                text = await send(REPAIR_NOTE.format(error=str(parse_exc)[:120]))
                data = extract_json(text)
                repaired = True
            meta = {"provider": provider, "model": model, "latency_ms": int((time.time() - started) * 1000),
                    "prompt_chars": len(system) + len(user), "response_chars": len(text), "fallback_used": bool(errors), "repaired": repaired}
            await llm_log.insert_one({"ts": now_iso(), "incident_id": incident_id, "purpose": purpose, **meta, "ok": True})
            return data, meta
        except Exception as exc:  # provider failure → try the next one
            msg = f"{provider}:{model} → {type(exc).__name__}: {str(exc)[:300]}"
            errors.append(msg)
            await llm_log.insert_one({"ts": now_iso(), "incident_id": incident_id, "purpose": purpose, "provider": provider,
                                      "model": model, "ok": False, "error": msg,
                                      "latency_ms": int((time.time() - started) * 1000)})
    raise LLMUnavailable("; ".join(errors) or "no LLM provider configured")
