import {
  Button,
  ContentUnavailableView,
  HStack,
  Host,
  Menu,
  Picker,
  ScrollView as SwiftScrollView,
  Text as SwiftText,
} from '@expo/ui/swift-ui';
import {
  buttonBorderShape,
  buttonStyle,
  controlSize,
  padding,
  scrollClipDisabled,
  tag,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { api, type Lore, type LoreFeedQuery, type LoreKind, type Message } from '@/api';
import { useLoreActions } from '@/components/lore/MomentCard';
import { MomentDeck } from '@/components/lore/MomentDeck';
import { MomentRow } from '@/components/lore/MomentRow';
import { PhotoViewer } from '@/components/thread/PhotoViewer';
import { deckOrder, DECK_SIZE, getLoreLastSeenAt, loreTint, markLoreSeen, newestFeedTs, tintWash } from '@/lib/lore';
import { useInbox } from '@/state/inbox';
import { usePlaybackControls, type PlaybackItem } from '@/state/playback';
import { useRealtime } from '@/state/realtime';
import { useMe } from '@/state/session';
import { colors } from '@/theme';

const PAGE = 30;
/** Fetch the next deck page once this few cards are left. */
const DECK_REFILL = 3;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

type Sort = 'deck' | 'recent';
type Filters = { groupId: number | null; kind: LoreKind | null; pinned: boolean };
type Load = 'loading' | 'ready' | 'error';

const query = (f: Filters): LoreFeedQuery => ({
  ...(f.groupId ? { group_id: f.groupId } : {}),
  ...(f.kind ? { kind: f.kind } : {}),
  ...(f.pinned ? { pinned: true } : {}),
});

const matches = (l: Lore, f: Filters) =>
  (!f.groupId || l.group_id === f.groupId) && (!f.kind || l.hero_kind === f.kind) && (!f.pinned || l.pinned);

const dedupe = (prev: Lore[], next: Lore[]) => [...prev, ...next.filter((n) => !prev.some((p) => p.id === n.id))];

function monthLabel(iso: string, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.getFullYear() === now.getFullYear() ? MONTHS[d.getMonth()] : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Feature 6: Lore. A deck of the moments your groups kept (For You or Newest), the front card's tint
 * washing the background, then every moment by month. Filter by Audio, Photos, Pinned or group.
 */
export default function LoreScreen() {
  const me = useMe();
  const params = useLocalSearchParams<{ group?: string; pinned?: string }>();
  const { height: windowH } = useWindowDimensions();
  const { items: inbox } = useInbox();
  const playback = usePlaybackControls();

  // `/reels?group=` (Lore from This Group) and `/reels?pinned=1` (You → Pinned Moments) set the filters.
  const paramKey = `${params.group ?? ''}|${params.pinned ?? ''}`;
  const fromParams = (): Filters => ({
    groupId: params.group ? Number(params.group) || null : null,
    kind: null,
    pinned: params.pinned === '1' || params.pinned === 'true',
  });
  const [filters, setFilters] = useState<Filters>(fromParams);
  const [seenParams, setSeenParams] = useState(paramKey);
  if (paramKey !== seenParams) {
    setSeenParams(paramKey);
    setFilters(fromParams());
  }

  const [sort, setSort] = useState<Sort>('deck');
  const [mode, setMode] = useState<'deck' | 'list'>('deck');

  const [deck, setDeck] = useState<Lore[]>([]);
  const [deckCursor, setDeckCursor] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [total, setTotal] = useState(0);
  const [archive, setArchive] = useState<Lore[]>([]);
  const [archiveCursor, setArchiveCursor] = useState<string | null>(null);
  const [deckLoad, setDeckLoad] = useState<Load>('loading');
  const [archiveLoad, setArchiveLoad] = useState<Load>('loading');
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Message | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The mark from before this visit, so cards new since then stay first while filters change.
  const lastSeen = useRef<Promise<string | null> | null>(null);
  const deckPaging = useRef(false);
  const archivePaging = useRef(false);
  // Bumped when a filter or sort reloads a list: a page fetched for the old one is dropped.
  const deckGen = useRef(0);
  const deckCursorGen = useRef(0); // the load `deckCursor` came from
  const archiveGen = useRef(0);
  const archiveCursorGen = useRef(0);

  const archiveSort: Sort = mode === 'list' ? sort : 'recent';
  const filterKey = JSON.stringify(filters);

  useEffect(() => {
    let cancelled = false;
    const f: Filters = JSON.parse(filterKey);
    const gen = ++deckGen.current;
    deckPaging.current = false; // the old filter's cursor no longer pages (deckCursorGen)
    (async () => {
      try {
        lastSeen.current ??= getLoreLastSeenAt(me.id);
        const seen = await lastSeen.current;
        const d = await api.getLoreFeed(me.id, { ...query(f), sort, limit: DECK_SIZE });
        if (cancelled) return;
        setDeck(sort === 'deck' ? deckOrder(d.items, seen) : d.items);
        setDeckCursor(d.next_cursor);
        deckCursorGen.current = gen;
        setIndex(0);
        const c = d.counts;
        setTotal(f.pinned ? c.pinned : f.kind ? c[f.kind] : c.photo + c.replay + c.quote);
        setDeckLoad('ready');
        markLoreSeen(me.id, newestFeedTs(d.items));
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setDeckLoad('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [me.id, filterKey, sort, attempt]);

  useEffect(() => {
    let cancelled = false;
    const f: Filters = JSON.parse(filterKey);
    const gen = ++archiveGen.current;
    archivePaging.current = false;
    api
      .getLoreFeed(me.id, { ...query(f), sort: archiveSort, limit: PAGE })
      .then((a) => {
        if (cancelled || gen !== archiveGen.current) return;
        setArchive(a.items);
        setArchiveCursor(a.next_cursor);
        archiveCursorGen.current = gen;
        setArchiveLoad('ready');
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setArchiveLoad('error');
      });
    return () => {
      cancelled = true;
    };
  }, [me.id, filterKey, archiveSort, attempt]);

  const status: Load =
    deckLoad === 'error' || archiveLoad === 'error'
      ? 'error'
      : (mode === 'deck' ? deckLoad : archiveLoad) === 'loading'
        ? 'loading'
        : 'ready';

  const reload = () => {
    setDeckLoad('loading');
    setArchiveLoad('loading');
    setAttempt((a) => a + 1);
  };

  const setFilter = (patch: Partial<Filters>) => {
    Haptics.selectionAsync();
    setDeckLoad('loading');
    setArchiveLoad('loading');
    setFilters((f) => ({ ...f, ...patch }));
  };

  // Paging: the next deck page once only a few cards are left.
  useEffect(() => {
    if (!deckCursor || deckPaging.current || deck.length - index > DECK_REFILL) return;
    if (deckCursorGen.current !== deckGen.current) return; // a cursor from before the filter changed
    deckPaging.current = true;
    const gen = deckGen.current;
    api
      .getLoreFeed(me.id, { ...query(filters), sort, limit: DECK_SIZE, cursor: deckCursor })
      .then((d) => {
        if (gen !== deckGen.current) return;
        setDeck((prev) => dedupe(prev, d.items));
        setDeckCursor(d.next_cursor);
      })
      .catch(() => {
        // Keep the cursor: the next swipe tries this page again.
      })
      .finally(() => {
        if (gen === deckGen.current) deckPaging.current = false;
      });
  }, [deck.length, index, deckCursor, me.id, filters, sort]);

  const loadMoreArchive = () => {
    if (!archiveCursor || archivePaging.current || archiveCursorGen.current !== archiveGen.current) return;
    archivePaging.current = true;
    const gen = archiveGen.current;
    api
      .getLoreFeed(me.id, { ...query(filters), sort: archiveSort, limit: PAGE, cursor: archiveCursor })
      .then((a) => {
        if (gen !== archiveGen.current) return;
        setArchive((prev) => dedupe(prev, a.items));
        setArchiveCursor(a.next_cursor);
      })
      .catch(() => {})
      .finally(() => {
        if (gen === archiveGen.current) archivePaging.current = false;
      });
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    if (contentOffset.y + layoutMeasurement.height > contentSize.height - 600) loadMoreArchive();
  };

  const patch = useCallback((id: number, p: Partial<Lore>) => {
    const apply = (list: Lore[]) => list.map((l) => (l.id === id ? { ...l, ...p } : l));
    setDeck(apply);
    setArchive(apply);
  }, []);

  // Dropping a card before the front one shifts the index so the front card stays put. Ids not on
  // screen are ignored: new suggestions and dismissals in my groups arrive as frames too.
  const drop = useCallback(
    (id: number) => {
      const at = deck.findIndex((l) => l.id === id);
      if (at < 0 && !archive.some((l) => l.id === id)) return;
      if (at >= 0 && at < index) setIndex((i) => i - 1);
      setDeck((prev) => prev.filter((l) => l.id !== id));
      setArchive((prev) => prev.filter((l) => l.id !== id));
      setTotal((t) => Math.max(0, t - 1));
    },
    [deck, archive, index],
  );

  const actions = useLoreActions({ onChange: patch, onRemoved: drop });

  // Newly kept lore slides in behind the front card, never in front of it; pins update in place.
  useRealtime((frame) => {
    if (frame.type !== 'lore.updated') return;
    const l = frame.data;
    if (l.status !== 'kept') {
      drop(l.id);
      return;
    }
    const known = deck.some((d) => d.id === l.id) || archive.some((a) => a.id === l.id);
    if (known) {
      patch(l.id, l);
      return;
    }
    if (!matches(l, filters)) return;
    setDeck((prev) => [...prev.slice(0, index + 1), l, ...prev.slice(index + 1)]);
    setArchive((prev) => (archiveSort === 'recent' ? [l, ...prev].sort((a, b) => b.started_at.localeCompare(a.started_at)) : [l, ...prev]));
    setTotal((t) => t + 1);
  });

  const onIndexChange = (i: number) => {
    Haptics.selectionAsync();
    setIndex(Math.max(0, Math.min(i, deck.length)));
  };

  const front = mode === 'deck' ? (deck[index] ?? null) : null;
  const queue = useMemo(() => deck.map(actions.replayOf).filter((q): q is PlaybackItem => !!q), [deck, actions]);
  // Short enough that the title, chips, peeking cards and the button all clear the tab bar.
  const cardH = Math.round(Math.min(540, Math.max(380, windowH - 460)));

  const groups = inbox.map((i) => i.group).filter((g) => !g.is_dm || g.id === filters.groupId);
  const groupName = groups.find((g) => g.id === filters.groupId)?.name;
  const filtered = !!(filters.groupId || filters.kind || filters.pinned);

  // The chips run wider than a phone once a group name replaces "Groups", so they scroll sideways
  // in a SwiftUI ScrollView (a nested RN one picks up the nav bar's scroll-edge band).
  const chips = (
    <Host matchContents={{ vertical: true }} style={styles.chips} key={`${filterKey}|${groupName ?? ''}`}>
      <SwiftScrollView axes="horizontal" showsIndicators={false} modifiers={[scrollClipDisabled()]}>
        <HStack spacing={8} modifiers={[padding({ horizontal: 16 })]}>
          <Chip label="Audio" icon="waveform" on={filters.kind === 'replay'} onPress={() => setFilter({ kind: filters.kind === 'replay' ? null : 'replay' })} />
          <Chip label="Photos" icon="photo.on.rectangle" on={filters.kind === 'photo'} onPress={() => setFilter({ kind: filters.kind === 'photo' ? null : 'photo' })} />
          <Chip label="Pinned" icon="pin" on={filters.pinned} onPress={() => setFilter({ pinned: !filters.pinned })} />
          <Menu
            label={groupName ?? 'Groups'}
            systemImage="folder"
            modifiers={[
              buttonStyle(filters.groupId ? 'glassProminent' : 'glass'),
              ...(filters.groupId ? [tint(colors.blue)] : []),
              controlSize('small'),
            ]}
          >
            <Picker<number> selection={filters.groupId ?? 0} onSelectionChange={(v) => setFilter({ groupId: v || null })}>
              <SwiftText modifiers={[tag(0)]}>All Groups</SwiftText>
              {groups.map((g) => (
                <SwiftText key={g.id} modifiers={[tag(g.id)]}>
                  {g.name}
                </SwiftText>
              ))}
            </Picker>
          </Menu>
        </HStack>
      </SwiftScrollView>
    </Host>
  );

  let body: ReactNode;
  if (status === 'loading') {
    body = <ActivityIndicator style={styles.loading} color={colors.textSecondary} />;
  } else if (status === 'error') {
    body = (
      <View style={styles.state}>
        <Host matchContents={{ vertical: true }}>
          <ContentUnavailableView title="Can’t Load Lore" systemImage="wifi.slash" description={error ?? undefined} />
        </Host>
        <Host matchContents>
          <Button label="Try Again" onPress={reload} modifiers={[buttonStyle('bordered'), buttonBorderShape('capsule')]} />
        </Host>
      </View>
    );
  } else if (!deck.length && !archive.length) {
    body = (
      <Host matchContents={{ vertical: true }} style={styles.state}>
        {filtered ? (
          <ContentUnavailableView
            title="No Matching Moments"
            systemImage="line.3.horizontal.decrease.circle"
            description="Try another group or turn off a filter."
          />
        ) : (
          <ContentUnavailableView
            title="No Lore Yet"
            systemImage="sparkles.rectangle.stack"
            description="Moments your group keeps show up here."
          />
        )}
      </Host>
    );
  } else {
    body = (
      <>
        {mode === 'deck' && deck.length ? (
          <>
            <MomentDeck
              items={deck}
              index={index}
              onIndexChange={onIndexChange}
              actions={actions}
              queue={queue}
              onOpenPhoto={setViewing}
              height={cardH}
              done={
                <View style={styles.done}>
                  <Host matchContents={{ vertical: true }} style={styles.doneText}>
                    <ContentUnavailableView
                      title="You’re All Caught Up"
                      systemImage="checkmark.circle"
                      description="You’ve seen every moment here. New ones join the deck as your groups keep them."
                    />
                  </Host>
                  <Host matchContents>
                    <Button
                      label="Start Over"
                      systemImage="arrow.counterclockwise"
                      onPress={() => onIndexChange(0)}
                      modifiers={[buttonStyle('bordered'), buttonBorderShape('capsule')]}
                    />
                  </Host>
                </View>
              }
            />
            <View style={styles.below}>
              {front ? (
                <>
                  <CtaPill
                    key={front.id}
                    lore={front}
                    replay={actions.replayOf(front)}
                    onPlay={(item) => playback.play(item.lore, item.replay, queue)}
                    onOpen={() => actions.openInChat(front)}
                  />
                  <Text style={styles.count}>
                    {index + 1} of {Math.max(total, deck.length)}
                  </Text>
                </>
              ) : null}
            </View>
          </>
        ) : null}
        <Archive items={archive} byMonth={archiveSort === 'recent'} />
        {archiveCursor ? <ActivityIndicator style={styles.more} color={colors.textSecondary} /> : null}
      </>
    );
  }

  return (
    // A fragment, not a wrapping View: UIKit only drives the large title from a ScrollView at the
    // top of the screen's view hierarchy.
    <>
      <Stack.Screen options={{ headerTransparent: true }} />
      <Stack.Title large>Lore</Stack.Title>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="arrow.up.arrow.down" accessibilityLabel="Sort">
          <Stack.Toolbar.MenuAction
            icon="sparkles"
            isOn={sort === 'deck'}
            onPress={() => {
              Haptics.selectionAsync();
              if (sort !== 'deck') setDeckLoad('loading');
              setSort('deck');
            }}
          >
            For You
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            icon="clock"
            isOn={sort === 'recent'}
            onPress={() => {
              Haptics.selectionAsync();
              if (sort !== 'recent') setDeckLoad('loading');
              setSort('recent');
            }}
          >
            Newest
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
        <Stack.Toolbar.Button
          icon={mode === 'deck' ? 'list.bullet' : 'square.stack'}
          accessibilityLabel={mode === 'deck' ? 'Show as List' : 'Show as Deck'}
          onPress={() => {
            Haptics.selectionAsync();
            setMode((m) => (m === 'deck' ? 'list' : 'deck'));
          }}
        />
      </Stack.Toolbar>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        onScroll={onScroll}
        scrollEventThrottle={100}
      >
        {/* Inside the scroll, not behind it: react-native-screens only finds the ScrollView that
            drives the large title through each view's first subview. */}
        <TintWash color={front ? loreTint(front) : colors.blue} strength={front ? 0.25 : 0.1} />
        {chips}
        {body}
      </ScrollView>
      <PhotoViewer message={viewing} onClose={() => setViewing(null)} />
    </>
  );
}

type Symbol = ComponentProps<typeof Button>['systemImage'];

function Chip({ label, icon, on, onPress }: { label: string; icon: Symbol; on: boolean; onPress: () => void }) {
  return (
    <Button
      label={label}
      systemImage={icon}
      onPress={onPress}
      modifiers={[buttonStyle(on ? 'glassProminent' : 'glass'), ...(on ? [tint(colors.blue)] : []), controlSize('small')]}
    />
  );
}

/** "Play Moment" for audio moments, else "Open in Chat". In the scroll content, clear of the accessory. */
function CtaPill({
  lore,
  replay,
  onPlay,
  onOpen,
}: {
  lore: Lore;
  replay: PlaybackItem | null;
  onPlay: (item: PlaybackItem) => void;
  onOpen: () => void;
}) {
  const label = replay ? 'Play Moment' : 'Open in Chat';
  return (
    <Host matchContents key={`${lore.id}|${label}`}>
      <Button
        label={label}
        systemImage={replay ? 'play.fill' : 'arrow.up.forward'}
        onPress={() => {
          Haptics.selectionAsync();
          if (replay) onPlay(replay);
          else onOpen();
        }}
        modifiers={[buttonStyle('glassProminent'), buttonBorderShape('capsule'), controlSize('large'), tint('black')]}
      />
    </Host>
  );
}

/** Every moment, under month headers when it's in time order. */
function Archive({ items, byMonth }: { items: Lore[]; byMonth: boolean }) {
  const sections = useMemo(() => {
    if (!byMonth) return [{ title: '', items }];
    const out: { title: string; items: Lore[] }[] = [];
    for (const l of items) {
      const title = monthLabel(l.started_at);
      const last = out[out.length - 1];
      if (last && last.title === title) last.items.push(l);
      else out.push({ title, items: [l] });
    }
    return out;
  }, [items, byMonth]);
  if (!items.length) return null;
  return (
    <View style={styles.archive}>
      {sections.map((s, si) => (
        <View key={`${s.title}:${si}`} style={styles.section}>
          {s.title ? <Text style={styles.month}>{s.title}</Text> : null}
          <View style={styles.group}>
            {s.items.map((l, i) => (
              <MomentRow key={l.id} lore={l} separator={i < s.items.length - 1} />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

/** The background: the front card's tint fading down into grouped gray, cross-faded on change. */
function TintWash({ color, strength }: { color: string; strength: number }) {
  const { height } = useWindowDimensions();
  const top = tintWash(color, strength);
  const [shown, setShown] = useState(top);
  const [under, setUnder] = useState(top);
  if (top !== shown) {
    setUnder(shown);
    setShown(top);
  }
  const fade = useSharedValue(1);
  useEffect(() => {
    fade.set(0);
    fade.set(withTiming(1, { duration: 420 }));
  }, [shown, fade]);
  const overStyle = useAnimatedStyle(() => ({ opacity: fade.get() }));
  // The washes are translucent, so the old one fades out as the new one fades in; left at full
  // strength it would tint the new color for good.
  const underStyle = useAnimatedStyle(() => ({ opacity: 1 - fade.get() }));
  return (
    // Starts well above the content so the large title and an overscroll stay tinted, then fades to
    // the grouped background about two thirds of the way down the screen.
    <View style={[styles.wash, { height: WASH_OVER + height * 0.65 }]} pointerEvents="none">
      <Animated.View style={[StyleSheet.absoluteFill, underStyle]}>
        <LinearGradient colors={[under, under, colors.grouped]} locations={WASH_STOPS} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, overStyle]}>
        <LinearGradient colors={[shown, shown, colors.grouped]} locations={WASH_STOPS} style={StyleSheet.absoluteFill} />
      </Animated.View>
    </View>
  );
}

const WASH_OVER = 400;
const WASH_STOPS = [0, 0.3, 1] as const;

const styles = StyleSheet.create({
  wash: { position: 'absolute', top: -WASH_OVER, left: 0, right: 0 },
  scroll: { flex: 1, backgroundColor: colors.grouped },
  content: { paddingBottom: 40 },
  chips: { marginTop: 4, marginBottom: 14 },
  loading: { marginTop: 80 },
  state: { marginTop: 60, alignItems: 'center', gap: 12, paddingHorizontal: 24 },
  done: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 16 },
  doneText: { alignSelf: 'stretch' }, // a centered parent would size the SwiftUI view to zero width
  below: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 14 },
  count: { color: colors.textSecondary, fontSize: 12, fontVariant: ['tabular-nums'] },
  more: { marginVertical: 20 },
  archive: { marginTop: 24, gap: 22 },
  section: { gap: 8 },
  month: { color: colors.text, fontSize: 22, fontWeight: '700', paddingHorizontal: 20 },
  group: {
    marginHorizontal: 16,
    backgroundColor: colors.bg,
    borderRadius: 22,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
});
