"""Deterministic synthetic chat; contains no exported or real personal data."""

from datetime import datetime, timedelta, timezone

USERS = [("priya", "Priya"), ("swayam", "Swayam"), ("alex", "Alex")]
GROUP_ID = "longhorns"


def demo_messages() -> list[dict]:
    start = datetime(2026, 9, 1, 12, tzinfo=timezone.utc)
    chatter = [
        "Anyone heading to the library after class?",
        "I can bring snacks for study night.",
        "The bus is running a little late today.",
        "Thanks for sending the notes!",
        "See you at the dining hall at noon.",
        "I finally finished that assignment.",
        "Does anyone have an extra phone charger?",
        "It's a beautiful day on campus.",
    ]
    planted = {
        24: ("alex", "Why do you all keep calling Swayam's house Grandma's?"),
        25: (
            "swayam",
            "Grandma is our nickname for my house, because of the floral couches.",
        ),
        26: (
            "alex",
            "Got it, Grandma's means Swayam's house, not an actual grandmother.",
        ),
        47: ("swayam", "We usually go to Grandma's after football games."),
        153: (
            "alex",
            "The usual spot means the picnic tables behind the student union.",
        ),
        154: ("swayam", "Yep, when we say usual spot we mean those picnic tables."),
        435: ("swayam", "Grandma's after the game."),
        436: ("alex", "Meet at the usual spot first?"),
        437: ("swayam", "Bring the moon waffle."),
        438: ("alex", "ok see you at 7"),
        439: ("priya", "Just joined! Excited to meet you all."),
    }
    rows = []
    for index in range(440):
        sender, text = planted.get(
            index, (["swayam", "alex"][index % 2], chatter[index % len(chatter)])
        )
        rows.append(
            {
                "id": f"demo-{index:04d}",
                "group_id": GROUP_ID,
                "sender_id": sender,
                "ts": start + timedelta(hours=index),
                "text": text,
            }
        )
    return rows
