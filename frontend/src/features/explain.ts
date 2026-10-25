// Feature 1 (hold-to-explain) hook point. Owned by a teammate: replace the body of
// `useExplain` with the real flow. Everything that wants an explanation calls `onExplain`.
import { useRouter } from 'expo-router';
import { useCallback } from 'react';

import type { Message } from '@/api';

export type ExplainTarget = { groupId: number; message?: Message; term?: string };

export function useExplain() {
  const router = useRouter();
  return useCallback(
    (target: ExplainTarget) => {
      router.push({
        pathname: '/explain',
        params: {
          groupId: String(target.groupId),
          ...(target.message ? { messageId: String(target.message.id), text: target.message.text } : {}),
          ...(target.term ? { term: target.term } : {}),
        },
      });
    },
    [router],
  );
}
