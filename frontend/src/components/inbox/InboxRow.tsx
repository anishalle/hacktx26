import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { InboxItem, User } from '@/api';
import { firstName, shortAge } from '@/lib/format';
import { colors } from '@/theme';
import { Avatar } from '../Avatar';
import { Icon } from '../Icon';

type Props = {
  item: InboxItem;
  meId: string;
  userById: (id: string | null | undefined) => User | undefined;
  onPress: (item: InboxItem) => void;
};
function subtitle(item: InboxItem, meId: string, userById: Props['userById']) {
  const m = item.last_message;
  if (!m) return 'Start the conversation';
  if (m.kind === 'system') return m.text;
  const body = m.kind === 'photo' ? 'Shared a photo' : m.text;
  if (m.sender_id === meId) return `You: ${body}`;
  const sender = userById(m.sender_id);
  return !item.group.is_dm && sender ? `${firstName(sender.display_name)}: ${body}` : body;
}
export const InboxRow = memo(function InboxRow({ item, meId, userById, onPress }: Props) {
  const unread = item.unread_count > 0;
  return (
    <Pressable
      onPress={() => onPress(item)}
      accessibilityRole="button"
      accessibilityLabel={`${item.group.name}${unread ? `, ${item.unread_count} unread messages` : ''}`}
      style={({ pressed }) => [styles.row, unread && styles.unreadRow, pressed && { backgroundColor: colors.surface }]}
    >
      <View>
        <Avatar uri={item.group.avatar_url} name={item.group.name} size={52} style={{ borderRadius: 18 }} />
        {!item.group.is_dm ? (
          <View style={styles.groupBadge}>
            <Icon name="person.2.fill" size={10} color={colors.textSecondary} />
          </View>
        ) : null}
      </View>
      <View style={styles.body}>
        <View style={styles.nameRow}>
          <Text style={[styles.name, unread && { color: colors.text }]} numberOfLines={1}>
            {item.group.name}
          </Text>
          {item.last_message ? (
            <Text style={[styles.age, unread && { color: colors.blue }]}>{shortAge(item.last_message.ts)}</Text>
          ) : null}
        </View>
        <View style={styles.previewRow}>
          <Text style={[styles.preview, unread && { color: colors.textSecondary }]} numberOfLines={1}>
            {subtitle(item, meId, userById)}
          </Text>
          {unread ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{item.unread_count > 99 ? '99+' : item.unread_count}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
});
const styles = StyleSheet.create({
  row: {
    marginHorizontal: 16,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 15,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 86,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  unreadRow: { backgroundColor: colors.surfaceAlt, borderColor: colors.separator },
  groupBadge: {
    position: 'absolute',
    bottom: -3,
    right: -3,
    backgroundColor: colors.surface,
    borderRadius: 7,
    padding: 3,
    borderWidth: 2,
    borderColor: colors.bg,
  },
  body: { flex: 1, marginLeft: 14 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  name: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
  age: { color: colors.textTertiary, fontSize: 11 },
  previewRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6, gap: 10 },
  preview: { flex: 1, color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  badge: {
    minWidth: 22,
    minHeight: 22,
    borderRadius: 8,
    paddingHorizontal: 5,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: colors.blue, fontSize: 10, fontWeight: '700' },
});
