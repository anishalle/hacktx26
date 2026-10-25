// In-process implementation of the API used when EXPO_PUBLIC_USE_MOCKS=1.
import { readSse } from '../sse';
import type {
  Api,
  CatchupEvent,
  FlaggedTerm,
  GroupDetail,
  InboxItem,
  Member,
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
