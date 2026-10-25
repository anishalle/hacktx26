import { useCallback, useRef, useState } from 'react';
import type { Participant } from '../types/call';

interface SpeakerState {
  participantId: string;
  isSpeaking: boolean;
  lastSpokeAt: number;
  totalSpeakTimeMs: number;
}

/**
 * Tracks who is currently speaking in the call.
 * Updates participant speaking state based on audio level or STT events.
 * Stores speaker activity for display (highlight active speaker tile).
 */
export function useSpeakerDetection(participants: Participant[]) {
  const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null);
  const speakerStates = useRef<Map<string, SpeakerState>>(new Map());

  // Initialize speaker states for all participants
  const initSpeakers = useCallback((pList: Participant[]) => {
    pList.forEach((p) => {
      if (!speakerStates.current.has(p.id)) {
        speakerStates.current.set(p.id, {
          participantId: p.id,
          isSpeaking: false,
          lastSpokeAt: 0,
          totalSpeakTimeMs: 0,
        });
      }
    });
  }, []);

  /**
   * Mark a participant as currently speaking.
   * Called when STT detects speech from a specific participant.
   */
  const setSpeaking = useCallback((participantId: string, speaking: boolean) => {
    const state = speakerStates.current.get(participantId);
    if (state) {
      if (speaking && !state.isSpeaking) {
        state.isSpeaking = true;
        state.lastSpokeAt = Date.now();
      } else if (!speaking && state.isSpeaking) {
        state.isSpeaking = false;
        state.totalSpeakTimeMs += Date.now() - state.lastSpokeAt;
      }
      speakerStates.current.set(participantId, state);
    }

    if (speaking) {
      setActiveSpeakerId(participantId);
    } else if (activeSpeakerId === participantId) {
      setActiveSpeakerId(null);
    }
  }, [activeSpeakerId]);

  /**
   * Get the most active speaker (by total talk time).
   */
  const getMostActiveSpeaker = useCallback((): string | null => {
    let maxTime = 0;
    let maxId: string | null = null;
    speakerStates.current.forEach((state) => {
      const total = state.isSpeaking
        ? state.totalSpeakTimeMs + (Date.now() - state.lastSpokeAt)
        : state.totalSpeakTimeMs;
      if (total > maxTime) {
        maxTime = total;
        maxId = state.participantId;
      }
    });
    return maxId;
  }, []);

  return {
    activeSpeakerId,
    setSpeaking,
    getMostActiveSpeaker,
    initSpeakers,
  };
}
