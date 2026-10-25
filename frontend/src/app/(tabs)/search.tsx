import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { InboxRow } from '@/components/inbox/InboxRow';
import { filterConversations } from '@/lib/conversations';
import { useInbox } from '@/state/inbox';
import { useMe, useSession } from '@/state/session';
import { colors } from '@/theme';
export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const me = useMe();
  const { items } = useInbox();
  const { userById } = useSession();
  const [query, setQuery] = useState('');
  const results = useMemo(() => filterConversations(items, query), [items, query]);
  return (
    <View style={[styles.screen, { paddingTop: insets.top + 24 }]}>
      <Text style={styles.eyebrow}>PICK UP THE THREAD</Text>
      <Text style={styles.title}>Find your people.</Text>
      <Text style={styles.sub}>A name, a group, a familiar conversation.</Text>
      <View style={styles.search}>
        <Icon name="magnifyingglass" size={20} color={colors.blue} />
        <TextInput
          accessibilityLabel="Find conversations"
          value={query}
          onChangeText={setQuery}
          placeholder="Search your chats"
          placeholderTextColor={colors.textTertiary}
          style={styles.input}
          clearButtonMode="while-editing"
          keyboardAppearance="light"
        />
      </View>
      <Text style={styles.label}>{query ? `${results.length} CONVERSATIONS FOUND` : 'YOUR CONVERSATIONS'}</Text>
      <FlatList
        contentInsetAdjustmentBehavior="never"
        data={results}
        keyExtractor={(item) => String(item.group.id)}
        renderItem={({ item }) => (
          <InboxRow
            item={item}
            meId={me.id}
            userById={userById}
            onPress={(it) =>
              router.push({
                pathname: '/thread/[id]',
                params: { id: String(it.group.id), unread: String(it.unread_count), name: it.group.name },
              })
            }
          />
        )}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 100 }}
        ListEmptyComponent={<Text style={styles.empty}>No matches yet. Try another name.</Text>}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  eyebrow: { paddingHorizontal: 24, color: colors.blue, fontSize: 10, fontWeight: '700', letterSpacing: 2 },
  title: { paddingHorizontal: 24, color: colors.text, fontSize: 32, fontWeight: '700', letterSpacing: -1.2, marginTop: 10 },
  sub: { paddingHorizontal: 24, color: colors.textSecondary, fontSize: 14, lineHeight: 21, marginTop: 8 },
  search: {
    margin: 24,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.searchBg,
    borderWidth: 1,
    borderColor: colors.separator,
    borderRadius: 16,
  },
  input: { minHeight: 52, color: colors.text, fontSize: 15, flex: 1 },
  label: {
    color: colors.textTertiary,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1.4,
    paddingHorizontal: 28,
    marginBottom: 12,
  },
  empty: { padding: 30, color: colors.textSecondary, textAlign: 'center' },
});
