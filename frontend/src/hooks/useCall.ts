import { useCallback, useEffect, useState } from 'react';

import { callAudioUrl, type CallCaption, type CallJoin } from '@/api';
import { engineFor, type CallEngine, type CallState } from '@/lib/callEngine';
import { useRealtime } from '@/state/realtime';

const KEEP_FINISHED = 3; // finished turns kept above the live one (they scroll up and fade)

export type Participant = {
  attendeeId: string;
  userId: string | null;
  isLocal: boolean;
  muted: boolean;
  speaking: boolean;
  tileId?: number;
};

/** One speaker's recent speech: finished turns (oldest first) plus the turn in progress. */
export type SpeakerCaption = {
  finished: string[];
  live: { turnId: string; text: string } | null;
  updatedAt: number;
};

export type CaptionStatus = 'off' | 'connecting' | 'ready' | 'reconnecting' | 'error';

function applyCaption(prev: SpeakerCaption | undefined, c: CallCaption): SpeakerCaption {
  const base = prev ?? { finished: [], live: null, updatedAt: 0 };
  let finished = base.finished;
  // A new turn pushes the previous live text up as finished, even if its final got lost.
  if (base.live && base.live.turnId !== c.turn_id && base.live.text) finished = [...finished, base.live.text];
  if (c.final) {
    finished = [...finished, c.text].slice(-KEEP_FINISHED);
    return { finished, live: null, updatedAt: Date.now() };
  }
  return { finished: finished.slice(-KEEP_FINISHED), live: { turnId: c.turn_id, text: c.text }, updatedAt: Date.now() };
}

/**
 * Joins the media session for `join` and streams this phone's microphone for captions.
 * Captions for everyone (this member included) arrive as `call.caption` frames, keyed by user.
 */
export function useCall(join: CallJoin | null, meId: string) {
  const [engine] = useState<CallEngine | null>(() => (join ? engineFor(join, meId) : null));
  const [state, setState] = useState<CallState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [captionStatus, setCaptionStatus] = useState<CaptionStatus>('off');
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [captions, setCaptions] = useState<Record<string, SpeakerCaption>>({});
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(true);

  useRealtime((frame) => {
    if (frame.type !== 'call.caption' || !join || frame.data.call_id !== join.call.id) return;
    const c = frame.data;
    setCaptions((all) => ({ ...all, [c.user_id]: applyCaption(all[c.user_id], c) }));
  });

  useEffect(() => {
    if (!join || !engine) return;
    let active = true;
    const memberOf = (attendeeId: string) => join.call.members.find((m) => m.attendee_id === attendeeId)?.user.id ?? null;
    const localId = String(join.attendee.AttendeeId ?? '');
    const upsert = (attendeeId: string, userId: string | null, patch: Partial<Participant> = {}) =>
      setParticipants((list) => {
        const found = list.some((p) => p.attendeeId === attendeeId);
        const base: Participant = { attendeeId, userId: userId ?? memberOf(attendeeId), isLocal: attendeeId === localId, muted: false, speaking: false };
        return found ? list.map((p) => (p.attendeeId === attendeeId ? { ...p, ...patch, userId: p.userId ?? userId } : p)) : [...list, { ...base, ...patch }];
      });
    upsert(localId, meId);

    const subs = [
      engine.addListener('onState', (e) => active && setState(e.state)),
      engine.addListener('onError', (e) => active && setError(e.message)),
      engine.addListener('onCaptionStatus', (e) => {
        if (!active) return;
        const status = (['connecting', 'ready', 'reconnecting', 'error'] as const).find((s) => s === e.status) ?? 'connecting';
        setCaptionStatus(status);
        if (status === 'error') setError(e.message || 'Live captions are unavailable right now.');
        else if (status === 'ready') setError(null);
      }),
      engine.addListener('onParticipants', (e) => {
        if (!active) return;
        for (const a of e.attendees ?? []) {
          if (e.removed) setParticipants((list) => list.filter((p) => p.attendeeId !== a.attendeeId));
          else upsert(a.attendeeId, a.externalUserId || null);
        }
        if (e.attendeeIds) setParticipants((list) => list.map((p) => (e.attendeeIds!.includes(p.attendeeId) ? { ...p, muted: !!e.muted } : p)));
      }),
      engine.addListener('onVideoTile', (e) => active && upsert(e.attendeeId, null, { tileId: e.removed ? undefined : e.tileId })),
      engine.addListener('onVolume', (e) => {
        if (!active) return;
        setParticipants((list) =>
          list.map((p) => {
            const u = e.updates.find((x) => x.attendeeId === p.attendeeId);
            return u ? { ...p, speaking: u.speaking } : p;
          }),
        );
      }),
    ];

    engine
      .join(JSON.stringify(join.meeting), JSON.stringify(join.attendee))
      .then(async (r) => {
        if (!active) return;
        setVideoOff(!r.cameraEnabled);
        setCaptionStatus('connecting');
        await engine.startCaptions(callAudioUrl(join.call.id, meId));
      })
      .catch((e) => {
        if (!active) return;
        setError(e instanceof Error ? e.message : 'Could not join the call.');
        setState('ended');
      });

    return () => {
      active = false;
      subs.forEach((s) => s.remove());
      void engine.stopCaptions().catch(() => {});
      void engine.leave();
    };
  }, [join, engine, meId]);

  const toggleMute = useCallback(async () => {
    if (!engine) return;
    try {
      await engine.setMuted(!muted);
      setMuted((m) => !m);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [engine, muted]);

  const toggleVideo = useCallback(async () => {
    if (!engine) return;
    try {
      await engine.setVideoOff(!videoOff);
      setVideoOff((v) => !v);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [engine, videoOff]);

  return {
    supported: !!engine,
    state,
    error,
    captionStatus,
    participants,
    captions,
    muted,
    videoOff,
    toggleMute,
    toggleVideo,
  };
}
