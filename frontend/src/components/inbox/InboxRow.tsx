import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { InboxItem, User } from '@/api';
import { firstName, shortAge } from '@/lib/format';
import { colors } from '@/theme';

import { Avatar, GroupAvatar } from '../Avatar';

type Props = {
  item: InboxItem;
  meId: string;
  userById: (id: string | null | undefined) => User | undefined;
  onPress: (item: InboxItem) => void;
};

function subtitle(item: InboxItem, meId: string, userById: Props['userById']) {
  const m = item.last_message;
  if (!m) return 'Say hi';
  if (item.unread_count > 1) return item.unread_count >= 10 ? '10+ new messages' : `${item.unread_count} new messages`;
  if (m.kind === 'system') return m.text;
  const photo = m.kind === 'photo';
  const body = photo ? 'Sent a photo' : m.text;
  if (m.sender_id === meId) return item.unread_count ? body : photo ? 'You sent a photo' : `You: ${m.text}`;
  const sender = userById(m.sender_id);
  return !item.group.is_dm && sender ? `${firstName(sender.display_name)}: ${body}` : body;
}

export const InboxRow = memo(function InboxRow({ item, meId, userById, onPress }: Props) {
  const unread = item.unread_count > 0;
  const m = item.last_message;
  const sentByMe = m?.sender_id === meId;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={'Open conversation ' + item.group.name} onPress={() => onPress(item)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: '#ffffffcc' }]}>
      {item.group.is_dm || item.group.avatar_url ? (
        <Avatar uri={item.group.avatar_url} size={56} />
      ) : (
        <GroupAvatar uris={[null, null]} size={56} />
      )}
      <View style={styles.body}>
        <Text style={[styles.name, unread && styles.bold]} numberOfLines={1}>
          {item.group.name}
        </Text>
        <View style={styles.previewLine}>
          {sentByMe && !unread ? (
            <Text style={styles.preview} numberOfLines={1}>
              Sent {shortAge(m!.ts)} ago
            </Text>
          ) : (
            <>
              <Text style={[styles.preview, unread && styles.previewUnread]} numberOfLines={1}>
                {subtitle(item, meId, userById)}
              </Text>
              {m ? <Text style={styles.age}> · {shortAge(m.ts)}</Text> : null}
            </>
          )}
        </View>
      </View>
      {unread ? <View style={styles.dot} /> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, minHeight: 84, marginHorizontal: 18, marginBottom: 8, borderRadius: 24, backgroundColor: '#ffffff80', borderWidth: 1, borderColor: '#ffffff99' },
  body: { flex: 1, marginLeft: 12, marginRight: 12, justifyContent: 'center' },
  name: { color: colors.text, fontSize: 15, letterSpacing: -0.1 },
  bold: { fontWeight: '600' },
  previewLine: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  preview: { color: colors.textSecondary, fontSize: 15, flexShrink: 1 },
  previewUnread: { color: colors.text, fontWeight: '600' },
  age: { color: colors.textSecondary, fontSize: 15 },
  dot: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: colors.blueDot, marginRight: 4 },
});
