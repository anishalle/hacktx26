import asyncio
import json
import re
import time
from collections.abc import AsyncIterator
from typing import Any

import pytest
from conftest import LoadFixture
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ChunkDigest, Membership
from app.seed import LoadedFixture
from app.services import catchup, digests, llm

USERS = [
    {"id": "aakash", "username": "aakash", "display_name": "Aakash Mehta"},
    {"id": "maya", "username": "maya", "display_name": "Maya Chen"},
    {"id": "priya", "username": "priya", "display_name": "Priya Kapoor"},
    {"id": "out", "username": "out", "display_name": "Outsider"},
]


def chat(
    n: int,
    *,
    priya_join: int = 0,
    maya_read: int | None = None,
    text: Any = None,
    glossary: list[dict] | None = None,
) -> dict:
    """One group "g" of n messages a minute apart; priya joins just before idx
    priya_join; aakash has read everything."""
    span = (n + 1) * 60
    return {
        "users": USERS,
        "groups": [
            {
                "key": "g",
                "name": "G",
                "members": [
                    {
                        "user_id": "aakash",
                        "joined_offset_s": span,
                        "last_read_idx": n - 1,
                    },
                    {
                        "user_id": "maya",
                        "joined_offset_s": span,
                        "last_read_idx": maya_read,
                    },
                    {
                        "user_id": "priya",
                        "joined_offset_s": (n - priya_join) * 60 + 1,
                        "last_read_idx": None,
                    },
                ],
                "messages": [
                    {
                        "idx": i,
                        "sender_id": ("aakash", "maya", "priya")[i % 3],
                        "text": text(i) if text else f"message number {i}",
                        "offset_s": (n - i) * 60,
                    }
                    for i in range(n)
                ],
                "glossary": glossary or [],
            }
        ],
    }


def prompt_ids(call: llm.LLMCall) -> list[int]:
    return [int(x) for x in re.findall(r"\[#(\d+) ", call.user)]


def fake_digest(call: llm.LLMCall) -> dict:
    ids = prompt_ids(call)
    return {
        "events": [
            {
                "text": f"stuff {ids[0]}",
                "start_message_id": ids[0],
                "end_message_id": ids[-1],
            },
            {
                "text": "hallucinated",
                "start_message_id": 999999,
                "end_message_id": 999999,
            },
            {
                "text": "half wrong",
                "start_message_id": ids[-1],
                "end_message_id": 999999,
            },
        ],
        "decisions": [{"text": "no ids"}],
        "open_questions": "not a list",
        "terms": ["Grandma", 3],
        "mood": "chill",
    }


def ndjson(lo: int, hi: int) -> list[str]:
    lines = [
        {
            "type": "bullet",
            "section": "happened",
            "text": "They planned Saturday.",
            "start_message_id": lo,
            "end_message_id": lo + 5,
        },
        {
            "type": "bullet",
            "section": "decisions",
            "text": "Going at 8pm.",
            "start_message_id": hi,
            "end_message_id": hi + 1000,
        },
        {
            "type": "bullet",
            "section": "open",
            "text": "Who's driving?",
            "start_message_id": hi,
            "end_message_id": hi,
        },
    ]
    text = "\n".join(json.dumps(x) for x in lines) + "\n"
    return [text[i : i + 7] for i in range(0, len(text), 7)]  # split mid-line


def handler(stream_chunks: list[str] | None = None) -> Any:
    def handle(call: llm.LLMCall) -> Any:
        if call.system == digests.DIGEST_SYSTEM:
            return fake_digest(call)
        if call.stream and stream_chunks is not None:
            return stream_chunks
        raise AssertionError(f"unexpected call: {call.system[:60]}")

    return handle


def parse_sse(body: str) -> list[tuple[str, dict]]:
    assert body.endswith("\n\n")
    frames = []
    for block in body.strip("\n").split("\n\n"):
        fields = dict(line.split(": ", 1) for line in block.split("\n"))
        frames.append((fields["event"], json.loads(fields["data"])))
    return frames


def digest_count(session: AsyncSession) -> Any:
    return session.scalar(select(func.count()).select_from(ChunkDigest))


@pytest.fixture(autouse=True)
async def _digest_state() -> AsyncIterator[None]:
    digests._failures.clear()
    yield
    for task in list(digests._tasks):
        task.cancel()
    await digests.drain()
    digests._failures.clear()


def digest_calls(calls: list[llm.LLMCall], lo: int) -> int:
    """Digest calls for chunks starting at/after message id lo."""
    return sum(
        c.system == digests.DIGEST_SYSTEM and prompt_ids(c)[0] >= lo for c in calls
    )


def block_heads(prompt: str, m0: int) -> list[tuple[str, int, int]]:
    """(kind, start idx, end idx) of each DIGEST/RAW/GAP block in a reduce prompt."""
    heads = re.findall(r"^(DIGEST|RAW|GAP) #(\d+)-#(\d+)", prompt, re.M)
    return [(k, int(a) - m0, int(b) - m0) for k, a, b in heads]


class ScriptedLLM:
    """Backend with async behaviors: `digest` and `complete` take the call and may
    sleep or raise; `stream` is an async generator function of the call."""

    def __init__(self, digest: Any = None, complete: Any = None, stream: Any = None):
        self.digest, self._complete, self._stream = digest, complete, stream
        self.calls: list[llm.LLMCall] = []
        self.active = self.peak = 0

    async def complete(self, call: llm.LLMCall) -> str:
        self.calls.append(call)
        fn = self.digest if call.system == digests.DIGEST_SYSTEM else self._complete
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            return json.dumps(await fn(call))
        finally:
            self.active -= 1

    def stream(self, call: llm.LLMCall) -> Any:
        self.calls.append(call)
        return self._stream(call)


async def hang(*_: Any) -> Any:
    await asyncio.sleep(3600)


def sse_events(body: str) -> list[tuple[str, dict]]:
    """parse_sse, skipping `: ping` keepalive comments."""
    blocks = [b for b in body.split("\n\n") if b and not b.startswith(":")]
    return parse_sse("\n\n".join(blocks) + "\n\n")


# Digests


async def test_chunk_alignment_backfill_and_idempotency(
    load_fixture: LoadFixture, session: AsyncSession, fake_llm: llm.FakeLLM
) -> None:
    fx = await load_fixture(chat(250))
    gid = fx.group_id("g")
    fake_llm.handler = handler()
    chunks = await digests.pending_chunks(session, gid)
    assert [(c.start_id, c.end_id) for c in chunks] == [
        (fx.msg("g", 0), fx.msg("g", 99)),
        (fx.msg("g", 100), fx.msg("g", 199)),
    ]
    assert await digests.backfill_digests(session, gid) == 2
    rows = list(await session.scalars(select(ChunkDigest).order_by(ChunkDigest.id)))
    first = next(r for r in rows if r.start_message_id == fx.msg("g", 0))
    assert first.end_message_id == fx.msg("g", 99) and first.message_count == 100
    lo, hi = fx.msg("g", 0), fx.msg("g", 99)
    assert first.digest["events"] == [
        {"text": f"stuff {lo}", "start_message_id": lo, "end_message_id": hi},
        {"text": "half wrong", "start_message_id": hi, "end_message_id": hi},
    ]
    assert first.digest["decisions"] == first.digest["open_questions"] == []
    assert first.digest["terms"] == ["Grandma"] and first.digest["mood"] == "chill"
    assert "[#%d " % lo in fake_llm.calls[0].user and "---" in fake_llm.calls[0].user
    assert fake_llm.calls[0].max_tokens >= 2000

    calls = len(fake_llm.calls)
    assert await digests.backfill_digests(session, gid) == 0
    assert len(fake_llm.calls) == calls

    await load_fixture({"groups": [chat(50)["groups"][0] | {"key": "h"}]})
    assert await digests.backfill_digests(session, gid) == 0  # 250 + 0 new


class SlowDigestLLM:
    def __init__(self, delay: float = 0.02) -> None:
        self.delay, self.active, self.peak, self.calls = delay, 0, 0, 0

    async def complete(self, call: llm.LLMCall) -> str:
        self.calls += 1
        self.active += 1
        self.peak = max(self.peak, self.active)
        await asyncio.sleep(self.delay)
        self.active -= 1
        return json.dumps(fake_digest(call))

    def stream(self, call: llm.LLMCall) -> Any:
        raise AssertionError("no streams here")


async def test_backfill_bounded_concurrency_and_range(
    load_fixture: LoadFixture, session: AsyncSession
) -> None:
    fx = await load_fixture(chat(1050))
    gid = fx.group_id("g")
    slow = SlowDigestLLM()
    llm.set_llm_backend(slow)
    n = await digests.backfill_digests(
        session, gid, min_id=fx.msg("g", 150), max_id=fx.msg("g", 1049)
    )
    assert n == 8 and slow.calls == 8  # chunks 2..9; chunk 1 straddles min_id
    assert await digests.backfill_digests(session, gid) == 2  # chunks 0 and 1
    assert slow.peak == digests.CONCURRENCY


async def test_schedule_digest_dedupes_and_does_not_block(
    load_fixture: LoadFixture, session: AsyncSession, client: AsyncClient
) -> None:
    fx = await load_fixture(chat(99))
    gid = fx.group_id("g")
    slow = SlowDigestLLM(delay=0.2)
    llm.set_llm_backend(slow)
    resp = await client.post(
        f"/api/v1/groups/{gid}/messages", json={"sender_id": "maya", "text": "100th"}
    )
    assert resp.status_code == 201
    for _ in range(5):
        digests.schedule_digest(gid)
    assert len(digests._tasks) == 1 and slow.calls <= 1
    assert await digest_count(session) == 0  # still running in the background
    await digests.drain()
    assert slow.calls == 1 and await digest_count(session) == 1
    assert not digests._active and not digests._tasks


# Range resolution


async def test_since_resolution(
    load_fixture: LoadFixture, session: AsyncSession
) -> None:
    fx = await load_fixture(chat(30, priya_join=10, maya_read=19))
    gid, m = fx.group_id("g"), lambda i: fx.msg("g", i)

    maya = await catchup.resolve_range(session, gid, "maya")
    assert (maya.since_message_id, maya.lo, maya.until) == (m(19), m(20), m(29))
    assert maya.unread_count == 7  # 20..29 minus maya's own (22, 25, 28)

    priya = await catchup.resolve_range(session, gid, "priya")
    assert (priya.since_message_id, priya.lo, priya.until) == (m(10), m(10), m(29))
    assert priya.unread_count == 20 - 7  # her own: 11, 14, ..., 29

    explicit = await catchup.resolve_range(session, gid, "priya", m(25))
    assert (explicit.lo, explicit.until) == (m(26), m(29))

    aakash = await catchup.resolve_range(session, gid, "aakash")
    assert aakash.empty and aakash.unread_count == 0 and aakash.until == m(29)

    with pytest.raises(Exception, match="not a member"):
        await catchup.resolve_range(session, gid, "out")


async def test_preview(client: AsyncClient, load_fixture: LoadFixture) -> None:
    fx = await load_fixture(chat(120, priya_join=40, maya_read=100))
    gid = fx.group_id("g")
    url = f"/api/v1/groups/{gid}/catchup/preview"
    priya = (await client.get(url, params={"user_id": "priya"})).json()
    assert priya == {
        "unread_count": 80 - 27,
        "since_message_id": fx.msg("g", 40),
        "eligible": True,
    }
    maya = (await client.get(url, params={"user_id": "maya"})).json()
    assert maya["since_message_id"] == fx.msg("g", 100) and maya["eligible"] is False
    assert (await client.get(url, params={"user_id": "out"})).status_code == 403
    assert (await client.get(url)).status_code == 422


# Parsing and validation


def test_json_object_stream_handles_split_lines() -> None:
    text = (
        '```json\n{"a": "x}{\\"y", "n": 1}\n'
        '{"b": {"nested": [1, 2]}}{"c": 3}\nsome prose\n{bad json}\n{"d": "é"}\n```'
    )
    for size in (1, 3, 7, len(text)):
        parser = catchup.JsonObjectStream()
        out = []
        for i in range(0, len(text), size):
            out += parser.feed(text[i : i + size])
        assert out == [
            {"a": 'x}{"y', "n": 1},
            {"b": {"nested": [1, 2]}},
            {"c": 3},
            {"d": "é"},
        ]
    parser = catchup.JsonObjectStream()
    assert parser.feed('{"type": "bullet", "te') == []
    assert parser.feed('xt": "hi"}\n{"type"') == [{"type": "bullet", "text": "hi"}]


def _rng(lo: int = 100, until: int = 200) -> catchup.CatchupRange:
    from datetime import UTC, datetime

    return catchup.CatchupRange(1, "priya", datetime.now(UTC), None, lo, lo, until, 50)


def test_bullet_filter_clamps_and_limits() -> None:
    filt = catchup.BulletFilter(_rng())
    out = []
    objs: list[dict] = [
        {
            "section": "happened",
            "text": "ok",
            "start_message_id": 120,
            "end_message_id": 130,
        },
        {
            "section": "happened",
            "text": "swap",
            "start_message_id": 9999,
            "end_message_id": 5,
        },
        {"section": "events", "text": "alias", "start_message_id": "#150"},
        {"section": "decisions", "text": "no ids"},
        {"section": "nonsense", "text": "dropped", "start_message_id": 120},
        {"section": "open", "text": "  "},
        {"type": "note", "text": "not a bullet"},
        {"section": "happened", "text": "OK", "start_message_id": 120},
        {"bullets": [{"section": "open", "text": "wrapped", "start_message_id": 101}]},
    ]
    objs += [{"section": "happened", "text": f"more {i}"} for i in range(10)]
    for obj in objs:
        out += list(filt.accept(obj))
    got = [(b.section, b.text, b.start_message_id, b.end_message_id) for b in out]
    assert got[:5] == [
        ("happened", "ok", 120, 130),
        ("happened", "swap", 100, 200),
        ("happened", "alias", 150, 150),
        ("decisions", "no ids", 200, 200),
        ("open", "wrapped", 101, 101),
    ]
    assert sum(1 for b in out if b.section == "happened") == 6


# Terms


async def test_missed_terms_rule(
    load_fixture: LoadFixture, session: AsyncSession
) -> None:
    texts = {
        2: "grandma's tonight",
        5: "Sideout means the bar",
        12: "grandma's again",
        14: "the usual spot then grandmas",
        15: "sideout after?",
        16: "usual place",
        17: "sideout!",
        18: "GRANDMA",
        19: "mike moment",
    }
    gloss = [
        {
            "term": "Grandma",
            "aliases": ["grandma's", "grandmas"],
            "meaning": "Swayam's",
            "kind": "nickname",
            "first_seen_idx": 1,
            "last_explained_idx": 2,
        },
        {
            "term": "usual spot",
            "aliases": ["usual place"],
            "meaning": "back lot",
            "kind": "place",
            "first_seen_idx": 3,
        },
        {
            "term": "Sideout",
            "meaning": "the bar",
            "kind": "place",
            "first_seen_idx": 4,
            "last_explained_idx": 5,
        },
        {
            "term": "unused",
            "meaning": "never used",
            "kind": "slang",
            "first_seen_idx": 0,
        },
        {
            "term": "mike moment",
            "meaning": "bailing",
            "kind": "inside_joke",
            "first_seen_idx": 13,
        },
    ]
    fx = await load_fixture(
        chat(20, priya_join=10, text=lambda i: texts.get(i, f"m{i}"), glossary=gloss)
    )
    gid = fx.group_id("g")
    priya = await catchup.resolve_range(session, gid, "priya")
    terms = await catchup.missed_terms(session, priya)
    # Grandma x3, usual spot x2, Sideout x2 (both explained before she joined);
    # "unused" not in range; "mike moment" was introduced after she joined.
    assert [t.term for t in terms] == ["Grandma", "usual spot", "Sideout"]
    assert terms[0].glossary_id == fx.groups["g"].glossary_ids["Grandma"]
    assert terms[0].meaning == "Swayam's"
    maya = await catchup.resolve_range(session, gid, "maya")
    assert await catchup.missed_terms(session, maya) == []  # she was there


# POST /catchup


async def test_catchup_sse_stream(
    client: AsyncClient,
    load_fixture: LoadFixture,
    session: AsyncSession,
    fake_llm: llm.FakeLLM,
) -> None:
    gloss = [
        {
            "term": "Grandma",
            "meaning": "Swayam's house",
            "kind": "nickname",
            "first_seen_idx": 0,
        },
    ]
    fx = await load_fixture(
        chat(
            330,
            priya_join=30,
            text=lambda i: "grandma tonight" if i % 50 == 0 else f"m{i}",
            glossary=gloss,
        )
    )
    gid, m = fx.group_id("g"), lambda i: fx.msg("g", i)
    fake_llm.handler = handler()
    assert await digests.backfill_digests(session, gid) == 3
    fake_llm.handler = handler(ndjson(m(30), m(329)))
    calls = len(fake_llm.calls)

    resp = await client.post(
        "/api/v1/catchup", json={"group_id": gid, "user_id": "priya"}
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert resp.headers["cache-control"] == "no-cache"
    assert resp.headers["x-accel-buffering"] == "no"
    frames = parse_sse(resp.text)
    names = [e for e, _ in frames]
    assert names == ["meta", "bullet", "bullet", "bullet", "term", "done"]
    assert frames[0][1] == {
        "unread_count": 300 - 100,
        "since_message_id": m(30),
        "until_message_id": m(329),
    }
    assert frames[1][1] == {
        "section": "happened",
        "text": "They planned Saturday.",
        "start_message_id": m(30),
        "end_message_id": m(35),
    }
    assert frames[2][1]["end_message_id"] == m(329)  # clamped
    assert frames[4][1] == {
        "term": "Grandma",
        "glossary_id": fx.groups["g"].glossary_ids["Grandma"],
        "meaning": "Swayam's house",
    }
    assert isinstance(frames[5][1]["elapsed_ms"], int)

    assert len(fake_llm.calls) == calls + 1  # just the reduce
    reduce = fake_llm.calls[-1]
    assert reduce.stream and reduce.system == catchup.REDUCE_SYSTEM
    assert reduce.user.count("DIGEST #") == 2  # chunks 1, 2 (chunk 0 straddles)
    assert f"RAW #{m(30)}-#{m(99)}" in reduce.user  # head of the straddling chunk
    assert f"RAW #{m(300)}-#{m(329)}" in reduce.user  # undigested tail
    assert f"[#{m(29)} " not in reduce.user
    assert "Grandma: Swayam's house" in reduce.user and "Priya Kapoor" in reduce.user

    priya = await session.get(Membership, (gid, "priya"))
    assert priya is not None and priya.last_read_message_id is None


async def test_catchup_stream_false_and_json_fallback(
    client: AsyncClient, load_fixture: LoadFixture, fake_llm: llm.FakeLLM
) -> None:
    fx = await load_fixture(chat(60, priya_join=0))
    gid, m = fx.group_id("g"), lambda i: fx.msg("g", i)
    fake_llm.queue(
        ["Sorry, here you go: no json"],
        {
            "bullets": [
                {
                    "section": "happened",
                    "text": "Stuff.",
                    "start_message_id": m(3),
                    "end_message_id": m(9),
                }
            ]
        },
    )
    resp = await client.post(
        "/api/v1/catchup?stream=false", json={"group_id": gid, "user_id": "priya"}
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "unread_count": 40,
        "since_message_id": m(0),
        "until_message_id": m(59),
        "bullets": [
            {
                "section": "happened",
                "text": "Stuff.",
                "start_message_id": m(3),
                "end_message_id": m(9),
            }
        ],
        "terms": [],
    }
    assert fake_llm.calls[0].stream and fake_llm.calls[1].json_mode


async def test_catchup_error_event(
    client: AsyncClient, load_fixture: LoadFixture, fake_llm: llm.FakeLLM
) -> None:
    fx = await load_fixture(chat(60))
    gid = fx.group_id("g")
    fake_llm.queue(TimeoutError(), llm.LLMError("down"))
    resp = await client.post(
        "/api/v1/catchup", json={"group_id": gid, "user_id": "priya"}
    )
    frames = parse_sse(resp.text)
    assert [e for e, _ in frames] == ["meta", "error"]
    assert frames[1][1]["message"]
    fake_llm.queue(TimeoutError(), llm.LLMError("down"))
    resp = await client.post(
        "/api/v1/catchup?stream=false", json={"group_id": gid, "user_id": "priya"}
    )
    assert resp.status_code == 502


async def test_catchup_nothing_unread_and_non_member(
    client: AsyncClient, load_fixture: LoadFixture
) -> None:
    fx = await load_fixture(chat(10))
    gid = fx.group_id("g")
    resp = await client.post(
        "/api/v1/catchup", json={"group_id": gid, "user_id": "aakash"}
    )
    assert [e for e, _ in parse_sse(resp.text)] == ["meta", "done"]
    resp = await client.post(
        "/api/v1/catchup", json={"group_id": gid, "user_id": "out"}
    )
    assert resp.status_code == 403


async def test_catchup_digests_missing_range_on_the_fly(
    client: AsyncClient,
    load_fixture: LoadFixture,
    session: AsyncSession,
    fake_llm: llm.FakeLLM,
) -> None:
    fx = await load_fixture(chat(1000, priya_join=50))
    gid, m = fx.group_id("g"), lambda i: fx.msg("g", i)
    failures = iter(range(9))

    def handle(call: llm.LLMCall) -> Any:
        if call.system == digests.DIGEST_SYSTEM:
            if next(failures, None) is not None:  # stored backfill fails entirely
                raise llm.LLMError("flaky")
            return fake_digest(call)
        return ndjson(m(50), m(999))

    fake_llm.handler = handle
    resp = await client.post(
        "/api/v1/catchup?stream=false", json={"group_id": gid, "user_id": "priya"}
    )
    assert resp.status_code == 200 and len(resp.json()["bullets"]) == 3
    assert digest_calls(fake_llm.calls, m(50)) == 9  # failures aren't retried here
    reduce = next(c for c in fake_llm.calls if c.stream)
    assert block_heads(reduce.user, m(0)) == [("GAP", 50, 749), ("RAW", 750, 999)]
    assert (
        f"[#{m(749)} " not in reduce.user and "(700 msgs not included)" in reduce.user
    )

    await digests.drain()  # the scheduled background run skips backed-off chunks
    assert digest_calls(fake_llm.calls, m(50)) == 9
    assert await digest_count(session) == 1  # chunk 0, outside the range

    fake_llm.handler = handler(ndjson(m(50), m(999)))
    resp = await client.post(
        "/api/v1/catchup?stream=false", json={"group_id": gid, "user_id": "priya"}
    )
    assert resp.status_code == 200  # the tap path ignores the backoff
    assert await digest_count(session) == 10  # + the 9 chunks inside the range


async def test_catchup_partial_digests_keep_blocks_ordered(
    client: AsyncClient,
    load_fixture: LoadFixture,
    session: AsyncSession,
    fake_llm: llm.FakeLLM,
) -> None:
    fx = await load_fixture(chat(800, priya_join=50))
    gid, m = fx.group_id("g"), lambda i: fx.msg("g", i)
    failing = {m(200), m(400), m(600)}

    def handle(call: llm.LLMCall) -> Any:
        if call.system == digests.DIGEST_SYSTEM:
            if prompt_ids(call)[0] in failing:
                raise llm.LLMError("flaky")
            return fake_digest(call)
        return ndjson(m(50), m(799))

    fake_llm.handler = handle
    resp = await client.post(
        "/api/v1/catchup?stream=false", json={"group_id": gid, "user_id": "priya"}
    )
    assert resp.status_code == 200
    assert digest_calls(fake_llm.calls, m(50)) == 7
    heads = block_heads(next(c for c in fake_llm.calls if c.stream).user, m(0))
    assert heads == [
        ("GAP", 50, 99),
        ("DIGEST", 100, 199),
        ("GAP", 200, 249),
        ("RAW", 250, 299),
        ("DIGEST", 300, 399),
        ("RAW", 400, 499),
        ("DIGEST", 500, 599),
        ("RAW", 600, 699),
        ("DIGEST", 700, 799),
    ]
    assert all(a[2] < b[1] for a, b in zip(heads, heads[1:], strict=False))
    await digests.drain()
    assert await digest_count(session) == 5  # 4 in range + chunk 0 in the background


async def test_catchup_tap_digests_have_one_budget(
    client: AsyncClient,
    load_fixture: LoadFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fx = await load_fixture(chat(1400, priya_join=50))
    gid, m = fx.group_id("g"), lambda i: fx.msg("g", i)

    async def stream(call: llm.LLMCall) -> AsyncIterator[str]:
        for chunk in ndjson(m(50), m(1399)):
            yield chunk

    backend = ScriptedLLM(digest=hang, stream=stream)
    llm.set_llm_backend(backend)
    monkeypatch.setattr(catchup, "TAP_DIGEST_BUDGET_S", 0.2)
    scheduled: list[int] = []
    monkeypatch.setattr(digests, "schedule_digest", scheduled.append)
    t0 = time.monotonic()
    resp = await client.post(
        "/api/v1/catchup", json={"group_id": gid, "user_id": "priya"}
    )
    elapsed = time.monotonic() - t0
    assert [e for e, _ in sse_events(resp.text)][:2] == ["meta", "bullet"]
    assert elapsed < 2
    assert digest_calls(backend.calls, m(50)) == catchup.TAP_DIGEST_CONCURRENCY
    assert backend.active == 0 and scheduled == [gid]  # cancelled; rest in background
    reduce = next(c for c in backend.calls if c.stream)
    assert block_heads(reduce.user, m(0)) == [("GAP", 50, 1149), ("RAW", 1150, 1399)]


# Reduce deadlines and keepalive


async def _predigested(load_fixture: LoadFixture, session: AsyncSession) -> int:
    fx = await load_fixture(chat(300))
    llm.set_llm_backend(llm.FakeLLM(handler=handler()))
    await digests.backfill_digests(session, fx.group_id("g"))
    return fx.group_id("g")


def _bullet(text: str = "one") -> dict:
    return {"type": "bullet", "section": "happened", "text": text}


async def test_reduce_races_one_shot_when_first_bullet_is_late(
    client: AsyncClient,
    load_fixture: LoadFixture,
    session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gid = await _predigested(load_fixture, session)
    monkeypatch.setattr(catchup, "FIRST_BULLET_S", 0.05)

    async def stalled(call: llm.LLMCall) -> AsyncIterator[str]:
        await hang()
        yield ""

    async def one_shot(call: llm.LLMCall) -> dict:
        return {"bullets": [_bullet("from the one-shot call")]}

    backend = ScriptedLLM(complete=one_shot, stream=stalled)
    llm.set_llm_backend(backend)
    t0 = time.monotonic()
    resp = await client.post(
        "/api/v1/catchup", json={"group_id": gid, "user_id": "priya"}
    )
    frames = sse_events(resp.text)
    assert [e for e, _ in frames] == ["meta", "bullet", "done"]
    assert frames[1][1]["text"] == "from the one-shot call"
    assert time.monotonic() - t0 < 1 and len(backend.calls) == 2


async def test_reduce_stall_after_first_bullet_ends_the_list(
    client: AsyncClient,
    load_fixture: LoadFixture,
    session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gid = await _predigested(load_fixture, session)
    monkeypatch.setattr(catchup, "STREAM_IDLE_S", 0.1)

    async def midhang(call: llm.LLMCall) -> AsyncIterator[str]:
        yield json.dumps(_bullet()) + "\n"
        await hang()

    backend = ScriptedLLM(stream=midhang)
    llm.set_llm_backend(backend)
    t0 = time.monotonic()
    resp = await client.post(
        "/api/v1/catchup", json={"group_id": gid, "user_id": "priya"}
    )
    assert [e for e, _ in sse_events(resp.text)] == ["meta", "bullet", "done"]
    assert time.monotonic() - t0 < 1 and len(backend.calls) == 1


async def test_reduce_gives_up_at_the_cap_with_keepalives(
    client: AsyncClient,
    load_fixture: LoadFixture,
    session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gid = await _predigested(load_fixture, session)
    for name, value in (
        ("FIRST_BULLET_S", 0.05),
        ("FALLBACK_TIMEOUT_S", 0.1),
        ("REDUCE_TIMEOUT_S", 0.3),
        ("KEEPALIVE_S", 0.04),
    ):
        monkeypatch.setattr(catchup, name, value)

    async def stalled(call: llm.LLMCall) -> AsyncIterator[str]:
        await hang()
        yield ""

    backend = ScriptedLLM(complete=hang, stream=stalled)
    llm.set_llm_backend(backend)
    t0 = time.monotonic()
    resp = await client.post(
        "/api/v1/catchup", json={"group_id": gid, "user_id": "priya"}
    )
    assert [e for e, _ in sse_events(resp.text)] == ["meta", "error"]
    assert 0.25 < time.monotonic() - t0 < 1.5 and len(backend.calls) == 2
    assert resp.text.count(": ping\n\n") >= 3


# Background backoff


async def test_background_digest_failures_back_off(
    client: AsyncClient, load_fixture: LoadFixture, session: AsyncSession
) -> None:
    fx = await load_fixture(chat(300))
    gid = fx.group_id("g")

    async def down(call: llm.LLMCall) -> Any:
        raise llm.LLMError("down")

    backend = ScriptedLLM(digest=down)
    llm.set_llm_backend(backend)

    async def send(text: str) -> None:
        resp = await client.post(
            f"/api/v1/groups/{gid}/messages", json={"sender_id": "maya", "text": text}
        )
        assert resp.status_code == 201
        await digests.drain()

    for i in range(5):
        await send(f"new {i}")
    assert len(backend.calls) == 3  # one attempt per chunk, then backed off
    first = fx.msg("g", 0)
    assert digests._failures[(gid, first)][0] == 1

    digests._failures.update(
        {k: (n, 0.0) for k, (n, _) in digests._failures.items()}
    )  # backoff elapsed
    await send("later")
    assert len(backend.calls) == 6
    n, retry_at = digests._failures[(gid, first)]
    assert n == 2 and retry_at - time.monotonic() > digests.BACKOFF_S * 1.5

    backend.digest = lambda call: asyncio.sleep(0, fake_digest(call))
    assert await digests.backfill_digests(session, gid) == 3  # explicit runs retry
    assert not digests._failures


# POST /catchup/ask


async def test_catchup_ask(
    client: AsyncClient, load_fixture: LoadFixture, fake_llm: llm.FakeLLM
) -> None:
    texts = {5: "who is driving on saturday?", 40: "dinner at grandma's", 7: "driving!"}
    fx = await load_fixture(
        chat(80, priya_join=3, text=lambda i: texts.get(i, f"filler {i}"))
    )
    gid, m = fx.group_id("g"), lambda i: fx.msg("g", i)
    fake_llm.queue(
        {
            "answer": "Nobody has said yet.",
            "sources": [
                {"start_message_id": m(5), "end_message_id": m(7)},
                {"start_message_id": 999999, "end_message_id": 999999},
                {"start_message_id": m(5), "end_message_id": m(7)},
                "junk",
            ],
        }
    )
    resp = await client.post(
        "/api/v1/catchup/ask",
        json={
            "group_id": gid,
            "user_id": "priya",
            "question": "Who's driving Saturday?",
        },
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "answer": "Nobody has said yet.",
        "sources": [{"start_message_id": m(5), "end_message_id": m(7)}],
    }
    call = fake_llm.calls[-1]
    assert call.json_mode and "Who's driving Saturday?" in call.user
    assert f"[#{m(5)} " in call.user and f"[#{m(7)} " in call.user  # FTS hits
    assert f"[#{m(79)} " in call.user and f"[#{m(40)} " not in call.user
    empty = await client.post(
        "/api/v1/catchup/ask",
        json={"group_id": gid, "user_id": "priya", "question": "  "},
    )
    assert empty.status_code == 422


async def test_catchup_on_sample(
    client: AsyncClient, sample: LoadedFixture, fake_llm: llm.FakeLLM
) -> None:
    gid = sample.group_id("volleyball")
    fake_llm.handler = handler(ndjson(sample.msg("volleyball", 44), 0))
    resp = await client.post(
        "/api/v1/catchup?stream=false", json={"group_id": gid, "user_id": "priya"}
    )
    body = resp.json()
    assert body["since_message_id"] == sample.msg("volleyball", 44)
    assert [t["term"] for t in body["terms"]] == ["Grandma", "usual spot"]
