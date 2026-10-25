import type { InboxItem } from '@/api';

export type ConversationFilter = 'All' | 'Groups' | 'Direct';

export function filterConversations(items: InboxItem[], query: string, filter: ConversationFilter = 'All') {
  const needle = query.trim().toLowerCase();
  return items.filter(
    (item) =>
      (filter === 'All' || (filter === 'Direct' ? item.group.is_dm : !item.group.is_dm)) &&
      `${item.group.name} ${item.last_message?.text || ''}`.toLowerCase().includes(needle),
  );
}
