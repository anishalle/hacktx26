import pytest

from app.services import llm


async def test_complete_json_parses_fences_and_retries(fake_llm: llm.FakeLLM) -> None:
    fake_llm.queue('```json\n{"a": 1}\n```')
    assert await llm.complete_json("sys", "user") == {"a": 1}
    fake_llm.queue("not json at all", 'Sure! {"b": 2} hope that helps')
    assert await llm.complete_json("sys", "user") == {"b": 2}
    assert len(fake_llm.calls) == 3
    assert fake_llm.calls[-1].json_mode is True
    assert fake_llm.calls[-1].effort == "minimal" or fake_llm.calls[-1].effort is None
    fake_llm.queue("nope", "still nope")
    with pytest.raises(llm.LLMError):
        await llm.complete_json("sys", "user")


async def test_complete_text_and_stream(fake_llm: llm.FakeLLM) -> None:
    fake_llm.queue("hello there", ["a", "b", "c"], "one two three")
    assert await llm.complete_text("s", "u", effort="low") == "hello there"
    assert fake_llm.calls[0].effort == "low"
    assert [c async for c in llm.stream_text("s", "u")] == ["a", "b", "c"]
    chunks = [c async for c in llm.stream_text("s", "u")]
    assert "".join(chunks) == "one two three" and len(chunks) == 3
    assert fake_llm.calls[-1].stream is True


async def test_fake_llm_handler_and_errors(fake_llm: llm.FakeLLM) -> None:
    fake_llm.handler = lambda call: {"echo": call.user}
    assert await llm.complete_json("s", "ping") == {"echo": "ping"}
    fake_llm.queue(TimeoutError())
    with pytest.raises(TimeoutError):
        await llm.complete_text("s", "u")


async def test_unexpected_call_fails() -> None:
    with pytest.raises(AssertionError):
        await llm.complete_text("s", "u")
