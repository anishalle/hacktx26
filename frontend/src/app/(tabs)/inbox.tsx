import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { InboxItem } from '@/api';
import { Avatar } from '@/components/Avatar';
import { BrandMark } from '@/components/BrandMark';
import { Icon } from '@/components/Icon';
import { InboxRow } from '@/components/inbox/InboxRow';
import { filterConversations, type ConversationFilter } from '@/lib/conversations';
import { useAsks } from '@/state/asks';
import { useInbox } from '@/state/inbox';
import { useMe, useSession } from '@/state/session';
import { colors } from '@/theme';

export default function InboxScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const me = useMe();
  const { userById } = useSession();
  const { items, status, error, refresh } = useInbox();
  const { pendingIncoming, refresh: refreshAsks } = useAsks();
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ConversationFilter>('All');
  useFocusEffect(
    useCallback(() => {
      refresh();
      refreshAsks();
    }, [refresh, refreshAsks]),
  );
  const visible = useMemo(() => filterConversations(items, query, filter), [items, filter, query]);
  const openThread = useCallback(
    (item: InboxItem) => {
      Haptics.selectionAsync();
      router.push({
        pathname: '/thread/[id]',
        params: { id: String(item.group.id), unread: String(item.unread_count), name: item.group.name },
      });
    },
    [router],
  );
  const openSwitcher = () => {
    Haptics.selectionAsync();
    router.push('/switch-user');
  };
  const contextHint = (
    <View style={styles.contextCard}>
      <View style={styles.contextIcon}>
        <Icon name="sparkles" size={22} color={colors.blue} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.contextTitle}>There’s a story behind it.</Text>
        <Text style={styles.contextText}>Hold a message or photo to understand a little more.</Text>
      </View>
    </View>
  );
  const header = (
    <View>
      <View style={styles.heading}>
        <Text style={styles.eyebrow}>CONVERSATIONS</Text>
        <Text style={styles.title}>Your people.</Text>
        <Text style={styles.subtitle}>A little context. A closer connection.</Text>
      </View>
      <View style={styles.search}>
        <Icon name="magnifyingglass" size={19} color={colors.textSecondary} />
        <TextInput
          accessibilityLabel="Search conversations"
          value={query}
          onChangeText={setQuery}
          placeholder="Find a conversation"
          placeholderTextColor={colors.textTertiary}
          style={styles.input}
          returnKeyType="search"
          clearButtonMode="while-editing"
          keyboardAppearance="light"
        />
      </View>
      <View style={styles.section}>
        <View style={styles.filters}>
          {(['All', 'Groups', 'Direct'] as const).map((label) => (
            <Pressable
              key={label}
              onPress={() => {
                setFilter(label);
                Haptics.selectionAsync();
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: filter === label }}
              style={[styles.filter, filter === label && styles.filterActive]}
            >
              <Text style={[styles.filterText, filter === label && styles.filterTextActive]}>{label}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable
          onPress={() => router.push('/requests')}
          accessibilityRole="button"
          accessibilityLabel={`Questions${pendingIncoming ? `, ${pendingIncoming} pending` : ''}`}
          style={styles.questions}
        >
          <Icon name="bubble.left.and.text.bubble.right" size={18} color={pendingIncoming ? colors.blue : colors.textSecondary} />
          {pendingIncoming ? <Text style={styles.questionCount}>{pendingIncoming}</Text> : null}
        </Pressable>
      </View>
    </View>
  );
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.topbar}>
        <View style={styles.brand}>
          <BrandMark size={28} />
          <Text style={styles.brandName}>closer</Text>
        </View>
        <Pressable
          onPress={openSwitcher}
          accessibilityRole="button"
          accessibilityLabel={`Switch profile, currently ${me.display_name}`}
          style={styles.profile}
        >
          <Avatar uri={me.avatar_url} name={me.display_name} size={36} />
          <Icon name="chevron.down" size={10} color={colors.textSecondary} />
        </Pressable>
      </View>
      <FlatList
        data={visible}
        keyExtractor={(item) => String(item.group.id)}
        renderItem={({ item }) => <InboxRow item={item} meId={me.id} userById={userById} onPress={openThread} />}
        ListHeaderComponent={header}
        ListFooterComponent={visible.length ? contextHint : undefined}
        ListEmptyComponent={
          <View style={styles.empty}>
            {status === 'loading' ? (
              <ActivityIndicator color={colors.blue} />
            ) : (
              <>
                <Icon
                  name={status === 'error' ? 'wifi.slash' : 'bubble.left.and.bubble.right'}
                  size={30}
                  color={colors.textTertiary}
                />
                <Text style={styles.emptyTitle}>
                  {status === 'error'
                    ? 'Let’s reconnect.'
                    : query || filter !== 'All'
                      ? 'No conversations found.'
                      : 'A little quiet here.'}
                </Text>
                <Text style={styles.emptyText}>{status === 'error' ? error : 'Your conversations will appear here.'}</Text>
              </>
            )}
          </View>
        }
        refreshControl={
          <RefreshControl
            tintColor={colors.blue}
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              try {
                await refresh();
                await refreshAsks();
              } finally {
                setRefreshing(false);
              }
            }}
          />
        }
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingBottom: insets.bottom + 100 }}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  topbar: {
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandName: { color: colors.text, fontSize: 23, fontWeight: '600', letterSpacing: -1 },
  profile: { minHeight: 44, flexDirection: 'row', gap: 8, alignItems: 'center' },
  heading: { paddingHorizontal: 24, paddingTop: 20, paddingBottom: 18 },
  eyebrow: { color: colors.blue, fontSize: 10, fontWeight: '700', letterSpacing: 2 },
  title: { color: colors.text, fontSize: 34, lineHeight: 42, fontWeight: '700', letterSpacing: -1.6, marginTop: 9 },
  subtitle: { color: colors.textSecondary, fontSize: 14, lineHeight: 21, marginTop: 7, maxWidth: 300 },
  search: {
    marginHorizontal: 24,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.separator,
    paddingHorizontal: 15,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.searchBg,
  },
  input: { flex: 1, minHeight: 50, fontSize: 15, color: colors.text },
  contextCard: {
    marginHorizontal: 24,
    marginTop: 18,
    padding: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.separator,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  contextIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
  },
  contextTitle: { color: colors.text, fontSize: 14, fontWeight: '600', marginBottom: 4 },
  contextText: { color: colors.textSecondary, fontSize: 12, lineHeight: 18 },
  section: {
    paddingHorizontal: 24,
    paddingTop: 26,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  filters: { flexDirection: 'row', gap: 5 },
  filter: { minHeight: 44, paddingHorizontal: 15, borderRadius: 14, justifyContent: 'center' },
  filterActive: { backgroundColor: colors.accentSoft },
  filterText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  filterTextActive: { color: colors.blue },
  questions: { minWidth: 44, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  questionCount: { color: colors.blue, fontSize: 12, fontWeight: '700' },
  empty: { padding: 40, alignItems: 'center', gap: 12 },
  emptyTitle: { color: colors.text, fontSize: 17, fontWeight: '600' },
  emptyText: { color: colors.textSecondary, fontSize: 14, textAlign: 'center' },
});
