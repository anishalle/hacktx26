/**
 * API client for the video call features.
 * Stubs for now — will connect to AWS backend (Bedrock + RDS) once IAM is set up.
 */

import type { ExplainResponse, SuggestionPrompt, TranscriptUtterance } from '../types/call';

const API_BASE = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8000';

/**
 * Quick explain — single tap on ? button.
 * Sends last ~30s of transcript to Bedrock for a fast one-liner.
 */
export async function explainCall(params: {
  callId: string;
  userId: string;
  atMs: number;
  transcript: TranscriptUtterance[];
}): Promise<ExplainResponse> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/explain/call`, {
      method: 'POST',
      signal: AbortSignal.timeout(12_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        call_id: params.callId,
        user_id: params.userId,
        at_ms: params.atMs,
        recent_transcript: params.transcript.map((u) => ({
          speaker_id: u.speakerId,
          speaker_name: u.speakerName,
          text: u.text,
          start_ms: u.startMs,
          end_ms: u.endMs,
        })),
      }),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return await res.json();
  } catch {
    // Surface connection failures; never substitute invented call context.
    throw new Error("Could not reach the assistant. Check the API connection and try again.");
  }
}

/**
 * Detailed question — long press on ? button.
 * User asks a specific question about the call.
 */
export async function askCallQuestion(params: {
  callId: string;
  userId: string;
  question: string;
  transcript: TranscriptUtterance[];
}): Promise<ExplainResponse> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/explain/call`, {
      method: 'POST',
      signal: AbortSignal.timeout(12_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        call_id: params.callId,
        user_id: params.userId,
        follow_up: params.question,
        recent_transcript: params.transcript.map((u) => ({
          speaker_id: u.speakerId,
          speaker_name: u.speakerName,
          text: u.text,
          start_ms: u.startMs,
          end_ms: u.endMs,
        })),
      }),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return await res.json();
  } catch {
    throw new Error("Could not reach the assistant. Check the API connection and try again.");
  }
}

/**
 * Get silence-based suggestions when user hasn't spoken.
 */
export async function getSilenceSuggestions(params: {
  callId: string;
  userId: string;
  silenceDurationMs: number;
  transcript: TranscriptUtterance[];
}): Promise<SuggestionPrompt[]> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/suggest/call`, {
      method: 'POST',
      signal: AbortSignal.timeout(12_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        call_id: params.callId,
        user_id: params.userId,
        silence_duration_ms: params.silenceDurationMs,
        recent_transcript: params.transcript.map((u) => ({
          speaker_id: u.speakerId,
          speaker_name: u.speakerName,
          text: u.text,
          start_ms: u.startMs,
          end_ms: u.endMs,
        })),
      }),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return await res.json();
  } catch {
    return [];
  }
}

/**
 * Store a transcript utterance to the backend (Postgres via RDS).
 */
export async function storeTranscriptUtterance(params: {
  callId: string;
  speakerId: string;
  speakerName: string;
  text: string;
  startMs: number;
  endMs: number;
}): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/calls/${encodeURIComponent(params.callId)}/transcript`, {
      method: 'POST',
      signal: AbortSignal.timeout(12_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        speaker_id: params.speakerId,
        speaker_name: params.speakerName,
        text: params.text,
        start_ms: params.startMs,
        end_ms: params.endMs,
      }),
    });
    if (!res.ok || !(await res.json()).stored) throw new Error('Transcript not stored');
  } catch {
    throw new Error('Transcript could not be saved.');
  }
}
