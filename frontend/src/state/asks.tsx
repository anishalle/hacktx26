import { createContext, ReactNode, use, useCallback, useEffect, useMemo, useState } from 'react';

import { api, type MemberAsk } from '@/api';

import { useRealtime } from './realtime';

type AsksState = {
  /** Asks sent to the current user (the member who knows). */
  incoming: MemberAsk[];
  /** Asks the current user sent from the explain sheet. */
  outgoing: MemberAsk[];
  pendingIncoming: number;
  refresh: () => Promise<void>;
  /** Insert or replace an ask the user just created or answered. */
  upsert: (ask: MemberAsk) => void;
  /** The current user's latest ask about `term` in this group, if any. */
  findOutgoing: (groupId: number, term: string) => MemberAsk | undefined;
};

const AsksContext = createContext<AsksState | null>(null);

const upsertInto = (list: MemberAsk[], ask: MemberAsk) => [ask, ...list.filter((a) => a.id !== ask.id)];

/** Feature 1's private asks for the current user, kept live by `ask.new` / `ask.updated` frames. */
export function AsksProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [incoming, setIncoming] = useState<MemberAsk[]>([]);
  const [outgoing, setOutgoing] = useState<MemberAsk[]>([]);

  const refresh = useCallback(async () => {
    try {
      const res = await api.getAsks(userId);
      setIncoming(res.incoming);
      setOutgoing(res.outgoing);
    } catch {
      // keep what we have; the next frame or refresh catches up
    }
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    api
      .getAsks(userId)
      .then((res) => {
        if (cancelled) return;
        setIncoming(res.incoming);
        setOutgoing(res.outgoing);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const upsert = useCallback(
    (ask: MemberAsk) => {
      if (ask.asked_user.id === userId) setIncoming((prev) => upsertInto(prev, ask));
      if (ask.for_user.id === userId) setOutgoing((prev) => upsertInto(prev, ask));
    },
    [userId],
  );

  useRealtime((frame) => {
    if (frame.type === 'ask.new' || frame.type === 'ask.updated') upsert(frame.data);
  });

  const value = useMemo<AsksState>(
    () => ({
      incoming,
      outgoing,
      pendingIncoming: incoming.filter((a) => a.status === 'pending').length,
      refresh,
      upsert,
      findOutgoing: (groupId, term) =>
        outgoing.find((a) => a.group_id === groupId && a.term.toLowerCase() === term.toLowerCase()),
    }),
    [incoming, outgoing, refresh, upsert],
  );
  return <AsksContext value={value}>{children}</AsksContext>;
}

export function useAsks() {
  const ctx = use(AsksContext);
  if (!ctx) throw new Error('useAsks outside AsksProvider');
  return ctx;
}
