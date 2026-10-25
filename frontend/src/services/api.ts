import type { ExplainResponse, SuggestionPrompt, TranscriptUtterance, ChimeResult, CallSession } from '../types/call';

const rawBase = process.env.EXPO_PUBLIC_CALLS_API_URL || process.env.EXPO_PUBLIC_API_URL || 'https://tq3imyqav7.execute-api.us-east-1.amazonaws.com';
const API_BASE = `${rawBase.replace(/\/$/, '').replace(/\/api\/v1$/, '')}/api/v1`;
const DEMO_KEY = process.env.EXPO_PUBLIC_CALLS_DEMO_KEY || '';
const sessions = new Map<string, CallSession>();

export function registerCallSession(session: CallSession) { sessions.set(session.call_id, session); }
export function getCallSession(callId: string) { return sessions.get(callId); }

async function request<T>(path: string, body?: unknown, callId?: string, demo = false): Promise<T> {
  const token = callId ? sessions.get(callId)?.call_token : undefined;
  if (callId && !token) throw new Error('Join this call before using the assistant.');
  if (demo && !DEMO_KEY) throw new Error('The call demo key is missing from frontend/.env.local.');
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json', ...(demo ? { 'X-Demo-Key': DEMO_KEY } : {}), ...(token ? { 'X-Call-Token': token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new Error('Could not reach the call backend. Check your connection and try again.'); }
  const payload = await response.json();
  if (!response.ok) {
    const detail = typeof payload.detail === 'string' ? payload.detail
      : Array.isArray(payload.detail) ? payload.detail.map((error: { loc?: (string | number)[]; msg?: string }) => `${error.loc?.join('.') || 'request'}: ${error.msg || 'Invalid value'}`).join('; ')
      : `Call API error: ${response.status}`;
    throw new Error(detail);
  }
  return payload as T;
}

export async function createCall(groupId: string, userId: string): Promise<CallSession> {
  const session = await request<CallSession>('/calls', { group_id: groupId, user_id: userId }, undefined, true);
  registerCallSession(session); return session;
}
export async function joinCall(callId: string, userId: string): Promise<CallSession> {
  const session = await request<CallSession>(`/calls/${encodeURIComponent(callId)}/join`, { user_id: userId }, undefined, true);
  registerCallSession(session); return session;
}
export async function startTranscription(callId: string) {
  return request<{ status: string }>(`/calls/${callId}/transcription/start`, {}, callId);
}
export async function endCall(callId: string) {
  return request<{ status: string }>(`/calls/${callId}/end`, {}, callId);
}
export async function getMembers(callId: string) {
  return request<{ members: { attendee_id: string; user_id: string; is_host: boolean }[] }>(`/calls/${callId}/members`, undefined, callId);
}

export function toChimeResult(utterance: TranscriptUtterance): ChimeResult {
  return utterance.result || {
    resultId: utterance.id, isPartial: utterance.isPartial || false,
    startTimeMs: utterance.startMs, endTimeMs: utterance.endMs,
    alternatives: [{ transcript: utterance.text, items: [{
      type: 'pronunciation', content: utterance.text,
      startTimeMs: utterance.startMs, endTimeMs: utterance.endMs,
      attendee: { attendeeId: utterance.speakerId, externalUserId: utterance.speakerName },
    }] }],
  };
}
export async function storeTranscriptUtterance(params: TranscriptUtterance & { callId: string }): Promise<void> {
  const response = await request<{ accepted_results: number }>(`/calls/${params.callId}/transcripts`, { results: [toChimeResult(params)] }, params.callId);
  if (response.accepted_results !== 1) throw new Error('Transcript could not be saved.');
}

export async function explainCall(params: { callId: string; userId: string; atMs: number; transcript: TranscriptUtterance[]; question?: string }): Promise<ExplainResponse> {
  const payload = await request<ExplainResponse>(`/calls/${params.callId}/explain`, {
    at_ms: params.atMs, follow_up: params.question || null,
    pending_results: params.transcript.slice(-20).map(toChimeResult),
  }, params.callId);
  return { ...payload, confidence: 0, kind: 'general' };
}
export function askCallQuestion(params: { callId: string; userId: string; question: string; transcript: TranscriptUtterance[]; atMs?: number }) {
  return explainCall({ ...params, atMs: params.atMs ?? Date.now() });
}
export async function getSilenceSuggestions(params: { callId: string; userId: string; silenceDurationMs: number; transcript: TranscriptUtterance[] }): Promise<SuggestionPrompt[]> {
  return request<SuggestionPrompt[]>(`/calls/${params.callId}/suggest`, { at_ms: Date.now(), silence_duration_ms: params.silenceDurationMs }, params.callId);
}
