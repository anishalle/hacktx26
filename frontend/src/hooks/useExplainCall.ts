import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExplainResponse, TranscriptUtterance } from '../types/call';
import { askCallQuestion, explainCall } from '../services/api';

export function useExplainCall(callId: string, userId: string, flush: () => Promise<void>) {
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<ExplainResponse | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const busy = useRef(false);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  useEffect(() => () => { generation.current++; clearTimer(); }, [clearTimer]);
  const run = useCallback(async (transcript: TranscriptUtterance[], question?: string) => {
    if (busy.current) return;
    clearTimer();
    const current = ++generation.current;
    busy.current = true;
    setIsLoading(true);
    setIsVisible(true);
    setResponse(null);
    try {
      const atMs = Date.now();
      await flush();
      const result = question
        ? await askCallQuestion({ callId, userId, question, transcript, atMs })
        : await explainCall({ callId, userId, atMs, transcript });
      if (current !== generation.current) return;
      setResponse(result);
      if (!question) timer.current = setTimeout(() => setIsVisible(false), 15_000);
    } catch (error) {
      if (current === generation.current) setResponse({
        answer: error instanceof Error ? error.message : 'Assistant unavailable. Try again.', confidence: 0,
      });
    } finally {
      busy.current = false;
      if (current === generation.current) setIsLoading(false);
    }
  }, [callId, userId, clearTimer, flush]);
  const quickExplain = useCallback((transcript: TranscriptUtterance[]) => run(transcript), [run]);
  const askQuestion = useCallback((question: string, transcript: TranscriptUtterance[]) => run(transcript, question), [run]);
  const dismiss = useCallback(() => { clearTimer(); setIsVisible(false); }, [clearTimer]);
  return { isLoading, response, isVisible, quickExplain, askQuestion, dismiss };
}
