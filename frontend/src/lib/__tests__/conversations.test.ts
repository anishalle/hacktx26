import type { InboxItem } from '@/api';
import { filterConversations } from '../conversations';

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
