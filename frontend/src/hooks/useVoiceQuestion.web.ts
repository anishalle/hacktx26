import { useCallback, useEffect, useRef, useState } from 'react';
import type { PrivateAudioSession } from '../services/call/PrivateAudioSession';
import { createSpeechRecognition, type BrowserRecognition } from '../services/call/speech.web';

export type VoiceStatus = 'idle' | 'preparing' | 'listening' | 'ready' | 'stopping' | 'error';

export function useVoiceQuestion(audio: PrivateAudioSession | null, onSubmit: (text: string) => void) {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState('');
  const generation = useRef(0);
  const recognition = useRef<BrowserRecognition | null>(null);
  const restore = useRef<(() => Promise<void>) | null>(null);
  const transcriptRef = useRef('');
  const busy = useRef(false);
  const recording = useRef(false);
  const sending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (stopTimer.current) clearTimeout(stopTimer.current);
  }, []);

  const close = useCallback(async () => {
    generation.current++;
    clearTimers();
    const current = recognition.current;
    recognition.current = null;
    recording.current = false;
    sending.current = false;
    if (current) { current.onend = null; current.onerror = null; current.onresult = null; current.onstart = null; current.abort(); }
    const release = restore.current;
    restore.current = null;
    try { await release?.(); }
    catch { setError('Your microphone could not be restored. Use Unmute when ready.'); setStatus('error'); return; }
    finally { busy.current = false; }
    setStatus('idle');
  }, [clearTimers]);

  const deliver = useCallback(async () => {
    const text = transcriptRef.current.trim();
    await close();
    if (text) onSubmit(text);
  }, [close, onSubmit]);

  const start = useCallback(async () => {
    if (busy.current || !audio) return;
    busy.current = true;
    const currentGeneration = ++generation.current;
    setTranscript(''); transcriptRef.current = '';
    setError(''); setStatus('preparing');
    try {
      const speech = createSpeechRecognition();
      const release = await audio.enter();
      if (currentGeneration !== generation.current) { await release(); return; }
      restore.current = release;
      recognition.current = speech;
      speech.onstart = () => { if (currentGeneration === generation.current) { recording.current = true; setStatus('listening'); } };
      speech.onresult = event => {
        if (currentGeneration !== generation.current) return;
        const text = Array.from(event.results).map(result => result[0].transcript).join(' ').trim();
        transcriptRef.current = text;
        setTranscript(text);
      };
      speech.onerror = event => {
        if (currentGeneration !== generation.current) return;
        clearTimers(); sending.current = false; recording.current = false;
        setError(event.error === 'not-allowed' || event.error === 'service-not-allowed'
          ? 'Allow microphone and speech access in your browser, then try again.'
          : event.error === 'no-speech' ? 'No speech heard. Close and try again.' : 'Speech recognition stopped. Close and try again.');
        setStatus('error');
      };
      speech.onend = () => {
        if (currentGeneration !== generation.current) return;
        recording.current = false; clearTimers();
        if (sending.current) { void deliver(); return; }
        setStatus(current => current === 'error' ? current : 'ready');
      };
      speech.start();
      timer.current = setTimeout(() => speech.stop(), 20_000);
    } catch (e) {
      if (currentGeneration !== generation.current) return;
      await restore.current?.().catch(() => {}); restore.current = null;
      busy.current = false;
      setError(e instanceof Error ? e.message : 'Voice capture could not start.');
      setStatus('error');
    }
  }, [audio, clearTimers, deliver]);

  const send = useCallback(() => {
    if (!transcriptRef.current.trim() || sending.current) return;
    sending.current = true;
    setStatus('stopping');
    if (!recording.current) { void deliver(); return; }
    recognition.current?.stop();
    // Some engines omit onend after stop; abort before restoration in that case.
    stopTimer.current = setTimeout(() => { void deliver(); }, 2500);
  }, [deliver]);

  useEffect(() => () => {
    generation.current++;
    clearTimers();
    const current = recognition.current;
    if (current) { current.onend = null; current.onerror = null; current.onresult = null; current.onstart = null; current.abort(); }
    void restore.current?.().catch(() => {});
  }, [clearTimers]);

  return { status, transcript, error, start, send, close, active: status !== 'idle' };
}
