// Guess that Lore for the mock API: rounds over the mock's kept lore, with deterministic masking
// and hints in place of Muse.
import type { LoreGame, Message, User } from '../types';
import { DAY, groups, messages, userById } from './data';
import { loreById, type MockLore } from './lore';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export type MockGame = {
  id: number;
  group_id: number;
  lore_id: number;
  message_id: number;
  started_by: string;
  prompt: string;
  question: string;
  hints: string[];
  hints_shown: number;
  options: string[];
  answer_id: string;
  status: 'open' | 'revealed';
  votes: Map<string, string>;
  created_at: string;
  revealed_at: string | null;
};

export const gamesByMessage = new Map<number, MockGame>();
const gamesById = new Map<number, MockGame>();
let nextGameId = 1;

/** Errors the screens tell apart by status, like the server's 403/404/409. */
export function apiError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const first = (u: User) => u.display_name.trim().split(/\s+/)[0] ?? u.display_name;
const memberIds = (groupId: number) => groups.find((g) => g.id === groupId)?.members.map((m) => m.user_id) ?? [];

/** Every member's first name and username, longest first so "Mike Chen" never leaves "Chen". */
function nameWords(groupId: number) {
  const words = new Set<string>();
  for (const id of memberIds(groupId)) {
    const u = userById.get(id);
    if (!u) continue;
    words.add(first(u));
    words.add(u.username);
    words.add(u.id);
  }
  return [...words].filter((w) => w.length > 1).sort((a, b) => b.length - a.length);
}

/** The deterministic fallback the server uses too: each name becomes "Someone". */
export function maskTitle(title: string, groupId: number) {
  let out = title;
  for (const w of nameWords(groupId)) out = out.replace(new RegExp(`\\b${escapeRe(w)}\\b`, 'gi'), 'Someone');
  out = out.replace(/\bSomeone(?:\s+Someone)+\b/g, 'Someone');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** Who a moment is about: a member named in the title, else whoever said the most in it. */
function subjectOf(l: MockLore) {
  const members = new Set(memberIds(l.group_id));
  for (const id of members) {
    const u = userById.get(id);
    if (u && new RegExp(`\\b${escapeRe(first(u))}\\b`, 'i').test(l.title)) return id;
  }
  const counts = new Map<string, number>();
  for (const m of messages) {
    if (l.message_ids.includes(m.id) && m.sender_id && members.has(m.sender_id))
      counts.set(m.sender_id, (counts.get(m.sender_id) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return top ?? l.people.find((p) => members.has(p)) ?? null;
}

function hintsFor(l: MockLore, subject: string) {
  const days = Math.max(0, Math.round((Date.now() - new Date(l.ended_at).getTime()) / DAY));
  const when = days === 0 ? 'earlier today' : days === 1 ? 'yesterday' : `${days} days ago`;
  const said = messages.filter((m) => l.message_ids.includes(m.id) && m.sender_id === subject).length;
  const u = userById.get(subject);
  return [
    `It happened ${when}.`,
    said > 1 ? `They sent ${said} of the messages in this moment.` : 'Everyone else did most of the talking.',
    u ? `Their name starts with “${first(u).charAt(0).toUpperCase()}”.` : 'They are in this chat right now.',
  ];
}

export function gameView(g: MockGame, viewer?: string): LoreGame {
  const revealed = g.status === 'revealed';
  const members = memberIds(g.group_id);
  const lore = loreById.get(g.lore_id);
  const allVoted = members.every((m) => g.votes.has(m));
  const old = Date.now() - new Date(g.created_at).getTime() >= DAY;
  return clone({
    id: g.id,
    group_id: g.group_id,
    message_id: g.message_id,
    lore_id: g.lore_id,
    prompt: g.prompt,
    question: g.question,
    hints: g.hints.slice(0, g.hints_shown),
    hints_total: g.hints.length,
    options: g.options.map((id) => {
      const voters = [...g.votes].filter(([, choice]) => choice === id).map(([who]) => who);
      return {
        user: userById.get(id)!,
        votes: voters.length,
        voters: revealed ? voters.map((v) => userById.get(v)!).filter(Boolean) : [],
      };
    }),
    my_vote: viewer ? (g.votes.get(viewer) ?? null) : null,
    total_votes: g.votes.size,
    member_count: members.length,
    status: g.status,
    answer: revealed ? (userById.get(g.answer_id) ?? null) : null,
    lore_title: revealed ? (lore?.title ?? null) : null,
    started_by: g.started_by,
    can_reveal:
      !revealed && !!viewer && members.includes(viewer) && (viewer === g.started_by || allVoted || old),
    created_at: g.created_at,
    revealed_at: g.revealed_at,
  });
}

/** A message as `viewer` sees it: game messages carry their round. */
export function withGame(m: Message, viewer?: string): Message {
  const g = m.kind === 'game' ? gamesByMessage.get(m.id) : undefined;
  return g ? { ...m, game: gameView(g, viewer) } : m;
}

function mustMember(groupId: number, userId: string) {
  if (!memberIds(groupId).includes(userId)) throw apiError(403, `${userId} is not a member of this group`);
}

function mustGame(gameId: number) {
  const g = gamesById.get(gameId);
  if (!g) throw apiError(404, 'Game not found');
  return g;
}

/** A random kept moment of the group, avoiding the last 5 rounds' when it can. */
export function createGame(groupId: number, userId: string, nextMessageId: number): { game: MockGame; message: Message } {
  mustMember(groupId, userId);
  const kept = [...loreById.values()]
    .filter((l) => l.group_id === groupId && l.status === 'kept')
    .map((l) => ({ l, subject: subjectOf(l) }))
    .filter((x): x is { l: MockLore; subject: string } => !!x.subject);
  if (!kept.length) throw apiError(409, 'No Lore yet in this group');
  const recent = new Set(
    [...gamesById.values()]
      .filter((g) => g.group_id === groupId)
      .slice(-5)
      .map((g) => g.lore_id),
  );
  const fresh = kept.filter((x) => !recent.has(x.l.id));
  const pool = fresh.length ? fresh : kept;
  const { l, subject } = pool[Math.floor(Math.random() * pool.length)];

  const id = nextGameId++;
  const rand = rng(id * 7919 + groupId);
  const others = shuffle(
    memberIds(groupId).filter((m) => m !== subject),
    rand,
  ).slice(0, 3);
  const now = new Date().toISOString();
  const message: Message = {
    id: nextMessageId,
    group_id: groupId,
    sender_id: userId,
    kind: 'game',
    text: 'Guess that Lore 🎲',
    ts: now,
    reply_to: null,
    reactions: [],
  };
  const game: MockGame = {
    id,
    group_id: groupId,
    lore_id: l.id,
    message_id: message.id,
    started_by: userId,
    prompt: maskTitle(l.title, groupId),
    question: 'Who was it?',
    hints: hintsFor(l, subject),
    hints_shown: 0,
    options: shuffle([subject, ...others], rand),
    answer_id: subject,
    status: 'open',
    votes: new Map(),
    created_at: now,
    revealed_at: null,
  };
  messages.push(message);
  gamesById.set(id, game);
  gamesByMessage.set(message.id, game);
  return { game, message };
}

/** Returns the reveal's system line when this vote was the last one. */
export function voteGame(gameId: number, userId: string, choice: string, nextMessageId: () => number) {
  const g = mustGame(gameId);
  mustMember(g.group_id, userId);
  if (g.status === 'revealed') throw apiError(409, 'This game was already revealed.');
  if (!g.options.includes(choice)) throw apiError(422, 'Not one of the options');
  g.votes.set(userId, choice);
  const everyone = memberIds(g.group_id).every((m) => g.votes.has(m));
  return { game: g, system: everyone ? reveal(g, nextMessageId()) : null };
}

export function hintGame(gameId: number, userId: string) {
  const g = mustGame(gameId);
  mustMember(g.group_id, userId);
  // Like the server: 409 once revealed or with no hints left.
  if (g.status === 'revealed') throw apiError(409, 'This game was already revealed.');
  if (g.hints_shown >= g.hints.length) throw apiError(409, 'No hints left.');
  g.hints_shown += 1;
  return g;
}

export function revealGame(gameId: number, userId: string, nextMessageId: () => number) {
  const g = mustGame(gameId);
  mustMember(g.group_id, userId);
  if (g.status === 'revealed') throw apiError(409, 'This game was already revealed.');
  const allVoted = memberIds(g.group_id).every((m) => g.votes.has(m));
  const old = Date.now() - new Date(g.created_at).getTime() >= DAY;
  if (userId !== g.started_by && !allVoted && !old) throw apiError(403, 'Only the starter can reveal this round yet');
  return { game: g, system: reveal(g, nextMessageId()) };
}

function reveal(g: MockGame, messageId: number): Message {
  g.status = 'revealed';
  g.hints_shown = g.hints.length;
  g.revealed_at = new Date().toISOString();
  const who = userById.get(g.answer_id);
  const title = loreById.get(g.lore_id)?.title ?? '';
  const system: Message = {
    id: messageId,
    group_id: g.group_id,
    sender_id: null,
    kind: 'system',
    text: `🎉 It was ${who ? first(who) : 'them'}: ${title}`,
    ts: g.revealed_at,
    reply_to: null,
    reactions: [],
  };
  messages.push(system);
  return system;
}
