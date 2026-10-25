"""LLM access: Meta Muse through the OpenAI-compatible Meta Model API.

Muse is a reasoning model: `max_tokens` covers reasoning plus output, so keep it
>= 2000 or `content` comes back empty.

Test seam: every call goes through one backend object. Swap it with
`set_llm_backend(fake)` and restore with `set_llm_backend(None)`. `FakeLLM` below is
a ready-made fake (the `fake_llm` pytest fixture installs one):

    fake_llm.queue({"rewritten": "..."})   # next call returns this (dict -> JSON)
    fake_llm.queue(["Last ", "night..."])  # next stream yields these chunks
    fake_llm.queue(TimeoutError())         # next call raises
    fake_llm.handler = lambda call: {...}  # fallback when the queue is empty
    fake_llm.calls[-1].user                # inspect prompts (LLMCall)
"""

import asyncio
import json
import logging
import re
from collections import deque
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from openai import AsyncOpenAI

from app.core.config import settings

log = logging.getLogger(__name__)


class LLMError(RuntimeError):
    pass


@dataclass
class LLMCall:
    system: str
    user: str
    max_tokens: int
    effort: str | None
    json_mode: bool
    stream: bool = False
    images: list[str] = field(default_factory=list)  # data: URLs sent with `user`


class LLMBackend(Protocol):
    async def complete(self, call: LLMCall) -> str: ...

    def stream(self, call: LLMCall) -> AsyncIterator[str]: ...


def _content(call: LLMCall) -> str | list[dict[str, Any]]:
    if not call.images:
        return call.user
    return [{"type": "text", "text": call.user}] + [
        {"type": "image_url", "image_url": {"url": url}} for url in call.images
    ]


class OpenAIBackend:
    def __init__(self) -> None:
        self._client: AsyncOpenAI | None = None

    @property
    def client(self) -> AsyncOpenAI:
        if self._client is None:
            if not settings.MODEL_API_KEY:
                raise LLMError("MODEL_API_KEY is not set")
            self._client = AsyncOpenAI(
                base_url=settings.MODEL_API_BASE_URL,
                api_key=settings.MODEL_API_KEY,
                timeout=settings.LLM_TIMEOUT_S,
                max_retries=1,
            )
        return self._client

    def _params(self, call: LLMCall) -> dict[str, Any]:
        params: dict[str, Any] = {
            "model": settings.LLM_MODEL,
            "messages": [
                {"role": "system", "content": call.system},
                {"role": "user", "content": _content(call)},
            ],
            "max_tokens": call.max_tokens,
        }
        if call.effort:
            params["reasoning_effort"] = call.effort
        if call.json_mode:
            params["response_format"] = {"type": "json_object"}
        return params

    async def complete(self, call: LLMCall) -> str:
        resp = await self.client.chat.completions.create(**self._params(call))
        choice = resp.choices[0]
        if not choice.message.content:
            raise LLMError(f"empty completion (finish_reason={choice.finish_reason})")
        return choice.message.content

    async def stream(self, call: LLMCall) -> AsyncIterator[str]:
        resp = await self.client.chat.completions.create(
            **self._params(call), stream=True
        )
        async for chunk in resp:
            if chunk.choices and (delta := chunk.choices[0].delta.content):
                yield delta


@dataclass
class FakeLLM:
    """Scripted backend for tests. Queue items: str, dict/list (JSON), list[str]
    (stream chunks), or an Exception to raise."""

    calls: list[LLMCall] = field(default_factory=list)
    responses: deque[Any] = field(default_factory=deque)
    handler: Callable[[LLMCall], Any] | None = None

    def queue(self, *responses: Any) -> "FakeLLM":
        self.responses.extend(responses)
        return self

    def _next(self, call: LLMCall) -> Any:
        self.calls.append(call)
        if self.responses:
            result = self.responses.popleft()
        elif self.handler is not None:
            result = self.handler(call)
        else:
            raise AssertionError(f"FakeLLM got an unexpected call: {call.user[:200]!r}")
        if isinstance(result, BaseException):
            raise result
        return result

    async def complete(self, call: LLMCall) -> str:
        result = self._next(call)
        if isinstance(result, list) and all(isinstance(r, str) for r in result):
            return "".join(result)
        return result if isinstance(result, str) else json.dumps(result)

    async def stream(self, call: LLMCall) -> AsyncIterator[str]:
        result = self._next(call)
        if isinstance(result, list) and all(isinstance(r, str) for r in result):
            chunks = result
        else:
            text = result if isinstance(result, str) else json.dumps(result)
            chunks = re.findall(r"\S+\s*|\s+", text)
        for chunk in chunks:
            yield chunk


_backend: LLMBackend = OpenAIBackend()


def set_llm_backend(backend: LLMBackend | None) -> None:
    """Install a backend (tests); None restores the real Muse client."""
    global _backend
    _backend = backend if backend is not None else OpenAIBackend()


def get_llm_backend() -> LLMBackend:
    return _backend


_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL)


def parse_json(text: str) -> dict[str, Any]:
    """Parse a model reply as a JSON object, tolerating code fences and stray prose."""
    if m := _FENCE.match(text):
        text = m.group(1)
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise
        data = json.loads(text[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError(f"expected a JSON object, got {type(data).__name__}")
    return data


def _effort(effort: str | None) -> str | None:
    return effort if effort is not None else settings.LLM_REASONING_EFFORT


async def complete_json(
    system: str,
    user: str,
    *,
    max_tokens: int = 3000,
    effort: str | None = None,
    images: list[str] | None = None,
) -> dict[str, Any]:
    """JSON-object completion; retries once if the reply doesn't parse."""
    call = LLMCall(
        system, user, max_tokens, _effort(effort), json_mode=True, images=images or []
    )
    for attempt in range(2):
        text = await asyncio.wait_for(
            _backend.complete(call), settings.LLM_TIMEOUT_S + 5
        )
        try:
            return parse_json(text)
        except ValueError as exc:  # JSONDecodeError is a ValueError
            log.warning("LLM JSON parse failed (attempt %d): %s", attempt + 1, exc)
    raise LLMError("model did not return valid JSON")


async def complete_text(
    system: str,
    user: str,
    *,
    max_tokens: int = 3000,
    effort: str | None = None,
    images: list[str] | None = None,
) -> str:
    """Plain-text completion; `images` are data: URLs Muse looks at with `user`."""
    call = LLMCall(
        system, user, max_tokens, _effort(effort), json_mode=False, images=images or []
    )
    return await asyncio.wait_for(_backend.complete(call), settings.LLM_TIMEOUT_S + 5)


async def stream_text(
    system: str,
    user: str,
    *,
    max_tokens: int = 3000,
    effort: str | None = None,
    json_mode: bool = False,
) -> AsyncIterator[str]:
    """Yield content deltas as the model produces them."""
    call = LLMCall(system, user, max_tokens, _effort(effort), json_mode, stream=True)
    async for delta in _backend.stream(call):
        yield delta
