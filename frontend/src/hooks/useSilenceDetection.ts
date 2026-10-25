import { useCallback, useEffect, useRef, useState } from 'react';
import type { SuggestionPrompt, TranscriptUtterance } from '../types/call';
import { getSilenceSuggestions } from '../services/api';

const SILENCE_THRESHOLD_MS = 45_000; // 45 seconds of silence triggers suggestions
const SUGGESTION_COOLDOWN_MS = 90_000; // don't re-suggest for 90 seconds after dismissal

/**
 * Detects when the local user has been silent for a while on the call
 * and fetches conversation suggestions from the AI.
 */
export function useSilenceDetection(params: {
  callId: string;
  userId: string;
  localParticipantId: string;
  getRecentTranscript: (windowMs: number) => TranscriptUtterance[];
  enabled: boolean;
}) {
  const { callId, userId, localParticipantId, getRecentTranscript, enabled } = params;
  const [suggestions, setSuggestions] = useState<SuggestionPrompt[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const lastSpokeAt = useRef<number>(0);
  const lastSuggestionAt = useRef<number>(0);
  const silenceTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * Call this whenever the local user speaks.
   */
  const recordUserSpeech = useCallback(() => {
    lastSpokeAt.current = Date.now();
    setShowSuggestions(false);
    setSuggestions([]);
  }, []);

  /**
   * Dismiss suggestions (user saw them but didn't act).
   */
  const dismissSuggestions = useCallback(() => {
    setShowSuggestions(false);
    setSuggestions([]);
    lastSuggestionAt.current = Date.now();
  }, []);

  /**
   * Tap on a suggestion — could auto-fill or just dismiss.
   */
  const selectSuggestion = useCallback((suggestion: SuggestionPrompt) => {
    setShowSuggestions(false);
    setSuggestions([]);
    lastSuggestionAt.current = Date.now();
    // The calling component handles what to do with the selected suggestion
    return suggestion;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    lastSpokeAt.current = Date.now();

    let cancelled = false;
    silenceTimer.current = setInterval(async () => {
      const silenceDuration = Date.now() - lastSpokeAt.current;
      const timeSinceLastSuggestion = Date.now() - lastSuggestionAt.current;

      if (
        silenceDuration >= SILENCE_THRESHOLD_MS &&
        timeSinceLastSuggestion >= SUGGESTION_COOLDOWN_MS &&
        !showSuggestions
      ) {
        const transcript = getRecentTranscript(60_000); // last minute
        if (transcript.length === 0) return; // nobody's talking, don't suggest

        // Only suggest if others are talking (not just dead silence)
        const othersAreTalking = transcript.some(
          (u) => u.speakerId !== localParticipantId,
        );
        if (!othersAreTalking) return;

        const speechAtRequest = lastSpokeAt.current;
        lastSuggestionAt.current = Date.now();
        const newSuggestions = await getSilenceSuggestions({
          callId,
          userId,
          silenceDurationMs: silenceDuration,
          transcript,
        });
        if (cancelled || lastSpokeAt.current !== speechAtRequest) return;
        setSuggestions(newSuggestions);
        setShowSuggestions(newSuggestions.length > 0);
      }
    }, 5000); // check every 5 seconds

    return () => {
      cancelled = true;
      if (silenceTimer.current) clearInterval(silenceTimer.current);
    };
  }, [enabled, callId, userId, localParticipantId, getRecentTranscript, showSuggestions]);

  return {
    suggestions,
    showSuggestions,
    recordUserSpeech,
    dismissSuggestions,
    selectSuggestion,
  };
}
