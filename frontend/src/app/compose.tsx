import { ContentUnavailableView, Host } from '@expo/ui/swift-ui';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { InboxItem } from '@/api';
import { Avatar } from '@/components/Avatar';
import { ConversationAvatar } from '@/components/inbox/InboxRow';
import { composeTargets, useGroupMembers } from '@/lib/conversations';
import { firstName } from '@/lib/format';
import { useInbox } from '@/state/inbox';
import { useMe } from '@/state/session';
import { colors } from '@/theme';

/** New Message: pick a person or group from your conversations and jump straight into that thread. */
export default function ComposeSheet() {
  const router = useRouter();
  const me = useMe();
  const { items } = useInbox();
  const members = useGroupMembers(items, me.id);
  const [query, setQuery] = useState('');
  const { people, conversations } = useMemo(() => composeTargets(items, members, me.id, query), [items, members, me.id, query]);

  const open = (item: InboxItem) => {
    Haptics.selectionAsync();
    router.replace({
      pathname: '/thread/[id]',
      params: { id: String(item.group.id), unread: String(item.unread_count), name: item.group.name },
    });
  };

  return (
    <View style={styles.sheet}>
      {/* The header rides inside the ScrollView as a sticky header: a formSheet sizes its ScrollView to
          the whole sheet, so a sibling header above it ends up underneath the rows. */}
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" stickyHeaderIndices={[0]} contentContainerStyle={styles.content}>
        <View style={styles.top}>
          <View style={styles.header}>
            <Pressable onPress={() => router.back()} accessibilityRole="button" hitSlop={8} style={styles.cancel}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Text style={styles.title} accessibilityRole="header">
              New Message
            </Text>
            <View style={styles.cancel} />
          </View>
          <View style={styles.to}>
            <Text style={styles.toLabel}>To:</Text>
            <TextInput
              accessibilityLabel="To"
              value={query}
              onChangeText={setQuery}
              autoFocus
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="done"
              clearButtonMode="while-editing"
              keyboardAppearance="light"
              style={styles.toInput}
            />
          </View>
        </View>
        {people.length ? <Text style={styles.sectionTitle}>People</Text> : null}
        {people.map(({ user, item, direct }, i) => (
          <Pressable
            key={user.id}
            onPress={() => open(item)}
            accessibilityRole="button"
            accessibilityLabel={`${user.display_name}, ${direct ? 'direct message' : `in ${item.group.name}`}`}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <Avatar uri={user.avatar_url} name={user.display_name} size={40} />
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {user.display_name}
              </Text>
              <Text style={styles.rowSub} numberOfLines={1}>
                {direct ? `@${user.username}` : `No direct thread with ${firstName(user.display_name)} · opens ${item.group.name}`}
              </Text>
            </View>
            {i < people.length - 1 ? <View style={styles.separator} /> : null}
          </Pressable>
        ))}
        {conversations.length ? <Text style={styles.sectionTitle}>Groups</Text> : null}
        {conversations.map((item, i) => (
          <Pressable
            key={item.group.id}
            onPress={() => open(item)}
            accessibilityRole="button"
            accessibilityLabel={`${item.group.name}, ${item.group.member_count} people`}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <ConversationAvatar item={item} meId={me.id} members={members[item.group.id]} size={40} />
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.group.name}
              </Text>
              <Text style={styles.rowSub} numberOfLines={1}>
                {(members[item.group.id] ?? [])
                  .filter((u) => u.id !== me.id)
                  .map((u) => firstName(u.display_name))
                  .join(', ') || `${item.group.member_count} people`}
              </Text>
            </View>
            {i < conversations.length - 1 ? <View style={styles.separator} /> : null}
          </Pressable>
        ))}
        {!people.length && !conversations.length && query.trim() ? (
          <Host matchContents={{ vertical: true }} style={styles.empty}>
            <ContentUnavailableView
              title="No Matches"
              systemImage="person.crop.circle.badge.questionmark"
              description="Only people and groups you already talk with show up here."
            />
          </Host>
        ) : null}
        <Text style={styles.footer}>New groups aren’t supported yet.</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.bg },
  top: { backgroundColor: colors.bg },
  header: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  cancel: { minWidth: 64, minHeight: 44, justifyContent: 'center' },
  cancelText: { color: colors.blue, fontSize: 17 },
  title: {
    flex: 1,
    textAlign: 'center',
    color: colors.text,
    fontSize: 17,
    fontWeight: '600',
  },
  to: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    minHeight: 44,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
  },
  toLabel: { color: colors.textSecondary, fontSize: 17, marginRight: 6 },
  toInput: { flex: 1, minHeight: 44, color: colors.text, fontSize: 17 },
  content: { paddingBottom: 40 },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    paddingHorizontal: 16,
    marginTop: 20,
    marginBottom: 6,
  },
  row: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 12,
  },
  pressed: { backgroundColor: 'rgba(0,0,0,0.05)' },
  rowBody: { flex: 1, gap: 1 },
  rowTitle: { color: colors.text, fontSize: 17 },
  rowSub: { color: colors.textSecondary, fontSize: 13 },
  separator: {
    position: 'absolute',
    left: 68,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator,
  },
  empty: { width: '100%', marginTop: 32 },
  footer: {
    color: colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 28,
    paddingHorizontal: 32,
  },
});
