import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

import type { Call } from '@/api';
import { useActiveCalls } from '@/state/calls';

/** The group's active call (or null), read from ActiveCallsProvider and refetched when the screen focuses. */
export function useGroupCall(groupId: number): Call | null {
  const { byGroup, refresh } = useActiveCalls();
  useFocusEffect(
    useCallback(() => {
      refresh(groupId);
    }, [groupId, refresh]),
  );
  return byGroup[groupId] ?? null;
}
