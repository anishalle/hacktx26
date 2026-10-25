import { fetch } from 'expo/fetch';

import { API_URL, WS_URL } from './config';
import { readSse } from './sse';
import type {
  Api,
  AsideResult,
  Asks,
  CatchupAnswer,
  CatchupEvent,
  CatchupPreview,
  Explanation,
  GlossaryEntry,
  GroupDetail,
  InboxItem,
  MemberAsk,
  Message,
  MessagePage,
  MessageQuery,
  NudgeCheck,
  NudgeUnknown,
  RealtimeFrame,
  RealtimeHandlers,
  Rewrite,
  User,
} from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | undefined | null>;

function url(path: string, query?: Query) {
  const qs = query
    ? Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';
  return `${API_URL}${path}${qs ? `?${qs}` : ''}`;
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  opts: { query?: Query; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const res = await fetch(url(path, opts.query), {
    method,
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const j = (await res.json()) as { detail?: unknown };
      if (j?.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, `${method} ${path}: ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const get = <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>('GET', path, { query, signal });
const post = <T>(path: string, body: unknown, signal?: AbortSignal, query?: Query) =>
  request<T>('POST', path, { body, signal, query });

async function* catchupStream(
  body: { group_id: number; user_id: string; since_message_id?: number },
  signal?: AbortSignal,
): AsyncGenerator<CatchupEvent> {
  const res = await fetch(url('/catchup'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let detail = `${res.status}`;
    try {
      detail = ((await res.json()) as { detail?: string }).detail ?? detail;
    } catch {}
    yield { event: 'error', data: { message: `Catch-up failed (${detail})` } };
    return;
  }
  for await (const msg of readSse(res.body, signal)) {
    let data: unknown;
    try {
      data = JSON.parse(msg.data);
    } catch {
      continue;
    }
    yield { event: msg.event, data } as CatchupEvent;
    if (msg.event === 'done' || msg.event === 'error') return;
  }
}

/** One socket per user with exponential-backoff reconnects and a keep-alive ping. */
function connectRealtime(userId: string, { onFrame, onStatus }: RealtimeHandlers): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  const open = () => {
    if (closed) return;
    onStatus?.('connecting');
    const sock = new WebSocket(`${WS_URL}?user_id=${encodeURIComponent(userId)}`);
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      onStatus?.('open');
      pingTimer = setInterval(() => {
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'ping' }));
      }, 25000);
    };
    sock.onmessage = (ev) => {
      try {
        const frame = JSON.parse(String(ev.data)) as RealtimeFrame;
        if (frame && typeof frame.type === 'string') onFrame(frame);
      } catch {
        // ignore malformed frames
      }
    };
    sock.onerror = () => {
      // onclose follows and schedules the retry
    };
    sock.onclose = () => {
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
      if (ws === sock) ws = null;
      onStatus?.('closed');
      if (closed) return;
      const delay = Math.min(15000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      attempt++;
      retryTimer = setTimeout(open, delay);
    };
  };

  open();
  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (pingTimer) clearInterval(pingTimer);
    ws?.close();
    ws = null;
  };
}

export const realApi: Api = {
  getUsers: () => get<User[]>('/users'),
  getInbox: (userId) => get<InboxItem[]>(`/users/${encodeURIComponent(userId)}/inbox`),

  getGroup: (groupId, userId) => get<GroupDetail>(`/groups/${groupId}`, { user_id: userId }),
  getMessages: (groupId, q: MessageQuery = {}, signal) =>
    get<MessagePage>(`/groups/${groupId}/messages`, { limit: 50, ...q }, signal),
  sendMessage: (groupId, body) => post<Message>(`/groups/${groupId}/messages`, body),
  toggleReaction: (groupId, messageId, body) => post<Message>(`/groups/${groupId}/messages/${messageId}/reactions`, body),
  markRead: (groupId, body) => post<void>(`/groups/${groupId}/read`, body),
  getGlossary: (groupId) => get<GlossaryEntry[]>(`/groups/${groupId}/glossary`),

  nudgeCheck: (body, signal) => post<NudgeCheck>('/nudge/check', body, signal),
  nudgeRewrite: (body) => post<Rewrite>('/nudge/rewrite', body),
  nudgeUnknown: (body, signal) => post<NudgeUnknown>('/nudge/unknown', body, signal),
  nudgeAside: (body) => post<AsideResult>('/nudge/aside', body),
  nudgeDismiss: (body) => post<void>('/nudge/dismiss', body),

  catchupPreview: (groupId, userId) => get<CatchupPreview>(`/groups/${groupId}/catchup/preview`, { user_id: userId }),
  catchupStream,
  catchupAsk: (body) => post<CatchupAnswer>('/catchup/ask', body),

  explain: (body, signal) => post<Explanation>('/explain', body, signal),
  askMember: (body) => post<MemberAsk>('/ask-member', body),
  getAsks: (userId) => get<Asks>(`/users/${encodeURIComponent(userId)}/asks`),
  answerAsk: (askId, body) => post<MemberAsk>(`/ask-member/${askId}/answer`, body),

  connectRealtime,
};
