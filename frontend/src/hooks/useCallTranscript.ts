import { useCallback, useRef, useState } from 'react';
import type { TranscriptUtterance } from '../types/call';
import { storeTranscriptUtterance } from '../services/api';

const BUFFER_MAX_MS = 5 * 60 * 1000; // keep 5 minutes of transcript in memory

/**
 * Manages the live transcript buffer during a call.
 * Receives utterances from the STT service (via WebSocket) and keeps a rolling window.
 * Also persists each utterance to the backend for long-term storage.
 */
export function useCallTranscript(callId: string) {
  const [storageError, setStorageError] = useState<string | null>(null);
  const [utterances, setUtterances] = useState<TranscriptUtterance[]>([]);
  const utterancesRef = useRef<TranscriptUtterance[]>([]);

  const addUtterance = useCallback(
    (utterance: Omit<TranscriptUtterance, 'id' | 'timestamp'>) => {
      const full: TranscriptUtterance = {
        ...utterance,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date(),
      };

      utterancesRef.current = [...utterancesRef.current, full];

      // Trim buffer: remove utterances older than BUFFER_MAX_MS
      const cutoff = Date.now() - BUFFER_MAX_MS;
      utterancesRef.current = utterancesRef.current.filter(
        (u) => u.timestamp.getTime() > cutoff,
      );

      setUtterances([...utterancesRef.current]);

      // Persist to backend (fire and forget)
      storeTranscriptUtterance({
        callId,
        speakerId: utterance.speakerId,
        speakerName: utterance.speakerName,
        text: utterance.text,
        startMs: utterance.startMs,
        endMs: utterance.endMs,
      }).then(() => setStorageError(null)).catch(() => setStorageError("Transcript not saved. Check the backend connection."));
    },
    [callId],
  );

  /**
   * Get the last N milliseconds of transcript for the ? button.
   */
  const getRecentWindow = useCallback(
    (windowMs: number = 30_000): TranscriptUtterance[] => {
      const cutoff = Date.now() - windowMs;
      return utterancesRef.current.filter(
        (u) => u.timestamp.getTime() > cutoff,
      );
    },
    [],
  );

  /**
   * Get all utterances by a specific speaker.
   */
  const getUtterancesBySpeaker = useCallback(
    (speakerId: string): TranscriptUtterance[] => {
      return utterancesRef.current.filter((u) => u.speakerId === speakerId);
    },
    [],
  );

  return {
    utterances,
    storageError,
    addUtterance,
    getRecentWindow,
    getUtterancesBySpeaker,
  };
}
