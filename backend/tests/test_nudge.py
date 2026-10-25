import asyncio
import json
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import db
from app.models import Glossary, Membership, Message, NudgeDismissal, User
from app.seed import LoadedFixture
from app.services import llm, nudge

DAY = 86400
URL = "/api/v1/nudge"


@pytest.fixture(autouse=True)
def _clear_nudge_caches() -> Iterator[None]:
    nudge.invalidate_glossary()  # group ids repeat across tests (RESTART IDENTITY)
    yield
    nudge.invalidate_glossary()


def js_slice(text: str, start: int, end: int) -> str:
    """text[start:end] using JS (UTF-16) indices."""
    return text.encode("utf-16-le")[start * 2 : end * 2].decode("utf-16-le")


def _user(uid: str, name: str) -> dict[str, Any]:
    return {"id": uid, "username": uid, "display_name": name}


def group_fixture(
    members: dict[str, int],
    *,
    explained_offset_s: int | None = 30 * DAY,
    extra_users: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """One group "g"; members maps user id -> joined_offset_s. "Grandma" is first
    seen 40 days ago and (optionally) explained at explained_offset_s."""
    names = {"aakash": "Aakash Mehta", "priya": "Priya Kapoor", "wei": "Wei Zhang"}
    names |= {"sam": "Sam Okafor", "lena": "Lena Fox"}
    explained = explained_offset_s or 39 * DAY
    msgs = [
        {"idx": 0, "sender_id": "aakash", "text": "grandma's", "offset_s": 40 * DAY},
        {"idx": 1, "sender_id": "aakash", "text": "Grandma=", "offset_s": explained},
    ]
    term = {
        "term": "Grandma",
        "aliases": ["grandma's", "grandmas", "grandma's house"],
        "meaning": "Swayam's house. We call it Grandma's because of the couches.",
        "kind": "nickname",
        "first_seen_idx": 0,
        "source_idxs": [0, 1],
    }
    if explained_offset_s is not None:
        term["last_explained_idx"] = 1
    return {
        "users": [_user(u, names[u]) for u in members] + (extra_users or []),
        "groups": [
            {
                "key": "g",
                "name": "G",
                "members": [
                    {"user_id": u, "joined_offset_s": s, "last_read_idx": None}
                    for u, s in members.items()
                ],
                "messages": msgs,
                "glossary": [term],
            }
        ],
    }


async def post(client: AsyncClient, path: str, **body: Any) -> dict[str, Any]:
    resp = await client.post(f"{URL}/{path}", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


# ------------------------------------------------------------------ matching


def _index() -> nudge.GlossaryIndex:
    now = datetime.now(UTC)
    return nudge.GlossaryIndex(
        [
            nudge.Term(1, "Grandma", ("grandma's", "grandmas", "grandma's house"), "Swayam's house.", "nickname", now),  # noqa: E501
            nudge.Term(2, "usual spot", ("the usual spot", "usual place"), "The back lot.", "place", now),  # noqa: E501
            nudge.Term(3, "OT", (), "Our team, the Spikers.", "nickname", now),
        ]
    )  # fmt: skip


@pytest.mark.parametrize(
    ("draft", "expected"),
    [
        ("grandma's after the game", [("Grandma", "grandma's")]),
        ("GRANDMA tonight", [("Grandma", "GRANDMA")]),
        ("Grandmas?", [("Grandma", "Grandmas")]),
        ("at grandma’s.", [("Grandma", "grandma’s")]),
        ("(grandma's house!)", [("Grandma", "grandma's house")]),
        ("the usual spot, then grandma's", [("usual spot", "the usual spot"), ("Grandma", "grandma's")]),  # noqa: E501
        ("usual-spot at 6", [("usual spot", "usual-spot")]),
        ("usual\nspots", [("usual spot", "usual\nspots")]),
        ("grnadma's at 9", [("Grandma", "grnadma's")]),
        ("go OT!", [("OT", "OT")]),
        ("grandmaster grandmother hot shot", []),
        ("the usual", []),
    ],
)  # fmt: skip
def test_glossary_matching(draft: str, expected: list[tuple[str, str]]) -> None:
    got = [(m.term.term, m.text) for m in _index().find(draft)]
    assert got == expected
    for m in _index().find(draft):
        assert draft[m.start : m.end] == m.text


def test_utf16_offsets() -> None:
    assert nudge.utf16_offsets("a🏐b") == [0, 1, 3, 4]
    assert nudge.utf16_offsets("é") == [0, 1]


def test_humanize_ago() -> None:
    now = datetime.now(UTC)
    ago = lambda **kw: nudge.humanize_ago(now - timedelta(**kw), now)  # noqa: E731
    assert ago(seconds=20) == "just now"
    assert ago(minutes=5) == "5 minutes ago"
    assert ago(hours=1, minutes=5) == "an hour ago"
    assert ago(hours=26) == "yesterday"
    assert ago(days=2, minutes=1) == "2 days ago"
    assert ago(days=9) == "last week"
    assert ago(days=36) == "5 weeks ago"
    assert ago(days=100) == "3 months ago"


def test_diff_spans() -> None:
    draft = "grandma's after the game, usual spot"
    out = "grandma's (Swayam's house) after the game, usual spot (back lot)"
    spans = [(s.start, s.end) for s in nudge.diff_spans(draft, out)]
    assert [out[s:e] for s, e in spans] == ["(Swayam's house)", "(back lot)"]
    emoji = "🏐 " + out
    spans = [(s.start, s.end) for s in nudge.diff_spans("🏐 " + draft, emoji)]
    assert [js_slice(emoji, s, e) for s, e in spans] == [
        "(Swayam's house)",
        "(back lot)",
    ]
    assert nudge.diff_spans(draft, draft) == []


# --------------------------------------------------------------------- check


async def test_check_sample(client: AsyncClient, sample: LoadedFixture) -> None:
    gid = sample.group_id("volleyball")
    draft = "grandma's after the game, usual spot."
    body = await post(client, "check", group_id=gid, user_id="aakash", draft=draft)
    assert body["show"] is True
    assert body["message"] == (
        'Priya joined 2 days ago and might not know "Grandma" or "usual spot." '
        "Rewrite for Priya?"
    )
    assert [n["user_id"] for n in body["newcomers"]] == ["priya"]
    assert body["newcomers"][0]["display_name"] == "Priya Kapoor"
    grandma, spot = body["flagged_terms"]
    assert grandma == {
        "term": "Grandma",
        "glossary_id": sample.groups["volleyball"].glossary_ids["Grandma"],
        "matched_text": "grandma's",
        "start": 0,
        "end": 9,
        "meaning": grandma["meaning"],
        "kind": "nickname",
        "newcomer_ids": ["priya"],
    }
    assert grandma["meaning"].startswith("Swayam's house")
    assert (spot["term"], spot["matched_text"]) == ("usual spot", "usual spot")
    assert draft[spot["start"] : spot["end"]] == "usual spot"


async def test_check_emoji_offsets(client: AsyncClient, sample: LoadedFixture) -> None:
    gid = sample.group_id("volleyball")
    draft = "🏐🏐 omw to GRANDMAS 👵🏽 then the usual spot"
    body = await post(client, "check", group_id=gid, user_id="maya", draft=draft)
    got = [(t["matched_text"], t["start"], t["end"]) for t in body["flagged_terms"]]
    assert got == [("GRANDMAS", 12, 20), ("the usual spot", 31, 45)]
    for text, s, e in got:
        assert js_slice(draft, s, e) == text


async def test_check_plain_draft_and_errors(
    client: AsyncClient, sample: LoadedFixture
) -> None:
    gid = sample.group_id("volleyball")
    plain = await post(client, "check", group_id=gid, user_id="aakash", draft="hi all")
    assert plain == {
        "show": False, "flagged_terms": [], "newcomers": [], "message": None
    }  # fmt: skip
    body = {"group_id": gid, "user_id": "nobody", "draft": "grandma's"}
    assert (await client.post(f"{URL}/check", json=body)).status_code == 403
    body |= {"group_id": 999, "user_id": "aakash"}
    assert (await client.post(f"{URL}/check", json=body)).status_code == 404


async def test_check_sender_newcomer_excluded(
    client: AsyncClient, sample: LoadedFixture
) -> None:
    gid = sample.group_id("volleyball")
    body = await post(
        client, "check", group_id=gid, user_id="priya", draft="grandma's later?"
    )
    assert body["show"] is False


async def test_check_no_newcomer(client: AsyncClient, load_fixture: Any) -> None:
    fx = await load_fixture(group_fixture({"aakash": 50 * DAY, "sam": 45 * DAY}))
    body = await post(
        client, "check", group_id=fx.group_id("g"), user_id="aakash", draft="grandmas"
    )
    assert body["show"] is False


async def test_check_newcomer_before_last_explained(
    client: AsyncClient, load_fixture: Any
) -> None:
    # sam joined 35 days ago: after first use (40d) but before the explanation (30d)
    fx = await load_fixture(group_fixture({"aakash": 50 * DAY, "sam": 35 * DAY}))
    gid = fx.group_id("g")
    body = await post(client, "check", group_id=gid, user_id="aakash", draft="grandma")
    assert body["show"] is False
    # never explained: origin is first_seen (40d), but sam joined more than
    # TERM_NEWCOMER_DAYS (30) ago, so he has had time to pick it up
    fx = await load_fixture(
        group_fixture({"aakash": 50 * DAY, "sam": 35 * DAY}, explained_offset_s=None)
        | {"users": []}
    )
    gid = fx.group_id("g")
    body = await post(client, "check", group_id=gid, user_id="aakash", draft="grandma")
    assert body["show"] is False
    # never explained and sam joined 20 days ago: newcomer
    fx = await load_fixture(
        group_fixture({"aakash": 50 * DAY, "sam": 20 * DAY}, explained_offset_s=None)
        | {"users": []}
    )
    gid = fx.group_id("g")
    body = await post(client, "check", group_id=gid, user_id="aakash", draft="grandma")
    assert body["show"] is True
    assert body["message"].startswith("Sam joined 2 weeks ago")


async def test_check_multiple_newcomers(client: AsyncClient, load_fixture: Any) -> None:
    fx = await load_fixture(
        group_fixture({"aakash": 50 * DAY, "priya": 2 * DAY, "wei": 3600})
    )
    body = await post(
        client, "check", group_id=fx.group_id("g"), user_id="aakash", draft="grandmas?"
    )
    assert body["show"] is True
    assert [n["user_id"] for n in body["newcomers"]] == ["priya", "wei"]
    assert body["flagged_terms"][0]["newcomer_ids"] == ["priya", "wei"]
    assert body["message"] == (
        'Priya and Wei joined recently and might not know "Grandma." Rewrite for them?'
    )


def test_check_message_many_terms() -> None:
    now = datetime.now(UTC)
    m = Membership(user_id="priya", joined_at=now - timedelta(days=1))
    m.user = User(id="priya", username="priya", display_name="Priya Kapoor")
    msg = nudge.check_message([m], ["Grandma", "usual spot", "OT"], now)
    assert msg == (
        'Priya joined yesterday and might not know "Grandma", "usual spot", or "OT." '
        "Rewrite for Priya?"
    )
    many = []
    for i, name in enumerate(["Ann B", "Bo C", "Cy D", "Di E"]):
        x = Membership(user_id=f"u{i}", joined_at=now - timedelta(hours=10 - i))
        x.user = User(id=f"u{i}", username=f"u{i}", display_name=name)
        many.append(x)
    assert nudge.check_message(many, ["OT"], now).startswith(
        "Ann, Bo, and 2 others joined recently"
    )
    many[0].joined_at = now - timedelta(days=19, hours=12)
    assert nudge.check_message(many, ["OT"], now).startswith(
        "Ann, Bo, and 2 others joined in the last 20 days"
    )


async def test_dismiss(
    client: AsyncClient, sample: LoadedFixture, session: AsyncSession
) -> None:
    gid = sample.group_id("volleyball")
    draft = "grandma's after, usual spot before"
    resp = await client.post(
        f"{URL}/dismiss",
        json={"group_id": gid, "user_id": "aakash", "term": "Grandma's"},
    )
    assert resp.status_code == 204
    again = await client.post(
        f"{URL}/dismiss", json={"group_id": gid, "user_id": "aakash", "term": "grandma"}
    )
    assert again.status_code == 204
    rows = (await session.scalars(select(NudgeDismissal))).all()
    assert [(r.user_id, r.group_id, r.term) for r in rows] == [
        ("aakash", gid, "grandma")
    ]
    body = await post(client, "check", group_id=gid, user_id="aakash", draft=draft)
    assert [t["term"] for t in body["flagged_terms"]] == ["usual spot"]
    assert body["message"].startswith(
        'Priya joined 2 days ago and might not know "usual'
    )
    other = await post(client, "check", group_id=gid, user_id="maya", draft=draft)
    assert [t["term"] for t in other["flagged_terms"]] == ["Grandma", "usual spot"]
    bad = await client.post(
        f"{URL}/dismiss", json={"group_id": gid, "user_id": "nobody", "term": "x"}
    )
    assert bad.status_code == 403


async def test_check_is_fast(client: AsyncClient, sample: LoadedFixture) -> None:
    gid = sample.group_id("volleyball")
    draft = "grandma's after the game, usual spot. " * 5
    await post(client, "check", group_id=gid, user_id="aakash", draft=draft)  # warm
    t0 = asyncio.get_running_loop().time()
    for _ in range(10):
        await post(client, "check", group_id=gid, user_id="aakash", draft=draft)
    per_call = (asyncio.get_running_loop().time() - t0) / 10
    assert per_call < 0.05


# ------------------------------------------------------------------- rewrite


async def test_rewrite(
    client: AsyncClient, sample: LoadedFixture, fake_llm: llm.FakeLLM
) -> None:
    gid = sample.group_id("volleyball")
    draft = "grandma's after the game, usual spot at 6:40"
    rewritten = (
        "grandma's (swayam's place) after the game, usual spot "
        "(back lot by the tennis courts) at 6:40"
    )
    fake_llm.queue({"rewritten": rewritten})
    body = await post(
        client,
        "rewrite",
        group_id=gid,
        user_id="aakash",
        draft=draft,
        terms=["Grandma", "the usual spot"],
    )
    assert body["rewritten"] == rewritten
    spans = [rewritten[c["start"] : c["end"]] for c in body["changes"]]
    assert spans == ["(swayam's place)", "(back lot by the tennis courts)"]
    call = fake_llm.calls[-1]
    assert call.json_mode
    assert "plastic-covered couches" in call.user and "tennis courts" in call.user
    assert "Priya" in call.user
    assert "casing" in call.system


@pytest.mark.parametrize(
    "reply",
    [
        {"rewritten": ""},
        {"something": "else"},
        {"rewritten": "Hello! Hope you're all doing well today."},  # drops content
        {"rewritten": "grandma's after the game " + "blah " * 200},  # too long
        {"rewritten": "grandma's after the game"},  # unchanged
        llm.LLMError("boom"),
        "not json at all",
    ],
)
async def test_rewrite_fallback(
    client: AsyncClient, sample: LoadedFixture, fake_llm: llm.FakeLLM, reply: Any
) -> None:
    gid = sample.group_id("volleyball")
    fake_llm.queue(reply, reply)  # complete_json retries unparseable replies once
    draft = "grandma's after the game"
    body = await post(
        client,
        "rewrite",
        group_id=gid,
        user_id="aakash",
        draft=draft,
        terms=["Grandma"],
    )
    assert body["rewritten"] == "grandma's (Swayam's house) after the game"
    assert body["changes"] == [{"start": 10, "end": 26}]


async def test_rewrite_fallback_two_terms_no_terms_given(
    client: AsyncClient, sample: LoadedFixture, fake_llm: llm.FakeLLM
) -> None:
    gid = sample.group_id("volleyball")
    fake_llm.queue(TimeoutError())
    body = await post(
        client,
        "rewrite",
        group_id=gid,
        user_id="aakash",
        draft="🏐 usual spot then Grandma?",
        terms=[],
    )
    out = body["rewritten"]
    assert out == (
        "🏐 usual spot (the back parking lot behind the rec center) then "
        "Grandma (Swayam's house)?"
    )
    spans = [js_slice(out, c["start"], c["end"]) for c in body["changes"]]
    assert spans == ["(the back parking lot behind the rec center)", "(Swayam's house)"]


async def test_rewrite_unknown_terms_is_noop(
    client: AsyncClient, sample: LoadedFixture
) -> None:
    gid = sample.group_id("volleyball")
    body = await post(
        client, "rewrite", group_id=gid, user_id="aakash", draft="hi", terms=["zzz"]
    )
    assert body == {"rewritten": "hi", "changes": []}


# ------------------------------------------------------------------- unknown


@pytest.mark.parametrize(
    ("user_id", "draft"),
    [
        ("aakash", "see you all at the game tonight, bring water"),  # all common
        ("aakash", "lets gooo, omw to grandma's with Priya and Swayam"),  # slang etc
        ("aakash", "pickle incident"),  # < 3 words
    ],
)  # fmt: skip
async def test_unknown_prefilter_skips_llm(
    client: AsyncClient,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
    user_id: str,
    draft: str,
) -> None:
    gid = sample.group_id("volleyball")
    body = await post(client, "unknown", group_id=gid, user_id=user_id, draft=draft)
    assert body["show"] is False
    assert fake_llm.calls == []


async def test_unknown_no_newcomers_skips_llm(
    client: AsyncClient, load_fixture: Any, fake_llm: llm.FakeLLM
) -> None:
    fx = await load_fixture(group_fixture({"aakash": 50 * DAY, "sam": 45 * DAY}))
    body = await post(
        client,
        "unknown",
        group_id=fx.group_id("g"),
        user_id="aakash",
        draft="remember the zorblax fiasco lmao",
    )
    assert body["show"] is False
    assert fake_llm.calls == []


async def test_unknown_flags_and_caches(
    client: AsyncClient, sample: LoadedFixture, fake_llm: llm.FakeLLM
) -> None:
    gid = sample.group_id("volleyball")
    draft = "🏐 lol remember the Zorblax fiasco at grandma's"
    fake_llm.queue(
        {"unknown_terms": ["Zorblax fiasco", "made up", "grandma's", "Priya"]}
    )
    body = await post(client, "unknown", group_id=gid, user_id="aakash", draft=draft)
    assert body["show"] is True
    assert body["unknown_terms"] == [{"term": "Zorblax fiasco", "start": 20, "end": 34}]
    assert js_slice(draft, 20, 34) == "Zorblax fiasco"
    assert [n["user_id"] for n in body["newcomers"]] == ["priya"]
    assert body["message"] == (
        "This looks like an inside reference and I can't find where it's explained. "
        "Priya probably doesn't know it. Add a quick aside?"
    )
    call = fake_llm.calls[-1]
    assert "Zorblax" in call.user and "usual spot" in call.user
    assert "omw to the usual spot" in call.user  # recent messages
    assert call.max_tokens >= 2000
    # same draft (modulo case/whitespace) within 10 min: cached, no second LLM call
    again = await post(
        client, "unknown", group_id=gid, user_id="maya", draft=draft.upper() + "  "
    )
    assert len(fake_llm.calls) == 1
    assert again["unknown_terms"] == [
        {"term": "ZORBLAX FIASCO", "start": 20, "end": 34}
    ]


async def test_unknown_llm_says_none(
    client: AsyncClient, sample: LoadedFixture, fake_llm: llm.FakeLLM
) -> None:
    gid = sample.group_id("volleyball")
    fake_llm.queue({"unknown_terms": []})
    draft = "anyone know a good libero drill"
    body = await post(client, "unknown", group_id=gid, user_id="aakash", draft=draft)
    assert body["show"] is False
    assert len(fake_llm.calls) == 1


async def test_unknown_timeout(
    client: AsyncClient,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gid = sample.group_id("volleyball")
    fake_llm.queue(TimeoutError())
    draft = "remember the zorblax fiasco lol"
    body = await post(client, "unknown", group_id=gid, user_id="aakash", draft=draft)
    assert body["show"] is False

    class Slow(llm.FakeLLM):
        async def complete(self, call: llm.LLMCall) -> str:
            await asyncio.sleep(1)
            return '{"unknown_terms": ["zorblax fiasco"]}'

    monkeypatch.setattr(nudge, "UNKNOWN_TIMEOUT_S", 0.05)
    llm.set_llm_backend(Slow())
    t0 = asyncio.get_running_loop().time()
    body = await post(client, "unknown", group_id=gid, user_id="aakash", draft=draft)
    assert body["show"] is False
    assert asyncio.get_running_loop().time() - t0 < 0.5


# --------------------------------------------------------------------- aside


@pytest.fixture
async def later_member(session: AsyncSession) -> AsyncIterator[Any]:
    async def add(group_id: int, user_id: str) -> None:
        session.add(User(id=user_id, username=user_id, display_name="Lena Fox"))
        session.add(
            Membership(group_id=group_id, user_id=user_id, joined_at=datetime.now(UTC))
        )
        await session.commit()

    yield add


async def test_aside_saves_glossary(
    client: AsyncClient,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
    session: AsyncSession,
    later_member: Any,
) -> None:
    gid = sample.group_id("volleyball")
    draft = "zorblax fiasco part 2 tonight"
    rewritten = "zorblax fiasco (when the net collapsed mid-rally) part 2 tonight"
    fake_llm.queue({"rewritten": rewritten, "kind": "event"})
    body = await post(
        client,
        "aside",
        group_id=gid,
        user_id="aakash",
        draft=draft,
        term="zorblax fiasco",
        meaning="the time the net collapsed mid-rally",
    )
    assert body["rewritten"] == rewritten
    assert [rewritten[c["start"] : c["end"]] for c in body["changes"]] == [
        "(when the net collapsed mid-rally)"
    ]
    row = await session.get(Glossary, body["glossary_id"])
    assert row is not None
    assert (row.term, row.source, row.kind, row.confidence, row.aliases) == (
        "zorblax fiasco", "human", "event", 1.0, []
    )  # fmt: skip
    assert row.meaning == "the time the net collapsed mid-rally"
    assert row.last_explained_ts is None  # only set once the explanation is sent
    assert "net collapsed" in fake_llm.calls[-1].user

    # Priya joined before the aside: the term counts as explained for her
    check = await post(
        client, "check", group_id=gid, user_id="aakash", draft="zorblax fiasco again"
    )
    assert check["show"] is False
    # someone who joins afterwards gets the nudge
    await asyncio.sleep(0.01)
    await later_member(gid, "lena")
    check = await post(
        client, "check", group_id=gid, user_id="aakash", draft="Zorblax Fiasco again"
    )
    assert check["show"] is True
    assert check["flagged_terms"][0]["glossary_id"] == body["glossary_id"]
    assert check["flagged_terms"][0]["newcomer_ids"] == ["lena"]
    assert check["message"].startswith("Lena joined just now and might not know")
    # sending the aside's text marks the term explained for everyone in the group
    await send(client, gid, "aakash", rewritten + " lol")
    await session.refresh(row)
    assert row.last_explained_ts is not None
    check = await post(
        client, "check", group_id=gid, user_id="aakash", draft="Zorblax Fiasco again"
    )
    assert check["show"] is False


async def test_aside_keeps_existing_meaning_and_falls_back(
    client: AsyncClient,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
    session: AsyncSession,
) -> None:
    gid = sample.group_id("volleyball")
    gl_id = sample.groups["volleyball"].glossary_ids["Grandma"]
    before = await session.get(Glossary, gl_id)
    assert before is not None
    meaning, explained_ts = before.meaning, before.last_explained_ts
    await post(
        client, "check", group_id=gid, user_id="aakash", draft="grandmas"
    )  # cache
    fake_llm.queue({"rewritten": ""})
    body = await post(
        client,
        "aside",
        group_id=gid,
        user_id="aakash",
        draft="grandmas at 9",
        term="grandmas",
        meaning="lol",
    )
    assert body["glossary_id"] == gl_id
    assert body["rewritten"] == "grandmas (lol) at 9"
    await session.refresh(before)
    assert (before.term, before.source, before.kind) == ("Grandma", "seed", "nickname")
    assert (before.meaning, before.last_explained_ts) == (meaning, explained_ts)
    # nothing was sent yet: Priya still gets nudged
    check = await post(
        client, "check", group_id=gid, user_id="aakash", draft="grandmas"
    )
    assert check["show"] is True
    # sending the aside's text counts as explaining it
    msg = await send(client, gid, "aakash", "grandmas (lol) at 9")
    await session.refresh(before)
    assert before.last_explained_ts == datetime.fromisoformat(msg["ts"])
    check = await post(
        client, "check", group_id=gid, user_id="aakash", draft="grandmas"
    )
    assert check["show"] is False


async def test_aside_replaces_low_confidence_auto_meaning(
    client: AsyncClient,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
    session: AsyncSession,
) -> None:
    gid = sample.group_id("volleyball")
    gl_id = sample.groups["volleyball"].glossary_ids["usual spot"]
    row = await session.get(Glossary, gl_id)
    assert row is not None
    row.source, row.confidence = "auto", 0.3
    await session.commit()
    fake_llm.queue({"rewritten": "", "kind": "place"})
    await post(
        client,
        "aside",
        group_id=gid,
        user_id="aakash",
        draft="usual spot at 6",
        term="the usual spot",
        meaning="the gym lot",
    )
    await session.refresh(row)
    assert (row.meaning, row.source, row.confidence) == ("the gym lot", "human", 1.0)


async def test_aside_new_term_origin_is_first_mention(
    client: AsyncClient,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
    session: AsyncSession,
) -> None:
    gid = sample.group_id("volleyball")
    said = sample.now - timedelta(days=10)
    session.add(
        Message(
            group_id=gid,
            sender_id="maya",
            kind="text",
            text="LOL the Zorblax Fiasco",
            ts=said,
        )
    )
    await session.commit()
    rewritten = "zorblax fiasco (when the net fell) round 2"
    fake_llm.queue({"rewritten": rewritten})
    body = await post(
        client,
        "aside",
        group_id=gid,
        user_id="aakash",
        draft="zorblax fiasco round 2",
        term="zorblax fiasco",
        meaning="when the net fell",
    )
    row = await session.get(Glossary, body["glossary_id"])
    assert row is not None
    assert (row.first_seen_ts, row.last_explained_ts) == (said, None)
    # Priya joined after it was first used and the aside wasn't sent: still a newcomer
    check = await post(
        client, "check", group_id=gid, user_id="maya", draft="zorblax fiasco again"
    )
    assert check["flagged_terms"][0]["newcomer_ids"] == ["priya"]
    # ...but the aside's own output doesn't nag
    check = await post(client, "check", group_id=gid, user_id="aakash", draft=rewritten)
    assert check["show"] is False


async def test_aside_llm_timeout_still_saves(
    client: AsyncClient,
    sample: LoadedFixture,
    session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(nudge, "REWRITE_TIMEOUT_S", 0.1)
    monkeypatch.setattr(nudge, "REWRITE_HEDGE_S", 0.05)
    llm.set_llm_backend(Slow({"rewritten": "x", "kind": "event"}))
    gid = sample.group_id("volleyball")
    t0 = asyncio.get_running_loop().time()
    body = await post(
        client,
        "aside",
        group_id=gid,
        user_id="aakash",
        draft="zorblax fiasco tonight",
        term="zorblax fiasco",
        meaning="the net collapse",
    )
    assert asyncio.get_running_loop().time() - t0 < 0.5
    assert body["rewritten"] == "zorblax fiasco (the net collapse) tonight"
    assert await session.get(Glossary, body["glossary_id"]) is not None


# ------------------------------------------------------- review regressions


class Slow(llm.FakeLLM):
    """Answers after `delay` s and records how many pooled connections were checked
    out while the request was waiting on the model."""

    def __init__(self, reply: Any, delay: float = 1.0) -> None:
        super().__init__()
        self.reply, self.delay, self.checked_out = reply, delay, []

    async def complete(self, call: llm.LLMCall) -> str:
        self.calls.append(call)
        self.checked_out.append(db.engine.pool.checkedout())
        await asyncio.sleep(self.delay)
        return self.reply if isinstance(self.reply, str) else json.dumps(self.reply)


async def send(client: AsyncClient, gid: int, sender: str, text: str) -> dict:
    resp = await client.post(
        f"/api/v1/groups/{gid}/messages", json={"sender_id": sender, "text": text}
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_rewrite_llm_timeout_falls_back(
    client: AsyncClient, sample: LoadedFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(nudge, "REWRITE_TIMEOUT_S", 0.3)
    monkeypatch.setattr(nudge, "REWRITE_HEDGE_S", 0.05)
    slow = Slow({"rewritten": "never used"})
    llm.set_llm_backend(slow)
    gid = sample.group_id("volleyball")
    t0 = asyncio.get_running_loop().time()
    body = await post(
        client,
        "rewrite",
        group_id=gid,
        user_id="aakash",
        draft="grandma's after the game",
        terms=["Grandma"],
    )
    assert asyncio.get_running_loop().time() - t0 < 0.5
    assert body["rewritten"] == "grandma's (Swayam's house) after the game"
    assert len(slow.calls) == 2  # hedged


@pytest.mark.parametrize("path", ["rewrite", "aside", "unknown"])
async def test_llm_calls_release_db_connection(
    client: AsyncClient, sample: LoadedFixture, path: str
) -> None:
    slow = Slow({"rewritten": "", "unknown_terms": []}, delay=0.05)
    llm.set_llm_backend(slow)
    gid = sample.group_id("volleyball")
    draft = "grandma's then the zorblax fiasco lol"
    extra: dict[str, Any] = {
        "rewrite": {"terms": ["Grandma"]},
        "aside": {"term": "zorblax fiasco", "meaning": "the net collapse"},
        "unknown": {},
    }[path]
    await post(client, path, group_id=gid, user_id="aakash", draft=draft, **extra)
    assert slow.checked_out and set(slow.checked_out) == {0}


async def test_dismiss_and_rewrite_accept_matched_text(
    client: AsyncClient,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
    session: AsyncSession,
) -> None:
    gid = sample.group_id("volleyball")
    draft = "meet at the usual spots at 6"
    check = await post(client, "check", group_id=gid, user_id="aakash", draft=draft)
    matched = check["flagged_terms"][0]["matched_text"]
    assert matched == "the usual spots"

    fake_llm.queue({"rewritten": "meet at the usual spots (back lot) at 6"})
    body = await post(
        client, "rewrite", group_id=gid, user_id="aakash", draft=draft, terms=[matched]
    )
    assert body["rewritten"] == "meet at the usual spots (back lot) at 6"
    assert "tennis courts" in fake_llm.calls[-1].user
    # unresolvable names fall back to the terms found in the draft
    fake_llm.queue({"rewritten": "meet at the usual spots (the lot) at 6"})
    body = await post(
        client, "rewrite", group_id=gid, user_id="aakash", draft=draft, terms=["zzz"]
    )
    assert body["changes"] != []

    resp = await client.post(
        f"{URL}/dismiss", json={"group_id": gid, "user_id": "aakash", "term": matched}
    )
    assert resp.status_code == 204
    rows = (await session.scalars(select(NudgeDismissal.term))).all()
    assert rows == ["usual spot"]
    check = await post(client, "check", group_id=gid, user_id="aakash", draft=draft)
    assert check["show"] is False


def test_resolve() -> None:
    index = _index()
    for name in ["the usual spots", "usual-spot", "usual spot's", "Usual Spot"]:
        assert (t := index.resolve(name)) is not None and t.term == "usual spot"
    t = index.resolve("grnadma's")
    assert t is not None and t.term == "Grandma"
    assert index.resolve("usual spot tonight") is None


@pytest.mark.parametrize(
    ("draft", "show"),
    [
        ("grandma's (Swayam's house) after the game, usual spot (back lot by the "
         "tennis courts) at 6:40", False),
        ("priya, grandma's is swayam's house btw", False),
        ("grandma's - swayam's place - at 9", False),
        ("grandma's is open saturday!! bring snacks", True),
        ("usual spot at 6:40 before thursday games", True),
    ],
)  # fmt: skip
async def test_check_skips_terms_already_explained(
    client: AsyncClient, sample: LoadedFixture, draft: str, show: bool
) -> None:
    gid = sample.group_id("volleyball")
    body = await post(client, "check", group_id=gid, user_id="aakash", draft=draft)
    assert body["show"] is show


async def test_send_marks_terms_explained(
    client: AsyncClient,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
    session: AsyncSession,
) -> None:
    gid = sample.group_id("volleyball")
    ids = sample.groups["volleyball"].glossary_ids
    grandma = await session.get(Glossary, ids["Grandma"])
    spot = await session.get(Glossary, ids["usual spot"])
    assert grandma is not None and spot is not None
    old = grandma.last_explained_ts

    async def flagged(draft: str) -> list[str]:
        body = await post(client, "check", group_id=gid, user_id="maya", draft=draft)
        return [t["term"] for t in body["flagged_terms"]]

    # a plain mention (even with a parenthetical) doesn't count as explaining
    await send(client, gid, "aakash", "grandma's (8pm) tonight")
    await session.refresh(grandma)
    assert grandma.last_explained_ts == old
    assert await flagged("grandma's later") == ["Grandma"]
    # explained in the sender's own words
    await send(client, gid, "aakash", "@priya grandma's is swayam's house")
    await session.refresh(grandma)
    assert grandma.last_explained_ts > old
    assert await flagged("grandma's later, usual spot first") == ["usual spot"]
    # a /rewrite result, sent with edits elsewhere
    fake_llm.queue({"rewritten": "usual spot (the lot) at 6"})
    await post(
        client, "rewrite", group_id=gid, user_id="aakash", draft="usual spot at 6",
        terms=["usual spot"],
    )  # fmt: skip
    await send(client, gid, "aakash", "ok usual spot (the lot) at 6:30")
    await session.refresh(spot)
    assert spot.last_explained_ts is not None
    assert spot.last_explained_ts > sample.now - timedelta(minutes=1)
    assert await flagged("usual spot later") == []


async def test_unknown_respects_dismissals(
    client: AsyncClient, sample: LoadedFixture, fake_llm: llm.FakeLLM
) -> None:
    gid = sample.group_id("volleyball")
    resp = await client.post(
        f"{URL}/dismiss",
        json={"group_id": gid, "user_id": "aakash", "term": "Zorblax Fiasco"},
    )
    assert resp.status_code == 204
    body = await post(
        client, "unknown", group_id=gid, user_id="aakash",
        draft="remember the zorblax fiasco lol",
    )  # fmt: skip
    assert body["show"] is False
    assert fake_llm.calls == []
    fake_llm.queue({"unknown_terms": ["zorblax fiasco", "blorp saga"]})
    body = await post(
        client, "unknown", group_id=gid, user_id="aakash",
        draft="zorblax fiasco then the blorp saga",
    )  # fmt: skip
    assert [t["term"] for t in body["unknown_terms"]] == ["blorp saga"]
    # another member hasn't dismissed it (served from the cache)
    body = await post(
        client, "unknown", group_id=gid, user_id="maya",
        draft="zorblax fiasco then the blorp saga",
    )  # fmt: skip
    assert [t["term"] for t in body["unknown_terms"]] == [
        "zorblax fiasco", "blorp saga"
    ]  # fmt: skip
    assert len(fake_llm.calls) == 1


async def test_hedged_request() -> None:
    calls: list[float] = []

    async def first_slow() -> int:
        calls.append(0)
        await asyncio.sleep(1 if len(calls) == 1 else 0.01)
        return len(calls)

    assert await nudge.hedged(first_slow, hedge_after=0.02, timeout=0.5) == 2

    async def always_slow() -> int:
        await asyncio.sleep(1)
        return 1

    with pytest.raises(TimeoutError):
        await nudge.hedged(always_slow, hedge_after=0.02, timeout=0.08)

    async def fails() -> int:
        raise llm.LLMError("nope")

    with pytest.raises(llm.LLMError):
        await nudge.hedged(fails, hedge_after=0.02, timeout=0.5)

    async def fast() -> int:
        return 7

    assert await nudge.hedged(fast, hedge_after=0.02, timeout=0.5) == 7
