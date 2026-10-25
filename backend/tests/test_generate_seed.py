"""Seed generator timing (backend/scripts/generate_seed.py) and the loader's anchor."""

import importlib.util
import random
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from app.seed import anchored_now

_path = Path(__file__).parents[1] / "scripts" / "generate_seed.py"
_spec = importlib.util.spec_from_file_location("generate_seed", _path)
assert _spec and _spec.loader
gen: Any = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gen)

CHI = ZoneInfo("America/Chicago")
ANCHOR = {"local": "2026-10-25T12:00:00", "tz": "America/Chicago"}


def burst(n: int, at: datetime | None) -> list[dict[str, Any]]:
    return [
        {"sender": "a", "text": "x", "at": at if i == 0 else None} for i in range(n)
    ]


def test_assign_times_keeps_hints() -> None:
    start, end = datetime(2026, 10, 24, 19, 20), datetime(2026, 10, 25, 2, 40)
    sec = gen.Section(id="s", start=start, end=end, count=90, pace="chill")
    a = burst(60, datetime(2026, 10, 24, 19, 21))  # chill pace overruns 40 minutes
    b = burst(10, datetime(2026, 10, 24, 20, 0))
    c = burst(10, datetime(2026, 10, 24, 19, 50))  # goes backwards: dropped
    msgs = a + b + c
    gen.assign_times(sec, msgs, random.Random(1))
    ts = [m["ts"] for m in msgs]
    assert ts == sorted(ts) and start <= ts[0] and ts[-1] <= end
    assert a[0]["ts"] == datetime(2026, 10, 24, 19, 21)
    assert b[0]["ts"] == datetime(2026, 10, 24, 20, 0)  # never moved
    assert a[-1]["ts"] < b[0]["ts"] and b[-1]["ts"] < c[0]["ts"]


def local(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=CHI)


def test_anchor_keeps_weekday_and_clock() -> None:
    cases = {
        "2026-10-25T13:00": "2026-10-25T12:00",  # just after: exact anchor
        "2026-10-24T20:50": "2026-10-18T12:00",  # a day early: previous week
        "2026-11-03T10:00": "2026-11-01T12:00",  # across DST: same wall clock
    }
    for real, want in cases.items():
        assert anchored_now(ANCHOR, local(real)) == local(want), real
    early = local("2026-10-25T09:00")  # a few hours early: real time, small drift
    assert anchored_now(ANCHOR, early) == early
