export type DemoUser = 'priya' | 'swayam' | 'alex';

export type Message = {
  id: string;
  group_id: string;
  sender_id: string;
  sender_name: string;
  ts: string;
  text: string;
};

export type Member = { id: string; name: string; joined_at: string };
export type Page = { messages: Message[]; has_more: boolean };
export type HumanSource = {
  id: string; recipient_name: string; answer: string; answered_at: string;
};
export type Explanation = {
  id: string;
  message_id: string;
  meaning: string;
  confidence: number;
  kind: 'nickname' | 'place' | 'event' | 'slang' | 'person' | 'plain' | 'unknown';
  sources: Message[];
  human_sources: HumanSource[];
  can_ask_sender: boolean;
  sender_name: string;
};
export type MemberAsk = {
  id: string; group_id: string; message_id: string; message_text: string;
  requester_id: string; requester_name: string;
  recipient_id: string; recipient_name: string;
  question: string; answer: string | null;
  status: 'pending' | 'answered' | 'declined';
  created_at: string; answered_at: string | null;
};

const BASE = (
  process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8000/api/v1'
).replace(/\/$/, '');

async function request<T>(
  path: string, user: DemoUser, body?: unknown, signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort);
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, 120000);
  try {
    const response = await fetch(BASE + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Demo-User': user },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(typeof error?.detail === 'string'
        ? error.detail : 'Something went wrong. Please try again.');
    }
    return await response.json() as T;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error('This is taking too long. Please try again.');
    }
    if (error instanceof TypeError) {
      throw new Error('Cannot reach the chat server. Check your connection and API URL.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export const GROUP = 'longhorns';
export const api = {
  messages: (user: DemoUser, query = '', signal?: AbortSignal) =>
    request<Page>(`/groups/${GROUP}/messages${query}`, user, undefined, signal),
  members: (user: DemoUser, signal?: AbortSignal) =>
    request<Member[]>(`/groups/${GROUP}/members`, user, undefined, signal),
  send: (user: DemoUser, text: string) =>
    request<Message>(`/groups/${GROUP}/messages`, user, { text }),
  explain: (
    user: DemoUser, messageId: string, followUp?: string,
    explanationId?: string, signal?: AbortSignal,
  ) => request<Explanation>('/explain/message', user, {
    group_id: GROUP, message_id: messageId,
    follow_up: followUp || null, explanation_id: explanationId || null,
  }, signal),
  asks: (user: DemoUser, signal?: AbortSignal) =>
    request<MemberAsk[]>(`/groups/${GROUP}/member-asks`, user, undefined, signal),
  ask: (user: DemoUser, messageId: string, question: string) =>
    request<MemberAsk>('/ask-member', user, {
      group_id: GROUP, message_id: messageId, question,
    }),
  answer: (user: DemoUser, id: string, answer?: string, decline = false) =>
    request<MemberAsk>(`/ask-member/${id}/answer`, user, {
      answer: answer || null, decline,
    }),
};
