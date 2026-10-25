// Feature 4 call media. The native Chime bridge (modules/chime-call) needs an Expo dev build;
// in mock mode a scripted engine stands in so the whole call + ? flow demos in Expo Go.
import { NativeModule, requireNativeView, requireOptionalNativeModule } from 'expo';
import type { StyleProp, ViewStyle } from 'react-native';

import { USE_MOCKS, type CallJoin, type ChimeResult } from '@/api';

export type CallState = 'connecting' | 'connected' | 'reconnecting' | 'ended';

export type CallEvents = {
  onTranscript: (event: { results: ChimeResult[] }) => void;
  onTranscriptionStatus: (event: { status: string; message?: string }) => void;
  onState: (event: { state: CallState; reason?: string }) => void;
  onError: (event: { message: string }) => void;
  onVideoTile: (event: { tileId: number; attendeeId: string; isLocal: boolean; removed: boolean }) => void;
  onParticipants: (event: {
    attendees?: { attendeeId: string; externalUserId: string }[];
    removed?: boolean;
    attendeeIds?: string[];
    muted?: boolean;
  }) => void;
  onVolume: (event: { updates: { attendeeId: string; speaking: boolean }[] }) => void;
};

export interface CallEngine {
  join(meeting: string, attendee: string): Promise<{ cameraEnabled: boolean }>;
  leave(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setVideoOff(off: boolean): Promise<void>;
  addListener<K extends keyof CallEvents>(event: K, listener: CallEvents[K]): { remove(): void };
}

declare class ChimeCallModule extends NativeModule<CallEvents> {
  join(meeting: string, attendee: string): Promise<{ cameraEnabled: boolean }>;
  leave(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setVideoOff(off: boolean): Promise<void>;
}

const Chime = requireOptionalNativeModule<ChimeCallModule>('ChimeCall');
const NativeVideo = Chime
  ? requireNativeView<{ tileId: number; mirror: boolean; style?: StyleProp<ViewStyle> }>('ChimeCall')
  : null;

/** True in a dev build that includes modules/chime-call; false in Expo Go. */
export const isChimeAvailable = !!Chime;

/** Renders a Chime video tile; nothing without the native module. */
export function ChimeVideo({ tileId, mirror, style }: { tileId: number; mirror: boolean; style?: StyleProp<ViewStyle> }) {
  return NativeVideo ? <NativeVideo tileId={tileId} mirror={mirror} style={style} /> : null;
}

/** The engine for this join: scripted in mock mode, Chime when available, else null (show the dev-build notice). */
export function engineFor(join: CallJoin, meId: string): CallEngine | null {
  if (USE_MOCKS) return scriptedEngine(join, meId);
  return Chime;
}

// ---------------------------------------------------------------------------
// Scripted engine (mock mode)
// ---------------------------------------------------------------------------

// Lines lean on the mock group's glossary ("Grandma", "usual spot"), one unexplained
// reference ("code yellow") and general slang ("bet"), so every card state shows up.
const SCRIPT = [
  'yo are we still doing grandma’s after the game',
  'yeah but meet at the usual spot first',
  'bet',
  'and nobody call a code yellow this time',
  'lmao that was one time',
];
const LINE_GAP_MS = 5200;
const WORD_MS = 260;

function scriptedEngine(join: CallJoin, meId: string): CallEngine {
  const subs = new Map<keyof CallEvents, Set<(e: never) => void>>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const emit = <K extends keyof CallEvents>(name: K, event: Parameters<CallEvents[K]>[0]) =>
    subs.get(name)?.forEach((fn) => (fn as CallEvents[K])(event as never));
  const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

  const others = join.call.members.filter((m) => m.user.id !== meId && !m.left_at);
  const speakers = others.length ? others : join.call.members;
  const attendees = speakers.map((m) => ({ attendeeId: m.attendee_id, externalUserId: m.user.id }));

  function speak(line: string, index: number, at: number) {
    const who = attendees[index % attendees.length];
    const words = line.split(' ');
    const resultId = `mock-${join.call.id}-${Date.now()}-${index}`;
    const start = Date.now() + at;
    const result = (n: number, partial: boolean): ChimeResult => {
      const items = words.slice(0, n).map((w, i) => ({
        type: 'pronunciation' as const,
        content: w,
        startTimeMs: start + i * WORD_MS,
        endTimeMs: start + (i + 1) * WORD_MS,
        attendee: who,
      }));
      return {
        resultId,
        isPartial: partial,
        startTimeMs: start,
        endTimeMs: start + n * WORD_MS,
        alternatives: [{ transcript: words.slice(0, n).join(' '), items }],
      };
    };
    later(at, () => emit('onVolume', { updates: [{ attendeeId: who.attendeeId, speaking: true }] }));
    words.forEach((_, i) => later(at + (i + 1) * WORD_MS, () => emit('onTranscript', { results: [result(i + 1, true)] })));
    later(at + words.length * WORD_MS + 300, () => {
      emit('onTranscript', { results: [result(words.length, false)] });
      emit('onVolume', { updates: [{ attendeeId: who.attendeeId, speaking: false }] });
    });
  }

  return {
    async join() {
      later(0, () => emit('onState', { state: 'connecting' }));
      later(600, () => {
        emit('onState', { state: 'connected' });
        emit('onParticipants', { attendees: join.call.members.filter((m) => !m.left_at).map((m) => ({ attendeeId: m.attendee_id, externalUserId: m.user.id })) });
        emit('onTranscriptionStatus', { status: 'started' });
      });
      SCRIPT.forEach((line, i) => speak(line, i, 1800 + i * LINE_GAP_MS));
      return { cameraEnabled: false };
    },
    async leave() {
      timers.splice(0).forEach(clearTimeout);
    },
    async setMuted() {},
    async setVideoOff() {},
    addListener(event, listener) {
      let set = subs.get(event);
      if (!set) subs.set(event, (set = new Set()));
      set.add(listener as (e: never) => void);
      return { remove: () => set!.delete(listener as (e: never) => void) };
    },
  };
}
