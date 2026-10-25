"""Generate the demo seed fixture from a hand-written outline with the Muse LLM.

    uv run python backend/scripts/generate_seed.py               # build the fixture
    uv run python backend/scripts/generate_seed.py --regen dm_x  # regenerate one group
    uv run python backend/scripts/generate_seed.py --regen volleyball \
        --keep-before 2026-10-23T12:00                # regenerate only the newer part
    uv run python backend/scripts/generate_seed.py --verify-only # check the fixture

Three separate steps, so real chats can replace generated ones later:

1. generate: outline sections -> LLM batches -> a transcript per group, a list of
   {"sender", "kind", "text", "ts" (nominal local ISO time), "reply_to", "script"}.
   Transcripts live in backend/scripts/transcripts/<key>.json, are committed and are
   the source of truth: hand-fix them there. Only groups without a transcript (or
   named by --regen) go to the LLM. Every LLM reply is cached in .cache/llm keyed by
   its prompt, so reruns are deterministic and free. A real chat export converted to
   the transcript shape skips the LLM; its glossary origins use {"find": {...}}.
2. build: transcript + outline (members, read state, terms) -> seed fixture JSON
   (format: backend/app/seed/README.md). Times become offsets before nominal_now,
   and the fixture's "anchor" lets the loader keep weekdays and clock times right.
3. verify: ordering, glossary origins, term usage; exits non-zero on failure.
"""

import argparse
import asyncio
import hashlib
import json
import logging
import math
import random
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import openai

from app.core.config import settings
from app.services import llm

HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
DEFAULT_OUTLINE = HERE / "seed_outline.json"
DEFAULT_OUT = HERE.parent / "app" / "seed" / "fixtures" / "demo.json"
DEFAULT_TRANSCRIPTS = HERE / "transcripts"
TAIL = 20
MAX_ATTEMPTS = 6
log = logging.getLogger("generate_seed")

Msg = dict[str, Any]

SYSTEM = (
    "You write realistic, fictional group-chat transcripts used as demo data for a "
    "messaging app. Follow the outline exactly. Output a single JSON object only."
)

# (weight, min s, max s) for the gap between consecutive messages in one conversation
PACES = {
    "chill": [(0.45, 5, 60), (0.3, 60, 300), (0.18, 300, 1800), (0.07, 1800, 5400)],
    "normal": [(0.55, 4, 30), (0.3, 30, 120), (0.12, 120, 600), (0.03, 600, 1800)],
    "heated": [(0.7, 2, 15), (0.25, 15, 60), (0.05, 60, 300)],
}
# relative chance a conversation starts in each local hour
ACTIVITY = [0.6, 0.4, 0.2, 0.08, 0.03, 0.02, 0.02, 0.04, 0.15, 0.4, 0.6, 0.7]
ACTIVITY += [0.8, 0.8, 0.8, 0.8, 0.85, 0.9, 1.0, 1.0, 1.0, 1.0, 0.95, 0.8]
EXPLAINS = re.compile(
    r"\b(means?|meaning|is when|like when|basically|aka|named after|refers?|who is)\b"
)
PLACEHOLDER = re.compile(r"\[[^\]]*(photo|pic|image|video|screenshot|gif)", re.I)
FUNNY = re.compile(r"lmao|lol|😭|💀|😂|haha|dead|crying|bro|no way", re.I)


def norm(text: str) -> str:
    return re.sub(r"[’']", "", text.lower())


def when(s: str) -> datetime:
    return datetime.fromisoformat(s)


@dataclass
class Term:
    term: str
    aliases: list[str]
    meaning: str = ""
    kind: str = "inside_joke"
    hint: str = ""
    glossary: bool = False
    origin: dict[str, Any] | None = None
    explain_markers: list[str] = field(default_factory=list)
    never_explain: bool = False

    def __post_init__(self) -> None:
        alts = sorted({norm(n) for n in [self.term, *self.aliases]}, key=len)[::-1]
        body = "|".join(re.escape(a) for a in alts)
        self.pattern = re.compile(rf"(?<![a-z0-9])(?:{body})(?![a-z0-9])")

    def found(self, text: str) -> bool:
        return bool(self.pattern.search(norm(text)))

    def explained_in(self, text: str, before: list[str] = []) -> str | None:  # noqa: B006
        """Why `text` explains the term (itself or replying to recent `before`)."""
        t = norm(text)
        if not self.pattern.search(t) and not any(map(self.found, before)):
            return None
        if self.never_explain:
            return "explains or asks about it" if EXPLAINS.search(t) else None
        return next((m for m in self.explain_markers if norm(m) in t), None)


@dataclass
class Section:
    id: str
    start: datetime
    end: datetime
    count: int
    pace: str = "normal"
    context: str = ""
    beats: list[Any] = field(default_factory=list)
    use_terms: list[str] = field(default_factory=list)
    after: str | None = None


@dataclass
class GroupSpec:
    raw: dict[str, Any]
    key: str
    terms: list[Term]
    scripts: dict[str, list[Msg]]
    timeline: list[Section | dict[str, Any]]
    speakers: list[str]
    script_at: dict[str, tuple[int, int]] = field(default_factory=dict)

    @classmethod
    def parse(cls, g: dict[str, Any], batch_size: int) -> "GroupSpec":
        timeline: list[Section | dict[str, Any]] = []
        for item in g["timeline"]:
            if "system" in item:
                timeline.append(item)
                continue
            fields = {
                k: v for k, v in item.items() if k in Section.__dataclass_fields__
            }
            fields["start"], fields["end"] = when(item["start"]), when(item["end"])
            timeline.append(Section(**fields))
        spec = cls(
            raw=g,
            key=g["key"],
            terms=[Term(**t) for t in g.get("terms", [])],
            scripts=g.get("scripts", {}),
            timeline=timeline,
            speakers=[m["user"] for m in g["members"] if not m.get("silent")],
        )
        prev_end: datetime | None = None
        for pos, item in enumerate(timeline):
            start = item.start if isinstance(item, Section) else when(item["at"])
            end = item.end if isinstance(item, Section) else start
            if prev_end and start < prev_end:
                raise SystemExit(
                    f"{spec.key}: timeline item {pos} overlaps the previous"
                )
            prev_end = end
            if isinstance(item, Section):
                for b, (_, beats) in enumerate(batch_plan(item, batch_size)):
                    if script := batch_script(beats):
                        spec.script_at[script] = (pos, b)
        return spec

    def origin(self, term: Term) -> tuple[int, int]:
        """(timeline pos, batch) that introduces the term; (-1, 0) = always known."""
        if term.origin and "script" in term.origin:
            return self.script_at[term.origin["script"]]
        return (-1, 0)


# ---------------------------------------------------------------- LLM + cache


SEM: asyncio.Semaphore


async def cached_json(user: str, max_tokens: int) -> dict[str, Any]:
    blob = json.dumps([settings.LLM_MODEL, SYSTEM, user, max_tokens])
    path = CACHE / "llm" / f"{hashlib.sha256(blob.encode()).hexdigest()[:24]}.json"
    if path.exists():
        return json.loads(path.read_text())
    async with SEM:
        data = await llm.complete_json(SYSTEM, user, max_tokens=max_tokens)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    return data


def beat_text(b: Any, done: bool = False) -> str:
    """A beat is a string or {"beat", "script"?, "done"?}; "done" is the state line
    later batches of the same section see instead of the beat itself."""
    if not isinstance(b, dict):
        return b
    return b.get("done", b["beat"]) if done else b["beat"]


def batch_script(beats: list[Any]) -> str | None:
    return next(
        (b["script"] for b in beats if isinstance(b, dict) and "script" in b), None
    )


def batch_plan(sec: Section, size: int) -> list[tuple[int, list[Any]]]:
    """Split a section into batches of <= size messages, beats spread in order."""
    n = max(1, math.ceil(sec.count / size))
    counts = [sec.count // n + (i < sec.count % n) for i in range(n)]
    beats: list[list[Any]] = [[] for _ in range(n)]
    for i, beat in enumerate(sec.beats):
        beats[i * n // len(sec.beats)].append(beat)
    return list(zip(counts, beats, strict=True))


def render_prompt(
    outline: dict[str, Any],
    spec: GroupSpec,
    cur: tuple[int, int],
    sec: Section,
    count: int,
    beats: list[Any],
    tail: list[Msg],
    feedback: list[str] | None,
    done: list[Any] = [],  # noqa: B006
    after: datetime | None = None,
) -> str:
    users = {u["id"]: u for u in outline["users"]}
    raw = spec.raw
    name = raw.get("name") or "direct message"
    lines = [f'CHAT: "{name}", {raw["description"]}.', "", "PEOPLE (sender ids):"]
    lines += [f"- {s}: {users[s]['persona']}" for s in spec.speakers]
    silent = [m["user"] for m in raw["members"] if m.get("silent")]
    lines += [f"- {s} is in the chat but NEVER sends a message" for s in silent]
    fmt = "%a %b %-d %-I:%M%p"
    lines += ["", f"WHEN: {sec.start.strftime(fmt)} to {sec.end.strftime(fmt)}."]
    n_days = (sec.end.date() - sec.start.date()).days + 1
    days = [sec.start.date() + timedelta(d) for d in range(n_days)]
    if n_days > 2:  # the model can't work out weekdays from dates on its own
        lines.append("Calendar: " + ", ".join(f"{d:%a %b} {d.day}" for d in days))
    lines += ["", f"STORY SO FAR: {sec.context}"]

    script = batch_script(beats)
    known, new, banned = [], [], []
    for t in spec.terms:
        o = spec.origin(t)
        if o < cur and (t.glossary or t.term in sec.use_terms):
            known.append(t)
        elif o == cur:
            new.append(t)
        elif o > cur:
            banned.append(t)
    if known:
        lines += [
            "",
            "INSIDE JOKES the group already shares. Use them casually where natural "
            "(not every message). NEVER explain or define them; nobody asks what they "
            "mean:",
        ]
        for t in known:
            what = t.meaning or t.hint
            use = " (work it in at least once)" if t.term in sec.use_terms else ""
            lines.append(f'- "{t.term}": {what}{use}')
    if banned:
        words = ", ".join(f'"{w}"' for t in banned for w in [t.term, *t.aliases])
        lines += ["", f"NOT A THING YET: these words must not appear at all: {words}."]
    if done:
        lines += [
            "",
            "ALREADY HAPPENED EARLIER IN THIS PART (done: never redo, re-announce or "
            "re-vote any of it; people may refer back to it):",
        ]
        lines += [f"- {beat_text(b, done=True)}" for b in done]
    lines += ["", "WHAT HAPPENS IN THIS PART (in order):"]
    lines += [f"- {beat_text(b)}" for b in beats]
    if script:
        lines += [
            "",
            f'SCRIPTED EXCHANGE: where it fits, output exactly one item {{"script": '
            f'"{script}"}}. These messages get inserted there verbatim:',
        ]
        lines += [f"  {m['s']}: {m['t']}" for m in spec.scripts[script]]
        lines.append(
            "Lead into it naturally and react to it afterwards without repeating it."
        )
        for t in new:
            lines.append(
                f'"{t.term}" must not appear before the placeholder; afterwards use it '
                "a couple of times without re-explaining it."
            )
    if tail:
        lines += [
            "",
            "RECENT MESSAGES (continue right after these, don't repeat them):",
        ]
        lines += [f"  {m['sender'] or 'system'}: {m['text']}" for m in tail]
    if after:
        lines.append(f"(they ended around {after.strftime(fmt)}; continue from there)")
    lines += ["", "STYLE:"] + [f"- {s}" for s in outline["style"]]
    lines += [
        "",
        f"Write exactly {count} messages"
        + (
            f" (the scripted exchange counts as {len(spec.scripts[script])})"
            if script
            else ""
        )
        + ". No bracketed placeholders like [photo]; a shared photo is just its "
        'caption or a link. Return {"messages": [{"s": sender id, "t": text, '
        '"new": true only on the first message of a conversation after a pause of an '
        'hour or more, "at": "MM-DD HH:MM" (24h local time, inside WHEN, increasing) '
        'on the first message, on every "new" one and on about every 10th message, '
        '"re": optional 0-based index in this list of an earlier message it directly '
        'replies to (use rarely)}]}. The script placeholder may carry "new" and "at" '
        "too. Make the times fit the content and the weekday (late-night chaos at "
        "night, class talk only on weekdays; clock times people mention match the at "
        "times).",
    ]
    if feedback:
        lines += ["", "YOUR PREVIOUS ATTEMPT WAS REJECTED. Fix these problems:"]
        lines += [f"- {f}" for f in feedback]
    return "\n".join(lines)


def parse_batch(
    data: dict[str, Any],
    spec: GroupSpec,
    cur: tuple[int, int],
    sec: Section,
    count: int,
    script: str | None,
    after: datetime | None = None,
) -> tuple[list[Msg], list[str]]:
    def anchor(item: dict[str, Any]) -> datetime | None:
        """The item's "at" hint, dropped if outside the section or before `after`."""
        try:
            at = datetime.strptime(f"{sec.start.year}-{item['at']}", "%Y-%m-%d %H:%M")
        except (KeyError, TypeError, ValueError):
            return None
        return at if max(sec.start, after or sec.start) <= at <= sec.end else None

    items = data.get("messages")
    if not isinstance(items, list) or not items:
        return [], ['no "messages" list']
    errors: list[str] = []
    out: list[Msg] = []
    first_out: dict[int, int] = {}
    scripted_at: int | None = None
    for i, item in enumerate(items):
        first_out[i] = len(out)
        if not isinstance(item, dict):
            errors.append(f"item {i} is not an object")
        elif "script" in item:
            if item["script"] != script or scripted_at is not None:
                errors.append(f"unexpected script placeholder at item {i}")
                continue
            scripted_at = len(out)
            for j, m in enumerate(spec.scripts[script]):
                out.append(
                    {"sender": m["s"], "text": m["t"], "script": f"{script}:{j}"}
                )
            out[scripted_at]["at"] = anchor(item)
            out[scripted_at]["new"] = bool(item.get("new"))
        else:
            sender, text = item.get("s"), str(item.get("t") or "").strip()
            if sender not in spec.speakers:
                errors.append(f"item {i}: sender {sender!r} is not allowed")
            elif not text or len(text) > 400:
                errors.append(f"item {i}: text must be 1-400 characters")
            elif PLACEHOLDER.search(text):
                errors.append(f'item {i}: "{text}" is a bracketed placeholder')
            else:
                re_ = item.get("re")
                ok = isinstance(re_, int) and 0 <= re_ < i
                out.append(
                    {
                        "sender": sender,
                        "text": text,
                        "new": bool(item.get("new")),
                        "at": anchor(item),
                        "re": first_out[re_] if ok else None,
                    }
                )
    if script and scripted_at is None:
        errors.append(f'missing the {{"script": "{script}"}} placeholder')
    total = len(out)
    if not 0.8 * count <= total <= 1.25 * count:
        errors.append(f"wrote {total} messages, expected about {count}")
    for i, m in enumerate(out):
        if "script" in m:
            continue
        for t in spec.terms:
            o = spec.origin(t)
            early = o > cur or (o == cur and (scripted_at is None or i < scripted_at))
            if early and t.found(m["text"]):
                errors.append(f'message "{m["text"]}" uses "{t.term}" too early')
            elif not early and (
                why := t.explained_in(m["text"], [x["text"] for x in out[i - 3 : i]])
            ):
                errors.append(
                    f'message "{m["text"]}" explains "{t.term}" ({why}); keep it opaque'
                )
    return out, errors


async def generate_batch(
    outline: dict[str, Any],
    spec: GroupSpec,
    pos: int,
    sec: Section,
    b: int,
    count: int,
    beats: list[Any],
    tail: list[Msg],
    done: list[Any],
    after: datetime | None,
) -> list[Msg]:
    script, cur = batch_script(beats), (pos, b)
    feedback: list[str] | None = None
    errors: list[str] = []
    for attempt in range(MAX_ATTEMPTS):
        prompt = render_prompt(
            outline, spec, cur, sec, count, beats, tail, feedback, done, after
        )
        try:
            data = await cached_json(prompt, max_tokens=max(4000, 120 * count))
        except (llm.LLMError, TimeoutError, openai.APIError) as exc:
            log.warning("%s#%d: LLM error %s, retrying", sec.id, b, exc)
            await asyncio.sleep(2 + 3 * attempt)
            continue
        msgs, errors = parse_batch(data, spec, cur, sec, count, script, after)
        if not errors:
            log.info("%s#%d: %d messages", sec.id, b, len(msgs))
            return msgs
        log.warning("%s#%d attempt %d rejected: %s", sec.id, b, attempt + 1, errors[:3])
        feedback = errors[:8]
    raise SystemExit(f"{spec.key}/{sec.id}#{b}: gave up: {errors[:5]}")


def assign_times(sec: Section, msgs: list[Msg], rng: random.Random) -> None:
    """Nominal timestamps. A conversation with an LLM "at" hint starts exactly there
    (hints that don't increase are dropped); others start at a plausible hour after
    the previous one. Messages in a conversation follow the section's pace; a stretch
    that would run into the next hint (or the section end) is compressed, never moved.
    """
    span = (sec.end - sec.start).total_seconds()
    bursts: list[list[Msg]] = []
    for i, m in enumerate(msgs):
        if i == 0 or m.get("new") or m.get("at"):
            bursts.append([])
        bursts[-1].append(m)
    hints: list[float | None] = []
    last = -1.0
    for burst in bursts:
        at = burst[0].get("at")
        t = (at - sec.start).total_seconds() if at else None
        ok = t is not None and last < t <= span
        hints.append(t if ok else None)
        last = t if ok and t is not None else last

    def gap() -> float:
        r, acc = rng.random(), 0.0
        for w, lo, hi in PACES[sec.pace]:
            acc += w
            if r <= acc:
                return rng.uniform(lo, hi)
        return rng.uniform(lo, hi)

    def awake(t: float) -> float:
        while rng.random() > ACTIVITY[(sec.start + timedelta(seconds=t)).hour]:
            t += 1800
        return t

    # segments: a hinted burst and the unhinted bursts after it, up to the next hint
    segments: list[list[list[Msg]]] = []
    starts: list[float] = []
    for burst, hint in zip(bursts, hints, strict=True):
        if hint is not None or not segments:
            segments.append([])
            starts.append(hint if hint is not None else -1.0)
        segments[-1].append(burst)
    stops = [*starts[1:], span]
    if starts[0] < 0:
        starts[0] = min(rng.uniform(0, span * 0.05), stops[0] * 0.5)
    times: list[float] = []
    for segment, t0, stop in zip(segments, starts, stops, strict=True):
        seg: list[float] = []
        for k, burst in enumerate(segment):
            t = awake(seg[-1] + rng.uniform(1800, 5400)) if k else t0
            for j, _ in enumerate(burst):
                t += gap() if j else 0
                seg.append(t)
        room = (stop - t0) * 0.97
        if seg[-1] - t0 > room:
            scale = room / (seg[-1] - t0)
            seg = [t0 + (t - t0) * scale for t in seg]
        times += seg
    for m, t in zip(msgs, times, strict=True):
        m["ts"] = sec.start + timedelta(seconds=t)


async def generate_section(
    outline: dict[str, Any],
    spec: GroupSpec,
    pos: int,
    sec: Section,
    prior: "asyncio.Task[list[Msg]] | None",
) -> list[Msg]:
    tail = (await prior)[-TAIL:] if prior else []
    msgs: list[Msg] = []
    done: list[Any] = []
    after: datetime | None = None
    for b, (count, beats) in enumerate(batch_plan(sec, outline["batch_size"])):
        batch = await generate_batch(
            outline, spec, pos, sec, b, count, beats, tail, done, after
        )
        msgs += batch
        tail = batch[-TAIL:]
        done += beats
        after = max((m["at"] for m in msgs if m.get("at")), default=after)
    assign_times(sec, msgs, random.Random(f"{spec.key}/{sec.id}"))
    return msgs


async def generate_group(
    outline: dict[str, Any],
    spec: GroupSpec,
    keep: list[Msg] | None = None,
    keep_before: datetime | None = None,
) -> list[Msg]:
    """Generate the group's transcript. With `keep`/`keep_before`, messages before
    keep_before are kept as they are and only later timeline items are generated."""
    tasks: dict[str, asyncio.Task[list[Msg]]] = {}
    parts: list[asyncio.Task[list[Msg]] | Msg] = []
    for pos, item in enumerate(spec.timeline):
        if isinstance(item, Section):
            if keep_before and item.start < keep_before:
                continue
            prior = tasks.get(item.after) if item.after else None
            coro = generate_section(outline, spec, pos, item, prior)
            parts.append(tasks.setdefault(item.id, asyncio.create_task(coro)))
        elif not keep_before or when(item["at"]) >= keep_before:
            sys_msg = {"sender": None, "kind": "system", "text": item["system"]}
            parts.append(sys_msg | {"ts": when(item["at"])})
    out: list[Msg] = [
        m for m in keep or [] if keep_before and when(m["ts"]) < keep_before
    ]
    for part in parts:
        batch = await part if isinstance(part, asyncio.Task) else [part]
        base = len(out)
        for m in batch:
            re_ = m.pop("re", None)
            out.append(
                {
                    "sender": m["sender"],
                    "kind": m.get("kind", "text"),
                    "text": m["text"],
                    "ts": m["ts"].isoformat(timespec="seconds"),
                    "reply_to": base + re_ if re_ is not None else None,
                    "script": m.get("script"),
                }
            )
    return out


# ---------------------------------------------------------------------- build


def resolve_origin(spec: GroupSpec, term: Term, tr: list[Msg]) -> dict[str, Any]:
    o = term.origin or {}
    if "script" in o:
        at = {m["script"]: i for i, m in enumerate(tr) if m.get("script")}
        idx = lambda j: at[f"{o['script']}:{j}"]  # noqa: E731
        first, explained = idx(o["first_seen"]), [idx(j) for j in o["explained"]]
        sources = [idx(j) for j in o.get("sources", o["explained"])]
    else:  # {"find": {"first_seen": regex, "explained": [regex], "sources": [regex]}}
        f = o["find"]

        def idx(rx: str) -> int:
            return next(i for i, m in enumerate(tr) if re.search(rx, m["text"], re.I))

        first, explained = idx(f["first_seen"]), [idx(r) for r in f["explained"]]
        sources = [idx(r) for r in f.get("sources", f["explained"])]
    return {
        "term": term.term,
        "aliases": term.aliases,
        "meaning": term.meaning,
        "kind": term.kind,
        "confidence": 1.0,
        "source": "seed",
        "first_seen_idx": first,
        "last_explained_idx": max(explained),
        "source_idxs": sorted(set(sources)),
    }


def build_group(
    spec: GroupSpec, tr: list[Msg], now: datetime, rng: random.Random
) -> dict[str, Any]:
    g = spec.raw
    offset = lambda ts: int((now - when(ts)).total_seconds())  # noqa: E731
    messages: list[Msg] = []
    prev = None
    for i, m in enumerate(tr):
        off = offset(m["ts"])
        if prev is not None and off >= prev:
            off = prev - 1
        if off < 0:
            raise SystemExit(f"{spec.key}: message {i} is after nominal_now")
        prev = off
        msg: Msg = {
            "idx": i,
            "sender_id": m["sender"],
            "text": m["text"],
            "offset_s": off,
        }
        if m["kind"] != "text":
            msg["kind"] = m["kind"]
        if m.get("reply_to") is not None:
            msg["reply_to_idx"] = m["reply_to"]
        messages.append(msg)

    silent = {m["user"] for m in g["members"] if m.get("silent")}
    if rx := g.get("reactions"):
        for msg in messages:
            if msg.get("kind") or rng.random() >= rx["rate"]:
                continue
            pool = [s for s in spec.speakers if s != msg["sender_id"]]
            who = rng.sample(pool, min(len(pool), rng.choices([1, 2, 3], [6, 3, 1])[0]))
            funny = bool(FUNNY.search(msg["text"]))
            emojis = rx["emojis"]
            emoji = emojis[1] if funny and rng.random() < 0.85 else rng.choice(emojis)
            msg["reactions"] = [{"user_id": u, "emoji": emoji} for u in who]

    created = when(tr[0]["ts"]) - timedelta(hours=2)
    last = len(messages) - 1
    members = []
    for m in g["members"]:
        joined = when(m["joined"]) if m.get("joined") else created
        spec_read = m.get("last_read")
        own = [x["idx"] for x in messages if x["sender_id"] == m["user"]]
        if spec_read is None:
            read = None
        elif spec_read == "end":
            read = last
        else:
            n = rng.randint(0, 45) if spec_read == "recent" else spec_read["unread"]
            read = max([last - n, *own[-1:]])
        if m["user"] in silent and own:
            raise SystemExit(f"{spec.key}: silent member {m['user']} sent messages")
        members.append(
            {
                "user_id": m["user"],
                "joined_offset_s": int((now - joined).total_seconds()),
                "last_read_idx": read,
            }
        )
    out: dict[str, Any] = {
        "key": spec.key,
        "name": g.get("name", ""),
        "is_dm": g.get("is_dm", False),
        "created_offset_s": int((now - created).total_seconds()),
        "members": members,
        "messages": messages,
    }
    glossary = [resolve_origin(spec, t, tr) for t in spec.terms if t.glossary]
    if glossary:
        out["glossary"] = glossary
    return out


def build_fixture(
    outline: dict[str, Any], specs: list[GroupSpec], trs: dict[str, list[Msg]]
) -> dict[str, Any]:
    now = when(outline["nominal_now"])
    keep = ("id", "username", "display_name", "avatar_url", "phonetic_hint")
    users = [{k: u[k] for k in keep if k in u} for u in outline["users"]]
    groups = [
        build_group(s, trs[s.key], now, random.Random(f"build/{s.key}")) for s in specs
    ]
    anchor = {"local": outline["nominal_now"], "tz": outline["timezone"]}
    return {"anchor": anchor, "users": users, "groups": groups}


# --------------------------------------------------------------------- verify


def verify(
    outline: dict[str, Any], fixture: dict[str, Any], specs: list[GroupSpec]
) -> list[str]:
    problems: list[str] = []
    user_ids = {u["id"] for u in fixture["users"]}
    by_key = {g["key"]: g for g in fixture["groups"]}
    for spec in specs:
        g = by_key[spec.key]
        msgs = g["messages"]
        members = {m["user_id"]: m for m in g["members"]}
        if set(members) - user_ids:
            problems.append(f"{spec.key}: unknown members {set(members) - user_ids}")
        offs = [m["offset_s"] for m in msgs]
        if any(a <= b for a, b in zip(offs, offs[1:], strict=False)):
            problems.append(f"{spec.key}: offsets are not strictly decreasing")
        for m in msgs:
            if m.get("kind") != "system" and m["sender_id"] not in members:
                problems.append(f"{spec.key}#{m['idx']}: sender is not a member")
            if not m["text"].strip():
                problems.append(f"{spec.key}#{m['idx']}: empty text")
        joins = [m["joined_offset_s"] for m in g["members"]]
        newest = min(joins)
        post = [m for m in msgs if m["offset_s"] < newest]
        rows = {r["term"]: r for r in g.get("glossary", [])}
        for t in spec.terms:
            hits = [m["idx"] for m in msgs if t.found(m["text"])]
            if not t.glossary:
                if t.term in rows:
                    problems.append(
                        f"{spec.key}: {t.term!r} must not have a glossary row"
                    )
                if len(hits) < 3:
                    problems.append(f"{spec.key}: {t.term!r} used {len(hits)}x (< 3)")
                for i in hits:
                    if t.explained_in(msgs[i]["text"]):
                        problems.append(f"{spec.key}#{i}: {t.term!r} explained")
                continue
            r = rows[t.term]
            first = r["first_seen_idx"]
            for key in ("first_seen_idx", "last_explained_idx"):
                if not t.found(msgs[r[key]]["text"]):
                    problems.append(f"{spec.key}: {t.term!r} {key} lacks the term")
            if hits and hits[0] != first:
                problems.append(
                    f"{spec.key}: {t.term!r} first appears at {hits[0]}, not {first}"
                )
            later = [i for i in hits if i > r["last_explained_idx"]]
            post_hits = [m for m in post if t.found(m["text"])]
            if len(later) < 3:
                problems.append(f"{spec.key}: {t.term!r} reused only {len(later)}x")
            if spec.terms and newest < g["created_offset_s"] and not post_hits:
                problems.append(
                    f"{spec.key}: {t.term!r} never used after the last join"
                )
            if msgs[r["last_explained_idx"]]["offset_s"] <= newest:
                problems.append(f"{spec.key}: {t.term!r} explained after the last join")
    return problems


def report(fixture: dict[str, Any], specs: list[GroupSpec]) -> None:
    for g in fixture["groups"]:
        msgs = g["messages"]
        newest = min(m["joined_offset_s"] for m in g["members"])
        post = sum(m["offset_s"] < newest for m in msgs)
        rx = sum(bool(m.get("reactions")) for m in msgs)
        print(
            f"{g['key']}: {len(msgs)} msgs, {post} after last join, {rx} with reactions"
        )
        spec = next(s for s in specs if s.key == g["key"])
        for t in spec.terms:
            hits = [m for m in msgs if t.found(m["text"])]
            n_post = sum(m["offset_s"] < newest for m in hits)
            print(f"  {t.term!r}: {len(hits)} uses, {n_post} after last join")


# ----------------------------------------------------------------------- main


def dump_transcript(tr: list[Msg]) -> str:
    """One message per line, so hand edits diff cleanly."""
    rows = [json.dumps(m, ensure_ascii=False) for m in tr]
    return "[\n" + ",\n".join(rows) + "\n]\n"


async def main(args: argparse.Namespace) -> None:
    global SEM
    SEM = asyncio.Semaphore(args.concurrency)
    settings.LLM_TIMEOUT_S = max(settings.LLM_TIMEOUT_S, 240.0)
    outline = json.loads(args.outline.read_text())
    specs = [GroupSpec.parse(g, outline["batch_size"]) for g in outline["groups"]]
    if args.verify_only:
        fixture = json.loads(args.out.read_text())
    else:
        trs: dict[str, list[Msg]] = {}
        jobs = {}
        regen = set(args.regen or [])
        for spec in specs:
            src = args.transcripts / f"{spec.key}.json"
            old = json.loads(src.read_text()) if src.exists() else None
            if old is not None and not regen & {spec.key, "all"}:
                trs[spec.key] = old
            else:
                keep = args.keep_before if old is not None else None
                jobs[spec.key] = generate_group(outline, spec, old, keep)
        done = await asyncio.gather(*jobs.values())
        args.transcripts.mkdir(parents=True, exist_ok=True)
        for key, tr in zip(jobs, done, strict=True):
            trs[key] = tr
            (args.transcripts / f"{key}.json").write_text(dump_transcript(tr))
        fixture = build_fixture(outline, specs, trs)
        args.out.write_text(json.dumps(fixture, ensure_ascii=False, indent=1) + "\n")
        print(f"wrote {args.out}")
    report(fixture, specs)
    if problems := verify(outline, fixture, specs):
        print("VERIFY FAILED:\n  " + "\n  ".join(problems))
        sys.exit(1)
    print("verify ok")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--outline", type=Path, default=DEFAULT_OUTLINE)
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    p.add_argument("--transcripts", type=Path, default=DEFAULT_TRANSCRIPTS)
    p.add_argument(
        "--regen", action="append", help="group key (or 'all') to regenerate"
    )
    p.add_argument(
        "--keep-before",
        type=when,
        help="with --regen: keep an existing transcript's messages before this time",
    )
    p.add_argument("--concurrency", type=int, default=6)
    p.add_argument("--verify-only", action="store_true")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    asyncio.run(main(p.parse_args()))
