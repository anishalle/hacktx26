from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models import Glossary, Message, MessageWindow, User
from app.seed import LoadedFixture
from app.services import embeddings, explain, llm, nudge
from tests.conftest import LoadFixture, WsConnect

URL = "/api/v1"


@pytest.fixture(autouse=True)
def _clear_nudge_caches() -> Iterator[None]:
    nudge.invalidate_glossary()  # group ids repeat across tests (RESTART IDENTITY)
    yield
    nudge.invalidate_glossary()


async def _explain(client: AsyncClient, **body: Any) -> dict[str, Any]:
    resp = await client.post(f"{URL}/explain", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _ctx(
    ids: list[int], glossary: dict[int, list[int]] | None = None
) -> explain.Context:
    return explain.Context(
        group_id=1,
        user_id="priya",
        message_id=99,
        sender_id="swayam",
        term=None,
        candidates=["Grandma"],
        prompt="",
        message_ids=ids,
        glossary=glossary or {},
    )


# ------------------------------------------------------------------ grounding


@pytest.mark.parametrize(
    "raw",
    [
        {"meaning": "An uncited guess", "confidence": 0.9, "kind": "place"},
        {
            "meaning": "Cites a message outside the context",
            "confidence": 0.9,
            "kind": "place",
            "source_message_ids": [12345],
        },
        {
            "meaning": "Someone else's private answer",
            "confidence": 0.9,
            "kind": "place",
            "ask_ids": [7],
        },
        {
            "meaning": "Low confidence",
            "confidence": 0.3,
            "kind": "place",
            "source_message_ids": [1],
        },
        {"meaning": "", "confidence": 0.9, "kind": "place", "source_message_ids": [1]},
        {"meaning": "x", "confidence": "high", "kind": "bogus"},
    ],
)
def test_unsupported_answers_become_honest_unknown(raw: dict[str, Any]) -> None:
    g = explain.ground(raw, _ctx([1]), set())
    assert (g.status, g.kind) == ("unknown", "unknown")
    assert g.message_ids == g.glossary_ids == g.ask_ids == []
    assert g.meaning == explain.UNKNOWN_MEANING
    assert g.term == "Grandma"  # still known, so the sheet can offer an ask


def test_grounded_plain_and_general_answers() -> None:
    g = explain.ground(
        {
            "term": "Grandma",
            "meaning": "**Grandma** is Swayam's house.",
            "confidence": 0.9,
            "kind": "nickname",
            "source_message_ids": [1, "#2", 12345, 1],
            "glossary_ids": [5],
        },
        _ctx([1, 2], {5: [1]}),
        set(),
    )
    assert (g.status, g.message_ids, g.glossary_ids) == ("explained", [1, 2], [5])

    plain = explain.ground(
        {"meaning": "They'll see you at 7.", "confidence": 0.95, "kind": "plain"},
        _ctx([]),
        set(),
    )
    assert (plain.status, plain.term) == ("plain", None)

    general = explain.ground(
        {
            "meaning": "Slang for cool.",
            "confidence": 0.8,
            "kind": "slang",
            "general": True,
        },
        _ctx([]),
        set(),
    )
    assert general.status == "general"

    follow = explain.ground(
        {"meaning": "", "kind": "unknown"}, _ctx([]), set(), follow_up=True
    )
    assert follow.meaning == explain.UNKNOWN_FOLLOW_UP


# -------------------------------------------------------------------- explain


async def test_explain_grounds_answer_in_history(
    client: AsyncClient,
    session: AsyncSession,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
) -> None:
    gid = sample.group_id("volleyball")
    pressed = sample.msg("volleyball", 36)  # "grandma's movie night friday? ..."
    canon = sample.msg("volleyball", 13)  # "ok from now on swayam's house = Grandma"
    grandma = await session.scalar(select(Glossary).where(Glossary.term == "Grandma"))
    assert grandma is not None

    def answer(call: llm.LLMCall) -> dict[str, Any]:
        assert f">> [#{pressed} " in call.user
        assert f"[G{grandma.id}] Grandma" in call.user
        assert f"[#{canon} " in call.user  # glossary source + definitional hit
        assert "EXPLAINING TO: Priya" in call.user
        return {
            "term": "Grandma",
            "meaning": "**Grandma's** is Swayam's house. Movie night is there Friday.",
            "kind": "nickname",
            "confidence": 0.92,
            "source_message_ids": [canon, pressed],
            "glossary_ids": [grandma.id],
        }

    fake_llm.handler = answer
    out = await _explain(client, group_id=gid, user_id="priya", message_id=pressed)
    assert out["status"] == "explained"
    assert out["term"] == "Grandma"
    assert out["ask"] is None and out["person"] is None
    ids = [m["id"] for m in out["sources"]]
    assert canon in ids and pressed not in ids  # the pressed message isn't evidence
    assert ids == sorted(ids) and len(ids) <= explain.MAX_SOURCES


async def test_unknown_offers_to_ask_the_sender(
    client: AsyncClient, sample: LoadedFixture, fake_llm: llm.FakeLLM
) -> None:
    gid = sample.group_id("volleyball")
    pressed = sample.msg("volleyball", 36)
    fake_llm.queue({"term": "movie night", "meaning": "?", "kind": "unknown"})
    out = await _explain(client, group_id=gid, user_id="priya", message_id=pressed)
    assert out["status"] == "unknown"
    assert out["sources"] == []
    assert out["ask"]["user"]["id"] == "swayam"
    assert out["ask"]["existing"] is None


async def test_plain_message_and_term_only(
    client: AsyncClient, sample: LoadedFixture, fake_llm: llm.FakeLLM
) -> None:
    gid = sample.group_id("volleyball")
    fake_llm.queue({"meaning": "Aakash agrees.", "kind": "plain", "confidence": 0.9})
    out = await _explain(
        client, group_id=gid, user_id="priya", message_id=sample.msg("volleyball", 30)
    )
    assert (out["status"], out["term"], out["ask"]) == ("plain", None, None)

    fake_llm.queue({"meaning": "The back lot.", "kind": "place", "confidence": 0.1})
    out = await _explain(client, group_id=gid, user_id="priya", term="usual spot")
    assert out["message_id"] is None
    assert "TERM: usual spot" in fake_llm.calls[-1].user
    assert out["status"] == "unknown"
    # no sender: the member who uses the term most gets asked
    assert out["ask"]["user"]["id"] == "aakash"


async def test_follow_up_reuses_context_and_is_private(
    client: AsyncClient, sample: LoadedFixture, fake_llm: llm.FakeLLM
) -> None:
    gid = sample.group_id("volleyball")
    canon = sample.msg("volleyball", 13)
    fake_llm.queue(
        {
            "term": "Grandma",
            "meaning": "**Grandma** is Swayam's house.",
            "kind": "nickname",
            "confidence": 0.9,
            "source_message_ids": [canon],
        },
        {
            "term": "Grandma",
            "meaning": "Because of the plastic-covered couches.",
            "kind": "nickname",
            "confidence": 0.9,
            "source_message_ids": [canon],
        },
    )
    first = await _explain(
        client, group_id=gid, user_id="priya", message_id=sample.msg("volleyball", 36)
    )
    second = await _explain(
        client,
        group_id=gid,
        user_id="priya",
        explanation_id=first["explanation_id"],
        follow_up="why is it called that?",
    )
    assert second["follow_up"] == "why is it called that?"
    assert second["message_id"] == first["message_id"]
    assert second["explanation_id"] != first["explanation_id"]
    prompt = fake_llm.calls[-1].user
    assert fake_llm.calls[0].user in prompt  # same context snapshot
    assert "FOLLOW-UP QUESTION: why is it called that?" in prompt

    resp = await client.post(
        f"{URL}/explain",
        json={
            "group_id": gid,
            "user_id": "maya",
            "explanation_id": first["explanation_id"],
            "follow_up": "what?",
        },
    )
    assert resp.status_code == 404


async def test_explain_validation(client: AsyncClient, sample: LoadedFixture) -> None:
    gid = sample.group_id("volleyball")
    cases = [
        ({"group_id": gid, "user_id": "priya"}, 422),
        ({"group_id": gid, "user_id": "priya", "follow_up": "and?"}, 422),
        ({"group_id": gid, "user_id": "priya", "message_id": 999999}, 404),
        (
            {
                "group_id": gid,
                "user_id": "priya",
                "message_id": sample.msg("volleyball", 0),
            },
            422,
        ),
        ({"group_id": gid, "user_id": "nobody", "term": "x"}, 403),
    ]
    for body, status in cases:
        resp = await client.post(f"{URL}/explain", json=body)
        assert resp.status_code == status, (body, resp.text)


async def test_model_failure_is_502(
    client: AsyncClient, sample: LoadedFixture, fake_llm: llm.FakeLLM
) -> None:
    fake_llm.handler = lambda call: llm.LLMError("boom")
    resp = await client.post(
        f"{URL}/explain",
        json={
            "group_id": sample.group_id("volleyball"),
            "user_id": "priya",
            "term": "x",
        },
    )
    assert resp.status_code == 502


# ----------------------------------------------------------------------- asks


async def test_ask_answer_in_chat_round_trip(
    client: AsyncClient,
    session: AsyncSession,
    ws_connect: WsConnect,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
) -> None:
    gid = sample.group_id("volleyball")
    pressed = sample.msg("volleyball", 36)
    body = {
        "group_id": gid,
        "user_id": "priya",
        "term": "movie night",
        "message_id": pressed,
    }

    async with ws_connect("swayam") as swayam, ws_connect("priya") as priya:
        resp = await client.post(f"{URL}/ask-member", json=body)
        assert resp.status_code == 201, resp.text
        ask = resp.json()
        assert (ask["asked_user"]["id"], ask["for_user"]["id"]) == ("swayam", "priya")
        assert ask["status"] == "pending" and ask["message"]["id"] == pressed
        frame = await swayam.receive_json(timeout=2)
        assert (frame["type"], frame["data"]["id"]) == ("ask.new", ask["id"])

        again = await client.post(f"{URL}/ask-member", json=body)
        assert again.json()["id"] == ask["id"]  # still pending: same ask

        listed = (await client.get(f"{URL}/users/swayam/asks")).json()
        assert [a["id"] for a in listed["incoming"]] == [ask["id"]]
        assert listed["outgoing"] == []

        answer_url = f"{URL}/ask-member/{ask['id']}/answer"
        wrong = await client.post(answer_url, json={"user_id": "priya", "answer": "x"})
        assert wrong.status_code == 404
        empty = await client.post(answer_url, json={"user_id": "swayam", "answer": " "})
        assert empty.status_code == 422

        resp = await client.post(
            answer_url,
            json={
                "user_id": "swayam",
                "answer": "we watch a movie at my place on fridays",
                "post_in_chat": True,
            },
        )
        assert resp.status_code == 200, resp.text
        done = resp.json()
        assert done["status"] == "answered" and done["answered_at"]

        frames = [await priya.receive_json(timeout=2) for _ in range(2)]
        assert {f["type"] for f in frames} == {"message.new", "ask.updated"}
        posted = next(f["data"] for f in frames if f["type"] == "message.new")
        assert posted["id"] == done["posted_message_id"]
        assert (
            posted["text"] == "“movie night” = we watch a movie at my place on fridays"
        )

    again = await client.post(answer_url, json={"user_id": "swayam", "decline": True})
    assert again.status_code == 409
    row = await session.scalar(select(Glossary).where(Glossary.term == "movie night"))
    assert row is not None and row.source == "human"

    # Priya's next explanation sees the private answer and can cite it.
    def cite(call: llm.LLMCall) -> dict[str, Any]:
        assert f"[A{ask['id']}] Swayam" in call.user
        return {
            "term": "movie night",
            "meaning": "**Movie night** is Friday movies at Swayam's.",
            "kind": "event",
            "confidence": 0.9,
            "ask_ids": [ask["id"]],
        }

    fake_llm.handler = cite
    out = await _explain(client, group_id=gid, user_id="priya", message_id=pressed)
    assert out["status"] == "explained"
    assert [h["ask_id"] for h in out["human_sources"]] == [ask["id"]]
    assert out["human_sources"][0]["user"]["id"] == "swayam"


async def test_decline_and_nobody_to_ask(
    client: AsyncClient, sample: LoadedFixture
) -> None:
    gid = sample.group_id("volleyball")
    resp = await client.post(
        f"{URL}/ask-member",
        json={"group_id": gid, "user_id": "priya", "term": "grandma"},
    )
    ask = resp.json()
    assert ask["asked_user"]["id"] in {"swayam", "jordan", "aakash", "sam"}
    resp = await client.post(
        f"{URL}/ask-member/{ask['id']}/answer",
        json={"user_id": ask["asked_user"]["id"], "decline": True},
    )
    assert resp.json()["status"] == "declined" and resp.json()["answer"] is None

    # a term nobody else has used, with no message: no one to ask
    resp = await client.post(
        f"{URL}/ask-member",
        json={"group_id": gid, "user_id": "priya", "term": "zorblax"},
    )
    assert resp.status_code == 409


# ----------------------------------------------------------------- embeddings


async def test_windows_are_embedded_once_and_searchable(
    session: AsyncSession, sample: LoadedFixture, fake_embedder: embeddings.FakeEmbedder
) -> None:
    gid = sample.group_id("volleyball")
    texts = (
        await session.scalars(
            select(Message.id).where(Message.group_id == gid, Message.kind == "text")
        )
    ).all()
    n = await embeddings.index_group(session, gid)
    assert n == len(texts) // 10
    assert await embeddings.index_group(session, gid) == 0  # nothing new
    windows = (
        await session.scalars(
            select(MessageWindow)
            .where(MessageWindow.group_id == gid)
            .order_by(MessageWindow.start_message_id)
        )
    ).all()
    assert all(
        w.end_message_id < nxt.start_message_id for w, nxt in zip(windows, windows[1:])
    )

    query = await embeddings.embed("plastic couches candy dish grandma house")
    assert query is not None
    best = await embeddings.nearest_windows(session, gid, query, 1)
    canon = sample.msg("volleyball", 12)
    assert best[0][0] <= canon <= best[0][1]


async def test_embeddings_off_falls_back_to_full_text(
    client: AsyncClient, sample: LoadedFixture, fake_llm: llm.FakeLLM
) -> None:
    class Off:
        async def embed(self, text: str) -> list[float]:
            raise embeddings.EmbeddingUnavailable("no credentials")

    embeddings.set_embedder(Off())
    fake_llm.queue({"meaning": "?", "kind": "unknown"})
    out = await _explain(
        client,
        group_id=sample.group_id("volleyball"),
        user_id="priya",
        message_id=sample.msg("volleyball", 36),
    )
    assert out["status"] == "unknown"
    assert "HISTORY:" in fake_llm.calls[-1].user


# ------------------------------------------------------------------- personas

DAD_ABOUT = "Dad. 52, engineer. Doesn't know internet slang or memes."
KID_ABOUT = "High schooler. Very online. Sends memes."
HOME: dict[str, Any] = {
    "users": [
        {"id": "dad", "username": "dad", "display_name": "Ravi V", "about": DAD_ABOUT},
        {"id": "kid", "username": "kid", "display_name": "Diya V", "about": KID_ABOUT},
        {"id": "mom", "username": "mom", "display_name": "Lakshmi V"},
    ],
    "groups": [
        {
            "key": "home",
            "name": "Home",
            "members": [
                {"user_id": u, "joined_offset_s": 864000} for u in ("dad", "kid", "mom")
            ],
            "messages": [
                {"idx": 0, "sender_id": "kid", "text": "chem test", "offset_s": 600},
                {
                    "idx": 1,
                    "sender_id": "kid",
                    "kind": "photo",
                    "image": "manga-meme.jpg",
                    "image_description": "A manga panel of a man pointing up.",
                    "text": "me after finishing my chem test",
                    "offset_s": 500,
                },
                {"idx": 2, "sender_id": "kid", "text": "he is cooked", "offset_s": 400},
            ],
        }
    ],
}


async def test_explanations_are_written_for_the_reader(
    client: AsyncClient,
    load_fixture: LoadFixture,
    fake_llm: llm.FakeLLM,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(settings, "MEDIA_DIR", tmp_path)
    fx = await load_fixture(HOME)
    gid, photo = fx.group_id("home"), fx.msg("home", 1)

    def meme(call: llm.LLMCall) -> dict[str, Any]:
        assert f"READER: The reader: Ravi V. {DAD_ABOUT}" in call.user
        assert "Diya V (joined" in call.user and KID_ABOUT in call.user
        assert "Lakshmi V (joined" in call.user  # no about: just the join date
        assert "Write for the reader" in call.system and "MEME" in call.system
        assert len(call.images) == 1  # the meme itself
        return {
            "term": "Honored One meme",
            "meaning": "A famous anime panel people post to show off a win.",
            "kind": "slang",
            "general": True,
            "confidence": 0.9,
        }

    fake_llm.handler = meme
    out = await _explain(client, group_id=gid, user_id="dad", message_id=photo)
    assert (out["status"], out["term"]) == ("general", "Honored One meme")

    # The same JSON contract for a reader without an about, and no READER line.
    fake_llm.handler = None
    fake_llm.queue(
        {"meaning": "Slang for in trouble.", "kind": "slang", "general": True}
    )
    out = await _explain(
        client, group_id=gid, user_id="mom", message_id=fx.msg("home", 2)
    )
    assert out["status"] == "general"
    assert "READER:" not in fake_llm.calls[-1].user


def test_profile_needs_an_about() -> None:
    dad = User(id="d", username="d", display_name="Ravi V", about="  Dad.\n 52.  ")
    assert explain.profile(dad) == "The reader: Ravi V. Dad. 52."
    assert explain.profile(User(id="m", username="m", display_name="M")) is None
