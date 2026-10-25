import AsyncStorage from '@react-native-async-storage/async-storage';

import { mockApi } from '../../api/mock';
import { buildEvents, DETAIL_LIMITS, FEED_LIMITS, snippetScore } from '../../api/mock/lore';
import type { Lore, LoreReplay, Message, Reaction } from '../../api/types';
import { colors } from '../../theme';
import {
  deckOrder,
  getLoreLastSeenAt,
  groupTint,
  isNewSince,
  LORE_TINTS,
  loreDate,
  loreSubtitle,
  loreTint,
  markLoreSeen,
  newestFeedTs,
  peopleLabel,
  tintWash,
} from '../lore';

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 10, 20, 0);
const iso = (offsetMin: number) => new Date(T0 + offsetMin * MIN).toISOString();
const person = (display_name: string) => ({
  id: display_name.toLowerCase(),
  username: display_name.toLowerCase(),
  display_name,
  avatar_url: null,
  phonetic_hint: null,
  pronunciation_audio_url: null,
});

function lore(id: number, keptMin: number | null, endedMin = 0): Pick<Lore, 'id' | 'kept_at' | 'ended_at'> {
  return { id, kept_at: keptMin === null ? null : iso(keptMin), ended_at: iso(endedMin) };
}

describe('deck order and last seen', () => {
  test('moments new since the mark go first, otherwise the server order holds; duplicates drop', () => {
    const items = [lore(1, 10), lore(2, 50), lore(3, null, 70), lore(4, 5), lore(2, 50)];
    expect(deckOrder(items, iso(30)).map((l) => l.id)).toEqual([2, 3, 1, 4]);
    expect(deckOrder(items, null).map((l) => l.id)).toEqual([1, 2, 3, 4]);
    expect(deckOrder(items, 'garbage').map((l) => l.id)).toEqual([1, 2, 3, 4]);
    expect(isNewSince(lore(9, null, 31), iso(30))).toBe(true);
    expect(isNewSince(lore(9, 30), iso(30))).toBe(false);
  });

  test('newestFeedTs picks the latest kept (or ended) time', () => {
    expect(newestFeedTs([lore(1, 10), lore(2, null, 40), lore(3, 20)])).toBe(iso(40));
    expect(newestFeedTs([])).toBeNull();
  });

  test('the mark is per user, only moves forward, and survives storage failures', async () => {
    expect(await getLoreLastSeenAt('maya')).toBeNull();
    await markLoreSeen('maya', iso(20));
    await markLoreSeen('maya', iso(10));
    await markLoreSeen('maya', null);
    expect(await getLoreLastSeenAt('maya')).toBe(iso(20));
    expect(await getLoreLastSeenAt('theo')).toBeNull();
    await markLoreSeen('maya', iso(40));
    expect(await getLoreLastSeenAt('maya')).toBe(iso(40));

    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('nope'));
    expect(await getLoreLastSeenAt('maya')).toBeNull();
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('full'));
    await expect(markLoreSeen('theo', iso(5))).resolves.toBeUndefined();
  });
});

describe('subtitles', () => {
  const now = new Date(2026, 9, 25);
  const moment = {
    group_name: 'Design team',
    started_at: new Date(2026, 9, 10, 21, 41).toISOString(),
    people: ['Maya Johnson', 'Theo Park', 'Sam Rivera', 'Leo Martins'].map(person),
  };

  test('full subtitle: group, weekday date, first names with a count', () => {
    expect(loreSubtitle(moment, { now })).toBe('Design team · Sat, Oct 10 · Maya, Theo +2');
  });

  test('parts can be left out for the card header and list rows', () => {
    expect(loreSubtitle(moment, { group: false, now })).toBe('Sat, Oct 10 · Maya, Theo +2');
    expect(loreSubtitle(moment, { weekday: false, people: false, now })).toBe('Design team · Oct 10');
    expect(loreSubtitle({ ...moment, people: [] }, { now })).toBe('Design team · Sat, Oct 10');
  });

  test('dates add the year only when it differs', () => {
    expect(loreDate(new Date(2025, 11, 31, 9).toISOString(), { now })).toBe('Wed, Dec 31, 2025');
    expect(loreDate(new Date(2026, 9, 12).toISOString(), { weekday: false, now })).toBe('Oct 12');
    expect(loreDate('nope', { now })).toBe('');
  });

  test('people label', () => {
    expect(peopleLabel([])).toBe('');
    expect(peopleLabel([person('Maya Johnson')])).toBe('Maya');
    expect(peopleLabel([person('Maya Johnson'), person('Theo Park')])).toBe('Maya, Theo');
    expect(peopleLabel(moment.people, 3)).toBe('Maya, Theo, Sam +1');
  });
});

describe('tints', () => {
  test('a fixed palette hue per group, neighbours apart, blue for audio', () => {
    expect(LORE_TINTS).toContain(groupTint(1));
    expect(groupTint(4)).toBe(groupTint(4 + LORE_TINTS.length));
    expect(groupTint(1)).not.toBe(groupTint(2));
    expect(groupTint(-3)).toMatch(/^#/);
    expect(new Set([1, 2, 3, 4, 5, 6, 7].map(groupTint)).size).toBe(LORE_TINTS.length);
    expect(loreTint({ group_id: 1, hero_kind: 'replay' })).toBe(colors.blue);
    expect(loreTint({ group_id: 1, hero_kind: 'photo' })).toBe(groupTint(1));
  });

  test('wash', () => {
    expect(tintWash('#FF2D55')).toBe('rgba(255,45,85,0.25)');
    expect(tintWash('#007AFF', 0.5)).toBe('rgba(0,122,255,0.5)');
  });
});

// ---------------------------------------------------------------------------
// Mock events: the same snippet rules the server uses
// ---------------------------------------------------------------------------
let nextId = 100;
function msg(sender: string, text: string, atMin: number, extra: Partial<Message> = {}): Message {
  return { id: nextId++, group_id: 9, sender_id: sender, kind: 'text', text, ts: iso(atMin), reply_to: null, reactions: [], ...extra };
}
const photo = (sender: string, caption: string, atMin: number, extra: Partial<Message> = {}) =>
  msg(sender, caption, atMin, { kind: 'photo', image: { url: 'https://x/p.jpg', width: 4, height: 3 }, ...extra });
const reacts = (n: number): Reaction[] => Array.from({ length: n }, (_, i) => ({ emoji: '😂', user_id: `r${i}` }));

describe('mock buildEvents', () => {
  test('snippet score follows the signal table', () => {
    const p = photo('maya', '', 0);
    const ctx = { anchor: p, at: Date.parse(p.ts), keys: new Set<number>(), terms: ['ramen'] };
    expect(snippetScore(msg('jordan', 'the ramen 😭', 0, { reply_to: p.id, reactions: reacts(5) }), ctx)).toBeCloseTo(3 + 3 + 1 + 0.5 + 1);
    expect(snippetScore(msg('maya', 'ok', 10), ctx)).toBeCloseTo(-2 - 1);
    expect(snippetScore(msg('jordan', 'what time tmrw', 0), ctx)).toBeCloseTo(1 - 2);
  });

  test('photo: caption first, top lines (≤2 per sender) in time order, nearest photo owns a line', () => {
    nextId = 100;
    const p1 = photo('maya', 'ramen alarm round two', 0, { reactions: reacts(1) });
    const lines = [
      msg('jordan', 'LMAO 😭', 1, { reactions: reacts(3) }),
      msg('jordan', 'no way he did that', 2, { reactions: reacts(2) }),
      msg('jordan', 'dead', 3, { reactions: reacts(2) }),
      msg('maya', 'ok', 4),
      msg('sam', 'mike again??', 5),
    ];
    const p2 = photo('sam', '', 12);
    const late = msg('leo', 'x'.repeat(200), 13, { reactions: reacts(1) });
    const reply = msg('mike', 'in my defense the pot was cursed', 6, { reply_to: p1.id });
    const pool = [p1, ...lines, p2, late, reply];
    const events = buildEvents({ message_ids: [p1.id, p2.id], replays: [], hero_message_id: null, terms: [] }, pool, 'jordan');

    expect(events.map((e) => [e.kind, e.message?.id])).toEqual([
      ['photo', p1.id], // most reacted photo is the hero
      ['photo', p2.id],
    ]);
    const [first, second] = events;
    expect(first.snippets[0]).toMatchObject({ reason: 'caption', message_id: p1.id, text: 'ramen alarm round two' });
    expect(first.snippets).toHaveLength(DETAIL_LIMITS.photo);
    expect(first.snippets.filter((s) => s.user?.id === 'jordan')).toHaveLength(2);
    expect(first.snippets.map((s) => s.message_id)).not.toContain(lines[3].id); // "ok" is logistics
    expect(first.snippets.find((s) => s.message_id === reply.id)?.reason).toBe('reply');
    const ts = first.snippets.map((s) => s.ts);
    expect([...ts].sort()).toEqual(ts);
    // `late` sits nearer p2, so it shows only there, cut to 140 chars.
    expect(first.snippets.map((s) => s.message_id)).not.toContain(late.id);
    const lateSnippet = second.snippets.find((s) => s.message_id === late.id)!;
    expect(lateSnippet.text).toHaveLength(140);
    expect(second.snippets.find((s) => s.user?.id === 'sam')).toBeUndefined();
    expect(first.snippets.map((s) => s.is_me)).toEqual([false, true, true, false]);
  });

  test('hero: Muse pick when valid, then the rest oldest first; feed caps events and snippets', () => {
    nextId = 200;
    const photos = Array.from({ length: 8 }, (_, i) => photo('maya', `p${i}`, i * 20, { reactions: reacts(i === 2 ? 4 : 0) }));
    const input = { message_ids: photos.map((p) => p.id), replays: [], terms: [] };
    const muse = buildEvents({ ...input, hero_message_id: photos[5].id }, photos);
    expect(muse.map((e) => e.message!.text)).toEqual(['p5', 'p0', 'p1', 'p2', 'p3', 'p4']);
    const bogus = buildEvents({ ...input, hero_message_id: 1 }, photos, undefined, FEED_LIMITS);
    expect(bogus.map((e) => e.message!.text)).toEqual(['p2', 'p0', 'p1']);
  });

  test('replay: speaker turns around the signal with seek offsets, then chat after the call', () => {
    nextId = 300;
    const replay: LoreReplay = {
      id: 4,
      call_id: 1,
      audio_url: '',
      duration_ms: 30_000,
      started_at: iso(0),
      captions: [
        { user_id: 'maya', text: 'too early', start_ms: 0, end_ms: 4000 },
        { user_id: 'jordan', text: 'wait', start_ms: 17_000, end_ms: 18_500 },
        { user_id: 'jordan', text: 'he did what', start_ms: 18_500, end_ms: 20_000 },
        { user_id: 'maya', text: 'set off the alarm', start_ms: 21_000, end_ms: 24_000 },
        { user_id: 'sam', text: 'NO', start_ms: 25_000, end_ms: 26_000 },
        { user_id: 'jordan', text: 'lmao', start_ms: 27_000, end_ms: 29_500 },
      ],
    };
    const after = [msg('sam', 'that call 😭', 1, { reactions: reacts(1) }), msg('leo', 'ok', 2), msg('nina', 'later', 30)];
    const events = buildEvents({ message_ids: [], replays: [replay], hero_message_id: null, terms: [] }, after, 'maya');
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e).toMatchObject({ kind: 'replay', at: replay.started_at, message: null });
    const spoken = e.snippets.filter((s) => s.reason === 'spoken');
    expect(spoken.map((s) => [s.user?.id, s.text, s.start_ms])).toEqual([
      ['maya', 'set off the alarm', 21_000],
      ['sam', 'NO', 25_000],
      ['jordan', 'lmao', 27_000],
    ]);
    expect(spoken[0].is_me).toBe(true);
    expect(e.snippets.filter((s) => s.reason === 'after').map((s) => s.message_id)).toEqual([after[0].id]);
    expect(buildEvents({ message_ids: [], replays: [replay], hero_message_id: null, terms: [] }, after, 'maya', FEED_LIMITS)[0].snippets).toHaveLength(3);
  });

  test('quote: only without media; the most-reacted key line (earliest on ties) with its replies', () => {
    nextId = 400;
    const a = msg('maya', 'mike set off the ramen alarm', 0, { reactions: reacts(3) });
    const b = msg('jordan', 'AGAIN??', 1, { reactions: reacts(3) });
    const c = msg('sam', 'fire dept on speed dial', 2);
    const d = msg('leo', 'ok', 3);
    const r = msg('nina', 'iconic', 9, { reply_to: a.id });
    const events = buildEvents({ message_ids: [a.id, b.id, c.id, d.id], replays: [], hero_message_id: null, terms: [] }, [a, b, c, d, r]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'quote', message: { id: a.id } });
    expect(events[0].snippets.map((s) => [s.message_id, s.reason])).toEqual([
      [b.id, 'key'],
      [c.id, 'key'],
      [d.id, 'key'],
      [r.id, 'reply'],
    ]);
    const withPhoto = buildEvents({ message_ids: [a.id, b.id], replays: [], hero_message_id: null, terms: [] }, [a, b, photo('sam', '', 1.5)]);
    expect(withPhoto.map((e) => e.kind)).not.toContain('photo'); // the photo isn't a key message
    const p = photo('sam', '', 1.5);
    const media = buildEvents({ message_ids: [a.id, p.id], replays: [], hero_message_id: null, terms: [] }, [a, p]);
    expect(media.map((e) => e.kind)).toEqual(['photo']);
  });
});

// ---------------------------------------------------------------------------
// Mock API: feed filters, counts, pins
// ---------------------------------------------------------------------------
describe('mock lore API', () => {
  const me = 'anish';

  test('feed items carry v2 fields and no story; counts cover the scope', async () => {
    const feed = await mockApi.getLoreFeed(me);
    expect(feed.items.length).toBeGreaterThan(0);
    for (const l of feed.items) {
      expect(l).not.toHaveProperty('story');
      expect(l.events.length).toBeGreaterThan(0);
      expect(l.events.length).toBeLessThanOrEqual(3);
      expect(l.hero_kind).toBe(l.events[0].kind);
      expect(l.pinned).toBe(false);
      expect(Array.isArray(l.media)).toBe(true);
      for (const e of l.events) expect(e.snippets.length).toBeLessThanOrEqual(3);
    }
    // Today's data is text only: every moment is a quote.
    expect(feed.counts).toEqual({ photo: 0, replay: 0, quote: feed.items.length, pinned: 0 });
    expect((await mockApi.getLoreFeed(me, { kind: 'photo' })).items).toEqual([]);
    expect((await mockApi.getLoreFeed(me, { kind: 'quote' })).items).toHaveLength(feed.items.length);
  });

  test('q filters by title; recent sorts newest moment first; paging', async () => {
    const all = (await mockApi.getLoreFeed(me)).items;
    const ended = all.map((l) => l.ended_at);
    expect([...ended].sort().reverse()).toEqual(ended);
    const hit = await mockApi.getLoreFeed(me, { q: '  GRANDMA ' });
    expect(hit.items.map((l) => l.title)).toEqual(["Swayam's house becomes Grandma's"]);
    expect(hit.counts.quote).toBe(1);
    const page = await mockApi.getLoreFeed(me, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.next_cursor).toBe('2');
    const rest = await mockApi.getLoreFeed(me, { limit: 2, cursor: page.next_cursor! });
    expect([...page.items, ...rest.items].map((l) => l.id)).toEqual(all.slice(0, 4).map((l) => l.id));
  });

  test('pins are per user and lead the deck, newest pin first', async () => {
    const deck = (await mockApi.getLoreFeed(me, { sort: 'deck' })).items;
    const [a, b] = [deck[deck.length - 1], deck[deck.length - 2]];
    expect((await mockApi.pinLore(a.id, me)).pinned).toBe(true);
    expect((await mockApi.pinLore(b.id, me)).pinned).toBe(true);
    const pinnedDeck = await mockApi.getLoreFeed(me, { sort: 'deck' });
    expect(pinnedDeck.items.slice(0, 2).map((l) => l.id)).toEqual([b.id, a.id]);
    expect(pinnedDeck.counts.pinned).toBe(2);
    expect((await mockApi.getLoreFeed(me, { pinned: true })).items.map((l) => l.id)).toEqual([b.id, a.id]);
    expect((await mockApi.getLoreFeed('swayam', { pinned: true })).items).toEqual([]);
    expect((await mockApi.getLore(a.id, me)).pinned).toBe(true);

    expect((await mockApi.unpinLore(a.id, me)).pinned).toBe(false);
    expect((await mockApi.unpinLore(a.id, me)).pinned).toBe(false);
    await mockApi.unpinLore(b.id, me);
    expect((await mockApi.getLoreFeed(me)).counts.pinned).toBe(0);
    await expect(mockApi.pinLore(a.id, 'sam')).rejects.toThrow('Not a member');
  });

  test('detail has every event and the v1 compat lists', async () => {
    const [first] = (await mockApi.getLoreFeed(me)).items;
    const detail = await mockApi.getLore(first.id, me);
    expect(detail.events[0].kind).toBe('quote');
    expect(detail.events[0].snippets.length).toBeLessThanOrEqual(DETAIL_LIMITS.quote);
    expect(detail.cover).toEqual({ photo: null, replay: null });
    expect(detail.messages.length).toBe(detail.message_count);
    expect(detail.related.every((r) => r.id !== first.id)).toBe(true);
  });
});
