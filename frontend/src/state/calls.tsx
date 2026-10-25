import { createContext, ReactNode, use, useCallback, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';

import { api, type Call } from '@/api';

import { useInbox } from './inbox';
import { useRealtime } from './realtime';

type ActiveCalls = {
  /** Live calls by group id; ended calls are dropped. */
  byGroup: Record<number, Call>;
  /** Refetch one group's call (a thread on focus), or every inbox group's. */
  refresh: (groupId?: number) => Promise<void>;
};

const ActiveCallsContext = createContext<ActiveCalls | null>(null);

function put(prev: Record<number, Call>, groupId: number, call: Call | null) {
  const live = call && !call.ended_at ? call : null;
  if (!live && !(groupId in prev)) return prev;
  const next = { ...prev };
  if (live) next[groupId] = live;
  else delete next[groupId];
  return next;
}

/**
 * The live call in each of the user's groups: seeded from `getCall` per inbox group on load and
 * when the app comes back to the foreground, then kept current by `call.updated` frames.
 */
export function ActiveCallsProvider({ children }: { children: ReactNode }) {
  const { items } = useInbox();
  const [byGroup, setByGroup] = useState<Record<number, Call>>({});

  // Refetch only when the set of groups changes, not on every new message.
  const groupKey = useMemo(
    () =>
      items
        .map((it) => it.group.id)
        .sort((a, b) => a - b)
        .join(','),
    [items],
  );

  const refresh = useCallback(
    async (groupId?: number) => {
      const ids = groupId != null ? [groupId] : groupKey ? groupKey.split(',').map(Number) : [];
      await Promise.all(
        ids.map((id) =>
          api
            .getCall(id)
            .then((call) => setByGroup((prev) => put(prev, id, call)))
            .catch(() => {}),
        ),
      );
    },
    [groupKey],
  );

  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && refresh());
    return () => sub.remove();
  }, [refresh]);

  useRealtime((frame) => {
    if (frame.type === 'call.updated') setByGroup((prev) => put(prev, frame.data.group_id, frame.data));
  });

  const value = useMemo<ActiveCalls>(() => ({ byGroup, refresh }), [byGroup, refresh]);
  return <ActiveCallsContext value={value}>{children}</ActiveCallsContext>;
}

export function useActiveCalls() {
  const ctx = use(ActiveCallsContext);
  if (!ctx) throw new Error('useActiveCalls outside ActiveCallsProvider');
  return ctx;
}
