// Lore v2 for the mock API: the in-memory store, pins, and events built from the mock chat's
// own messages the way the server's `_events()` does it (deterministic, no model).
import type {
  Lore,
  LoreCounts,
  LoreDetail,
  LoreEvent,
  LoreFeed,
  LoreFeedQuery,
  LoreReplay,
  LoreSnippet,
  Message,
} from '../types';
import { DAY, glossary, groups, messages, MIN, userById } from './data';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const ms = (iso: string) => new Date(iso).getTime();

export type MockLore = Omit<
  Lore,
  'group_name' | 'people' | 'hero_kind' | 'events' | 'media' | 'cover' | 'message_count' | 'photo_count' | 'replay_count' | 'kept_by' | 'pinned'
> & {
  people: string[];
  message_ids: number[];
  replays: LoreReplay[];
  kept_by: string | null;
  /** Muse's pick for the hero photo; ignored unless it is one of the moment's photos. */
  hero_message_id: number | null;
  /** Detection score in [0, 1], the deck's main signal. */
  score: number;
};

export const loreById = new Map<number, MockLore>();
let nextLoreId = 1;
export const newLoreId = () => nextLoreId++;

// ---------------------------------------------------------------------------
// Events and snippets
// ---------------------------------------------------------------------------
export const MAX_EVENTS = 6;
const SNIPPET_CHARS = 140;
/** Per-event snippet caps: the feed shows ≤3 events with ≤3 snippets each; detail shows every event. */
export type EventLimits = { events: number; photo: number; quote: number; spoken: number; after: number };
export const FEED_LIMITS: EventLimits = { events: 3, photo: 3, quote: 3, spoken: 3, after: 0 };
export const DETAIL_LIMITS: EventLimits = { events: MAX_EVENTS, photo: 4, quote: 4, spoken: 3, after: 2 };

const EMOJI_ONLY = /^[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u200d\ufe0f\s]+$/u;
const HAS_EMOJI = /\p{Extended_Pictographic}/u;
const LAUGHTER = /😭|😂|💀|\blmf?ao+\b|\blol+\b|\bdead\b|\bno way\b|\bha(ha)+\b/i;
const LOGISTICS = /^(ok+|okay|k+|omw)[.!]*$|\bwhat time\b|\bwhere are\b/i;

const clip = (text: string) => (text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS - 1).trimEnd()}…` : text);

type ScoreContext = { anchor: Message | null; at: number; keys: Set<number>; terms: string[] };

/** The spec's snippet score: replies, key lines, reactions and laughs up; logistics and distance down. */
export function snippetScore(m: Message, ctx: ScoreContext) {
  const text = m.text.trim();
  let score = 0;
  if (ctx.anchor && m.reply_to === ctx.anchor.id) score += 3;
  if (ctx.keys.has(m.id)) score += 2;
  score += Math.min(3, m.reactions.length);
  if (!ctx.anchor || m.sender_id !== ctx.anchor.sender_id) score += 1;
  if (ctx.terms.some((t) => text.toLowerCase().includes(t.toLowerCase()))) score += 0.5;
  if (EMOJI_ONLY.test(text) || LAUGHTER.test(text)) score += 1;
  if (LOGISTICS.test(text) || (text.length < 3 && !HAS_EMOJI.test(text))) score -= 2;
  score -= (0.1 * Math.abs(ms(m.ts) - ctx.at)) / MIN;
  return score;
}

function snippetOf(m: Message, reason: LoreSnippet['reason'], viewer: string | undefined): LoreSnippet {
  return {
    message_id: m.id,
    user: m.sender_id ? (userById.get(m.sender_id) ?? null) : null,
    text: clip(m.text),
    ts: m.ts,
    reactions: m.reactions,
    reason,
    start_ms: null,
    is_me: !!viewer && m.sender_id === viewer,
  };
}

function reasonFor(m: Message, ctx: ScoreContext): LoreSnippet['reason'] {
  if (ctx.anchor && m.reply_to === ctx.anchor.id) return 'reply';
  if (ctx.keys.has(m.id)) return 'key';
  if (m.reactions.length) return 'reaction';
  return 'after';
}

/** Top `n` by score, at most 2 per sender, at least one line not from `author` when one exists. */
function pickTop(scored: { m: Message; score: number }[], n: number, author: string | null) {
  const ranked = [...scored].sort((a, b) => b.score - a.score || a.m.id - b.m.id);
  const picked: typeof ranked = [];
  const perSender = new Map<string | null, number>();
  for (const s of ranked) {
    if (picked.length >= n) break;
    const c = perSender.get(s.m.sender_id) ?? 0;
    if (c >= 2) continue;
    perSender.set(s.m.sender_id, c + 1);
    picked.push(s);
  }
  if (author && picked.length && picked.every((s) => s.m.sender_id === author)) {
    const other = ranked.find((s) => s.m.sender_id !== author);
    if (other) picked[picked.length - 1] = other;
  }
  return picked.map((s) => s.m);
}

const byTs = (a: { ts: string }, b: { ts: string }) => a.ts.localeCompare(b.ts);
const reactionCount = (m: Message) => m.reactions.length;

/** Text lines near a photo: the next 40 ids within 15 min, plus replies to it within a day. */
function photoCandidates(p: Message, pool: Message[]) {
  const at = ms(p.ts);
  return pool.filter(
    (m) =>
      m.kind === 'text' &&
      m.id !== p.id &&
      ((m.id > p.id && m.id <= p.id + 40 && ms(m.ts) <= at + 15 * MIN) || (m.reply_to === p.id && ms(m.ts) - at <= DAY)),
  );
}

type EventInput = Pick<MockLore, 'message_ids' | 'replays' | 'hero_message_id' | 'terms'>;

/**
 * A moment's events: one per photo, one per replay, or a single quote when it has no media.
 * events[0] is the hero (Muse's photo, else the most-reacted photo, else the first replay, else
 * the quote); the rest follow oldest first. `pool` is the group's messages.
 */
export function buildEvents(l: EventInput, pool: Message[], viewer?: string, limits: EventLimits = DETAIL_LIMITS): LoreEvent[] {
  const keys = new Set(l.message_ids);
  const terms = l.terms.map((t) => t.term);
  const keyMsgs = pool.filter((m) => keys.has(m.id)).sort((a, b) => a.id - b.id);
  const photos = keyMsgs.filter((m) => m.kind === 'photo');
  const events: LoreEvent[] = [];

  // Photos: each candidate line goes to its nearest photo (a reply goes to the photo it answers).
  const owner = new Map<number, Message>();
  for (const p of photos) {
    for (const m of photoCandidates(p, pool)) {
      const cur = owner.get(m.id);
      const closer = !cur || Math.abs(ms(m.ts) - ms(p.ts)) < Math.abs(ms(m.ts) - ms(cur.ts));
      if (m.reply_to === p.id || (closer && cur?.id !== m.reply_to)) owner.set(m.id, p);
    }
  }
  for (const p of photos) {
    const ctx: ScoreContext = { anchor: p, at: ms(p.ts), keys, terms };
    const caption = p.text.trim() ? [snippetOf(p, 'caption', viewer)] : [];
    const scored = photoCandidates(p, pool)
      .filter((m) => owner.get(m.id)?.id === p.id)
      .map((m) => ({ m, score: snippetScore(m, ctx) }));
    const lines = pickTop(scored, Math.max(0, limits.photo - caption.length), p.sender_id)
      .sort(byTs)
      .map((m) => snippetOf(m, reasonFor(m, ctx), viewer));
    events.push({ kind: 'photo', at: p.ts, message: p, replay: null, snippets: [...caption, ...lines] });
  }

  // Replays: the speaker turns around the signal (about 4 s before the clip ends), then the chat after.
  for (const r of l.replays) {
    const signal = Math.max(0, r.duration_ms - 4000);
    const turns: { user_id: string; text: string; start_ms: number; end_ms: number }[] = [];
    for (const c of r.captions.filter((c) => c.end_ms > signal - 8000 && c.start_ms < signal + 4000)) {
      const last = turns[turns.length - 1];
      if (last && last.user_id === c.user_id) {
        last.text = `${last.text} ${c.text}`;
        last.end_ms = c.end_ms;
      } else turns.push({ ...c });
    }
    const mid = (t: (typeof turns)[number]) => Math.abs((t.start_ms + t.end_ms) / 2 - signal);
    const spoken = [...turns]
      .sort((a, b) => mid(a) - mid(b))
      .slice(0, limits.spoken)
      .sort((a, b) => a.start_ms - b.start_ms)
      .map(
        (t): LoreSnippet => ({
          message_id: null,
          user: userById.get(t.user_id) ?? null,
          text: clip(t.text),
          ts: new Date(ms(r.started_at) + t.start_ms).toISOString(),
          reactions: [],
          reason: 'spoken',
          start_ms: t.start_ms,
          is_me: t.user_id === viewer,
        }),
      );
    const end = ms(r.started_at) + r.duration_ms;
    const ctx: ScoreContext = { anchor: null, at: end, keys, terms };
    const after = pool
      .filter((m) => m.kind === 'text' && ms(m.ts) > end && ms(m.ts) <= end + 10 * MIN)
      .map((m) => ({ m, score: snippetScore(m, ctx) }))
      .filter((s) => s.score >= 2);
    const afterLines = pickTop(after, limits.after, null)
      .sort(byTs)
      .map((m) => snippetOf(m, 'after', viewer));
    events.push({ kind: 'replay', at: r.started_at, message: null, replay: r, snippets: [...spoken, ...afterLines] });
  }

  // Quote: only without media. The most-reacted key line (earliest on ties), its replies, then key lines.
  if (!events.length) {
    const texts = keyMsgs.filter((m) => m.kind === 'text');
    const anchor = texts.reduce<Message | null>((best, m) => (!best || reactionCount(m) > reactionCount(best) ? m : best), null);
    if (anchor) {
      const ctx: ScoreContext = { anchor, at: ms(anchor.ts), keys, terms };
      const replies = pool.filter((m) => m.kind === 'text' && m.reply_to === anchor.id).sort(byTs);
      const rest = texts
        .filter((m) => m.id !== anchor.id && m.reply_to !== anchor.id)
        .map((m) => ({ m, score: snippetScore(m, ctx) }));
      const picked = [...replies.slice(0, limits.quote), ...pickTop(rest, limits.quote - Math.min(replies.length, limits.quote), null)];
      events.push({
        kind: 'quote',
        at: anchor.ts,
        message: anchor,
        replay: null,
        snippets: picked.sort(byTs).map((m) => snippetOf(m, m.reply_to === anchor.id ? 'reply' : 'key', viewer)),
      });
    }
  }

  const heroIdx = Math.max(0, heroIndex(events, l.hero_message_id));
  const [hero] = events.splice(heroIdx, 1);
  return hero ? [hero, ...events.sort(byAt)].slice(0, limits.events) : [];
}

const byAt = (a: LoreEvent, b: LoreEvent) => a.at.localeCompare(b.at);

function heroIndex(events: LoreEvent[], heroMessageId: number | null) {
  const muse = events.findIndex((e) => e.kind === 'photo' && e.message?.id === heroMessageId);
  if (muse >= 0) return muse;
  let best = -1;
  events.forEach((e, i) => {
    if (e.kind !== 'photo' || !e.message) return;
    const top = best >= 0 ? events[best].message! : null;
    if (!top || reactionCount(e.message) > reactionCount(top) || (reactionCount(e.message) === reactionCount(top) && e.at < top.ts)) best = i;
  });
  if (best >= 0) return best;
  return events.findIndex((e) => e.kind === 'replay');
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
const pins = new Map<string, number>(); // `${userId}:${loreId}` → pin order
let pinSeq = 0;
const pinKey = (userId: string, loreId: number) => `${userId}:${loreId}`;
export const isPinned = (loreId: number, userId?: string) => !!userId && pins.has(pinKey(userId, loreId));

export function groupName(groupId: number, viewer?: string) {
  const g = groups.find((x) => x.id === groupId);
  if (!g) throw new Error(`group ${groupId} not found`);
  if (!g.is_dm || !viewer) return g.name;
  const other = g.members.find((m) => m.user_id !== viewer)?.user_id ?? viewer;
  return userById.get(other)?.display_name ?? g.name;
}

const groupPool = (groupId: number) => messages.filter((m) => m.group_id === groupId);
const heroKind = (events: LoreEvent[]): LoreEvent['kind'] => events[0]?.kind ?? 'quote';

export function loreView(l: MockLore, viewer?: string, limits: EventLimits = FEED_LIMITS): Lore {
  const { message_ids: _ids, replays: _r, hero_message_id: _h, score: _s, ...rest } = l;
  const msgs = messages.filter((m) => l.message_ids.includes(m.id));
  const photos = msgs.filter((m) => m.kind === 'photo');
  const events = buildEvents(l, groupPool(l.group_id), viewer, limits);
  const hero = events[0];
  return clone({
    ...rest,
    group_name: groupName(l.group_id, viewer),
    people: l.people.map((p) => userById.get(p)).filter((x): x is NonNullable<typeof x> => !!x),
    hero_kind: heroKind(events),
    events,
    media: photos.slice(0, MAX_EVENTS),
    cover: { photo: hero?.kind === 'photo' ? hero.message : null, replay: hero?.replay ?? null },
    message_count: msgs.length,
    photo_count: photos.length,
    replay_count: l.replays.length,
    kept_by: l.kept_by ? (userById.get(l.kept_by) ?? null) : null,
    pinned: isPinned(l.id, viewer),
  });
}

export function loreDetail(l: MockLore, viewer: string): LoreDetail {
  const msgs = messages.filter((m) => l.message_ids.includes(m.id));
  const related = [...loreById.values()].filter((x) => x.id !== l.id && x.group_id === l.group_id && x.status === 'kept').slice(0, 6);
  return clone({
    ...loreView(l, viewer, DETAIL_LIMITS),
    messages: msgs,
    photos: msgs.filter((m) => m.kind === 'photo'),
    replays: l.replays,
    related: related.map((r) => loreView(r, viewer)),
  });
}

// ---------------------------------------------------------------------------
// Feed and pins
// ---------------------------------------------------------------------------
const MEDIA_WEIGHT: Record<LoreEvent['kind'], number> = { photo: 1, replay: 0.8, quote: 0, video: 1 };
const HALF_LIFE_DAYS = 14;

/** The deck's rank for unpinned moments: 0.6·score + 0.25·recency (14-day half-life) + 0.15·media. */
export function deckRank(l: MockLore, kind: LoreEvent['kind'], now = Date.now()) {
  const ageDays = Math.max(0, (now - ms(l.ended_at)) / DAY);
  return 0.6 * l.score + 0.25 * 0.5 ** (ageDays / HALF_LIFE_DAYS) + 0.15 * MEDIA_WEIGHT[kind];
}

export function queryFeed(userId: string, q: LoreFeedQuery = {}): LoreFeed {
  const mine = new Set(groups.filter((g) => g.members.some((m) => m.user_id === userId)).map((g) => g.id));
  const needle = q.q?.trim().toLowerCase() ?? '';
  const scope = [...loreById.values()]
    .filter((l) => l.status === 'kept' && mine.has(l.group_id) && (q.group_id == null || l.group_id === q.group_id))
    .filter((l) => !needle || l.title.toLowerCase().includes(needle))
    .map((l) => ({ l, view: loreView(l, userId) }));

  const counts: LoreCounts = { photo: 0, replay: 0, quote: 0, pinned: 0 };
  for (const { view } of scope) {
    if (view.hero_kind !== 'video') counts[view.hero_kind]++;
    if (view.pinned) counts.pinned++;
  }

  const pinOrder = (l: MockLore) => pins.get(pinKey(userId, l.id)) ?? -1;
  const recent = (a: MockLore, b: MockLore) => b.ended_at.localeCompare(a.ended_at) || b.id - a.id;
  const hits = scope
    .filter(({ view }) => (!q.kind || view.hero_kind === q.kind) && (!q.pinned || view.pinned))
    .sort((a, b) =>
      q.sort === 'deck'
        ? pinOrder(b.l) - pinOrder(a.l) || deckRank(b.l, b.view.hero_kind) - deckRank(a.l, a.view.hero_kind) || recent(a.l, b.l)
        : q.pinned
          ? pinOrder(b.l) - pinOrder(a.l)
          : recent(a.l, b.l),
    );
  const start = q.cursor ? Number(q.cursor) : 0;
  const limit = q.limit ?? 20;
  return {
    items: hits.slice(start, start + limit).map((h) => h.view),
    next_cursor: start + limit < hits.length ? String(start + limit) : null,
    counts,
  };
}

function assertMember(l: MockLore, userId: string) {
  const g = groups.find((x) => x.id === l.group_id);
  if (!g?.members.some((m) => m.user_id === userId)) throw new Error('Not a member of this group');
}

export function setPinned(l: MockLore, userId: string, pinned: boolean) {
  assertMember(l, userId);
  const key = pinKey(userId, l.id);
  if (!pinned) pins.delete(key);
  else if (!pins.has(key)) pins.set(key, ++pinSeq);
}

// ---------------------------------------------------------------------------
// Sample moments from the volleyball chat (in memory, rebuilt on reload)
// ---------------------------------------------------------------------------
const SAMPLES: { title: string; match: RegExp; terms: string[]; score: number }[] = [
  { title: "Swayam's house becomes Grandma's", match: /grandma/i, terms: ["Grandma's"], score: 0.9 },
  { title: 'Leo names the usual spot', match: /usual spot/i, terms: ['usual spot'], score: 0.7 },
  { title: 'Someone calls a code yellow at practice', match: /code yellow/i, terms: ['code yellow'], score: 0.6 },
  { title: 'Net Results wins the team name vote', match: /net results/i, terms: [], score: 0.5 },
];

export function seedLore() {
  if (loreById.size) return;
  const vbId = groups[0].id;
  const vb = groupPool(vbId).filter((m) => m.kind !== 'system');
  for (const s of SAMPLES) {
    const hits = vb.filter((m) => s.match.test(m.text) || s.match.test(m.image_description ?? ''));
    if (!hits.length) continue;
    const at = vb.indexOf(hits[0]);
    const around = vb.slice(Math.max(0, at - 2), at + 4);
    const ids = [...new Set([...around, ...hits.slice(1, 3)].map((m) => m.id))].sort((a, b) => a - b);
    const picked = vb.filter((m) => ids.includes(m.id));
    const id = newLoreId();
    loreById.set(id, {
      id,
      group_id: vbId,
      title: s.title,
      status: 'kept',
      source: 'chat',
      call_id: null,
      started_at: picked[0].ts,
      ended_at: picked[picked.length - 1].ts,
      people: [...new Set(picked.map((m) => m.sender_id).filter((x): x is string => !!x))],
      terms: s.terms.map((term) => ({ term, glossary_id: glossary.find((g) => g.term.toLowerCase() === term.toLowerCase().replace(/'s$/, ''))?.id ?? null })),
      anchor_message_id: null,
      message_ids: ids,
      replays: [],
      kept_by: null,
      kept_at: picked[picked.length - 1].ts,
      hero_message_id: null,
      score: s.score,
    });
  }
  // One waiting suggestion near the end of the chat, for the inline Keep card.
  const tail = vb.slice(-6);
  const id = newLoreId();
  loreById.set(id, {
    id,
    group_id: vbId,
    title: 'The group argues over who drives Saturday',
    status: 'suggested',
    source: 'chat',
    call_id: null,
    started_at: tail[0].ts,
    ended_at: tail[tail.length - 1].ts,
    people: [...new Set(tail.map((m) => m.sender_id).filter((x): x is string => !!x))],
    terms: [],
    anchor_message_id: tail[tail.length - 1].id,
    message_ids: tail.map((m) => m.id),
    replays: [],
    kept_by: null,
    kept_at: null,
    hero_message_id: null,
    score: 0.5,
  });
}

export function mustLore(id: number): MockLore {
  seedLore();
  const l = loreById.get(id);
  if (!l) throw new Error('Lore not found');
  return l;
}
