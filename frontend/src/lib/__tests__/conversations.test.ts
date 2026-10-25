import type { InboxItem, User } from '@/api';
import { composeTargets, conversationPreview, filterConversations, inboxTime } from '../conversations';

const group: InboxItem = {
  group: { id: 1, name: 'Sunday people', is_dm: false, avatar_url: null, member_count: 4 },
  last_message: {
    id: 1,
    group_id: 1,
    sender_id: 'sam',
    kind: 'text',
    text: 'Meet at the bakery',
    ts: '',
    reply_to: null,
    reactions: [],
  },
  unread_count: 2,
  last_read_message_id: null,
};
const direct: InboxItem = { ...group, group: { ...group.group, id: 2, name: 'Sam', is_dm: true }, last_message: null };

test('search matches names and message previews, respects the group filter, and keeps original order', () => {
  const items = [group, direct];
  expect(filterConversations(items, '  SUNDAY  ')).toEqual([group]);
  expect(filterConversations(items, 'BAKERY', 'Groups')).toEqual([group]);
  expect(filterConversations(items, 'bakery', 'Direct')).toEqual([]);
  expect(filterConversations(items, '', 'Direct')).toEqual([direct]);
  expect(filterConversations(items, '')).toEqual(items);
  expect(items).toEqual([group, direct]);
});

const user = (id: string, display_name: string): User => ({
  id,
  username: id,
  display_name,
  avatar_url: null,
  phonetic_hint: null,
  pronunciation_audio_url: null,
});
const sam = user('sam', 'Sam Lee');
const mia = user('mia', 'Mia Chen');
const me = user('me', 'Ani');

test('search also matches member names once they load', () => {
  expect(filterConversations([group, direct], 'mia')).toEqual([]);
  expect(filterConversations([group, direct], 'mia', 'All', { 1: [sam, mia] })).toEqual([group]);
});

test('previews prefix you or the group sender, and name captionless photos', () => {
  const byId = (id: string | null | undefined) => [sam, mia].find((u) => u.id === id);
  expect(conversationPreview(group, 'me', byId)).toBe('Sam: Meet at the bakery');
  expect(conversationPreview({ ...group, last_message: { ...group.last_message!, sender_id: 'me' } }, 'me', byId)).toBe(
    'You: Meet at the bakery',
  );
  expect(conversationPreview({ ...group, last_message: { ...group.last_message!, kind: 'photo', text: '' } }, 'me', byId)).toBe(
    'Sam: Photo',
  );
  expect(
    conversationPreview({ ...group, last_message: { ...group.last_message!, kind: 'game', text: 'Guess that Lore 🎲' } }, 'me', byId),
  ).toBe('Sam: 🎲 Guess that Lore');
  expect(conversationPreview(direct, 'me', byId)).toBe('No messages yet');
});

test('inbox times read like Messages', () => {
  const now = new Date(2026, 9, 25, 18, 0);
  expect(inboxTime(new Date(2026, 9, 25, 15, 29).toISOString(), now)).toBe('3:29 PM');
  expect(inboxTime(new Date(2026, 9, 25, 0, 5).toISOString(), now)).toBe('12:05 AM');
  expect(inboxTime(new Date(2026, 9, 24, 23, 0).toISOString(), now)).toBe('Yesterday');
  expect(inboxTime(new Date(2026, 9, 21, 9, 0).toISOString(), now)).toBe('Wednesday');
  expect(inboxTime(new Date(2026, 9, 12, 9, 0).toISOString(), now)).toBe('10/12/26');
});

test('compose sends people to their DM, else the smallest shared group', () => {
  const big: InboxItem = { ...group, group: { ...group.group, id: 3, name: 'Everyone', member_count: 9 } };
  const dm: InboxItem = { ...direct, group: { ...direct.group, member_count: 2 } };
  const members = { 1: [me, sam, mia], 2: [me, sam], 3: [me, sam, mia] };
  const { people, conversations } = composeTargets([big, group, dm], members, 'me', '');
  expect(people.map((p) => [p.user.id, p.item.group.id, p.direct])).toEqual([
    ['mia', 1, false],
    ['sam', 2, true],
  ]);
  expect(conversations).toEqual([big, group]);
  expect(composeTargets([big, group, dm], members, 'me', 'chen').people.map((p) => p.user.id)).toEqual(['mia']);
});
