import type { Participant, TranscriptUtterance } from '../types/call';

/**
 * Mock data for development.
 * Simulates a live call with transcript flowing in.
 * Remove this once Daily/LiveKit + Deepgram STT is integrated.
 */

export const MOCK_PARTICIPANTS: Participant[] = [
  {
    id: 'user-local',
    displayName: 'Priya',
    isMuted: false,
    isSpeaking: false,
    isLocal: true,
  },
  {
    id: 'user-swayam',
    displayName: 'Swayam',
    isMuted: false,
    isSpeaking: false,
    isLocal: false,
  },
  {
    id: 'user-mike',
    displayName: 'Mike',
    isMuted: false,
    isSpeaking: false,
    isLocal: false,
  },
  {
    id: 'user-alex',
    displayName: 'Alex',
    isMuted: false,
    isSpeaking: false,
    isLocal: false,
  },
];

/**
 * Simulated conversation lines — these play out over time to test the UI.
 * Include inside references that the ? button should explain.
 */
const MOCK_LINES: { speakerId: string; speakerName: string; text: string }[] = [
  { speakerId: 'user-swayam', speakerName: 'Swayam', text: "yo are we still going to Grandma's after the game?" },
  { speakerId: 'user-mike', speakerName: 'Mike', text: "yeah for sure, same time as usual right?" },
  { speakerId: 'user-alex', speakerName: 'Alex', text: "bro last time we went Mike got absolutely procs'd" },
  { speakerId: 'user-swayam', speakerName: 'Swayam', text: "lmaooo he was down bad, couldn't even come back" },
  { speakerId: 'user-mike', speakerName: 'Mike', text: "nah nah that doesn't count, I wasn't ready" },
  { speakerId: 'user-alex', speakerName: 'Alex', text: "that's what you said at the 6-7 too" },
  { speakerId: 'user-swayam', speakerName: 'Swayam', text: "anyway who's driving? I can't, my car's still at the shop" },
  { speakerId: 'user-mike', speakerName: 'Mike', text: "I got you, I'll swing by after I grab stuff from the Spot" },
  { speakerId: 'user-alex', speakerName: 'Alex', text: "Priya you coming too right? You gotta see Grandma's, it's iconic" },
  { speakerId: 'user-swayam', speakerName: 'Swayam', text: "yeah it's basically the hangout spot, you'll love it" },
  { speakerId: 'user-mike', speakerName: 'Mike', text: "just don't let Chef cook again, last time was a war crime" },
  { speakerId: 'user-alex', speakerName: 'Alex', text: "Chef is Alex by the way, self-proclaimed, emphasis on self" },
];

/**
 * Starts a mock transcript simulation.
 * Fires a callback with each utterance at a realistic cadence.
 * Returns a cleanup function.
 */
export function startMockTranscript(
  onUtterance: (u: Omit<TranscriptUtterance, 'id' | 'timestamp'>) => void,
  onSpeakerChange: (speakerId: string, speaking: boolean) => void,
): () => void {
  let index = 0;
  let cancelled = false;

  const playNext = () => {
    if (cancelled || index >= MOCK_LINES.length) {
      // Loop back
      index = 0;
    }

    const line = MOCK_LINES[index];
    const now = Date.now();

    // Simulate speaker starting
    onSpeakerChange(line.speakerId, true);

    // Duration proportional to text length (rough: 100ms per character)
    const durationMs = Math.max(1500, line.text.length * 80);

    // Emit the utterance partway through
    setTimeout(() => {
      if (cancelled) return;
      onUtterance({
        speakerId: line.speakerId,
        speakerName: line.speakerName,
        text: line.text,
        startMs: now,
        endMs: now + durationMs,
      });
    }, durationMs * 0.6);

    // Stop speaking after duration
    setTimeout(() => {
      if (cancelled) return;
      onSpeakerChange(line.speakerId, false);
    }, durationMs);

    index++;

    // Next line after a pause (2-5 seconds between lines)
    const gap = 2000 + Math.random() * 3000;
    setTimeout(() => {
      if (!cancelled) playNext();
    }, durationMs + gap);
  };

  // Start after a short delay
  setTimeout(playNext, 1500);

  return () => {
    cancelled = true;
  };
}
