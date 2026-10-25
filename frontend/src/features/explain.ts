// Feature 1 (hold-to-explain): everything that wants an explanation (the message menu, catch-up
// term chips) calls `onExplain`, which opens the private explain sheet.
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
