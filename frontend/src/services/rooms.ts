import type { TranscriptUtterance } from '../types/call';

export interface RoomInvitation { room_id: string; invite_token: string }
export interface RoomAccess { server_url: string; participant_token: string; participant_identity: string }

const API_BASE = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8000';

async function request<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/v1${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(12_000), body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Cannot reach the call server. Check your connection and try again.');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(typeof payload?.detail === 'string' ? payload.detail : 'Could not join this call. Try again.');
  }
  return response.json();
}

export function createRoom() { return request<RoomInvitation>('/calls/rooms', {}); }
export function joinRoom(roomId: string, inviteToken: string, displayName: string) {
  return request<RoomAccess>(`/calls/rooms/${encodeURIComponent(roomId)}/join`, {
    invite_token: inviteToken, display_name: displayName,
  });
}

/** Speech integrations provide finalized, timestamped utterances through this seam. */
export type FinalUtterance = Omit<TranscriptUtterance, 'id' | 'timestamp'>;
