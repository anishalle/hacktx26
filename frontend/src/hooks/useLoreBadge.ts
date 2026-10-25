import { usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { api, type Lore } from '@/api';
import { getLoreLastSeenAt, isNewSince } from '@/lib/lore';
import { useRealtime } from '@/state/realtime';
import { useMe } from '@/state/session';

/** How many recent moments the badge looks at (the feed's page limit). */
const BADGE_WINDOW = 50;

const isFresh = (l: Lore, meId: string, seenAt: string | null) =>
  l.status === 'kept' && l.kept_by?.id !== meId && isNewSince(l, seenAt);

/**
 * The Lore tab's badge: kept moments new since `loreLastSeenAt`, other than ones I kept myself.
 * The Lore tab moves that mark when it loads its deck, so the badge hides while the tab is open
 * and is recounted from the mark when I leave it; `lore.updated` frames keep it live meanwhile.
 */
export function useLoreBadge(): number {
  const me = useMe();
  const pathname = usePathname();
  const onLore = pathname === '/reels' || pathname.startsWith('/reels/');
  const [fresh, setFresh] = useState<ReadonlySet<number>>(() => new Set());
  const seen = useRef<string | null>(null);

  useEffect(() => {
    if (onLore) return;
    let cancelled = false;
    (async () => {
      seen.current = await getLoreLastSeenAt(me.id);
      const feed = await api.getLoreFeed(me.id, { sort: 'recent', limit: BADGE_WINDOW });
      if (cancelled) return;
      setFresh(new Set(feed.items.filter((l) => isFresh(l, me.id, seen.current)).map((l) => l.id)));
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [me.id, onLore]);

  useRealtime((frame) => {
    if (frame.type !== 'lore.updated' || onLore) return;
    const l = frame.data;
    const add = isFresh(l, me.id, seen.current);
    setFresh((prev) => {
      if (add === prev.has(l.id)) return prev;
      const next = new Set(prev);
      if (add) next.add(l.id);
      else next.delete(l.id);
      return next;
    });
  });

  return onLore ? 0 : fresh.size;
}
