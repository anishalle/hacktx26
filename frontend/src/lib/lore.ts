// Lore v2 client helpers: deck order, the per-user "last seen" mark, subtitles and tints.
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Lore, User } from '@/api';
import { colors } from '../theme';

import { firstName } from './format';

/** Cards per deck page (`sort=deck`). */
export const DECK_SIZE = 7;

const time = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};

/** When a moment reached the feed: when it was kept, else (backfill) when it ended. */
export const loreFeedTs = (l: Pick<Lore, 'kept_at' | 'ended_at'>) => l.kept_at ?? l.ended_at;

/** No mark yet (first open) means nothing counts as new. */
export function isNewSince(l: Pick<Lore, 'kept_at' | 'ended_at'>, lastSeenAt: string | null) {
  const seen = time(lastSeenAt);
  const at = time(loreFeedTs(l));
  return seen !== null && at !== null && at > seen;
}

/** Deck order: moments new since `lastSeenAt` first, otherwise the server's order; duplicates dropped. */
export function deckOrder<T extends Pick<Lore, 'id' | 'kept_at' | 'ended_at'>>(items: T[], lastSeenAt: string | null): T[] {
  const ids = new Set<number>();
  const unique: T[] = [];
  for (const l of items) {
    if (ids.has(l.id)) continue;
    ids.add(l.id);
    unique.push(l);
  }
  return [...unique.filter((l) => isNewSince(l, lastSeenAt)), ...unique.filter((l) => !isNewSince(l, lastSeenAt))];
}

/** The newest feed time among `items`, for marking them seen; null when there are none. */
export function newestFeedTs(items: Pick<Lore, 'kept_at' | 'ended_at'>[]): string | null {
  let best: { iso: string; t: number } | null = null;
  for (const l of items) {
    const iso = loreFeedTs(l);
    const t = time(iso);
    if (t !== null && (!best || t > best.t)) best = { iso, t };
  }
  return best?.iso ?? null;
}

// ---------------------------------------------------------------------------
// loreLastSeenAt (AsyncStorage, per user). Storage failures read as "never seen" and are ignored on write.
// ---------------------------------------------------------------------------
const lastSeenKey = (userId: string) => `lore_last_seen_at:${userId}`;

export async function getLoreLastSeenAt(userId: string): Promise<string | null> {
  try {
    const v = await AsyncStorage.getItem(lastSeenKey(userId));
    return time(v) === null ? null : v;
  } catch {
    return null;
  }
}

/** Moves the mark forward to `iso`; never back. */
export async function markLoreSeen(userId: string, iso: string | null): Promise<void> {
  const next = time(iso);
  if (next === null) return;
  try {
    const cur = time(await AsyncStorage.getItem(lastSeenKey(userId)));
    if (cur === null || next > cur) await AsyncStorage.setItem(lastSeenKey(userId), iso!);
  } catch {
    // storage unavailable: the deck just won't reorder next time
  }
}

// ---------------------------------------------------------------------------
// Subtitles: "Design team · Sat, Oct 12 · Maya, Theo +2"
// ---------------------------------------------------------------------------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Sat, Oct 12", or "Oct 12" without the weekday; the year is added when it isn't this year. */
export function loreDate(iso: string, { weekday = true, now = new Date() }: { weekday?: boolean; now?: Date } = {}) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== now.getFullYear() ? `, ${d.getFullYear()}` : ''}`;
  return weekday ? `${WEEKDAYS[d.getDay()]}, ${day}` : day;
}

/** "Maya, Theo +2": the first `max` first names, then how many more. */
export function peopleLabel(people: Pick<User, 'display_name'>[], max = 2) {
  const names = people.map((p) => firstName(p.display_name)).filter(Boolean);
  const extra = names.length - max;
  return extra > 0 ? `${names.slice(0, max).join(', ')} +${extra}` : names.join(', ');
}

export type SubtitleOptions = { group?: boolean; weekday?: boolean; people?: boolean; now?: Date };

/**
 * "Design team · Sat, Oct 12 · Maya, Theo +2". Leave out parts for other places: the deck card's
 * header (`group: false`) or a list row ("Design team · Oct 12": `weekday: false, people: false`).
 */
export function loreSubtitle(
  lore: Pick<Lore, 'group_name' | 'started_at' | 'people'>,
  { group = true, weekday = true, people = true, now }: SubtitleOptions = {},
) {
  return [group ? lore.group_name : '', loreDate(lore.started_at, { weekday, now }), people ? peopleLabel(lore.people) : '']
    .filter(Boolean)
    .join(' · ');
}

// ---------------------------------------------------------------------------
// Tints: a fixed hue per group, blue for audio moments
// ---------------------------------------------------------------------------
/** UIKit system pink, orange, yellow, green, mint, teal and indigo. */
export const LORE_TINTS = ['#FF2D55', '#FF9500', '#FFCC00', '#34C759', '#00C7BE', '#30B0C7', '#5856D6'] as const;

/** Stepping by 3 (coprime to 7) keeps neighbouring group ids on far-apart hues. */
export function groupTint(groupId: number) {
  const n = LORE_TINTS.length;
  return LORE_TINTS[(((groupId * 3) % n) + n) % n];
}

export function loreTint(lore: Pick<Lore, 'group_id' | 'hero_kind'>) {
  return lore.hero_kind === 'replay' ? colors.blue : groupTint(lore.group_id);
}

/** `#RRGGBB` at `alpha`, for the deck's background wash (25% by default). */
export function tintWash(hex: string, alpha = 0.25) {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
