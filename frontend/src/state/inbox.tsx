import { createContext, ReactNode, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, type InboxItem } from '@/api';

import { useRealtime } from './realtime';

type Inbox = {
  items: InboxItem[];
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  refresh: () => Promise<void>;
  /** Optimistically mark a thread read up to `messageId` (the thread screen calls this after POST /read). */
  markReadLocal: (groupId: number, messageId: number) => void;
  unreadThreads: number;
};

const InboxContext = createContext<Inbox | null>(null);

export function InboxProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [status, setStatus] = useState<Inbox['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.getInbox(userId);
      setItems(list);
      setStatus('ready');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus((s) => (s === 'ready' ? s : 'error'));
    }
  }, [userId]);

  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(refresh, 400);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    api
      .getInbox(userId)
      .then((list) => {
        if (cancelled) return;
        setItems(list);
        setStatus('ready');
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });
    return () => {
      cancelled = true;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [userId]);

  useRealtime((frame) => {
    if (frame.type === 'message.new') {
      const m = frame.data;
      setItems((prev) => {
        const idx = prev.findIndex((it) => it.group.id === m.group_id);
        if (idx === -1) {
          refreshSoon();
          return prev;
        }
        const it = prev[idx];
        if (it.last_message && it.last_message.id >= m.id) return prev;
        const updated: InboxItem = {
          ...it,
          last_message: m,
          unread_count: m.sender_id === userId ? 0 : it.unread_count + 1,
          last_read_message_id: m.sender_id === userId ? m.id : it.last_read_message_id,
        };
        return [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)];
      });
    } else if (frame.type === 'read.updated' && frame.data.user_id === userId) {
      const { group_id, message_id } = frame.data;
      setItems((prev) =>
        prev.map((it) => {
          if (it.group.id !== group_id) return it;
          if (it.last_message && message_id >= it.last_message.id) {
            return { ...it, unread_count: 0, last_read_message_id: message_id };
          }
          refreshSoon();
          return it;
        }),
      );
    }
  });

  const markReadLocal = useCallback((groupId: number, messageId: number) => {
    setItems((prev) =>
      prev.map((it) =>
        it.group.id === groupId && it.last_message && messageId >= it.last_message.id
          ? { ...it, unread_count: 0, last_read_message_id: messageId }
          : it,
      ),
    );
  }, []);

  const value = useMemo<Inbox>(
    () => ({
      items,
      status,
      error,
      refresh,
      markReadLocal,
      unreadThreads: items.filter((i) => i.unread_count > 0).length,
    }),
    [items, status, error, refresh, markReadLocal],
  );
  return <InboxContext value={value}>{children}</InboxContext>;
}

export function useInbox() {
  const ctx = use(InboxContext);
  if (!ctx) throw new Error('useInbox outside InboxProvider');
  return ctx;
}
