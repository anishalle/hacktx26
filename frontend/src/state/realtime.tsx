import { createContext, ReactNode, use, useEffect, useRef, useState } from 'react';

import { api, type RealtimeFrame, type RealtimeStatus } from '@/api';

type Listener = (frame: RealtimeFrame) => void;
type Ctx = { subscribe: (fn: Listener) => () => void; status: RealtimeStatus };

const RealtimeContext = createContext<Ctx | null>(null);

/** One WebSocket for the current user; screens subscribe to frames. Reconnects when the user changes. */
export function RealtimeProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  const [ctx] = useState(() => ({
    subscribe: (fn: Listener) => {
      listeners.current.add(fn);
      return () => {
        listeners.current.delete(fn);
      };
    },
  }));

  useEffect(() => {
    return api.connectRealtime(userId, {
      onFrame: (frame) => listeners.current.forEach((fn) => fn(frame)),
      onStatus: setStatus,
    });
  }, [userId]);

  return <RealtimeContext value={{ ...ctx, status }}>{children}</RealtimeContext>;
}

/** Calls `handler` for every frame. The latest handler is always used; no need to memoize it. */
export function useRealtime(handler: Listener) {
  const ctx = use(RealtimeContext);
  if (!ctx) throw new Error('useRealtime outside RealtimeProvider');
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  const { subscribe } = ctx;
  useEffect(() => subscribe((f) => ref.current(f)), [subscribe]);
  return ctx.status;
}
