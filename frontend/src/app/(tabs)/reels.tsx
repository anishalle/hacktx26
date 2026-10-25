import * as Haptics from 'expo-haptics';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ListViewToken,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, type Lore } from '@/api';
import { Icon } from '@/components/Icon';
import { LoreCard } from '@/components/lore/LoreCard';
import { useInbox } from '@/state/inbox';
import { useRealtime } from '@/state/realtime';
import { useMe } from '@/state/session';
import { colors } from '@/theme';

/**
 * Feature 6: Lore. The group's kept moments across all your groups, one full-screen card at a time
 * (swipe up for the next; swipe left on a card for its texts, photos, replays and related lore).
 */
export default function LoreScreen() {
  const me = useMe();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { items: inbox } = useInbox();
  const [groupId, setGroupId] = useState<number | null>(null);
  const [items, setItems] = useState<Lore[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(0);
  const loadingMore = useRef(false);
  const [focused, setFocused] = useState(true);

  // Bumped to reload (retry); changing the filter reloads too.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api
      .getLoreFeed(me.id, groupId ? { group_id: groupId } : {})
      .then((feed) => {
        if (cancelled) return;
        setItems(feed.items);
        setCursor(feed.next_cursor);
        setStatus('ready');
        setVisible(0);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [me.id, groupId, attempt]);
  const reload = () => {
    setStatus('loading');
    setAttempt((a) => a + 1);
  };

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  const loadMore = async () => {
    if (!cursor || loadingMore.current) return;
    loadingMore.current = true;
    try {
      const feed = await api.getLoreFeed(me.id, { ...(groupId ? { group_id: groupId } : {}), cursor });
      setItems((prev) => [...prev, ...feed.items.filter((i) => !prev.some((p) => p.id === i.id))]);
      setCursor(feed.next_cursor);
    } catch {
      // Keep the cursor: the next scroll toward the end tries this page again.
    } finally {
      loadingMore.current = false;
    }
  };

  // Newly kept lore joins the top of the feed; removed lore leaves it.
  useRealtime((frame) => {
    if (frame.type !== 'lore.updated') return;
    const l = frame.data;
    if (groupId && l.group_id !== groupId) return;
    if (l.status === 'kept') setItems((prev) => (prev.some((p) => p.id === l.id) ? prev.map((p) => (p.id === l.id ? l : p)) : [l, ...prev]));
    else setItems((prev) => prev.filter((p) => p.id !== l.id));
  });

  const removed = useCallback((id: number) => setItems((prev) => prev.filter((p) => p.id !== id)), []);

  // The title and filters float over the cards; they step aside while a card's panel is open.
  const [panelOpen, setPanelOpen] = useState<number | null>(null);
  const onPanelChange = useCallback((id: number, open: boolean) => setPanelOpen((cur) => (open ? id : cur === id ? null : cur)), []);
  const headerHidden = panelOpen !== null && panelOpen === items[visible]?.id;
  const [headerOpacity] = useState(() => new Animated.Value(1));
  useEffect(() => {
    Animated.timing(headerOpacity, { toValue: headerHidden ? 0 : 1, duration: 160, useNativeDriver: true }).start();
  }, [headerHidden, headerOpacity]);

  const onViewable = useCallback(({ viewableItems }: { viewableItems: ListViewToken[] }) => {
    const first = viewableItems[0];
    if (first?.index != null) setVisible(first.index);
  }, []);

  const groups = inbox.filter((i) => !i.group.is_dm).map((i) => i.group);

  return (
    <View style={styles.screen}>
      {status === 'ready' && items.length ? (
        <FlatList
          data={items}
          keyExtractor={(l) => String(l.id)}
          renderItem={({ item, index }) => (
            <LoreCard
              lore={item}
              width={width}
              height={height}
              active={focused && index === visible}
              onRemoved={removed}
              onPanelChange={onPanelChange}
            />
          )}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          decelerationRate="fast"
          onViewableItemsChanged={onViewable}
          viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
          onEndReached={loadMore}
          onEndReachedThreshold={2}
          getItemLayout={(_, index) => ({ length: height, offset: height * index, index })}
          windowSize={3}
          initialNumToRender={2}
          contentInsetAdjustmentBehavior="never"
        />
      ) : (
        <View style={styles.center}>
          {status === 'loading' ? (
            <ActivityIndicator color={colors.textSecondary} />
          ) : status === 'error' ? (
            <>
              <Text style={styles.empty}>Couldn’t load Lore. {error}</Text>
              <Pressable onPress={reload} style={styles.retry}>
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Icon name="sparkles" size={34} color={colors.sparkle} />
              <Text style={styles.emptyTitle}>No lore yet</Text>
              <Text style={styles.empty}>Moments the group keeps from chats and calls show up here.</Text>
            </>
          )}
        </View>
      )}

      <Animated.View
        style={[styles.header, { paddingTop: insets.top + 6, opacity: headerOpacity }]}
        pointerEvents={headerHidden ? 'none' : 'box-none'}>
        <Text style={styles.logo}>Lore</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
          {[{ id: null as number | null, name: 'All' }, ...groups].map((g) => {
            const on = groupId === g.id;
            return (
              <Pressable
                key={String(g.id)}
                onPress={() => {
                  Haptics.selectionAsync();
                  if (g.id === groupId) return;
                  setStatus('loading');
                  setGroupId(g.id);
                }}
                style={[styles.filter, on && styles.filterOn]}>
                <Text style={[styles.filterText, on && styles.filterTextOn]} numberOfLines={1}>
                  {g.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 40 },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
  empty: { color: colors.textSecondary, fontSize: 15, textAlign: 'center', lineHeight: 21 },
  retry: { backgroundColor: colors.surface, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 10, marginTop: 6 },
  retryText: { color: colors.text, fontWeight: '600' },
  header: { position: 'absolute', top: 0, left: 0, right: 0 },
  logo: { color: 'white', fontSize: 24, fontWeight: '800', letterSpacing: -0.5, paddingHorizontal: 18, marginBottom: 8 },
  filters: { paddingHorizontal: 14, gap: 8 },
  filter: { paddingHorizontal: 14, height: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.14)', justifyContent: 'center', maxWidth: 200 },
  filterOn: { backgroundColor: 'white' },
  filterText: { color: 'white', fontSize: 14, fontWeight: '600' },
  filterTextOn: { color: 'black' },
});
