import { ContentUnavailableView, Host } from '@expo/ui/swift-ui';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { api, type InboxItem } from '@/api';
import { Icon } from '@/components/Icon';
import { InboxRow, type InboxRowActions } from '@/components/inbox/InboxRow';
import { filterConversations, useGroupMembers, type ConversationFilter } from '@/lib/conversations';
import { useAsks } from '@/state/asks';
import { useInbox } from '@/state/inbox';
import { useMe, useSession } from '@/state/session';
import { colors } from '@/theme';

const FILTERS: { value: ConversationFilter; label: string; icon: 'bubble.left.and.bubble.right' | 'person.3' | 'person' }[] = [
  { value: 'All', label: 'All Messages', icon: 'bubble.left.and.bubble.right' },
  { value: 'Groups', label: 'Groups', icon: 'person.3' },
  { value: 'Direct', label: 'Direct', icon: 'person' },
];

export default function InboxScreen() {
  const router = useRouter();
  const me = useMe();
  const { userById } = useSession();
  const { items, status, error, refresh, markReadLocal } = useInbox();
  const { pendingIncoming, refresh: refreshAsks } = useAsks();
  const members = useGroupMembers(items, me.id);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ConversationFilter>('All');
  useFocusEffect(
    useCallback(() => {
      refresh();
      refreshAsks();
    }, [refresh, refreshAsks]),
  );
  const visible = useMemo(() => filterConversations(items, query, filter, members), [items, query, filter, members]);
  const unread = useMemo(() => items.filter((i) => i.unread_count > 0 && i.last_message), [items]);

  const markRead = useCallback(
    async (list: InboxItem[]) => {
      await Promise.all(
        list.map(async (it) => {
          const last = it.last_message;
          if (!last) return;
          markReadLocal(it.group.id, last.id);
          await api.markRead(it.group.id, { user_id: me.id, message_id: last.id }).catch(() => {});
        }),
      );
    },
    [markReadLocal, me.id],
  );

  const actions = useMemo<InboxRowActions>(
    () => ({
      onCatchUp: (it) => {
        const thread = {
          pathname: '/thread/[id]' as const,
          params: { id: String(it.group.id), unread: String(it.unread_count), name: it.group.name },
        };
        router.push(thread);
        router.push({
          pathname: '/catchup',
          params: {
            groupId: String(it.group.id),
            ...(it.last_read_message_id ? { since: String(it.last_read_message_id) } : {}),
          },
        });
      },
      onMarkRead: (it) => {
        Haptics.selectionAsync();
        markRead([it]);
      },
      onCall: (it) => router.push({ pathname: '/call/[groupId]', params: { groupId: String(it.group.id), name: it.group.name } }),
      onLore: (it) => router.navigate({ pathname: '/reels', params: { group: String(it.group.id) } }),
    }),
    [markRead, router],
  );

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await refresh();
      await refreshAsks();
    } finally {
      setRefreshing(false);
    }
  };

  let empty: ReactNode = null;
  if (!visible.length) {
    if (status === 'loading') {
      empty = <ActivityIndicator style={styles.loading} color={colors.textSecondary} />;
    } else if (status === 'error') {
      empty = (
        <Host matchContents={{ vertical: true }} style={styles.empty}>
          <ContentUnavailableView
            title="Can’t Load Messages"
            systemImage="wifi.slash"
            description={error ?? 'Pull down to try again.'}
          />
        </Host>
      );
    } else if (query.trim()) {
      empty = (
        <Host matchContents={{ vertical: true }} style={styles.empty}>
          <ContentUnavailableView
            title={`No Results for “${query.trim()}”`}
            systemImage="magnifyingglass"
            description="Check the spelling or try a new search."
          />
        </Host>
      );
    } else {
      empty = (
        <Host matchContents={{ vertical: true }} style={styles.empty}>
          <ContentUnavailableView
            title={filter === 'All' ? 'No Messages' : `No ${filter === 'Groups' ? 'Groups' : 'Direct Messages'}`}
            systemImage="message"
            description="Your conversations will appear here."
          />
        </Host>
      );
    }
  }

  return (
    <>
      <Stack.Title large>Messages</Stack.Title>
      <Stack.SearchBar placement="stacked" placeholder="Search" onChangeText={(e) => setQuery(e.nativeEvent.text)} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.View hidesSharedBackground>
          <Image source={require('../../../../assets/logo.png')} style={styles.logo} accessibilityLabel="Closer" />
        </Stack.Toolbar.View>
        <Stack.Toolbar.Menu accessibilityLabel="Edit">
          <Stack.Toolbar.Label>Edit</Stack.Toolbar.Label>
          <Stack.Toolbar.MenuAction
            icon="checkmark.message"
            disabled={!unread.length}
            onPress={() => {
              Haptics.selectionAsync();
              markRead(unread);
            }}
          >
            Mark All as Read
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="ellipsis.circle" accessibilityLabel="More">
          <Stack.Toolbar.Menu inline title="Filter">
            {FILTERS.map((f) => (
              <Stack.Toolbar.MenuAction
                key={f.value}
                icon={f.icon}
                isOn={filter === f.value}
                onPress={() => {
                  Haptics.selectionAsync();
                  setFilter(f.value);
                }}
              >
                {f.label}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Menu inline>
            <Stack.Toolbar.MenuAction icon="bubble.left.and.text.bubble.right" onPress={() => router.push('/requests')}>
              {pendingIncoming ? `Message Requests (${pendingIncoming})` : 'Message Requests'}
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="person.2" onPress={() => router.push('/switch-user')}>
              Switch Profile
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar.Menu>
        <Stack.Toolbar.Button
          icon="square.and.pencil"
          accessibilityLabel="New Message"
          onPress={() => router.push('/compose')}
        />
      </Stack.Toolbar>
      <ScrollView
        style={styles.screen}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {pendingIncoming > 0 && !query.trim() ? (
          <Pressable
            onPress={() => router.push('/requests')}
            accessibilityRole="button"
            accessibilityLabel={`Message Requests, ${pendingIncoming} waiting`}
            style={({ pressed }) => [styles.requests, pressed && styles.pressed]}
          >
            <View style={styles.requestsIcon}>
              <Icon name="bubble.left.and.text.bubble.right" size={26} color={colors.blue} />
            </View>
            <Text style={styles.requestsTitle}>Message Requests</Text>
            <Text style={styles.requestsCount}>{pendingIncoming}</Text>
            <Icon name="chevron.forward" size={13} color={colors.textTertiary} weight="semibold" />
            <View style={styles.separator} />
          </Pressable>
        ) : null}
        {visible.map((item, i) => (
          <InboxRow
            key={item.group.id}
            item={item}
            meId={me.id}
            userById={userById}
            members={members[item.group.id]}
            actions={actions}
            last={i === visible.length - 1}
          />
        ))}
        {empty}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  logo: { width: 81, height: 22 },
  pressed: { backgroundColor: 'rgba(0,0,0,0.05)' },
  requests: { minHeight: 60, flexDirection: 'row', alignItems: 'center', paddingRight: 16, gap: 8 },
  requestsIcon: { width: 72, paddingLeft: 20, marginRight: 4, alignItems: 'center', justifyContent: 'center' },
  requestsTitle: { flex: 1, color: colors.text, fontSize: 17 },
  requestsCount: { color: colors.textSecondary, fontSize: 17 },
  separator: {
    position: 'absolute',
    left: 84,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator,
  },
  loading: { marginTop: 48 },
  empty: { width: '100%', marginTop: 48 },
});
