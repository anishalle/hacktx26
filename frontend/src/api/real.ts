import { fetch } from 'expo/fetch';

import { API_URL, WS_URL } from './config';
import { readSse } from './sse';
import type {
  Api,
  AsideResult,
  Asks,
  Call,
  CallJoin,
  CatchupAnswer,
  CatchupEvent,
  CatchupPreview,
  Explanation,
  GlossaryEntry,
  GroupDetail,
  InboxItem,
  Lore,
  LoreDetail,
  LoreFeed,
  LoreFeedQuery,
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
  method: 'GET' | 'POST' | 'DELETE',
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
const del = <T>(path: string, query?: Query) => request<T>('DELETE', path, { query });

/** `pinned` goes on the wire only when set, as `true`; an empty `q` is dropped. */
const loreFeedQuery = ({ pinned, q, ...rest }: LoreFeedQuery): Query => ({
  ...rest,
  pinned: pinned ? 'true' : undefined,
  q: q?.trim() || undefined,
});

/**
 * Multipart photo upload. Uses XMLHttpRequest: Expo replaces the global fetch, and its FormData
 * only takes Blobs, while React Native's own networking (behind XHR) sends `{ uri }` file parts.
 */
function sendPhoto(
  groupId: number,
  body: { sender_id: string; uri: string; text?: string; reply_to?: number | null },
): Promise<Message> {
  const form = new FormData();
  form.append('file', { uri: body.uri, name: 'photo.jpg', type: 'image/jpeg' } as unknown as Blob);
  form.append('sender_id', body.sender_id);
  if (body.text) form.append('text', body.text);
  if (body.reply_to != null) form.append('reply_to', String(body.reply_to));
  const path = `/groups/${groupId}/photos`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url(path));
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.onload = () => {
      let json: unknown = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        // non-JSON body
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(json as Message);
      const detail = (json as { detail?: unknown } | null)?.detail;
      const text = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : `${xhr.status}`;
      reject(new ApiError(xhr.status, `POST ${path}: ${text}`));
    };
    xhr.onerror = () => reject(new ApiError(0, `POST ${path}: network error`));
    xhr.send(form);
  });
}

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
  sendPhoto,
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

  getCall: (groupId) => get<Call | null>(`/groups/${groupId}/call`),
  joinCall: (groupId, userId) => post<CallJoin>(`/groups/${groupId}/call`, { user_id: userId }),
  leaveCall: (callId, userId) => post<Call>(`/calls/${callId}/leave`, { user_id: userId }),
  explainCall: (callId, body, signal) => post<Explanation>(`/calls/${callId}/explain`, body, signal),

  getLoreFeed: (userId, q = {}) => get<LoreFeed>(`/users/${encodeURIComponent(userId)}/lore`, loreFeedQuery(q)),
  getLore: (loreId, userId) => get<LoreDetail>(`/lore/${loreId}`, { user_id: userId }),
  getLoreSuggestions: (groupId, userId) => get<Lore[]>(`/groups/${groupId}/lore/suggestions`, { user_id: userId }),
  saveLore: (groupId, messageId, userId) =>
    post<Lore>(`/groups/${groupId}/lore`, { user_id: userId, message_id: messageId }),
  keepLore: (loreId, userId) => post<Lore>(`/lore/${loreId}/keep`, { user_id: userId }),
  dismissLore: (loreId, userId) => post<Lore>(`/lore/${loreId}/dismiss`, { user_id: userId }),
  removeLore: (loreId, userId) => post<Lore>(`/lore/${loreId}/remove`, { user_id: userId }),
  pinLore: (loreId, userId) => post<Lore>(`/lore/${loreId}/pin`, { user_id: userId }),
  unpinLore: (loreId, userId) => del<Lore>(`/lore/${loreId}/pin`, { user_id: userId }),

  connectRealtime,
};
