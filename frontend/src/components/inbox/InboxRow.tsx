import { Link } from 'expo-router';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { InboxItem, User } from '@/api';
import { conversationPreview, inboxTime, memberAvatars, memberNames } from '@/lib/conversations';
import { colors } from '@/theme';

import { Avatar, GroupAvatar } from '../Avatar';
import { Icon } from '../Icon';

export type InboxRowActions = {
  onCatchUp: (item: InboxItem) => void;
  onMarkRead: (item: InboxItem) => void;
  onCall: (item: InboxItem) => void;
  onLore: (item: InboxItem) => void;
};

type Props = {
  item: InboxItem;
  meId: string;
  userById: (id: string | null | undefined) => User | undefined;
  /** The group's members, for the overlapping avatar when it has no photo. */
  members?: User[];
  /** Long-press menu under the peek; rows without it only peek. */
  actions?: InboxRowActions;
  /** The last row drops its separator. */
  last?: boolean;
};

export function ConversationAvatar({
  item,
  meId,
  members,
  size,
}: Pick<Props, 'item' | 'meId' | 'members'> & { size: number }) {
  const { group } = item;
  const pair = !group.avatar_url && !group.is_dm ? memberAvatars(members, meId) : null;
  if (pair) return <GroupAvatar uris={pair} names={memberNames(members, meId)} size={size} />;
  return <Avatar uri={group.avatar_url} name={group.name} size={size} />;
}

/** One Messages row, iOS-style: unread dot, 52pt avatar, name and time, a 2-line preview. */
export const InboxRow = memo(function InboxRow({ item, meId, userById, members, actions, last }: Props) {
  const unread = item.unread_count > 0;
  const time = item.last_message ? inboxTime(item.last_message.ts) : '';
  const preview = conversationPreview(item, meId, userById);
  const label = [item.group.name, unread ? `${item.unread_count} unread` : null, time || null, preview]
    .filter(Boolean)
    .join(', ');
  const row = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={
        actions
          ? 'Opens the conversation. Touch and hold to peek and for more.'
          : 'Opens the conversation. Touch and hold to peek.'
      }
    >
      {/* Link's Slot flattens `style`, so a style function would be dropped: the pressed fill lives
          on an inner view instead. */}
      {({ pressed }) => (
        <View style={[styles.row, pressed && styles.pressed]}>
          <View style={styles.lead}>{unread ? <View style={styles.dot} /> : null}</View>
          <ConversationAvatar item={item} meId={meId} members={members} size={52} />
          <View style={styles.body}>
            <View style={styles.nameRow}>
              <Text style={[styles.name, unread && styles.nameUnread]} numberOfLines={1}>
                {item.group.name}
              </Text>
              {time ? <Text style={styles.time}>{time}</Text> : null}
              <Icon name="chevron.forward" size={13} color={colors.textTertiary} weight="semibold" />
            </View>
            <Text style={styles.preview} numberOfLines={2}>
              {preview}
            </Text>
          </View>
          {last ? null : <View style={styles.separator} />}
        </View>
      )}
    </Pressable>
  );
  const href = {
    pathname: '/thread/[id]' as const,
    params: {
      id: String(item.group.id),
      unread: String(item.unread_count),
      name: item.group.name,
    },
  };
  // Touch and hold peeks into the thread (Link.Preview). thread/[id] checks useIsPreview() so the
  // peek marks nothing read, shows no catch-up pill and listens to no realtime frames.
  if (!actions) {
    return (
      <Link href={href} asChild>
        <Link.Trigger>{row}</Link.Trigger>
        <Link.Preview />
      </Link>
    );
  }
  return (
    <Link href={href} asChild>
      <Link.Trigger>{row}</Link.Trigger>
      <Link.Preview />
      <Link.Menu>
        <Link.MenuAction
          title="Catch Me Up"
          icon="text.bubble"
          disabled={!unread}
          onPress={() => actions.onCatchUp(item)}
        />
        <Link.MenuAction
          title="Mark as Read"
          icon="checkmark.message"
          disabled={!unread}
          onPress={() => actions.onMarkRead(item)}
        />
        <Link.MenuAction title="Start Call" icon="video" onPress={() => actions.onCall(item)} />
        <Link.MenuAction
          title="Lore from This Group"
          icon="sparkles.rectangle.stack"
          onPress={() => actions.onLore(item)}
        />
      </Link.Menu>
    </Link>
  );
});

const styles = StyleSheet.create({
  row: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bg,
  },
  pressed: { backgroundColor: 'rgba(0,0,0,0.05)' },
  lead: { width: 20, alignItems: 'center', justifyContent: 'center' },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.blueDot,
  },
  body: {
    flex: 1,
    marginLeft: 12,
    paddingVertical: 10,
    paddingRight: 16,
    gap: 2,
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { flex: 1, color: colors.text, fontSize: 17, fontWeight: '600' },
  nameUnread: { fontWeight: '700' },
  time: { color: colors.textSecondary, fontSize: 15 },
  preview: { color: colors.textSecondary, fontSize: 15, lineHeight: 20 },
  separator: {
    position: 'absolute',
    left: 84,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator,
  },
});
