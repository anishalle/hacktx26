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

export type Message = {
  id: number;
  group_id: number;
  sender_id: string | null;
  kind: 'text' | 'system';
  text: string;
  ts: string;
  reply_to: number | null;
  reactions: Reaction[];
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

export type RealtimeFrame =
  | { type: 'message.new'; data: Message }
  | { type: 'reaction.updated'; data: { group_id: number; message_id: number; reactions: Reaction[] } }
  | { type: 'read.updated'; data: { group_id: number; user_id: string; message_id: number } }
  | { type: 'pong'; data?: unknown };

/** The full client surface. `real.ts` and `mock/` both implement it. */
export interface Api {
  getUsers(): Promise<User[]>;
  getInbox(userId: string): Promise<InboxItem[]>;

  getGroup(groupId: number, userId: string): Promise<GroupDetail>;
  getMessages(groupId: number, query?: MessageQuery, signal?: AbortSignal): Promise<MessagePage>;
  sendMessage(groupId: number, body: { sender_id: string; text: string; reply_to?: number | null }): Promise<Message>;
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

  /** Opens the realtime channel for a user. Returns an unsubscribe/close function. */
  connectRealtime(userId: string, handlers: RealtimeHandlers): () => void;
}

export type RealtimeStatus = 'connecting' | 'open' | 'closed';

export type RealtimeHandlers = {
  onFrame: (frame: RealtimeFrame) => void;
  onStatus?: (status: RealtimeStatus) => void;
};
