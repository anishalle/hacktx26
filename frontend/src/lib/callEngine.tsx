// Feature 4 call media. The native Chime bridge (modules/chime-call) carries audio/video and
// streams this phone's own mic for captions; it needs an Expo dev build. In mock mode a scripted
// engine stands in (the mock API plays the captions), so the whole call + ? flow demos in Expo Go.
import { NativeModule, requireNativeView, requireOptionalNativeModule } from 'expo';
import type { StyleProp, ViewStyle } from 'react-native';

import { USE_MOCKS, type CallJoin } from '@/api';

export type CallState = 'connecting' | 'connected' | 'reconnecting' | 'ended';

export type CallEvents = {
  /** Captions stream: connecting | ready | reconnecting | error. */
  onCaptionStatus: (event: { status: string; message?: string | null }) => void;
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
  /** Streams this phone's microphone (24 kHz PCM16) to the captions WebSocket at `url`. */
  startCaptions(url: string): Promise<void>;
  stopCaptions(): Promise<void>;
  addListener<K extends keyof CallEvents>(event: K, listener: CallEvents[K]): { remove(): void };
}

declare class ChimeCallModule extends NativeModule<CallEvents> {
  join(meeting: string, attendee: string): Promise<{ cameraEnabled: boolean }>;
  leave(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setVideoOff(off: boolean): Promise<void>;
  startCaptions(url: string): Promise<void>;
  stopCaptions(): Promise<void>;
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
// Scripted engine (mock mode): media events only; the mock API plays the captions.
// ---------------------------------------------------------------------------

function scriptedEngine(join: CallJoin, _meId: string): CallEngine {
  const subs = new Map<keyof CallEvents, Set<(e: never) => void>>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const emit = <K extends keyof CallEvents>(name: K, event: Parameters<CallEvents[K]>[0]) =>
    subs.get(name)?.forEach((fn) => (fn as CallEvents[K])(event as never));
  const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

  return {
    async join() {
      later(0, () => emit('onState', { state: 'connecting' }));
      later(600, () => {
        emit('onState', { state: 'connected' });
        emit('onParticipants', {
          attendees: join.call.members.filter((m) => !m.left_at).map((m) => ({ attendeeId: m.attendee_id, externalUserId: m.user.id })),
        });
      });
      return { cameraEnabled: false };
    },
    async leave() {
      timers.splice(0).forEach(clearTimeout);
    },
    async setMuted() {},
    async setVideoOff() {},
    async startCaptions() {
      later(300, () => emit('onCaptionStatus', { status: 'ready' }));
    },
    async stopCaptions() {},
    addListener(event, listener) {
      let set = subs.get(event);
      if (!set) subs.set(event, (set = new Set()));
      set.add(listener as (e: never) => void);
      return { remove: () => set!.delete(listener as (e: never) => void) };
    },
  };
}
