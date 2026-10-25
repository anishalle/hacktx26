import { useEffect, useMemo, useState } from 'react';

import { api, type InboxItem, type User } from '@/api';

import { firstName } from './format';

export type ConversationFilter = 'All' | 'Groups' | 'Direct';

/** Members per group id, for avatars and name search. Missing groups just haven't loaded. */
export type MembersByGroup = Record<number, User[]>;

/** Search over names, the last message and (once loaded) member names; keeps the inbox order. */
export function filterConversations(
  items: InboxItem[],
  query: string,
  filter: ConversationFilter = 'All',
  members: MembersByGroup = {},
) {
  const needle = query.trim().toLowerCase();
  return items.filter((item) => {
    if (filter !== 'All' && (filter === 'Direct') !== item.group.is_dm) return false;
    if (!needle) return true;
    const names = (members[item.group.id] ?? []).map((u) => `${u.display_name} ${u.username}`).join(' ');
    return `${item.group.name} ${item.last_message?.text || ''} ${names}`.toLowerCase().includes(needle);
  });
}

export const GAME_PREVIEW = '🎲 Guess that Lore';

/** The inbox row's 2-line preview: "You: …", "Sam: …" in groups, "Photo" for a captionless photo. */
export function conversationPreview(
  item: InboxItem,
  meId: string,
  userById: (id: string | null | undefined) => User | undefined,
) {
  const m = item.last_message;
  if (!m) return 'No messages yet';
  if (m.kind === 'system') return m.text;
  const body = m.kind === 'photo' ? m.text || 'Photo' : m.kind === 'game' ? GAME_PREVIEW : m.text;
  if (m.sender_id === meId) return `You: ${body}`;
  const sender = userById(m.sender_id);
  return !item.group.is_dm && sender ? `${firstName(sender.display_name)}: ${body}` : body;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Messages' trailing time: "3:29 PM" today, then "Yesterday", the weekday, and "10/12/26". */
export function inboxTime(iso: string, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (days <= 0) {
    const h = d.getHours();
    return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  }
  if (days === 1) return 'Yesterday';
  if (days < 7) return WEEKDAYS[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
}

/** Up to two other members' photos for a group without its own avatar. */
export function memberAvatars(members: User[] | undefined, meId: string) {
  const others = (members ?? []).filter((u) => u.id !== meId);
  return others.length >= 2 ? [others[0].avatar_url, others[1].avatar_url] : null;
}

/** The same two members' names, for initials when they have no photo. */
export function memberNames(members: User[] | undefined, meId: string) {
  return (members ?? [])
    .filter((u) => u.id !== meId)
    .slice(0, 2)
    .map((u) => u.display_name);
}

export type ComposePerson = { user: User; item: InboxItem; direct: boolean };

/**
 * The compose sheet's "To:" results. A person opens their DM, or, without one, the smallest group
 * you share (new conversations can't be created yet). Conversations match like the inbox search.
 */
export function composeTargets(items: InboxItem[], members: MembersByGroup, meId: string, query: string) {
  const needle = query.trim().toLowerCase();
  const byUser = new Map<string, ComposePerson>();
  for (const item of items) {
    for (const user of members[item.group.id] ?? []) {
      if (user.id === meId) continue;
      const prev = byUser.get(user.id);
      const direct = item.group.is_dm;
      if (
        !prev ||
        (direct && !prev.direct) ||
        (!prev.direct && !direct && item.group.member_count < prev.item.group.member_count)
      ) {
        byUser.set(user.id, { user, item, direct });
      }
    }
  }
  const people = [...byUser.values()]
    .filter(({ user }) => !needle || `${user.display_name} ${user.username}`.toLowerCase().includes(needle))
    .sort((a, b) => a.user.display_name.localeCompare(b.user.display_name));
  const conversations = filterConversations(
    items.filter((i) => !i.group.is_dm),
    query,
    'All',
    members,
  );
  return { people, conversations };
}

const memberCache = new Map<number, Promise<User[]>>();

/** Members of every inbox group, fetched once per group and shared by Messages, Search and compose. */
export function useGroupMembers(items: InboxItem[], userId: string): MembersByGroup {
  const [members, setMembers] = useState<MembersByGroup>({});
  const groupKey = useMemo(() => items.map((i) => i.group.id).join(','), [items]);
  useEffect(() => {
    let cancelled = false;
    const ids = groupKey ? groupKey.split(',').map(Number) : [];
    for (const id of ids) {
      let pending = memberCache.get(id);
      if (!pending) {
        pending = api.getGroup(id, userId).then((g) => g.members.map((m) => m.user));
        memberCache.set(id, pending);
        pending.catch(() => memberCache.delete(id));
      }
      pending
        .then((users) => {
          if (!cancelled) setMembers((prev) => (prev[id] === users ? prev : { ...prev, [id]: users }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [groupKey, userId]);
  return members;
}
