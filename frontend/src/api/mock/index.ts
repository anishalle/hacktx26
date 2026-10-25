// In-process implementation of the API used when EXPO_PUBLIC_USE_MOCKS=1.
import { readSse } from '../sse';
import type {
  Api,
  Call,
  CallCaption,
  CatchupEvent,
  ExplainRequest,
  Explanation,
  FlaggedTerm,
  GroupDetail,
  InboxItem,
  Member,
  MemberAsk,
  Message,
  MessagePage,
  RealtimeFrame,
  RealtimeHandlers,
  Span,
} from '../types';
import { catchupScript, DAY, glossary, groups, messages, MockGroup, unknownTerms, userById, users } from './data';

const NEWCOMER_DAYS = 7;
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(id);
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
const latency = (signal?: AbortSignal) => sleep(120 + Math.random() * 180, signal);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------------------
// Realtime bus
// ---------------------------------------------------------------------------
const listeners = new Map<string, Set<RealtimeHandlers>>();
function groupOf(id: number): MockGroup {
  const g = groups.find((x) => x.id === id);
  if (!g) throw new Error(`group ${id} not found`);
  return g;
}
function fanOut(groupId: number, frame: RealtimeFrame) {
  for (const m of groupOf(groupId).members) {
    listeners.get(m.user_id)?.forEach((h) => {
      // Deliver asynchronously like a socket would.
      setTimeout(() => h.onFrame(clone(frame)), 30);
    });
  }
}

const dismissals = new Set<string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function groupMessages(groupId: number) {
  return messages.filter((m) => m.group_id === groupId);
}

function isNewcomer(joinedAt: string) {
  return Date.now() - new Date(joinedAt).getTime() < NEWCOMER_DAYS * DAY;
}

function viewName(g: MockGroup, viewer: string) {
  if (!g.is_dm) return { name: g.name, avatar_url: g.avatar_url };
  const other = userById.get(g.members.find((m) => m.user_id !== viewer)?.user_id ?? viewer)!;
  return { name: other.display_name, avatar_url: other.avatar_url };
}

function toGroup(g: MockGroup, viewer: string) {
  return { id: g.id, ...viewName(g, viewer), is_dm: g.is_dm, member_count: g.members.length };
}

function newcomersFor(g: MockGroup, senderId: string) {
  return g.members
    .filter((m) => m.user_id !== senderId && isNewcomer(m.joined_at))
    .map((m) => ({ user_id: m.user_id, display_name: userById.get(m.user_id)!.display_name, joined_at: m.joined_at }));
}

function daysAgo(iso: string) {
  const d = Math.round((Date.now() - new Date(iso).getTime()) / DAY);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}

function quoteList(terms: string[]) {
  const q = terms.map((x) => `“${x}”`);
  return q.length <= 1 ? q.join('') : `${q.slice(0, -1).join(', ')} or ${q[q.length - 1]}`;
}

function findFlagged(groupId: number, userId: string, draft: string): FlaggedTerm[] {
  const g = groupOf(groupId);
  const out: FlaggedTerm[] = [];
  for (const entry of glossary.filter((e) => e.group_id === groupId)) {
    if (dismissals.has(`${userId}|${groupId}|${entry.term.toLowerCase()}`)) continue;
    const origin = new Date(entry.last_explained_ts ?? entry.first_seen_ts).getTime();
    const newcomerIds = g.members
      .filter((m) => m.user_id !== userId && new Date(m.joined_at).getTime() > origin)
      .map((m) => m.user_id);
    if (!newcomerIds.length) continue;
    entry.pattern.lastIndex = 0;
    const match = entry.pattern.exec(draft);
    if (!match) continue;
    out.push({
      term: entry.term,
      glossary_id: entry.id,
      matched_text: match[0],
      start: match.index,
      end: match.index + match[0].length,
      meaning: entry.meaning,
      kind: entry.kind,
      newcomer_ids: newcomerIds,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Applies replacements right-to-left and returns the new text plus where the inserted text lives. */
function applyEdits(text: string, edits: { start: number; end: number; insert: string }[]) {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  const changes: Span[] = [];
  for (const e of sorted) {
    out += text.slice(cursor, e.start);
    changes.push({ start: out.length, end: out.length + e.insert.length });
    out += e.insert;
    cursor = e.end;
  }
  out += text.slice(cursor);
  return { rewritten: out, changes };
}

function rewriteFor(term: string, matched: string) {
  const lower = term.toLowerCase();
  if (lower === 'grandma') {
    const cap = matched[0] === matched[0].toUpperCase() ? 'S' : 's';
    return `${cap}wayam's house (we call it ${matched.replace(/^g/, 'G')})`;
  }
  if (lower === 'usual spot') return `${matched} (the back lot behind the rec center)`;
  const entry = glossary.find((e) => e.term.toLowerCase() === lower);
  return entry ? `${matched} (${entry.meaning.replace(/\.$/, '').toLowerCase()})` : matched;
}

// ---------------------------------------------------------------------------
// Feature 1: explain + private asks
// ---------------------------------------------------------------------------
function toUser(userId: string, frame: RealtimeFrame) {
  listeners.get(userId)?.forEach((h) => setTimeout(() => h.onFrame(clone(frame)), 30));
}

/** Common slang with no in-chat definition: answered from general knowledge and labelled so. */
const generalSlang: { pattern: RegExp; term: string; meaning: string }[] = [
  { pattern: /^bet!*$/i, term: 'bet', meaning: '**Bet** is slang for "okay, sounds good."' },
  { pattern: /\bno cap\b/i, term: 'no cap', meaning: '**No cap** means "for real, not lying."' },
  { pattern: /\brizz\b/i, term: 'rizz', meaning: '**Rizz** is charm, especially when flirting.' },
];

const asks: MemberAsk[] = [];
const explanations = new Map<number, { term: string | null; meaning: string; status: Explanation['status'] }>();
let nextAskId = 1;
let nextExplanationId = 1;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termPattern = (term: string) => new RegExp(`\\b${escapeRe(term)}\\b`, 'i');

function askView(a: MemberAsk): MemberAsk {
  return clone(a);
}

/** Who knows a term: the sender of the held message, else the member who uses it most. */
function whoToAsk(groupId: number, requester: string, term: string, message?: Message) {
  if (message?.sender_id && message.sender_id !== requester) return userById.get(message.sender_id) ?? null;
  const counts = new Map<string, number>();
  const re = termPattern(term);
  for (const m of groupMessages(groupId)) {
    if (m.sender_id && m.sender_id !== requester && re.test(m.text)) counts.set(m.sender_id, (counts.get(m.sender_id) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return top ? (userById.get(top) ?? null) : null;
}

function humanSources(groupId: number, userId: string, term: string) {
  return asks
    .filter((a) => a.group_id === groupId && a.for_user.id === userId && a.status === 'answered' && a.term.toLowerCase() === term.toLowerCase())
    .map((a) => ({ ask_id: a.id, user: clone(a.asked_user), answer: a.answer!, answered_at: a.answered_at! }));
}

function mockExplain(body: ExplainRequest): Explanation {
  const g = groupOf(body.group_id);
  const me = g.members.find((m) => m.user_id === body.user_id);
  const message = body.message_id !== undefined ? messages.find((m) => m.id === body.message_id && m.group_id === g.id) : undefined;
  const text = message?.text ?? body.term ?? '';
  const base = {
    explanation_id: nextExplanationId++,
    group_id: g.id,
    message_id: message?.id ?? null,
    follow_up: body.follow_up ?? null,
    sources: [] as Message[],
    human_sources: [] as Explanation['human_sources'],
    person: null,
    ask: null,
    call_id: null,
    said_by: null,
    heard: null,
  };

  if (body.follow_up && body.explanation_id !== undefined) {
    const prev = explanations.get(body.explanation_id);
    const entry = prev?.term ? glossary.find((e) => e.group_id === g.id && e.term.toLowerCase() === prev.term!.toLowerCase()) : undefined;
    const meaning = entry
      ? `All the group has said about **${entry.term}**: ${entry.meaning}`
      : "The chat doesn't say more about that than what's above.";
    return { ...base, term: prev?.term ?? null, status: prev?.status ?? 'plain', kind: entry?.kind ?? 'plain', meaning, confidence: entry ? 0.8 : 0.5 };
  }

  const entries = glossary.filter((e) => {
    e.pattern.lastIndex = 0;
    const hit = e.pattern.test(text) || e.term.toLowerCase() === text.toLowerCase();
    e.pattern.lastIndex = 0;
    return e.group_id === g.id && hit;
  });
  let result: Explanation;
  if (entries.length) {
    const joined = me ? new Date(me.joined_at).getTime() : Date.now();
    const sources = groupMessages(g.id)
      .filter((m) => m.kind === 'text' && m.id !== message?.id && new Date(m.ts).getTime() < joined && entries.some((e) => termPattern(e.term).test(m.text)))
      .slice(0, 3);
    const meaning = entries.map((e) => `**${e.term}**: ${e.meaning}`).join('\n');
    result = {
      ...base,
      term: entries[0].term,
      status: 'explained',
      kind: entries[0].kind,
      meaning: entries.length === 1 ? `**${entries[0].term}**: ${entries[0].meaning}` : meaning,
      confidence: entries[0].confidence ?? 0.9,
      sources: clone(sources),
      human_sources: entries.flatMap((e) => humanSources(g.id, body.user_id, e.term)),
    };
  } else {
    const person = users.find((x) => g.members.some((m) => m.user_id === x.id) && x.display_name.split(' ')[0].toLowerCase() === text.trim().toLowerCase());
    const slang = generalSlang.find((s) => s.pattern.test(text.trim()));
    const unknown = unknownTerms.find((x) => x.pattern.test(text));
    if (person) {
      result = { ...base, term: person.display_name, status: 'explained', kind: 'person', meaning: `**${person.display_name.split(' ')[0]}** is ${person.display_name}, a member of this group.`, confidence: 0.95, person: clone(person) };
    } else if (unknown || slang) {
      const term = unknown?.term ?? slang!.term;
      const human = humanSources(g.id, body.user_id, term);
      const who = whoToAsk(g.id, body.user_id, term, message);
      const existing = asks.find((a) => a.group_id === g.id && a.for_user.id === body.user_id && a.term.toLowerCase() === term.toLowerCase()) ?? null;
      result = {
        ...base,
        term,
        status: human.length ? 'explained' : slang ? 'general' : 'unknown',
        kind: human.length ? 'inside_joke' : slang ? 'slang' : 'unknown',
        meaning: human.length
          ? `**${term}**: ${human[0].answer}`
          : slang
            ? slang.meaning
            : `I couldn't find where **${term}** is explained in this group's history.`,
        confidence: human.length ? 0.9 : slang ? 0.7 : 0,
        human_sources: human,
        ask: !human.length && who ? { user: clone(who), existing: existing ? askView(existing) : null } : null,
      };
    } else {
      result = { ...base, term: null, status: 'plain', kind: 'plain', meaning: 'Nothing here looks like an inside reference. It means what it says.', confidence: 0.9 };
    }
  }
  explanations.set(result.explanation_id, { term: result.term, meaning: result.meaning, status: result.status });
  return result;
}

function encodeSse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A ReadableStream of SSE bytes, emitted in uneven chunks with model-like delays. */
function mockCatchupBody(groupId: number, userId: string, signal?: AbortSignal) {
  const g = groupOf(groupId);
  const member = g.members.find((m) => m.user_id === userId);
  const all = groupMessages(groupId);
  const since = member?.last_read_message_id ?? all[0].id;
  const unread = all.filter((m) => m.id > since && m.sender_id !== userId).length;
  const script =
    groupId === groups[0].id
      ? catchupScript
      : {
          bullets: [
            {
              section: 'happened' as const,
              text: 'A few quick messages; nothing big happened.',
              start_message_id: all[Math.max(0, all.length - 3)].id,
              end_message_id: all[all.length - 1].id,
            },
          ],
          terms: [],
        };
  const parts: { text: string; delay: number }[] = [
    { text: encodeSse('meta', { unread_count: unread, since_message_id: since, until_message_id: all[all.length - 1].id }), delay: 250 },
    { text: ': keep-alive\n\n', delay: 500 },
  ];
  script.bullets.forEach((b, i) => parts.push({ text: encodeSse('bullet', b), delay: i === 0 ? 900 : 380 + Math.random() * 420 }));
  script.terms.forEach((term) => parts.push({ text: encodeSse('term', term), delay: 250 }));
  parts.push({ text: encodeSse('done', { elapsed_ms: 3900 }), delay: 200 });

  const encoder = new TextEncoder();
  let i = 0;
  let carry = '';
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal?.aborted || (i >= parts.length && !carry)) {
        controller.close();
        return;
      }
      if (!carry) {
        await sleep(parts[i].delay).catch(() => {});
        carry = parts[i++].text;
      }
      // Split frames at arbitrary points to exercise the parser.
      const cut = Math.max(1, Math.floor(carry.length * (0.4 + Math.random() * 0.6)));
      controller.enqueue(encoder.encode(carry.slice(0, cut)));
      carry = carry.slice(cut);
    },
  });
}

// ---------------------------------------------------------------------------
// Calls (feature 4): one in-memory call per group. Joining a fresh call brings in two scripted
// members whose turns stream as `call.caption` frames word by word, the way the API relays Muse.
// ---------------------------------------------------------------------------
const CALL_FOCUS_MS = 45_000;
const WORD_MS = 280;
type Turn = { userId: string; turnId: string; text: string; final: boolean; startMs: number; endMs: number };
type MockCall = Call & { turns: Map<string, Turn>; scripted: Set<string>; timers: ReturnType<typeof setTimeout>[] };
const calls = new Map<number, MockCall>();
let nextCallId = 1;

// Lines lean on the mock glossary ("Grandma", "usual spot"), one unexplained reference
// ("code yellow") and general slang ("bet"), so every ? card state shows up. Turns overlap a little.
const CALL_SCRIPT = [
  { who: 0, at: 1500, text: 'yo are we still doing grandma’s after the game tonight' },
  { who: 1, at: 4300, text: 'yeah but meet at the usual spot first because parking is a nightmare' },
  { who: 0, at: 7900, text: 'bet' },
  { who: 1, at: 9400, text: 'and nobody call a code yellow this time please' },
  { who: 0, at: 12600, text: 'lmao that was one time and you know it' },
];

const activeCall = (groupId: number) => [...calls.values()].find((c) => c.group_id === groupId && !c.ended_at);
function callView({ turns: _t, scripted: _s, timers: _x, ...call }: MockCall): Call {
  return clone(call);
}
function toCall(call: MockCall, frame: RealtimeFrame) {
  for (const m of call.members) if (!m.left_at) toUser(m.user.id, frame);
}
function addMember(call: MockCall, userId: string) {
  const existing = call.members.find((m) => m.user.id === userId);
  if (existing) existing.left_at = null;
  else call.members.push({ user: clone(userById.get(userId)!), attendee_id: `mock-${call.id}-${userId}`, joined_at: new Date().toISOString(), left_at: null });
}

function playScript(call: MockCall, joinerId: string) {
  const g = groupOf(call.group_id);
  const speakers = g.members.map((m) => m.user_id).filter((id) => id !== joinerId).slice(0, 2);
  if (!speakers.length) return;
  speakers.forEach((id) => {
    call.scripted.add(id);
    addMember(call, id);
  });
  CALL_SCRIPT.forEach(({ who, at, text }, i) => {
    const userId = speakers[who % speakers.length];
    const turnId = `mock-${call.id}-${i}`;
    const words = text.split(' ');
    words.forEach((_, n) =>
      call.timers.push(
        setTimeout(() => {
          const final = n === words.length - 1;
          const now = Date.now();
          const prev = call.turns.get(turnId);
          const turn: Turn = { userId, turnId, text: words.slice(0, n + 1).join(' '), final, startMs: prev?.startMs ?? now, endMs: now };
          call.turns.set(turnId, turn);
          const caption: CallCaption = { call_id: call.id, user_id: userId, turn_id: turnId, text: turn.text, final, ts: new Date(now).toISOString() };
          toCall(call, { type: 'call.caption', data: caption });
        }, at + n * WORD_MS),
      ),
    );
  });
}

/** Same answer the text pipeline gives, applied to the newest turn in the focus window that needs one. */
function mockExplainCall(call: MockCall, userId: string, atMs: number): Explanation {
  const focus = [...call.turns.values()]
    .filter((t) => t.startMs <= atMs && t.endMs > atMs - CALL_FOCUS_MS && t.text.trim())
    .sort((a, b) => a.startMs - b.startMs);
  const callFields = { call_id: call.id, said_by: null, heard: null };
  if (!focus.length) {
    return {
      ...mockExplain({ group_id: call.group_id, user_id: userId, term: '' }),
      ...callFields,
      status: 'no_speech',
      kind: 'unknown',
      term: null,
      meaning: "I didn't catch anything in the last 45 seconds.",
      confidence: 0,
    };
  }
  const candidates = [...focus].reverse().map((t) => ({ t, e: mockExplain({ group_id: call.group_id, user_id: userId, term: t.text }) }));
  const { t, e } = candidates.find((c) => c.e.status !== 'plain') ?? candidates[0];
  return {
    ...e,
    ...callFields,
    said_by: clone(userById.get(t.userId)) ?? null,
    heard: e.status === 'unknown' ? `…${t.text.split(/\s+/).slice(0, 8).join(' ')}…` : null,
  };
}

// ---------------------------------------------------------------------------
// Api
// ---------------------------------------------------------------------------
export const mockApi: Api = {
  async getUsers() {
    await latency();
    return clone(users);
  },

  async getInbox(userId) {
    await latency();
    const items: InboxItem[] = groups
      .filter((g) => g.members.some((m) => m.user_id === userId))
      .map((g) => {
        const me = g.members.find((m) => m.user_id === userId)!;
        const msgs = groupMessages(g.id);
        const last = msgs[msgs.length - 1] ?? null;
        const lastRead = me.last_read_message_id;
        return {
          group: toGroup(g, userId),
          last_message: last ? clone(last) : null,
          unread_count: msgs.filter((m) => (lastRead === null || m.id > lastRead) && m.sender_id !== userId).length,
          last_read_message_id: lastRead,
        };
      });
    return items.sort((a, b) => (b.last_message?.ts ?? '').localeCompare(a.last_message?.ts ?? ''));
  },

  async getGroup(groupId, userId) {
    await latency();
    const g = groupOf(groupId);
    const members: Member[] = g.members.map((m) => ({
      user: clone(userById.get(m.user_id)!),
      joined_at: m.joined_at,
      last_read_message_id: m.last_read_message_id,
      is_newcomer: isNewcomer(m.joined_at),
    }));
    const detail: GroupDetail = { ...toGroup(g, userId), members };
    return detail;
  },

  async getMessages(groupId, q = {}, signal) {
    await latency(signal);
    const all = groupMessages(groupId);
    const limit = Math.min(200, q.limit ?? 50);
    let start: number;
    let end: number; // exclusive
    if (q.around !== undefined) {
      let idx = all.findIndex((m) => m.id >= q.around!);
      if (idx === -1) idx = all.length - 1;
      start = Math.max(0, idx - Math.floor(limit / 2));
      end = Math.min(all.length, start + limit);
      start = Math.max(0, end - limit);
    } else if (q.before !== undefined) {
      end = all.findIndex((m) => m.id >= q.before!);
      if (end === -1) end = all.length;
      start = Math.max(0, end - limit);
    } else if (q.after !== undefined) {
      start = all.findIndex((m) => m.id > q.after!);
      if (start === -1) start = all.length;
      end = Math.min(all.length, start + limit);
    } else {
      end = all.length;
      start = Math.max(0, end - limit);
    }
    const page: MessagePage = {
      messages: clone(all.slice(start, end)),
      has_more_before: start > 0,
      has_more_after: end < all.length,
    };
    return page;
  },

  async sendMessage(groupId, body) {
    await latency();
    const m: Message = {
      id: Math.max(...messages.map((x) => x.id)) + 1,
      group_id: groupId,
      sender_id: body.sender_id,
      kind: 'text',
      text: body.text,
      ts: new Date().toISOString(),
      reply_to: body.reply_to ?? null,
      reactions: [],
    };
    messages.push(m);
    const g = groupOf(groupId);
    const me = g.members.find((x) => x.user_id === body.sender_id);
    if (me) me.last_read_message_id = m.id;
    fanOut(groupId, { type: 'message.new', data: m });
    // Simulate a couple of members reading it so the seen-by stack moves.
    const readers = g.members.filter((x) => x.user_id !== body.sender_id).slice(0, 3);
    readers.forEach((r, i) =>
      setTimeout(() => {
        r.last_read_message_id = m.id;
        fanOut(groupId, { type: 'read.updated', data: { group_id: groupId, user_id: r.user_id, message_id: m.id } });
      }, 1500 + i * 900),
    );
    return clone(m);
  },

  async sendPhoto(groupId, body) {
    await latency();
    const m: Message = {
      id: Math.max(...messages.map((x) => x.id)) + 1,
      group_id: groupId,
      sender_id: body.sender_id,
      kind: 'photo',
      text: body.text ?? '',
      ts: new Date().toISOString(),
      reply_to: body.reply_to ?? null,
      reactions: [],
      image: { url: body.uri, width: body.width ?? 1200, height: body.height ?? 900 },
      image_description: null,
    };
    messages.push(m);
    const me = groupOf(groupId).members.find((x) => x.user_id === body.sender_id);
    if (me) me.last_read_message_id = m.id;
    fanOut(groupId, { type: 'message.new', data: m });
    // The real server describes the photo in the background; the mock just fills it in.
    setTimeout(() => {
      m.image_description = 'A photo shared in the chat.';
    }, 800);
    return clone(m);
  },

  async toggleReaction(groupId, messageId, { user_id, emoji }) {
    await latency();
    const m = messages.find((x) => x.id === messageId && x.group_id === groupId);
    if (!m) throw new Error('message not found');
    const had = m.reactions.some((r) => r.user_id === user_id && r.emoji === emoji);
    // One reaction per user, like Instagram: replacing removes the old one.
    m.reactions = m.reactions.filter((r) => r.user_id !== user_id);
    if (!had) m.reactions.push({ user_id, emoji });
    fanOut(groupId, { type: 'reaction.updated', data: { group_id: groupId, message_id: messageId, reactions: m.reactions } });
    return clone(m);
  },

  async markRead(groupId, { user_id, message_id }) {
    await sleep(60);
    const me = groupOf(groupId).members.find((m) => m.user_id === user_id);
    if (!me) return;
    if ((me.last_read_message_id ?? 0) >= message_id) return;
    me.last_read_message_id = message_id;
    fanOut(groupId, { type: 'read.updated', data: { group_id: groupId, user_id, message_id } });
  },

  async getGlossary(groupId) {
    await latency();
    return glossary
      .filter((g) => g.group_id === groupId)
      .map(({ pattern: _p, first_seen_ts: _f, last_explained_ts: _l, ...rest }) => clone(rest));
  },

  async nudgeCheck({ group_id, user_id, draft }, signal) {
    await sleep(50, signal);
    const flagged = findFlagged(group_id, user_id, draft);
    const g = groupOf(group_id);
    const newcomers = newcomersFor(g, user_id).filter((n) => flagged.some((f) => f.newcomer_ids.includes(n.user_id)));
    if (!flagged.length || !newcomers.length) return { show: false, flagged_terms: [], newcomers: [], message: null };
    const n = newcomers[0];
    const first = n.display_name.split(' ')[0];
    const pronoun = n.user_id === 'priya' ? 'her' : 'them';
    return {
      show: true,
      flagged_terms: flagged,
      newcomers,
      message: `${first} joined ${daysAgo(n.joined_at)} and might not know ${quoteList(flagged.map((f) => f.term))}. Rewrite for ${pronoun}?`,
    };
  },

  async nudgeRewrite({ group_id, user_id, draft, terms }) {
    await sleep(700 + Math.random() * 500);
    const wanted = new Set(terms.map((x) => x.toLowerCase()));
    const flagged = findFlagged(group_id, user_id, draft).filter((f) => wanted.has(f.term.toLowerCase()));
    return applyEdits(
      draft,
      flagged.map((f) => ({ start: f.start, end: f.end, insert: rewriteFor(f.term, f.matched_text) })),
    );
  },

  async nudgeUnknown({ group_id, user_id, draft }, signal) {
    await sleep(500 + Math.random() * 400, signal);
    const g = groupOf(group_id);
    const newcomers = newcomersFor(g, user_id);
    const hits = unknownTerms
      .filter((u) => !glossary.some((e) => e.group_id === group_id && e.term.toLowerCase() === u.term))
      .map((u) => {
        const m = u.pattern.exec(draft);
        return m ? { term: m[0], start: m.index, end: m.index + m[0].length } : null;
      })
      .filter((x): x is { term: string; start: number; end: number } => !!x);
    if (!hits.length || !newcomers.length) return { show: false, unknown_terms: [], newcomers: [], message: null };
    const first = newcomers[0].display_name.split(' ')[0];
    return {
      show: true,
      unknown_terms: hits,
      newcomers,
      message: `This looks like an inside reference and I can't find where it's explained. ${first} probably doesn't know it. Add a quick aside?`,
    };
  },

  async nudgeAside({ group_id, draft, term, meaning }) {
    await sleep(600 + Math.random() * 400);
    const idx = draft.toLowerCase().indexOf(term.toLowerCase());
    let clean = meaning.trim().replace(/[.!]+$/, '');
    // Keep the member's casing style: an aside reads as a clause, not a sentence.
    if (clean.length > 1 && clean[1] === clean[1].toLowerCase()) clean = clean[0].toLowerCase() + clean.slice(1);
    const id = Math.max(...glossary.map((g) => g.id)) + 1;
    glossary.push({
      id,
      group_id,
      term,
      aliases: [],
      meaning: clean,
      kind: 'inside_joke',
      source: 'human',
      pattern: new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
      first_seen_ts: new Date().toISOString(),
      last_explained_ts: new Date().toISOString(),
    });
    if (idx === -1) {
      const r = applyEdits(draft, [{ start: draft.length, end: draft.length, insert: ` (${term} = ${clean})` }]);
      return { ...r, glossary_id: id };
    }
    const end = idx + term.length;
    const r = applyEdits(draft, [{ start: end, end, insert: ` (${clean})` }]);
    return { ...r, glossary_id: id };
  },

  async nudgeDismiss({ group_id, user_id, term }) {
    await sleep(80);
    dismissals.add(`${user_id}|${group_id}|${term.toLowerCase()}`);
  },

  async catchupPreview(groupId, userId) {
    await latency();
    const me = groupOf(groupId).members.find((m) => m.user_id === userId);
    const since = me?.last_read_message_id ?? null;
    const unread = groupMessages(groupId).filter((m) => (since === null || m.id > since) && m.sender_id !== userId).length;
    return { unread_count: unread, since_message_id: since, eligible: unread >= 50 };
  },

  async *catchupStream(body, signal) {
    const stream = mockCatchupBody(body.group_id, body.user_id, signal);
    for await (const msg of readSse(stream, signal)) {
      yield { event: msg.event, data: JSON.parse(msg.data) } as CatchupEvent;
    }
  },

  async catchupAsk({ group_id, question }) {
    await sleep(1100 + Math.random() * 600);
    const q = question.toLowerCase();
    const b = catchupScript.bullets;
    const src = (i: number) => ({ start_message_id: b[i].start_message_id, end_message_id: b[i].end_message_id });
    if (group_id !== groups[0].id) return { answer: 'Nothing much happened here while you were away.', sources: [] };
    if (/driv|car|ride/.test(q))
      return {
        answer: "Nobody's confirmed yet. Leo can take 3 people if his car is back from the shop by Friday, and they still need one more car. They said they'd sort it out Thursday.",
        sources: [src(5)],
      };
    if (/mike|bail|annoy|mad/.test(q))
      return {
        answer: "Mike can't come Saturday because his cousin's event moved. Jordan and Tara are a bit annoyed since it's the second time he's bailed, but the plan is still on.",
        sources: [src(0), src(2)],
      };
    if (/tournament|team|sign|venmo|\$/.test(q))
      return { answer: 'The team is "Net Results". Signup is $15 each; Venmo Nina before Friday.', sources: [src(4)] };
    return {
      answer: "Saturday is still on: Grandma's (Swayam's house) at 8pm. Bring snacks. The one open question is who's driving.",
      sources: [src(3), src(5)],
    };
  },

  async explain(body, signal) {
    await sleep(900 + Math.random() * 700, signal);
    return mockExplain(body);
  },

  async askMember({ group_id, user_id, term, message_id }) {
    await latency();
    const g = groupOf(group_id);
    const message = message_id !== undefined ? messages.find((m) => m.id === message_id) : undefined;
    const pending = asks.find(
      (a) => a.group_id === group_id && a.for_user.id === user_id && a.status === 'pending' && a.term.toLowerCase() === term.toLowerCase(),
    );
    if (pending) return askView(pending);
    const asked = whoToAsk(group_id, user_id, term, message);
    if (!asked) throw new Error('Nobody in this group to ask about that.');
    const ask: MemberAsk = {
      id: nextAskId++,
      group_id,
      group_name: g.name,
      term,
      message: message ? clone(message) : null,
      for_user: clone(userById.get(user_id)!),
      asked_user: clone(asked),
      status: 'pending',
      answer: null,
      posted_message_id: null,
      created_at: new Date().toISOString(),
      answered_at: null,
    };
    asks.unshift(ask);
    toUser(asked.id, { type: 'ask.new', data: ask });
    return askView(ask);
  },

  async getAsks(userId) {
    await latency();
    return {
      incoming: asks.filter((a) => a.asked_user.id === userId).map(askView),
      outgoing: asks.filter((a) => a.for_user.id === userId).map(askView),
    };
  },

  async answerAsk(askId, { user_id, answer, decline, post_in_chat }) {
    await latency();
    const ask = asks.find((a) => a.id === askId && a.asked_user.id === user_id);
    if (!ask) throw new Error('Request not found.');
    if (ask.status !== 'pending') throw new Error('This request has already been resolved.');
    const text = answer?.trim();
    if (!decline && !text) throw new Error('Write an answer or pass on the request.');
    ask.status = decline ? 'declined' : 'answered';
    ask.answer = decline ? null : text!;
    ask.answered_at = new Date().toISOString();
    if (!decline && !glossary.some((e) => e.group_id === ask.group_id && e.term.toLowerCase() === ask.term.toLowerCase())) {
      glossary.push({
        id: Math.max(...glossary.map((g) => g.id)) + 1,
        group_id: ask.group_id,
        term: ask.term,
        aliases: [],
        meaning: text!,
        kind: 'inside_joke',
        source: 'human',
        pattern: new RegExp(`\\b${escapeRe(ask.term)}\\b`, 'gi'),
        first_seen_ts: new Date().toISOString(),
        last_explained_ts: null,
      });
    }
    if (!decline && post_in_chat) {
      const posted = await mockApi.sendMessage(ask.group_id, { sender_id: user_id, text: text! });
      ask.posted_message_id = posted.id;
    }
    for (const uid of [ask.for_user.id, ask.asked_user.id]) toUser(uid, { type: 'ask.updated', data: ask });
    return askView(ask);
  },

  async getCall(groupId) {
    await latency();
    const call = activeCall(groupId);
    return call ? callView(call) : null;
  },

  async joinCall(groupId, userId) {
    await latency();
    const g = groupOf(groupId);
    if (!g.members.some((m) => m.user_id === userId)) throw new Error(`${userId} is not a member of group ${groupId}`);
    let call = activeCall(groupId);
    const fresh = !call;
    if (!call) {
      call = { id: nextCallId++, group_id: groupId, started_by: userId, started_at: new Date().toISOString(), ended_at: null, members: [], turns: new Map(), scripted: new Set(), timers: [] };
      calls.set(call.id, call);
    }
    addMember(call, userId);
    if (fresh) playScript(call, userId);
    fanOut(groupId, { type: 'call.updated', data: callView(call) });
    return {
      call: callView(call),
      meeting: { MeetingId: `mock-meeting-${call.id}`, MediaRegion: 'us-east-1' },
      attendee: { AttendeeId: `mock-${call.id}-${userId}`, ExternalUserId: userId },
    };
  },

  async leaveCall(callId, userId) {
    await latency();
    const call = calls.get(callId);
    if (!call) throw new Error('Call not found');
    const now = new Date().toISOString();
    const member = call.members.find((m) => m.user.id === userId && !m.left_at);
    if (member) member.left_at = now;
    // Scripted members leave with the last real one.
    if (!call.ended_at && call.members.every((m) => m.left_at || call.scripted.has(m.user.id))) {
      call.timers.splice(0).forEach(clearTimeout);
      call.members.forEach((m) => (m.left_at ??= now));
      call.ended_at = now;
    }
    fanOut(call.group_id, { type: 'call.updated', data: callView(call) });
    return callView(call);
  },

  async explainCall(callId, body, signal) {
    await sleep(900 + Math.random() * 700, signal);
    const call = calls.get(callId);
    if (!call) throw new Error('Call not found');
    const result = mockExplainCall(call, body.user_id, body.at_ms);
    explanations.set(result.explanation_id, { term: result.term, meaning: result.meaning, status: result.status });
    return result;
  },

  connectRealtime(userId, handlers) {
    let set = listeners.get(userId);
    if (!set) listeners.set(userId, (set = new Set()));
    set.add(handlers);
    handlers.onStatus?.('connecting');
    const t = setTimeout(() => handlers.onStatus?.('open'), 100);
    return () => {
      clearTimeout(t);
      listeners.get(userId)?.delete(handlers);
      handlers.onStatus?.('closed');
    };
  },
};
