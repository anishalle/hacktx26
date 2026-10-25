import { Platform } from 'react-native';

export type Profile = { id: string; display_name: string; pronunciation_url: string | null };
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000/api/v1').replace(/\/$/, '');
const origin = new URL(API_URL).origin;
export const audioUrl = (path: string) => new URL(path, origin).href;

export async function api<T = void>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, options);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(typeof body?.detail === 'string' ? body.detail : 'Could not reach the server. Please try again.');
  }
  return response.status === 204 ? undefined as T : response.json();
}

export async function saveRecording(userId: string, uri: string): Promise<Profile> {
  const recording = await fetch(uri);
  const blob = await recording.blob();
  return api<Profile>(`/users/${userId}/pronunciation`, {
    method: 'PUT',
    headers: {
      'X-Demo-User': userId,
      'Content-Type': Platform.OS === 'web' ? (blob.type || 'audio/webm') : 'audio/mp4',
    },
    body: blob,
  });
}
