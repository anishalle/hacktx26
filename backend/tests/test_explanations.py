from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from app import repository
from app.explanations import ground_answer


def row(id):
    return {"id": id, "ts": datetime(2026, 1, 1, tzinfo=timezone.utc)}


@pytest.mark.parametrize(
    "raw",
    [
        {"meaning": "An unsupported guess", "confidence": 0.9, "kind": "place"},
        {
            "meaning": "Wrong group citation",
            "confidence": 0.9,
            "kind": "place",
            "source_message_ids": ["other-group"],
        },
        {
            "meaning": "Private answer from someone else",
            "confidence": 0.9,
            "kind": "place",
            "source_ask_ids": ["other-user"],
        },
        {
            "meaning": "Low confidence",
            "confidence": 0.3,
            "kind": "place",
            "source_message_ids": ["valid"],
        },
    ],
)
def test_unsupported_claims_become_honest_unknown(raw):
    answer = ground_answer(raw, [row("valid")], [])
    assert answer.kind == "unknown"
    assert not answer.source_message_ids
    assert "couldn't find" in answer.meaning


def test_grounded_and_plain_results():
    answer = ground_answer(
        {
            "meaning": "**Grandma** means Swayam's house.",
            "confidence": 0.9,
            "kind": "nickname",
            "source_message_ids": ["valid"],
        },
        [row("valid")],
        [],
    )
    assert answer.kind == "nickname"
    assert answer.source_message_ids == ["valid"]
    assert (
        ground_answer(
            {
                "meaning": "They will see you at seven.",
                "confidence": 0.95,
                "kind": "plain",
            },
            [],
            [],
        ).kind
        == "plain"
    )


def test_context_preserves_complete_windows_and_deduplicates(monkeypatch):
    monkeypatch.setattr(repository.settings, "CONTEXT_MAX_CHARS", 100000)
    monkeypatch.setattr(
        repository,
        "window",
        lambda db, anchor: (
            [row("a"), row("b")] if anchor["id"] == "a" else [row("b"), row("c")]
        ),
    )
    context = repository.build_context(None, row("a"), [row("c")])
    assert [item["id"] for item in context] == ["a", "b", "c"]
    monkeypatch.setattr(repository.settings, "CONTEXT_MAX_CHARS", 1)
    with pytest.raises(HTTPException) as error:
        repository.build_context(None, row("a"), [])
    assert error.value.status_code == 413
