import type { Explanation } from '@/api';

// Session-only, bounded cache: no private explanation is persisted on the device.
const cache = new Map<string, { result: Explanation; at: number }>();
export const explanationKey = (userId: string, groupId: number, messageId?: number, term?: string) =>
  JSON.stringify([userId, groupId, messageId ?? null, term ?? null]);
export function readExplanation(key: string) {
  const entry = cache.get(key);
  if (!entry || Date.now() - entry.at > 5 * 60_000) { cache.delete(key); return null; }
  return entry.result;
}
export function saveExplanation(key: string, result: Explanation) {
  cache.delete(key);
  cache.set(key, { result, at: Date.now() });
  if (cache.size > 100) cache.delete(cache.keys().next().value!);
}
