import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChimeResult, TranscriptUtterance } from '../types/call';
import { storeTranscriptUtterance } from '../services/api';

export function useCallTranscript(callId: string) {
  const [storageError, setStorageError] = useState<string | null>(null);
  const [utterances, setUtterances] = useState<TranscriptUtterance[]>([]);
  const buffer = useRef<TranscriptUtterance[]>([]);
  const pending = useRef(new Map<string, Promise<void>>());
  const failed = useRef(new Map<string, TranscriptUtterance>());
  const generation = useRef(0);
  useEffect(() => {
    const currentGeneration = ++generation.current;
    buffer.current = []; pending.current.clear(); failed.current.clear();
    return () => { generation.current = currentGeneration + 1; };
  }, [callId]);
  const addUtterance = useCallback((input: Omit<TranscriptUtterance, 'id' | 'timestamp'> & { id?: string }) => {
    const current = generation.current;
    const id = input.id || `${input.speakerId}-${input.startMs}-${input.endMs}`;
    const previous = buffer.current.find(item => item.id === id);
    if (previous && !previous.isPartial && input.isPartial) return;
    const full: TranscriptUtterance = { ...input, id, timestamp: new Date(input.endMs) };
    const cutoff = Date.now() - 300_000;
    buffer.current = [...buffer.current.filter(item => item.id !== id && item.endMs >= cutoff), full].sort((a, b) => a.startMs - b.startMs);
    setUtterances([...buffer.current]);
    if (full.isPartial) return;
    const save = storeTranscriptUtterance({ ...full, callId }).then(() => {
      if (current === generation.current) { failed.current.delete(id); setStorageError(null); }
    }).catch((error) => {
      if (current === generation.current) { failed.current.set(id, full); setStorageError(error instanceof Error ? error.message : 'Transcript could not be saved.'); }
      throw error;
    });
    pending.current.set(id, save);
    // Keep failed writes observable to flush(), without unhandled rejections.
    void save.catch(() => undefined);
  }, [callId]);
  const addChimeResults = useCallback((results: ChimeResult[], names: Record<string, string>) => {
    for (const result of results) {
      const alternative = result.alternatives[0];
      if (!alternative?.transcript) continue;
      const speakerId = alternative.items[0]?.attendee.attendeeId || 'unknown';
      addUtterance({ id: result.resultId, speakerId, speakerName: names[speakerId] || 'Participant', text: alternative.transcript, startMs: result.startTimeMs, endMs: result.endTimeMs, isPartial: result.isPartial, result });
    }
  }, [addUtterance]);
  const flush = useCallback(async () => {
    const writes = [...pending.current.entries()];
    await Promise.allSettled(writes.map(([, promise]) => promise));
    for (const [id, utterance] of failed.current) {
      await storeTranscriptUtterance({ ...utterance, callId });
      failed.current.delete(id);
    }
    for (const [id, promise] of writes) if (pending.current.get(id) === promise) pending.current.delete(id);
    setStorageError(null);
  }, [callId]);
  const getRecentWindow = useCallback((windowMs = 10_000) => {
    const at = Date.now();
    return buffer.current.filter(item => item.endMs >= at - windowMs && item.startMs <= at);
  }, []);
  const getUtterancesBySpeaker = useCallback((speakerId: string) => buffer.current.filter(item => item.speakerId === speakerId), []);
  return { utterances, storageError, addUtterance, addChimeResults, flush, getRecentWindow, getUtterancesBySpeaker };
}
