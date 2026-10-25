import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type CallJoin, type ChimeResult } from '@/api';
import { engineFor, type CallEngine, type CallState } from '@/lib/callEngine';

const FLUSH_MS = 1200; // finals are batched, not sent one request per result
const MAX_BATCH = 50;
const MAX_PENDING = 20;

export type Participant = {
  attendeeId: string;
  userId: string | null;
  isLocal: boolean;
  muted: boolean;
  speaking: boolean;
  tileId?: number;
};

export type Caption = { userId: string | null; text: string; partial: boolean };

const textOf = (r: ChimeResult) => r.alternatives[0]?.transcript ?? '';
const speakerOf = (r: ChimeResult) =>
  r.alternatives[0]?.items.find((i) => i.type === 'pronunciation')?.attendee.externalUserId || null;

/**
 * Joins the media session for `join` and forwards final transcript results to the API.
 * `pendingResults()` returns finals not uploaded yet plus the current partial, for the ? tap.
 */
export function useCall(join: CallJoin | null, meId: string) {
  const [engine] = useState<CallEngine | null>(() => (join ? engineFor(join, meId) : null));
  const [state, setState] = useState<CallState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [caption, setCaption] = useState<Caption | null>(null);
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(true);

  const unsent = useRef(new Map<string, ChimeResult>());
  const partial = useRef<ChimeResult | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRef = useRef<() => void>(() => {});

  const schedule = useCallback(() => {
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      flushRef.current();
    }, FLUSH_MS);
  }, []);

  const flush = useCallback(async () => {
    if (!join || !unsent.current.size) return;
    const batch = [...unsent.current.values()].slice(0, MAX_BATCH);
    try {
      await api.sendTranscripts(join.call.id, meId, batch);
      batch.forEach((r) => unsent.current.delete(r.resultId));
    } catch {
      // kept in `unsent`: retried on the next flush and sent with any ? tap
    }
    if (unsent.current.size) schedule();
  }, [join, meId, schedule]);
  useEffect(() => {
    flushRef.current = () => void flush();
  }, [flush]);

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
      engine.addListener('onTranscriptionStatus', (e) => {
        if (!active) return;
        setTranscribing(e.status === 'started' || e.status === 'resumed');
        if (e.status === 'failed') setError(e.message || 'Live transcription could not start.');
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
      engine.addListener('onTranscript', (e) => {
        if (!active) return;
        for (const r of e.results) {
          if (!textOf(r).trim()) continue;
          if (r.isPartial) partial.current = r;
          else {
            if (partial.current?.resultId === r.resultId) partial.current = null;
            unsent.current.set(r.resultId, r);
          }
          setCaption({ userId: speakerOf(r), text: textOf(r), partial: r.isPartial });
        }
        if (unsent.current.size) schedule();
      }),
    ];

    engine
      .join(JSON.stringify(join.meeting), JSON.stringify(join.attendee))
      .then((r) => active && setVideoOff(!r.cameraEnabled))
      .catch((e) => {
        if (!active) return;
        setError(e instanceof Error ? e.message : 'Could not join the call.');
        setState('ended');
      });

    return () => {
      active = false;
      subs.forEach((s) => s.remove());
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = null;
      void flush();
      void engine.leave();
    };
  }, [join, engine, meId, flush, schedule]);

  const pendingResults = useCallback(
    () => [...unsent.current.values(), ...(partial.current ? [partial.current] : [])].slice(-MAX_PENDING),
    [],
  );

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
    transcribing,
    participants,
    caption,
    muted,
    videoOff,
    toggleMute,
    toggleVideo,
    pendingResults,
  };
}
