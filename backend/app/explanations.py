import json
from uuid import uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb
from pydantic import ValidationError

from app import bedrock, repository
from app.chat_models import ExplainRequest, Explanation, ModelAnswer

UNKNOWN = (
    "I couldn't find a reliable explanation in this group's history. "
    "You can privately ask the sender what they meant."
)


def ground_answer(raw: dict, context: list[dict], human: list[dict]) -> ModelAnswer:
    answer = ModelAnswer.model_validate(raw)
    valid_messages = {row["id"] for row in context}
    valid_asks = {row["id"] for row in human}
    # Reject the whole unsupported answer instead of retaining its uncited claims.
    invalid = (
        not set(answer.source_message_ids) <= valid_messages
        or not set(answer.source_ask_ids) <= valid_asks
    )
    sourced = bool(answer.source_message_ids or answer.source_ask_ids)
    if (
        invalid
        or answer.confidence < 0.4
        or answer.kind == "unknown"
        or (answer.kind != "plain" and not sourced)
    ):
        return ModelAnswer(meaning=UNKNOWN, confidence=0, kind="unknown")
    return answer


def explain_message(db, request: ExplainRequest, user_id: str) -> Explanation:
    membership = repository.require_membership(db, request.group_id, user_id)
    selected = repository.message(db, request.group_id, request.message_id)
    if request.explanation_id:
        saved = db.execute(
            """SELECT context FROM explanations
            WHERE id = %s AND user_id = %s AND group_id = %s AND message_id = %s""",
            (request.explanation_id, user_id, request.group_id, request.message_id),
        ).fetchone()
        if saved is None:
            raise HTTPException(404, "Explanation not found.")
        payload = saved["context"]
    else:
        hits = repository.search(db, selected, bedrock.embed(selected["text"]))
        context = repository.build_context(db, selected, hits)
        payload = {
            "selected": selected,
            "history": context,
            "members": repository.members(db, request.group_id),
            "newcomer_joined_at": membership["joined_at"],
        }
    # Human replies can arrive after the original explanation; include fresh replies.
    human = repository.private_answers(
        db, request.group_id, request.message_id, user_id
    )
    payload["private_answers"] = human
    payload["follow_up"] = request.follow_up
    try:
        answer = ground_answer(bedrock.explain(payload), payload["history"], human)
    except (ValidationError, json.JSONDecodeError, KeyError, TypeError) as exc:
        raise HTTPException(
            502, "The model returned an invalid answer. Please retry."
        ) from exc
    explanation_id = str(uuid4())
    # Normalize datetime values for JSONB while preserving all original context.
    serializable = json.loads(json.dumps(payload, default=str))
    db.execute(
        """INSERT INTO explanations (id, group_id, user_id, message_id, context)
        VALUES (%s, %s, %s, %s, %s)""",
        (
            explanation_id,
            request.group_id,
            user_id,
            request.message_id,
            Jsonb(serializable),
        ),
    )
    source_ids = set(answer.source_message_ids)
    ask_ids = set(answer.source_ask_ids)
    return Explanation(
        id=explanation_id,
        message_id=selected["id"],
        meaning=answer.meaning,
        confidence=answer.confidence,
        kind=answer.kind,
        sources=[row for row in payload["history"] if row["id"] in source_ids],
        human_sources=[row for row in human if row["id"] in ask_ids],
        can_ask_sender=answer.kind == "unknown" and selected["sender_id"] != user_id,
        sender_name=selected["sender_name"],
    )
