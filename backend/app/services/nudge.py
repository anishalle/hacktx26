"""Feature 2: pre-send clarity nudge (glossary match, rewrite, unknown terms, aside).

/check is pure glossary matching against an in-memory per-group cache (no LLM).
Offsets in responses are JS string indices (UTF-16 code units).
"""

import asyncio
import difflib
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import cache, lru_cache
from pathlib import Path
from typing import Any, get_args

from sqlalchemy import func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.core.config import settings
from app.models import Glossary, Membership, Message, NudgeDismissal
from app.services import llm
from app.services.messages import require_member

log = logging.getLogger(__name__)

GLOSSARY_TTL_S = 60.0  # safety net for glossary rows written outside this module
UNKNOWN_CACHE_TTL_S = 600.0
UNKNOWN_TIMEOUT_S = 2.7  # client gives up at 3 s and sends anyway
UNKNOWN_HEDGE_S = 1.3  # Muse latency is usually ~1-2 s with 8-14 s outliers
UNKNOWN_CONTEXT_MESSAGES = 30
REWRITE_TIMEOUT_S = 4.5  # /rewrite and /aside fall back to a deterministic edit
REWRITE_HEDGE_S = 1.8
MAX_GROWTH = 3  # rewritten may be at most 3x the draft (or draft + 120 chars)
TERM_NEWCOMER_DAYS = 30  # older joiners have had time to pick a term up
ISSUED_TTL_S = 3600.0  # rewrite/aside snippets that count as explanations when sent
AUTO_OVERRIDE_CONFIDENCE = 0.5  # an aside may replace auto meanings below this

# ---------------------------------------------------------------- text helpers

_APOS = "['’]"
_WORD = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)*")
_TOKEN = re.compile(r"\w+(?:['’]\w+)*|[^\w\s]")


def utf16_offsets(text: str) -> list[int]:
    """offsets[i] = UTF-16 index of Python index i (len(text)+1 entries)."""
    out, pos = [0], 0
    for ch in text:
        pos += 2 if ord(ch) > 0xFFFF else 1
        out.append(pos)
    return out


def _utf16_span(offsets: list[int] | None, start: int, end: int) -> tuple[int, int]:
    return (offsets[start], offsets[end]) if offsets else (start, end)


def _offsets_for(text: str) -> list[int] | None:
    return utf16_offsets(text) if any(ord(c) > 0xFFFF for c in text) else None


@cache
def common_words() -> frozenset[str]:
    path = Path(__file__).parent / "data" / "common_words.txt"
    return frozenset(path.read_text().split())


def _word_variants(word: str) -> set[str]:
    w = word.lower().replace("’", "'")
    out = {w}
    for suffix in ("'s", "'"):
        if w.endswith(suffix):
            out.add(w[: -len(suffix)])
    for v in list(out):
        if re.search(r"(.)\1\1", v):  # gooo -> go / goo
            out |= {re.sub(r"(.)\1{2,}", r"\1", v), re.sub(r"(.)\1{2,}", r"\1\1", v)}
    for v in list(out):
        for suffix, repl in (
            ("ies", "y"), ("es", ""), ("s", ""), ("ed", ""), ("ed", "e"), ("d", ""),
            ("ing", ""), ("ing", "e"), ("ly", ""), ("er", ""), ("est", ""),
        ):  # fmt: skip
            if v.endswith(suffix) and len(v) - len(suffix) >= 3:
                out.add(v[: -len(suffix)] + repl)
    return out


def is_common(word: str) -> bool:
    return not _word_variants(word).isdisjoint(common_words())


def _norm(s: str) -> str:
    return " ".join(s.lower().replace("’", "'").split())


def _damerau1(a: str, b: str) -> bool:
    """True if a and b are exactly one edit apart (incl. one transposition)."""
    if a == b or abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        diff = [i for i in range(len(a)) if a[i] != b[i]]
        return len(diff) == 1 or (
            len(diff) == 2
            and diff[1] == diff[0] + 1
            and a[diff[0]] == b[diff[1]]
            and a[diff[1]] == b[diff[0]]
        )
    short, long_ = sorted((a, b), key=len)
    i = next((i for i in range(len(short)) if short[i] != long_[i]), len(short))
    return short[i:] == long_[i + 1 :]


# ------------------------------------------------------------- glossary cache


@dataclass(frozen=True)
class Term:
    id: int
    term: str
    aliases: tuple[str, ...]
    meaning: str
    kind: str
    origin: datetime  # coalesce(last_explained_ts, first_seen_ts)


@dataclass(frozen=True)
class Match:
    term: Term
    start: int  # Python indices
    end: int
    text: str


class GlossaryIndex:
    def __init__(self, terms: list[Term]) -> None:
        self.terms = terms
        self.by_name: dict[str, Term] = {}
        forms: list[tuple[str, Term]] = []
        for t in terms:
            for form in (t.term, *t.aliases):
                if form.strip():
                    forms.append((form.strip(), t))
                    self.by_name.setdefault(_norm(form), t)
        forms.sort(key=lambda f: -len(f[0]))
        self._forms = forms
        self._fuzzy = [
            (_norm(f).replace("'", ""), t)
            for f, t in forms
            if " " not in f.strip() and len(f) >= 5
        ]
        alts = "|".join(f"(?P<f{i}>{_form_regex(f)})" for i, (f, _) in enumerate(forms))
        self._regex = (
            re.compile(
                rf"(?<!\w)(?:{alts})(?:{_APOS}s|{_APOS}|es|s)?(?!\w)", re.IGNORECASE
            )
            if forms
            else None
        )

    def lookup(self, name: str) -> Term | None:
        return self.by_name.get(_norm(name))

    def resolve(self, name: str) -> Term | None:
        """Term for a canonical name, alias, or any whole form /check matches
        (FlaggedTerm.matched_text such as "the usual spots" or "grnadma's")."""
        if hit := self.lookup(name):
            return hit
        name = name.strip()
        whole = [m for m in self.find(name) if m.start == 0 and m.end == len(name)]
        return whole[0].term if whole else None

    def find(self, text: str) -> list[Match]:
        if self._regex is None:
            return []
        out = [
            Match(self._forms[int(m.lastgroup[1:])][1], m.start(), m.end(), m.group())
            for m in self._regex.finditer(text)
            if m.lastgroup
        ]
        out += self._fuzzy_find(text, out)
        return sorted(out, key=lambda m: m.start)

    def _fuzzy_find(self, text: str, taken: list[Match]) -> list[Match]:
        """One-typo matches for single-word forms ("grnadma's"); skips real words."""
        if not self._fuzzy:
            return []
        out = []
        for w in _WORD.finditer(text):
            if any(m.start < w.end() and w.start() < m.end for m in taken):
                continue
            word = w.group()
            if len(word) < 5 or is_common(word):
                continue
            bare = re.sub(rf"{_APOS}s?$", "", word.lower())
            for cand in {bare, bare.replace("'", "").replace("’", "")}:
                hit = next((t for f, t in self._fuzzy if _damerau1(cand, f)), None)
                if hit:
                    out.append(Match(hit, w.start(), w.end(), word))
                    break
        return out


def _form_regex(form: str) -> str:
    words = re.split(r"[\s\-]+", form)
    parts = [re.sub(_APOS, f"{_APOS}?", re.escape(w)) for w in words]
    return r"[\s\-]+".join(parts)


# ------------------------------------------------------ already explained?

_STOP = frozenset(
    "the and for are but not you all any can was one our out has had how its may "
    "now who did get let say too use with that this from they have what when were "
    "will your which their there about would these other into than then them some "
    "also been just like where after before because group it's".split()
)
_EXPLAIN_MARK = re.compile(
    r"\s*(?:[(\[]|[-–—:=]\s|,?\s*(?:i\.?e\.?|aka|a\.k\.a\.?|which is|meaning|means)"
    r"(?!\w))",
    re.IGNORECASE,
)
EXPLAIN_SCORE = 3  # meaning keywords near a term: rare words count 2, common 1


@lru_cache(maxsize=4096)
def _keywords(term: Term) -> tuple[tuple[frozenset[str], int], ...]:
    # the term's own words; alias words only if rare ("house" in "grandma's house"
    # can still be part of an explanation)
    own = set(_WORD.findall(term.term))
    own |= {w for a in term.aliases for w in _WORD.findall(a) if not is_common(w)}
    own_variants = {v for w in own for v in _word_variants(w)}
    out: list[tuple[frozenset[str], int]] = []
    for w in _WORD.findall(term.meaning):
        key = w.lower().replace("’", "'").removesuffix("'s")
        variants = frozenset(_word_variants(w))
        if len(key) < 3 or key in _STOP or variants & own_variants:
            continue
        if not any(variants & seen for seen, _ in out):  # "taco" / "Tacos" once
            out.append((variants, 1 if is_common(w) else 2))
    return tuple(out)


def _meaning_score(term: Term, text: str) -> int:
    seen = {v for w in _WORD.findall(text) for v in _word_variants(w)}
    return sum(weight for variants, weight in _keywords(term) if variants & seen)


def explained(text: str, m: Match, *, strict: bool = False) -> bool:
    """Does `text` already explain m's term next to the match? Meaning words nearby
    count; non-strict also accepts a "(", " - ", ", aka" ... right after it."""
    window = f"{text[max(0, m.start - 60) : m.start]} {text[m.end : m.end + 80]}"
    if _meaning_score(m.term, window) >= EXPLAIN_SCORE:
        return True
    return not strict and bool(_EXPLAIN_MARK.match(text, m.end))


_glossary_cache: dict[int, tuple[float, GlossaryIndex]] = {}
_unknown_cache: dict[tuple[int, str], tuple[float, list[str]]] = {}
_issued: dict[int, list[tuple[float, str, frozenset[int]]]] = {}


def invalidate_glossary(group_id: int | None = None) -> None:
    """Drop cached glossary (and unknown-term results); call after writing glossary
    rows. None clears every group."""
    if group_id is None:
        _glossary_cache.clear()
        _unknown_cache.clear()
        _issued.clear()
        return
    _glossary_cache.pop(group_id, None)
    for key in [k for k in _unknown_cache if k[0] == group_id]:
        _unknown_cache.pop(key, None)


async def glossary_index(session: AsyncSession, group_id: int) -> GlossaryIndex:
    hit = _glossary_cache.get(group_id)
    if hit and time.monotonic() - hit[0] < GLOSSARY_TTL_S:
        return hit[1]
    rows = await session.scalars(
        select(Glossary).where(Glossary.group_id == group_id).order_by(Glossary.id)
    )
    index = GlossaryIndex(
        [
            Term(
                r.id,
                r.term,
                tuple(r.aliases or ()),
                r.meaning,
                r.kind,
                r.last_explained_ts or r.first_seen_ts,
            )
            for r in rows
        ]
    )
    _glossary_cache[group_id] = (time.monotonic(), index)
    return index


# ------------------------------------------------------------------ members


async def _members(
    session: AsyncSession, group_id: int, user_id: str
) -> list[Membership]:
    memberships = await crud.list_memberships(session, group_id)
    if not any(m.user_id == user_id for m in memberships):
        await require_member(session, group_id, user_id)  # raises 404 / 403
    return memberships


async def _dismissed(session: AsyncSession, group_id: int, user_id: str) -> set[str]:
    rows = await session.scalars(
        select(NudgeDismissal.term).where(
            NudgeDismissal.group_id == group_id, NudgeDismissal.user_id == user_id
        )
    )
    return {_norm(t) for t in rows}


def _term_newcomers(
    memberships: list[Membership], sender: str, term: Term
) -> list[Membership]:
    """Members (not the sender) who joined after the term's origin, within the last
    TERM_NEWCOMER_DAYS."""
    recent = datetime.now(UTC) - timedelta(days=TERM_NEWCOMER_DAYS)
    cutoff = max(term.origin, recent)
    return [m for m in memberships if m.user_id != sender and m.joined_at > cutoff]


def _badge_newcomers(memberships: list[Membership], sender: str) -> list[Membership]:
    now = datetime.now(UTC)
    return [m for m in memberships if m.user_id != sender and crud.is_newcomer(m, now)]


def _newcomer_view(m: Membership) -> schemas.Newcomer:
    return schemas.Newcomer(
        user_id=m.user_id, display_name=m.user.display_name, joined_at=m.joined_at
    )


def _first_name(m: Membership) -> str:
    return (m.user.display_name or m.user_id).split()[0]


def _member_names(memberships: list[Membership]) -> set[str]:
    names: set[str] = set()
    for m in memberships:
        names.add(m.user_id.lower())
        names.update(re.split(r"[._\-\s]+", m.user.username.lower()))
        names.update(m.user.display_name.lower().split())
    return {n for n in names if n}


# ----------------------------------------------------------------- messages


def humanize_ago(ts: datetime, now: datetime | None = None) -> str:
    secs = max(0, ((now or datetime.now(UTC)) - ts).total_seconds())
    mins, hours, days = int(secs // 60), int(secs // 3600), int(secs // 86400)
    if mins < 1:
        return "just now"
    if hours < 1:
        return "a minute ago" if mins == 1 else f"{mins} minutes ago"
    if days < 1:
        return "an hour ago" if hours == 1 else f"{hours} hours ago"
    if days == 1:
        return "yesterday"
    if days < 7:
        return f"{days} days ago"
    if days < 14:
        return "last week"
    if days < 60:
        return f"{days // 7} weeks ago"
    if days < 365:
        return f"{days // 30} months ago"
    return "over a year ago"


def _join(items: list[str], conj: str) -> str:
    if len(items) <= 2:
        return f" {conj} ".join(items)
    return f"{', '.join(items[:-1])}, {conj} {items[-1]}"


def _who(newcomers: list[Membership]) -> str:
    names = [_first_name(m) for m in newcomers]
    if len(names) > 3:
        names = [*names[:2], f"{len(names) - 2} others"]
    return _join(names, "and")


def check_message(
    newcomers: list[Membership], terms: list[str], now: datetime | None = None
) -> str:
    """'Priya joined 2 days ago and might not know "Grandma" or "usual spot." ...'"""
    newcomers = sorted(newcomers, key=lambda m: m.joined_at)
    quoted = _join([f'"{t}"' for t in terms], "or")
    quoted = quoted[:-1] + '."'  # American style: period inside the closing quote
    if len(newcomers) == 1:
        m = newcomers[0]
        when = humanize_ago(m.joined_at, now)
        joined = "joined just now" if when == "just now" else f"joined {when}"
        return f"{_first_name(m)} {joined} and might not know {quoted} Rewrite for {_first_name(m)}?"  # noqa: E501
    secs = ((now or datetime.now(UTC)) - newcomers[0].joined_at).total_seconds()
    days = -int(-secs // 86400)  # ceil
    when = (
        "recently"
        if days <= settings.NEWCOMER_BADGE_DAYS
        else f"in the last {days} days"
    )
    return (
        f"{_who(newcomers)} joined {when} and might not know {quoted} Rewrite for them?"  # noqa: E501
    )


def unknown_message(newcomers: list[Membership], n_terms: int) -> str:
    many = n_terms > 1
    first = (
        "These look like inside references and I can't find where they're explained."
        if many
        else "This looks like an inside reference and I can't find where it's "
        "explained."
    )
    who = _who(sorted(newcomers, key=lambda m: m.joined_at))
    verb = "doesn't" if len(newcomers) == 1 else "don't"
    return f"{first} {who} probably {verb} know {'them' if many else 'it'}. Add a quick aside?"  # noqa: E501


# -------------------------------------------------------------------- check


async def check(
    session: AsyncSession, body: schemas.NudgeCheckRequest
) -> schemas.NudgeCheck:
    memberships = await _members(session, body.group_id, body.user_id)
    index = await glossary_index(session, body.group_id)
    matches = index.find(body.draft)
    if not matches:
        return schemas.NudgeCheck(show=False)
    dismissed = await _dismissed(session, body.group_id, body.user_id)
    offsets = _offsets_for(body.draft)
    flagged: list[schemas.FlaggedTerm] = []
    newcomers: dict[str, Membership] = {}
    terms: list[str] = []
    for m in matches:
        if _norm(m.term.term) in dismissed or explained(body.draft, m):
            continue
        who = _term_newcomers(memberships, body.user_id, m.term)
        if not who:
            continue
        start, end = _utf16_span(offsets, m.start, m.end)
        flagged.append(
            schemas.FlaggedTerm(
                term=m.term.term,
                glossary_id=m.term.id,
                matched_text=m.text,
                start=start,
                end=end,
                meaning=m.term.meaning,
                kind=m.term.kind,
                newcomer_ids=[n.user_id for n in who],
            )
        )
        newcomers.update((n.user_id, n) for n in who)
        if m.term.term not in terms:
            terms.append(m.term.term)
    if not flagged:
        return schemas.NudgeCheck(show=False)
    people = sorted(newcomers.values(), key=lambda m: m.joined_at)
    return schemas.NudgeCheck(
        show=True,
        flagged_terms=flagged,
        newcomers=[_newcomer_view(m) for m in people],
        message=check_message(people, terms),
    )


# ------------------------------------------------------------ rewrite / diff


def diff_spans(draft: str, rewritten: str) -> list[schemas.Span]:
    """Spans of inserted/replaced text in `rewritten` (word-level, UTF-16)."""
    offsets = _offsets_for(rewritten)
    return [
        schemas.Span(start=s, end=e)
        for s, e in (
            _utf16_span(offsets, s, e) for s, e in _diff_ranges(draft, rewritten)
        )
    ]


def _diff_ranges(draft: str, rewritten: str) -> list[tuple[int, int]]:
    a = [m.group() for m in _TOKEN.finditer(draft)]
    b_tokens = list(_TOKEN.finditer(rewritten))
    b = [m.group() for m in b_tokens]
    spans: list[list[int]] = []
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    for op, _, _, j1, j2 in sm.get_opcodes():
        if op in ("insert", "replace") and j2 > j1:
            start, end = b_tokens[j1].start(), b_tokens[j2 - 1].end()
            if spans and not rewritten[spans[-1][1] : start].strip():
                spans[-1][1] = end
            else:
                spans.append([start, end])
    return [(s, e) for s, e in spans]


def _short_meaning(meaning: str) -> str:
    s = re.split(r"(?<=[.!?])\s", meaning.strip(), maxsplit=1)[0].rstrip(".!? ")
    if len(s) > 60 and "," in s:
        s = s.split(",", 1)[0]
    first = s.split(" ", 1)[0]
    if first and first.lower() != "i" and first.lower() in common_words():
        s = s[0].lower() + s[1:]
    return s


def deterministic_rewrite(draft: str, items: list[tuple[str, str, int | None]]) -> str:
    """Insert " (<meaning>)" after the first occurrence of each term.

    items: (term, meaning, end index of its first match in draft or None).
    """
    inserts: list[tuple[int, str]] = []
    tail: list[str] = []
    for term, meaning, end in items:
        note = _short_meaning(meaning)
        if end is None:
            tail.append(f"{term}: {note}")
        else:
            inserts.append((end, f" ({note})"))
    out = draft
    for pos, text in sorted(inserts, reverse=True):
        out = out[:pos] + text + out[pos:]
    if tail:
        out = f"{out.rstrip()} ({'; '.join(tail)})"
    return out


def _words(text: str) -> list[str]:
    return [w.lower().replace("’", "'") for w in _WORD.findall(text)]


def acceptable_rewrite(draft: str, rewritten: str | None) -> bool:
    if not isinstance(rewritten, str) or not rewritten.strip():
        return False
    if rewritten.strip() == draft.strip():
        return False
    if len(rewritten) > max(MAX_GROWTH * len(draft), len(draft) + 120):
        return False
    original = _words(draft)
    if not original:
        return True
    kept = set(_words(rewritten))
    stems = {w.removesuffix("'s") for w in kept}
    present = sum(1 for w in original if w in kept or w.removesuffix("'s") in stems)
    return present / len(original) >= 0.6


_VOICE_RULES = """You edit a chat message so a newcomer to the group can follow it.
Rules:
- Keep the sender's exact voice: same casing (all-lowercase stays lowercase), slang, \
punctuation style and tone. Keep every original word you can.
- Only add a SHORT parenthetical or clause explaining the listed terms, using the \
given meanings (a few words each, not the whole meaning).
- Do not explain anything else, do not add emojis, greetings or sign-offs, do not \
make it more formal.
- Mention a newcomer's name only if it reads naturally (usually don't)."""

REWRITE_SYSTEM = (
    _VOICE_RULES + '\nReturn JSON only: {"rewritten": "<the edited message>"}'
)

ASIDE_SYSTEM = (
    _VOICE_RULES
    + "\nThe sender just told you what the term means; weave that into the message."
    + '\nReturn JSON only: {"rewritten": "<the edited message>", "kind": '
    '"nickname|place|event|slang|person|inside_joke"}'
)


async def _llm_rewrite(system: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    """One hedged LLM call capped at REWRITE_TIMEOUT_S; None means use the fallback."""
    user = json.dumps(payload, ensure_ascii=False)
    try:
        return await hedged(
            lambda: llm.complete_json(system, user),
            hedge_after=REWRITE_HEDGE_S,
            timeout=REWRITE_TIMEOUT_S,
        )
    except Exception as exc:  # LLMError, timeouts, transport errors
        log.warning("nudge rewrite LLM failed: %r", exc)
        return None


def _remember_explanations(
    group_id: int, draft: str, rewritten: str, term_ids: list[int]
) -> None:
    """Keep the text a rewrite/aside added so sending it marks the terms explained."""
    now = time.monotonic()
    items = [i for i in _issued.get(group_id, []) if now - i[0] < ISSUED_TTL_S]
    for s, e in _diff_ranges(draft, rewritten):
        if len(snippet := _norm(rewritten[s:e])) >= 4:
            items.append((now, snippet, frozenset(term_ids)))
    _issued[group_id] = items[-200:]


async def rewrite(
    session: AsyncSession, body: schemas.NudgeRewriteRequest
) -> schemas.NudgeRewriteResponse:
    memberships = await _members(session, body.group_id, body.user_id)
    index = await glossary_index(session, body.group_id)
    await session.commit()  # don't hold a pooled connection across the LLM call
    matches = index.find(body.draft)
    terms: list[Term] = []
    for t in map(index.resolve, body.terms):
        if t and t not in terms:
            terms.append(t)
    if not terms:  # none given or none resolved: every unexplained term in the draft
        for m in matches:
            if m.term not in terms and not explained(body.draft, m):
                terms.append(m.term)
    if not terms or not body.draft.strip():
        return schemas.NudgeRewriteResponse(rewritten=body.draft, changes=[])
    newcomers = {
        n.user_id: n
        for t in terms
        for n in _term_newcomers(memberships, body.user_id, t)
    }
    payload = {
        "message": body.draft,
        "terms": [{"term": t.term, "meaning": t.meaning} for t in terms],
        "newcomers": [_first_name(m) for m in newcomers.values()],
    }
    data = await _llm_rewrite(REWRITE_SYSTEM, payload)
    rewritten = data.get("rewritten") if data else None
    if not acceptable_rewrite(body.draft, rewritten):
        log.info("nudge rewrite: using deterministic fallback")
        first_end = {}
        for m in matches:
            first_end.setdefault(m.term.id, m.end)
        rewritten = deterministic_rewrite(
            body.draft, [(t.term, t.meaning, first_end.get(t.id)) for t in terms]
        )
    assert isinstance(rewritten, str)
    _remember_explanations(body.group_id, body.draft, rewritten, [t.id for t in terms])
    return schemas.NudgeRewriteResponse(
        rewritten=rewritten, changes=diff_spans(body.draft, rewritten)
    )


# ------------------------------------------------------------------ unknown


def suspicious_tokens(draft: str, index: GlossaryIndex, names: set[str]) -> list[str]:
    """Words that aren't common English, a glossary term, or a member name."""
    covered = [(m.start, m.end) for m in index.find(draft)]
    out = []
    for w in _WORD.finditer(draft):
        if any(s < w.end() and w.start() < e for s, e in covered):
            continue
        word = w.group()
        if len(word) < 2 or is_common(word):
            continue
        if not _word_variants(word).isdisjoint(names):
            continue
        out.append(word)
    return out


def _locate(draft: str, terms: list[str]) -> list[tuple[str, int, int]]:
    found: list[tuple[str, int, int]] = []
    lower = draft.lower()
    for term in terms:
        term = term.strip() if isinstance(term, str) else ""
        if not term:
            continue
        i = draft.find(term)
        if i < 0:
            i = lower.find(term.lower())
        if i < 0:
            continue
        span = (draft[i : i + len(term)], i, i + len(term))
        if not any(s < span[2] and span[1] < e for _, s, e in found):
            found.append(span)
    return sorted(found, key=lambda f: f[1])


UNKNOWN_SYSTEM = """You help a group chat app spot inside references before a message \
is sent. A newcomer just joined the group. Given the draft message, the group's known \
glossary, member names and recent messages, list the words or short phrases in the \
draft that are inside references (nicknames, private place names, inside jokes, \
group-specific events) a newcomer could not understand AND that are not already in the \
glossary. Ordinary English, common slang, well-known places/brands, member names and \
glossary terms are NOT inside references. Copy each span exactly as it appears in the \
draft. Most messages have none.
Return JSON only: {"unknown_terms": ["<exact span>", ...]}"""


async def _recent_lines(session: AsyncSession, group_id: int) -> list[str]:
    rows = (
        await session.execute(
            select(Message.sender_id, Message.text)
            .where(Message.group_id == group_id, Message.kind == "text")
            .order_by(Message.id.desc())
            .limit(UNKNOWN_CONTEXT_MESSAGES)
        )
    ).all()
    return [f"{s}: {t}" for s, t in reversed(rows)]


async def hedged[T](
    factory: Callable[[], Awaitable[T]], *, hedge_after: float, timeout: float
) -> T:
    """Run factory(); if it hasn't finished after hedge_after, race a second copy.
    First success wins; raises TimeoutError after `timeout` (or the last error)."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    pending = {asyncio.ensure_future(factory())}
    hedged_yet, error = False, None
    try:
        while pending:
            wait = deadline - loop.time()
            if not hedged_yet:
                wait = min(wait, hedge_after)
            if wait <= 0:
                raise TimeoutError
            done, pending = await asyncio.wait(
                pending, timeout=wait, return_when=asyncio.FIRST_COMPLETED
            )
            for task in done:
                if task.exception() is None:
                    return task.result()
                error = task.exception()
            if not done and not hedged_yet and loop.time() < deadline - 0.1:
                hedged_yet = True
                pending.add(asyncio.ensure_future(factory()))
        raise error or TimeoutError
    finally:
        for task in pending:
            task.cancel()


async def unknown(
    session: AsyncSession, body: schemas.NudgeUnknownRequest
) -> schemas.NudgeUnknown:
    memberships = await _members(session, body.group_id, body.user_id)
    newcomers = _badge_newcomers(memberships, body.user_id)
    if not newcomers or len(body.draft.split()) < 3:
        return schemas.NudgeUnknown(show=False)
    index = await glossary_index(session, body.group_id)
    names = _member_names(memberships)
    dismissed = await _dismissed(session, body.group_id, body.user_id)
    dismissed_words = {
        v for d in dismissed for w in _WORD.findall(d) for v in _word_variants(w)
    }
    suspects = [
        w
        for w in suspicious_tokens(body.draft, index, names)
        if _word_variants(w).isdisjoint(dismissed_words)
    ]
    if not suspects:
        await session.commit()
        return schemas.NudgeUnknown(show=False)

    key = (body.group_id, _norm(body.draft))
    hit = _unknown_cache.get(key)
    if hit and time.monotonic() - hit[0] < UNKNOWN_CACHE_TTL_S:
        terms = hit[1]
    else:
        payload = {
            "draft": body.draft,
            "glossary": [t.term for t in index.terms],
            "member_names": sorted({m.user.display_name for m in memberships}),
            "words_not_in_dictionary": suspects,
            "recent_messages": await _recent_lines(session, body.group_id),
        }
        await session.commit()  # don't hold a pooled connection across the LLM call
        try:
            user = json.dumps(payload, ensure_ascii=False)
            data = await hedged(
                lambda: llm.complete_json(UNKNOWN_SYSTEM, user, max_tokens=2000),
                hedge_after=UNKNOWN_HEDGE_S,
                timeout=UNKNOWN_TIMEOUT_S,
            )
        except Exception as exc:  # timeout or LLM failure: let the send go through
            log.warning("nudge unknown check skipped: %r", exc)
            return schemas.NudgeUnknown(show=False)
        raw = data.get("unknown_terms")
        terms = [t for t in raw if isinstance(t, str)] if isinstance(raw, list) else []
        _unknown_cache[key] = (time.monotonic(), terms)

    located = [
        (text, s, e)
        for text, s, e in _locate(body.draft, terms)
        if index.lookup(text) is None
        and not index.find(text)
        and _norm(text) not in names
        and _norm(text) not in dismissed
    ]
    if not located:
        return schemas.NudgeUnknown(show=False)
    offsets = _offsets_for(body.draft)
    out = []
    for text, s, e in located:
        start, end = _utf16_span(offsets, s, e)
        out.append(schemas.UnknownTerm(term=text, start=start, end=end))
    people = sorted(newcomers, key=lambda m: m.joined_at)
    return schemas.NudgeUnknown(
        show=True,
        unknown_terms=out,
        newcomers=[_newcomer_view(m) for m in people],
        message=unknown_message(people, len(out)),
    )


# -------------------------------------------------------------------- aside

_KINDS = set(get_args(schemas.GlossaryKind))


async def aside(
    session: AsyncSession, body: schemas.NudgeAsideRequest
) -> schemas.NudgeAsideResponse:
    await _members(session, body.group_id, body.user_id)
    term, meaning = body.term.strip(), body.meaning.strip()
    index = await glossary_index(session, body.group_id)
    await session.commit()  # don't hold a pooled connection across the LLM call
    payload = {
        "message": body.draft,
        "term": term,
        "meaning_from_sender": meaning,
    }
    data = await _llm_rewrite(ASIDE_SYSTEM, payload)
    rewritten = data.get("rewritten") if data else None
    if not acceptable_rewrite(body.draft, rewritten):
        log.info("nudge aside: using deterministic fallback")
        known = index.resolve(term)
        end = next(
            (m.end for m in index.find(body.draft) if known and m.term.id == known.id),
            None,
        )
        if end is None and (hit := _locate(body.draft, [term])):
            end = hit[0][2]
        rewritten = deterministic_rewrite(body.draft, [(term, meaning, end)])
    assert isinstance(rewritten, str)
    kind = data.get("kind") if data else None
    glossary_id = await upsert_human_term(
        session, body.group_id, term, meaning, kind if kind in _KINDS else None
    )
    _remember_explanations(body.group_id, body.draft, rewritten, [glossary_id])
    return schemas.NudgeAsideResponse(
        rewritten=rewritten,
        changes=diff_spans(body.draft, rewritten),
        glossary_id=glossary_id,
    )


def _like_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


async def upsert_human_term(
    session: AsyncSession, group_id: int, term: str, meaning: str, kind: str | None
) -> int:
    """Save a member-provided term (source "human") and invalidate caches.

    A new row's first_seen_ts is the term's earliest mention in the group, so members
    who joined since stay covered until the explanation is actually sent (see
    record_explanations). An existing term keeps its meaning unless it was a
    low-confidence auto guess; an aside never touches last_explained_ts.
    """
    index = await glossary_index(session, group_id)
    known = index.resolve(term)
    row = (
        await session.get(Glossary, known.id)
        if known
        else await session.scalar(
            select(Glossary).where(
                Glossary.group_id == group_id,
                func.lower(Glossary.term) == term.lower(),
            )
        )
    )
    if row is None:
        first = await session.scalar(
            select(func.min(Message.ts)).where(
                Message.group_id == group_id,
                Message.kind == "text",
                Message.text.ilike(f"%{_like_escape(term)}%", escape="\\"),
            )
        )
        row = Glossary(
            group_id=group_id,
            term=term,
            aliases=[],
            meaning=meaning,
            kind=kind or "inside_joke",
            confidence=1.0,
            source="human",
            first_seen_ts=first or datetime.now(UTC),
            source_message_ids=[],
        )
        session.add(row)
    elif row.source == "auto" and row.confidence < AUTO_OVERRIDE_CONFIDENCE:
        row.meaning, row.source, row.confidence = meaning, "human", 1.0
    else:
        await session.commit()
        return row.id
    await session.commit()
    invalidate_glossary(group_id)
    return row.id


# ------------------------------------------------------------------ dismiss


async def dismiss(session: AsyncSession, body: schemas.NudgeDismissRequest) -> None:
    await _members(session, body.group_id, body.user_id)
    index = await glossary_index(session, body.group_id)
    known = index.resolve(body.term)
    term = _norm(known.term if known else body.term)
    if not term:
        return
    await session.execute(
        pg_insert(NudgeDismissal)
        .values(user_id=body.user_id, group_id=body.group_id, term=term)
        .on_conflict_do_nothing()
    )
    await session.commit()


# ------------------------------------------------------------ on send


async def record_explanations(
    session: AsyncSession, group_id: int, text: str, ts: datetime
) -> list[int]:
    """Called after a message is sent: set last_explained_ts = ts on glossary terms
    the message explains (it carries text a rewrite/aside produced, or meaning words
    sit next to the term). Never raises; returns the updated glossary ids."""
    try:
        matches = (await glossary_index(session, group_id)).find(text)
        now, norm = time.monotonic(), _norm(text)
        issued = {
            tid
            for t0, snippet, ids in _issued.get(group_id, [])
            if now - t0 < ISSUED_TTL_S and snippet in norm
            for tid in ids
        }
        ids = sorted(
            {
                m.term.id
                for m in matches
                if m.term.id in issued or explained(text, m, strict=True)
            }
        )
        if ids:
            await session.execute(
                update(Glossary)
                .where(
                    Glossary.id.in_(ids),
                    or_(
                        Glossary.last_explained_ts.is_(None),
                        Glossary.last_explained_ts < ts,
                    ),
                )
                .values(last_explained_ts=ts)
            )
            await session.commit()
            invalidate_glossary(group_id)
        return ids
    except Exception:
        log.exception("nudge: recording explanations failed")
        await session.rollback()
        return []
