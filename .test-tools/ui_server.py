import os
os.environ["DATABASE_URL"] = "postgresql://postgres@127.0.0.1:55432/newcomer_ui"
os.environ["FRONTEND_HOST"] = "http://127.0.0.1:8089"
from alembic import command
from alembic.config import Config
from app import bedrock
from app.commands import seed
from app.main import app
import uvicorn

command.upgrade(Config("alembic.ini"), "head")
seed()
bedrock.embed = lambda text: [0.1] * 1024

def explain(payload):
    text = payload["selected"]["text"]
    if "moon waffle" in text:
        answers = payload.get("private_answers", [])
        if answers:
            return {"meaning": answers[0]["answer"], "confidence": .99,
                    "kind": "nickname", "source_ask_ids": [answers[0]["id"]]}
        return {"meaning": "Unknown.", "confidence": .1, "kind": "unknown"}
    return {"meaning": "**Grandma** is the group's nickname for Swayam's house.",
            "confidence": .95, "kind": "nickname",
            "source_message_ids": ["demo-0025"]}
bedrock.explain = explain
uvicorn.run(app, host="127.0.0.1", port=8011)
