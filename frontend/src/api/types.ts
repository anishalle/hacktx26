// Shapes from docs/API.md. Keep this file in lockstep with the contract.

export type User = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  phonetic_hint: string | null;
  pronunciation_audio_url: string | null;
};

export type Reaction = { emoji: string; user_id: string };

export type MessageImage = { url: string; width: number; height: number };

export type Message = {
  id: number;
  group_id: number;
  sender_id: string | null;
  kind: 'text' | 'system' | 'photo';
  text: string; // a photo's caption ("" if none)
  ts: string;
  reply_to: number | null;
  reactions: Reaction[];
  image?: MessageImage | null; // kind "photo"
  image_description?: string | null; // the AI's description of a photo (alt text); null until ready
};

export type Member = {
  user: User;
  joined_at: string;
  last_read_message_id: number | null;
  is_newcomer: boolean;
};

export type Group = {
  id: number;
  name: string;
  avatar_url: string | null;
  is_dm: boolean;
  member_count: number;
};

export type GroupDetail = Group & { members: Member[] };

export type InboxItem = {
  group: Group;
  last_message: Message | null;
  unread_count: number;
  last_read_message_id: number | null;
};

export type GlossaryKind = 'nickname' | 'place' | 'event' | 'slang' | 'person' | 'inside_joke';

export type FlaggedTerm = {
  term: string;
  glossary_id: number;
  matched_text: string;
  start: number;
  end: number;
  meaning: string;
  kind: GlossaryKind;
  newcomer_ids: string[];
};

export type Span = { start: number; end: number };

// Not spelled out in docs/API.md; mirrors the `glossary` table.
export type GlossaryEntry = {
  id: number;
  group_id: number;
  term: string;
  aliases: string[];
  meaning: string;
  kind: GlossaryKind;
  confidence?: number;
  source: 'seed' | 'auto' | 'human';
};

export type MessagePage = {
  messages: Message[];
  has_more_before: boolean;
  has_more_after: boolean;
};

export type MessageQuery = {
  before?: number;
  after?: number;
  around?: number;
  limit?: number;
};

export type Newcomer = { user_id: string; display_name: string; joined_at: string };

export type NudgeCheck = {
  show: boolean;
  flagged_terms: FlaggedTerm[];
  newcomers: Newcomer[];
  message: string | null;
};

export type NudgeUnknown = {
  show: boolean;
  unknown_terms: { term: string; start: number; end: number }[];
  newcomers: Newcomer[];
  message: string | null;
};

export type Rewrite = { rewritten: string; changes: Span[] };
export type AsideResult = Rewrite & { glossary_id: number };

export type CatchupSection = 'happened' | 'decisions' | 'open';

export type CatchupBullet = {
  section: CatchupSection;
  text: string;
  start_message_id: number;
  end_message_id: number;
};

export type CatchupTerm = { term: string; glossary_id: number; meaning: string };

export type CatchupPreview = {
  unread_count: number;
  since_message_id: number | null;
  eligible: boolean;
};

export type CatchupResult = {
  unread_count: number;
  since_message_id: number;
  until_message_id: number;
  bullets: CatchupBullet[];
  terms: CatchupTerm[];
};

export type CatchupAnswer = {
  answer: string;
  sources: { start_message_id: number; end_message_id: number }[];
};

export type CatchupEvent =
  | { event: 'meta'; data: { unread_count: number; since_message_id: number; until_message_id: number } }
  | { event: 'bullet'; data: CatchupBullet }
  | { event: 'term'; data: CatchupTerm }
  | { event: 'done'; data: { elapsed_ms: number } }
  | { event: 'error'; data: { message: string } };

/** `no_speech` only comes from calls: nothing was said in the last 45 s. */
export type ExplainStatus = 'explained' | 'general' | 'plain' | 'unknown' | 'no_speech';

export type HumanSource = { ask_id: number; user: User; answer: string; answered_at: string };

export type AskStatus = 'pending' | 'answered' | 'declined';

export type MemberAsk = {
  id: number;
  group_id: number;
  group_name: string;
  term: string;
  message: Message | null;
  for_user: User;
  asked_user: User;
  status: AskStatus;
  answer: string | null;
  posted_message_id: number | null;
  created_at: string;
  answered_at: string | null;
};

export type Explanation = {
  explanation_id: number;
  group_id: number;
  message_id: number | null;
  term: string | null;
  status: ExplainStatus;
  kind: GlossaryKind | 'plain' | 'unknown';
  /** 1-3 short sentences; terms wrapped in **double asterisks**. */
  meaning: string;
  confidence: number;
  follow_up: string | null;
  sources: Message[];
  human_sources: HumanSource[];
  person: User | null;
  ask: { user: User; existing: MemberAsk | null } | null;
  // Calls only (feature 4); null for messages and terms.
  call_id: number | null;
  said_by: User | null;
  /** Status unknown on a call: the words it caught, e.g. "…getting procs…". */
  heard: string | null;
  /** Kept lore this term/message belongs to (max 2): the "See the lore" card. */
  lore?: Lore[];
};

// Feature 6: Lore

export type LoreStatus = 'suggested' | 'kept' | 'dismissed' | 'removed';

export type LoreCaption = { user_id: string; text: string; start_ms: number; end_ms: number };

export type LoreReplay = {
  id: number;
  call_id: number;
  /** WAV, absolute. */
  audio_url: string;
  duration_ms: number;
  started_at: string;
  /** Offsets into the clip. */
  captions: LoreCaption[];
};

export type LoreSnippet = {
  /** null for spoken lines. */
  message_id: number | null;
  user: User | null;
  text: string;
  ts: string;
  reactions: Reaction[];
  reason: 'caption' | 'reply' | 'reaction' | 'key' | 'spoken' | 'after';
  /** Spoken lines: offset into the replay, so a tap seeks. */
  start_ms: number | null;
  is_me: boolean;
};

export type LoreEvent = {
  /** `video` is reserved; nothing builds it yet. */
  kind: 'photo' | 'replay' | 'quote' | 'video';
  at: string;
  /** The photo, or the quote's anchor message. */
  message: Message | null;
  replay: LoreReplay | null;
  snippets: LoreSnippet[];
};

export type Lore = {
  id: number;
  group_id: number;
  group_name: string;
  /** The only model-written text in Lore. */
  title: string;
  status: LoreStatus;
  source: 'chat' | 'call';
  call_id: number | null;
  started_at: string;
  ended_at: string;
  people: User[];
  terms: { term: string; glossary_id: number | null }[];
  hero_kind: LoreEvent['kind'];
  /** events[0] is the hero, the rest oldest first. Feed: ≤3 events, ≤3 snippets each; detail: all events. */
  events: LoreEvent[];
  /** ≤6 photo messages for the image row, oldest first. */
  media: Message[];
  /** Derived from events[0]; both null = a quote card. */
  cover: { photo: Message | null; replay: LoreReplay | null };
  /** Chat suggestions: the Keep card goes after this message. */
  anchor_message_id: number | null;
  message_count: number;
  photo_count: number;
  replay_count: number;
  kept_by: User | null;
  kept_at: string | null;
  /** Pinned by the requesting user. */
  pinned: boolean;
};

export type LoreDetail = Lore & {
  messages: Message[];
  photos: Message[];
  replays: LoreReplay[];
  related: Lore[];
};

/** The feed's kind filter matches a moment's `hero_kind`. */
export type LoreKind = 'photo' | 'replay' | 'quote';

export type LoreFeedQuery = {
  group_id?: number;
  kind?: LoreKind;
  pinned?: boolean;
  /** `deck`: pinned (newest pin first), then score/recency/media. `recent`: newest moment first. */
  sort?: 'deck' | 'recent';
  /** Title contains (case-insensitive). */
  q?: string;
  cursor?: string;
  limit?: number;
};

/** Per-kind and pinned totals for the feed's scope (`group_id`, `q`), ignoring `kind` and `pinned`. */
export type LoreCounts = { photo: number; replay: number; quote: number; pinned: number };

export type LoreFeed = { items: Lore[]; next_cursor: string | null; counts: LoreCounts };

export type ExplainRequest = {
  group_id: number;
  user_id: string;
  message_id?: number;
  term?: string;
  explanation_id?: number;
  follow_up?: string;
};

export type Asks = { incoming: MemberAsk[]; outgoing: MemberAsk[] };

// Feature 4: live ? on a group call

export type CallMember = { user: User; attendee_id: string; joined_at: string; left_at: string | null };

export type Call = {
  id: number;
  group_id: number;
  started_by: string;
  started_at: string;
  ended_at: string | null;
  members: CallMember[];
};

/** `meeting` / `attendee` are Chime's CreateMeeting / CreateAttendee objects, passed straight to the native SDK. */
export type CallJoin = { call: Call; meeting: Record<string, unknown>; attendee: Record<string, unknown> };

/** One speaker's turn so far, from their own microphone (Muse realtime). `text` is cumulative. */
export type CallCaption = {
  call_id: number;
  user_id: string;
  turn_id: string;
  text: string;
  final: boolean;
  ts: string;
};

export type RealtimeFrame =
  | { type: 'message.new'; data: Message }
  | { type: 'reaction.updated'; data: { group_id: number; message_id: number; reactions: Reaction[] } }
  | { type: 'read.updated'; data: { group_id: number; user_id: string; message_id: number } }
  | { type: 'ask.new'; data: MemberAsk }
  | { type: 'ask.updated'; data: MemberAsk }
  | { type: 'call.updated'; data: Call }
  | { type: 'call.caption'; data: CallCaption }
  | { type: 'lore.updated'; data: Lore }
  | { type: 'pong'; data?: unknown };

/** The full client surface. `real.ts` and `mock/` both implement it. */
export interface Api {
  getUsers(): Promise<User[]>;
  getInbox(userId: string): Promise<InboxItem[]>;

  getGroup(groupId: number, userId: string): Promise<GroupDetail>;
  getMessages(groupId: number, query?: MessageQuery, signal?: AbortSignal): Promise<MessagePage>;
  sendMessage(groupId: number, body: { sender_id: string; text: string; reply_to?: number | null }): Promise<Message>;
  /** Uploads a local photo (`uri` from the image picker) as a `kind: "photo"` message. */
  sendPhoto(
    groupId: number,
    body: { sender_id: string; uri: string; width?: number; height?: number; text?: string; reply_to?: number | null },
  ): Promise<Message>;
  toggleReaction(groupId: number, messageId: number, body: { user_id: string; emoji: string }): Promise<Message>;
  markRead(groupId: number, body: { user_id: string; message_id: number }): Promise<void>;
  getGlossary(groupId: number): Promise<GlossaryEntry[]>;

  nudgeCheck(body: { group_id: number; user_id: string; draft: string }, signal?: AbortSignal): Promise<NudgeCheck>;
  nudgeRewrite(body: { group_id: number; user_id: string; draft: string; terms: string[] }): Promise<Rewrite>;
  nudgeUnknown(body: { group_id: number; user_id: string; draft: string }, signal?: AbortSignal): Promise<NudgeUnknown>;
  nudgeAside(body: { group_id: number; user_id: string; draft: string; term: string; meaning: string }): Promise<AsideResult>;
  nudgeDismiss(body: { group_id: number; user_id: string; term: string }): Promise<void>;

  catchupPreview(groupId: number, userId: string): Promise<CatchupPreview>;
  /** Streams `POST /catchup` as SSE. Yields events in order until `done`/`error` or abort. */
  catchupStream(
    body: { group_id: number; user_id: string; since_message_id?: number },
    signal?: AbortSignal,
  ): AsyncGenerator<CatchupEvent>;
  catchupAsk(body: {
    group_id: number;
    user_id: string;
    since_message_id?: number;
    question: string;
  }): Promise<CatchupAnswer>;

  explain(body: ExplainRequest, signal?: AbortSignal): Promise<Explanation>;
  askMember(body: { group_id: number; user_id: string; term: string; message_id?: number }): Promise<MemberAsk>;
  getAsks(userId: string): Promise<Asks>;
  answerAsk(
    askId: number,
    body: { user_id: string; answer?: string; decline?: boolean; post_in_chat?: boolean },
  ): Promise<MemberAsk>;

  getCall(groupId: number): Promise<Call | null>;
  /** Starts the group's call or joins the active one. */
  joinCall(groupId: number, userId: string): Promise<CallJoin>;
  leaveCall(callId: number, userId: string): Promise<Call>;
  /** The ? button: `at_ms` is Date.now() frozen at the tap. */
  explainCall(callId: number, body: { user_id: string; at_ms: number }, signal?: AbortSignal): Promise<Explanation>;

  /** Kept lore across the user's groups; newest moment first unless `sort: 'deck'`. */
  getLoreFeed(userId: string, query?: LoreFeedQuery): Promise<LoreFeed>;
  getLore(loreId: number, userId: string): Promise<LoreDetail>;
  getLoreSuggestions(groupId: number, userId: string): Promise<Lore[]>;
  /** "Save to Lore" on a message: the moment around it, kept at once (or the lore that already holds it). */
  saveLore(groupId: number, messageId: number, userId: string): Promise<Lore>;
  keepLore(loreId: number, userId: string): Promise<Lore>;
  dismissLore(loreId: number, userId: string): Promise<Lore>;
  removeLore(loreId: number, userId: string): Promise<Lore>;
  /** Pins are per user; `kept` stays group-wide. Each pushes `lore.updated` to that user only. */
  pinLore(loreId: number, userId: string): Promise<Lore>;
  unpinLore(loreId: number, userId: string): Promise<Lore>;

  /** Opens the realtime channel for a user. Returns an unsubscribe/close function. */
  connectRealtime(userId: string, handlers: RealtimeHandlers): () => void;
}

export type RealtimeStatus = 'connecting' | 'open' | 'closed';

export type RealtimeHandlers = {
  onFrame: (frame: RealtimeFrame) => void;
  onStatus?: (status: RealtimeStatus) => void;
};
