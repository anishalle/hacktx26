import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { InboxItem } from '@/api';
import { Icon } from '@/components/Icon';
import { InboxRow } from '@/components/inbox/InboxRow';
import { NotesRow } from '@/components/inbox/NotesRow';
import { useInbox } from '@/state/inbox';
import { useMe, useSession } from '@/state/session';
import { colors } from '@/theme';

export default function InboxScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const me = useMe();
  const { users, userById } = useSession();
  const { items, status, error, refresh } = useInbox();
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const openSwitcher = () => {
    Haptics.selectionAsync();
    router.push('/switch-user');
  };

  const openThread = useCallback(
    (item: InboxItem) => {
      router.push({
        pathname: '/thread/[id]',
        params: { id: String(item.group.id), unread: String(item.unread_count), name: item.group.name },
      });
    },
    [router],
  );

  const header = (
    <View>
      <View style={styles.searchWrap}>
        <View style={styles.search}>
          <Icon name="sparkle.magnifyingglass" size={20} color={colors.textSecondary} />
          <Text style={styles.searchText}>Search or ask Meta AI</Text>
        </View>
      </View>
      <NotesRow me={me} others={users.filter((u) => u.id !== me.id)} />
      <View style={styles.sectionHeader}>
        <View style={styles.sectionLeft}>
          <Text style={styles.sectionTitle}>Messages</Text>
          <Icon name="bell.slash" size={17} color={colors.text} />
        </View>
        <Text style={styles.requests}>Requests</Text>
      </View>
    </View>
  );

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <View style={styles.side} />
        <Pressable onPress={openSwitcher} onLongPress={openSwitcher} style={styles.titleBtn} hitSlop={8}>
          <Text style={styles.title} numberOfLines={1}>
            {me.username}
          </Text>
          <Icon name="chevron.down" size={13} weight="semibold" color={colors.text} style={{ marginLeft: 6, marginTop: 3 }} />
        </Pressable>
        <View style={[styles.side, { alignItems: 'flex-end' }]}>
          <Icon name="square.and.pencil" size={26} color={colors.text} />
        </View>
      </View>
      <FlatList
        data={items}
        keyExtractor={(it) => String(it.group.id)}
        renderItem={({ item }) => <InboxRow item={item} meId={me.id} userById={userById} onPress={openThread} />}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <View style={styles.empty}>
            {status === 'loading' ? (
              <ActivityIndicator color={colors.textSecondary} />
            ) : status === 'error' ? (
              <Text style={styles.emptyText}>Couldn’t load messages. {error}</Text>
            ) : (
              <Text style={styles.emptyText}>No messages yet.</Text>
            )}
          </View>
        }
        refreshControl={
          <RefreshControl
            tintColor={colors.textSecondary}
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await refresh();
              setRefreshing(false);
            }}
          />
        }
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingBottom: insets.bottom + 90 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  topBar: { flexDirection: 'row', alignItems: 'center', height: 52, paddingHorizontal: 16 },
  side: { width: 40 },
  titleBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontSize: 22, fontWeight: '700', letterSpacing: -0.5 },
  searchWrap: { paddingHorizontal: 14, paddingTop: 6, paddingBottom: 4 },
  search: {
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.searchBg,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    gap: 10,
  },
  searchText: { color: colors.textSecondary, fontSize: 17 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
  },
  sectionLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  requests: { color: colors.textSecondary, fontSize: 15, fontWeight: '600' },
  empty: { paddingTop: 60, alignItems: 'center', paddingHorizontal: 32 },
  emptyText: { color: colors.textSecondary, fontSize: 15, textAlign: 'center' },
});
