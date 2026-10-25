import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { api, type Call } from '@/api';
import { useRealtime } from '@/state/realtime';

/** The group's active call (or null): fetched on focus, kept current by `call.updated` frames. */
export function useGroupCall(groupId: number) {
  const [call, setCall] = useState<Call | null>(null);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      api
        .getCall(groupId)
        .then((c) => !cancelled && setCall(c))
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }, [groupId]),
  );
  useRealtime((frame) => {
    if (frame.type === 'call.updated' && frame.data.group_id === groupId) setCall(frame.data.ended_at ? null : frame.data);
  });
  return call;
}
