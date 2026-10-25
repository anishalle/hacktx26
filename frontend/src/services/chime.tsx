import { NativeModule, requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ChimeResult } from '../types/call';

export type ChimeEvents = {
  onTranscript: (event: { results: ChimeResult[] }) => void;
  onTranscriptionStatus: (event: { status: string; message?: string }) => void;
  onState: (event: { state: 'connecting' | 'connected' | 'reconnecting' | 'ended'; reason?: string }) => void;
  onError: (event: { message: string }) => void;
  onVideoTile: (event: { tileId: number; attendeeId: string; isLocal: boolean; removed: boolean }) => void;
  onParticipants: (event: { attendees?: { attendeeId: string; externalUserId: string }[]; removed?: boolean; attendeeIds?: string[]; muted?: boolean }) => void;
  onVolume: (event: { updates: { attendeeId: string; speaking: boolean }[] }) => void;
};
declare class ChimeCallModule extends NativeModule<ChimeEvents> {
  join(meeting: string, attendee: string): Promise<{ cameraEnabled: boolean }>;
  leave(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setVideoOff(off: boolean): Promise<void>;
}
export const Chime = requireOptionalNativeModule<ChimeCallModule>('ChimeCall');
const VideoView = Chime ? requireNativeViewManager<{ tileId: number; mirror: boolean; style: StyleProp<ViewStyle> }>('ChimeCall') : null;
export function ChimeVideo({ tileId, mirror, style }: { tileId: number; mirror: boolean; style: StyleProp<ViewStyle> }) {
  return VideoView ? <VideoView tileId={tileId} mirror={mirror} style={style} /> : null;
}
