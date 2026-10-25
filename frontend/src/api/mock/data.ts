// Deterministic fake world for EXPO_PUBLIC_USE_MOCKS=1. All names are fictional.
import type { CatchupBullet, CatchupTerm, GlossaryEntry, Message, Reaction, User } from '../types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.now();

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
const rand = rng(26);
const pick = <T>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];

const u = (id: string, username: string, display_name: string, phonetic_hint: string | null = null): User => ({
  id,
  username,
  display_name,
  avatar_url: null,
  phonetic_hint,
  pronunciation_audio_url: null,
});

export const users: User[] = [
  u('anish', 'anish.a', 'Anish Alle', 'uh-NEESH'),
  u('priya', 'priya.k', 'Priya Kapoor', 'PREE-yah'),
  u('swayam', 'swayam.p', 'Swayam Patel', 'SWAH-yum'),
  u('mike', 'mikechen_', 'Mike Chen'),
  u('nina', 'ninapark', 'Nina Park'),
  u('jordan', 'jlee.22', 'Jordan Lee'),
  u('leo', 'leo.mrtns', 'Leo Martins'),
  u('tara', 'tara.s', 'Tara Singh'),
  u('sam', 'samrivera', 'Sam Rivera'),
  u('maya', 'mayaj', 'Maya Johnson'),
];
export const userById = new Map(users.map((x) => [x.id, x]));

export type MockGroup = {
  id: number;
  name: string;
  is_dm: boolean;
  avatar_url: string | null;
  members: { user_id: string; joined_at: string; last_read_message_id: number | null }[];
};

export const messages: Message[] = [];
let nextId = 1000;

function push(group_id: number, sender_id: string | null, text: string, ts: number, extra: Partial<Message> = {}) {
  const m: Message = {
    id: nextId++,
    group_id,
    sender_id,
    kind: sender_id ? 'text' : 'system',
    text,
    ts: new Date(ts).toISOString(),
    reply_to: null,
    reactions: [],
    ...extra,
  };
  messages.push(m);
  return m;
}

function sprinkleReactions(m: Message, pool: string[]) {
  if (m.kind !== 'text' || rand() > 0.09) return;
  const emojis = ['❤️', '😂', '😂', '❤️', '😮', '👍', '😭'];
  const n = 1 + Math.floor(rand() * 3);
  const reactions: Reaction[] = [];
  const who = pool.filter((p) => p !== m.sender_id);
  for (let i = 0; i < n && who.length; i++) {
    const idx = Math.floor(rand() * who.length);
    reactions.push({ emoji: i === 0 ? pick(emojis) : reactions[0].emoji, user_id: who.splice(idx, 1)[0] });
  }
  m.reactions = reactions;
}

// ---------------------------------------------------------------------------
// Group 1: volleyball. Priya joined two days ago and has 1,204 unread.
// ---------------------------------------------------------------------------
export const VOLLEYBALL = 1;
const vbMembers = ['anish', 'swayam', 'mike', 'nina', 'jordan', 'leo', 'tara', 'priya'];
const vbRegulars = vbMembers.filter((m) => m !== 'priya');

const filler = [
  'lol',
  'fr',
  'wait what',
  'no way',
  '😭😭',
  'LMAO',
  'same',
  'bro',
  'true',
  "i'm down",
  'what time',
  'nah',
  '💀',
  'ok ok',
  'facts',
  'hahaha',
  'omw',
  'running late',
  'who has the pump',
  'who is bringing the ball',
  'can someone send the court schedule',
  'my serve was so bad today',
  'practice at 6?',
  "can't, lab",
  'the rec center wifi is so bad',
  'we need a new libero fr',
  'did anyone see the game last night',
  'i literally just woke up',
  'that rally was insane',
  'ok but who took my water bottle',
  'jordan your jump serve is getting scary',
  "i'm so sore from yesterday",
  'stretch before games people',
  'tara carried tbh',
  'next week we run it back',
  'whose hoodie is in my car',
  'ok that was actually funny',
  'brb',
  'yeah',
  'yessss',
  'nooo',
  'real',
  'wait send the pic',
  'lmaooo',
];
const termFiller = [
  "grandma's after?",
  'usual spot?',
  "grandma's has the best snacks",
  'parking at the usual spot again',
  "is grandma's open tonight swayam",
  "i left my charger at grandma's",
  'usual spot is full, parking on the street',
  'code yellow at practice today 💀',
];

// History, two months back: where the inside references come from.
let t = NOW - 60 * DAY;
push(VOLLEYBALL, null, 'swayam created the group', t);
for (const who of ['anish', 'mike', 'nina', 'jordan', 'leo', 'tara']) {
  t += 7 * MIN;
  push(VOLLEYBALL, null, `swayam added ${who}`, t);
}
const groupJoined: Record<string, number> = {};
for (const m of vbRegulars) groupJoined[m] = NOW - 60 * DAY;

const origin: [string, string][] = [
  ['swayam', "parents are out of town all month, everyone's welcome at my place after games"],
  ['mike', "swayam's house is literally grandma's house. there's always food and someone tells you to eat more"],
  ['nina', 'LMAO grandma'],
  ['jordan', "ok it's officially Grandma now. grandma's after the game?"],
  ['swayam', 'i hate that this is sticking'],
  ['leo', 'where are we parking for the rec courts'],
  ['tara', 'back lot behind the rec center, by the tennis courts. lights stay on late'],
  ['leo', 'bet. that is the usual spot from now on'],
];
t = NOW - 55 * DAY;
for (const [who, text] of origin) {
  t += 2 * MIN + rand() * 4 * MIN;
  push(VOLLEYBALL, who, text, t);
}

t = NOW - 54 * DAY;
for (let i = 0; i < 170; i++) {
  t += rand() < 0.15 ? 6 * HOUR + rand() * DAY : rand() * 9 * MIN;
  if (t > NOW - 3 * DAY) break;
  const text = rand() < 0.1 ? pick(termFiller) : pick(filler);
  sprinkleReactions(push(VOLLEYBALL, pick(vbRegulars), text, t), vbRegulars);
}

// Priya is added two days ago.
const priyaJoinTs = NOW - 2 * DAY - 3 * HOUR;
groupJoined.priya = priyaJoinTs;
const priyaAdded = push(VOLLEYBALL, null, 'anish added priya', priyaJoinTs);
push(VOLLEYBALL, 'anish', 'welcome priya!! 🏐', priyaJoinTs + 2 * MIN);

// The backlog: 1,204 messages after Priya's last read (her welcome counts), with planted plot beats.
const BACKLOG = 1203; // + the welcome message = 1,204 unread
const beats: Record<number, [string, string][]> = {
  40: [
    ['mike', "guys i can't make saturday anymore, my cousin's thing got moved"],
    ['jordan', 'MIKE'],
    ['nina', 'you literally planned saturday'],
    ['mike', 'i know i know im sorry'],
  ],
  120: [
    ['tara', 'so are we still doing grandma’s saturday or no'],
    ['leo', 'without mike?? he was bringing the speaker'],
    ['swayam', 'my house is still free saturday, we can still do it'],
    ['nina', "i vote we still go, it's been planned for 2 weeks"],
  ],
  300: [
    ['jordan', "honestly kinda annoyed, this is the second time he's bailed"],
    ['tara', 'same tbh'],
    ['mike', 'i said im sorry 😭'],
  ],
  520: [
    ['swayam', "ok final answer: grandma's saturday, 8pm. bring snacks"],
    ['nina', 'locking it in'],
    ['anish', '8pm works'],
    ['leo', "i'll grab a speaker from my roommate"],
  ],
  760: [
    ['nina', "tournament signup is due friday, $15 each. venmo me"],
    ['jordan', 'team name???'],
    ['tara', 'Net Results'],
    ['anish', 'Net Results is perfect'],
    ['nina', 'ok Net Results it is. signing us up'],
  ],
  1010: [
    ['tara', 'wait who is driving saturday'],
    ['leo', "i can take 3 but my car's at the shop till friday maybe"],
    ['swayam', 'we need one more car'],
    ['jordan', "let's figure it out thursday"],
  ],
  1180: [
    ['swayam', "grandma's after the game, usual spot"],
    ['anish', 'bet'],
    ['nina', "i'll be at the usual spot by 7"],
  ],
};
export const beatIds: Record<number, number> = {};
t = priyaJoinTs + 5 * MIN;
let produced = 0;
while (produced < BACKLOG) {
  const beat = beats[produced];
  if (beat) {
    t += 25 * MIN;
    for (const [who, text] of beat) {
      t += MIN + rand() * MIN;
      const m = push(VOLLEYBALL, who, text, t);
      if (!(produced in beatIds)) beatIds[produced] = m.id;
      if (rand() < 0.4) sprinkleReactions(m, vbRegulars);
      produced++;
    }
    continue;
  }
  const remaining = BACKLOG - produced;
  const remainingTime = NOW - 3 * MIN - t;
  const avg = remainingTime / remaining;
  t += rand() < 0.03 ? avg * 12 : avg * rand() * 1.3;
  t = Math.min(t, NOW - 3 * MIN);
  const text = rand() < 0.06 ? pick(termFiller) : pick(filler);
  sprinkleReactions(push(VOLLEYBALL, pick(vbRegulars), text, t), vbRegulars);
  produced++;
}

const vbMsgs = messages.filter((m) => m.group_id === VOLLEYBALL);
const vbLast = vbMsgs[vbMsgs.length - 1].id;
const vbRead = (back: number) => vbMsgs[Math.max(0, vbMsgs.length - 1 - back)].id;

export const groups: MockGroup[] = [
  {
    id: VOLLEYBALL,
    name: 'volleyball',
    is_dm: false,
    avatar_url: null,
    members: vbMembers.map((user_id) => ({
      user_id,
      joined_at: new Date(groupJoined[user_id]).toISOString(),
      last_read_message_id:
        user_id === 'priya'
          ? priyaAdded.id
          : user_id === 'anish'
            ? vbRead(3)
            : user_id === 'mike'
              ? vbRead(140)
              : vbRead(Math.floor(rand() * 2)),
    })),
  },
];

// ---------------------------------------------------------------------------
// Smaller threads for the inbox.
// ---------------------------------------------------------------------------
function thread(
  id: number,
  name: string,
  is_dm: boolean,
  memberIds: string[],
  lines: [string, string, number][], // sender, text, minutes ago
  readBack: Record<string, number> = {},
) {
  for (const [who, text, minsAgo] of lines) push(id, who, text, NOW - minsAgo * MIN);
  const msgs = messages.filter((m) => m.group_id === id);
  groups.push({
    id,
    name,
    is_dm,
    avatar_url: null,
    members: memberIds.map((user_id) => ({
      user_id,
      joined_at: new Date(NOW - 90 * DAY).toISOString(),
      last_read_message_id: msgs[Math.max(0, msgs.length - 1 - (readBack[user_id] ?? 0))]?.id ?? null,
    })),
  });
}

thread(
  2,
  'dm',
  true,
  ['anish', 'swayam'],
  [
    ['swayam', 'yo are you coming saturday', 400],
    ['anish', "yeah obviously, what should i bring", 395],
    ['swayam', 'chips and the big speaker if leo forgets', 240],
  ],
  { anish: 1 },
);
thread(
  3,
  'weekend trip 🏕️',
  false,
  ['anish', 'nina', 'jordan', 'maya'],
  [
    ['maya', 'campsite is booked!!', 1500],
    ['jordan', 'lets gooo', 1490],
    ['nina', 'i can drive 4 people', 620],
    ['maya', 'packing list in the notes', 610],
  ],
  { anish: 0, nina: 0, jordan: 1, maya: 0 },
);
thread(
  4,
  'dm',
  true,
  ['anish', 'nina'],
  [
    ['nina', 'did you venmo for the tournament', 900],
    ['anish', 'just did', 880],
  ],
);
thread(
  5,
  'dm',
  true,
  ['priya', 'nina'],
  [
    ['nina', 'hiii welcome to the volleyball chat, it is chaos lol', 2700],
    ['priya', 'haha thank you! still figuring out who everyone is', 2690],
    ['nina', "you'll get it. come to practice thursday!", 2680],
  ],
);
thread(
  6,
  'dm',
  true,
  ['anish', 'sam'],
  [
    ['sam', 'can i borrow your 314 notes', 3000],
    ['anish', 'sent', 2950],
  ],
);
thread(
  7,
  'cs 314 study',
  false,
  ['anish', 'leo', 'tara', 'sam', 'priya'],
  [
    ['leo', 'midterm is curved right?', 2000],
    ['tara', 'pls say yes', 1990],
    ['priya', 'the TA said it is', 1500],
    ['sam', 'library 4th floor at 7?', 75],
  ],
  { anish: 1, priya: 1 },
);
thread(
  8,
  'dm',
  true,
  ['anish', 'maya'],
  [['maya', 'sent you the campsite link', 6000]],
);

// ---------------------------------------------------------------------------
// Glossary and catch-up script.
// ---------------------------------------------------------------------------
export const glossary: (GlossaryEntry & { pattern: RegExp; first_seen_ts: string; last_explained_ts: string | null })[] = [
  {
    id: 1,
    group_id: VOLLEYBALL,
    term: 'Grandma',
    aliases: ["grandma's", 'grandmas'],
    meaning: "Swayam's house. The group hangs out there after games.",
    kind: 'nickname',
    confidence: 0.96,
    source: 'seed',
    pattern: /\bgrandma(?:['’]?s)?\b/gi,
    first_seen_ts: new Date(NOW - 55 * DAY).toISOString(),
    last_explained_ts: new Date(NOW - 55 * DAY).toISOString(),
  },
  {
    id: 2,
    group_id: VOLLEYBALL,
    term: 'usual spot',
    aliases: ['the usual spot'],
    meaning: 'The back lot behind the rec center, by the tennis courts.',
    kind: 'place',
    confidence: 0.9,
    source: 'seed',
    pattern: /\busual spot\b/gi,
    first_seen_ts: new Date(NOW - 55 * DAY).toISOString(),
    last_explained_ts: new Date(NOW - 55 * DAY).toISOString(),
  },
];

/** Planted inside joke with no explanation anywhere in history (for /nudge/unknown). */
export const unknownTerms = [{ term: 'code yellow', pattern: /\bcode yellow\b/i }];

export const catchupScript: { bullets: CatchupBullet[]; terms: CatchupTerm[] } = {
  bullets: [
    {
      section: 'happened',
      text: "Mike bailed on Saturday because his cousin's event got moved.",
      start_message_id: beatIds[40],
      end_message_id: beatIds[40] + 3,
    },
    {
      section: 'happened',
      text: "The group debated whether to still go to Grandma's without him. Swayam said his place is still free.",
      start_message_id: beatIds[120],
      end_message_id: beatIds[120] + 3,
    },
    {
      section: 'happened',
      text: "Jordan and Tara are annoyed: it's the second time Mike has bailed.",
      start_message_id: beatIds[300],
      end_message_id: beatIds[300] + 2,
    },
    {
      section: 'decisions',
      text: "Still going: Grandma's on Saturday at 8pm. Bring snacks; Leo is bringing a speaker.",
      start_message_id: beatIds[520],
      end_message_id: beatIds[520] + 3,
    },
    {
      section: 'decisions',
      text: 'Team name for the tournament is "Net Results". Signup is $15 each, Venmo Nina by Friday.',
      start_message_id: beatIds[760],
      end_message_id: beatIds[760] + 4,
    },
    {
      section: 'open',
      text: "Who's driving Saturday. Leo can take 3 if his car is back; they need one more car.",
      start_message_id: beatIds[1010],
      end_message_id: beatIds[1010] + 3,
    },
  ],
  terms: [
    { term: 'Grandma', glossary_id: 1, meaning: "Swayam's house. The group hangs out there after games." },
    { term: 'usual spot', glossary_id: 2, meaning: 'The back lot behind the rec center, by the tennis courts.' },
  ],
};

export const vbLastId = vbLast;
export { DAY, HOUR, MIN, NOW };
