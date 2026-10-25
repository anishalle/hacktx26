import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Lore } from '@/api';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { useExplain } from '@/features/explain';
import { firstName, separatorLabel } from '@/lib/format';
import { colors } from '@/theme';

import { LorePanel } from './LorePanel';
import { ReplayPlayer } from './ReplayPlayer';

type Props = {
  lore: Lore;
  width: number;
  height: number;
  /** This card is the one on screen. */
  active: boolean;
  onRemoved: (id: number) => void;
  /** The panel is (being) swiped open or closed, so the screen can clear its header. */
  onPanelChange?: (id: number, open: boolean) => void;
};

/**
 * One page of the Lore feed: the moment's cover full-bleed with its title and story over it.
 * Swiping left pages to the LorePanel (texts, photos, replays, related lore).
 */
export function LoreCard({ lore, width, height, active, onRemoved, onPanelChange }: Props) {
  const [page, setPage] = useState(0);
  const pages = ['card', 'panel'] as const;
  const panelShown = useRef(false);
  const onScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => setPage(Math.round(e.nativeEvent.contentOffset.x / width));
  // Report as soon as the swipe gets going, not only once it settles.
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const shown = e.nativeEvent.contentOffset.x > width * 0.08;
    if (shown === panelShown.current) return;
    panelShown.current = shown;
    onPanelChange?.(lore.id, shown);
  };

  return (
    <FlatList
      data={pages}
      horizontal
      pagingEnabled
      bounces={false}
      showsHorizontalScrollIndicator={false}
      keyExtractor={(k) => k}
      onMomentumScrollEnd={onScrollEnd}
      onScroll={onScroll}
      scrollEventThrottle={32}
      style={{ width, height }}
      renderItem={({ item }) => (
        <View style={{ width, height }}>
          {item === 'card' ? (
            <Cover lore={lore} active={active && page === 0} />
          ) : (
            <LorePanel lore={lore} open={page === 1} onRemoved={onRemoved} />
          )}
        </View>
      )}
    />
  );
}

function Cover({ lore, active }: { lore: Lore; active: boolean }) {
  const insets = useSafeAreaInsets();
  const onExplain = useExplain();
  const photo = lore.cover.photo?.image;
  const replay = lore.cover.replay;
  return (
    <View style={styles.cover}>
      {photo ? (
        <Image source={{ uri: photo.url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} />
      ) : (
        <LinearGradient
          colors={replay ? ['#1B1035', '#0B0B0D'] : ['#3A1C71', '#1B2A5C', '#0B0B0D']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      )}
      {replay ? (
        <View style={[styles.replay, { top: insets.top + 110 }]}>
          <ReplayPlayer replay={replay} active={active} />
        </View>
      ) : !photo ? (
        <View style={[styles.textCover, { top: insets.top + 130 }]}>
          <Icon name="quote.opening" size={36} color="rgba(255,255,255,0.35)" />
          <Text style={styles.bigQuote} numberOfLines={5}>
            {lore.story}
          </Text>
        </View>
      ) : null}
      <LinearGradient
        colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.55)', 'rgba(0,0,0,0.92)']}
        locations={[0, 0.35, 1]}
        style={styles.scrim}
        pointerEvents="none"
      />
      <View style={[styles.meta, { paddingBottom: insets.bottom + 96 }]}>
        <Text style={styles.kicker}>
          {lore.group_name} · {separatorLabel(lore.started_at)}
          {lore.source === 'call' ? ' · from a call' : ''}
        </Text>
        <Text style={styles.title}>{lore.title}</Text>
        {lore.people.length ? (
          <View style={styles.people}>
            {lore.people.slice(0, 5).map((p, i) => (
              <Avatar key={p.id} uri={p.avatar_url} size={24} ring="#000" style={{ marginLeft: i ? -8 : 0 }} />
            ))}
            <Text style={styles.peopleText} numberOfLines={1}>
              {lore.people
                .slice(0, 3)
                .map((p) => firstName(p.display_name))
                .join(', ')}
              {lore.people.length > 3 ? ` +${lore.people.length - 3}` : ''}
            </Text>
          </View>
        ) : null}
        {photo || replay ? (
          <Text style={styles.story} numberOfLines={2}>
            {lore.story}
          </Text>
        ) : null}
        <View style={styles.bottomRow}>
          <View style={styles.chips}>
            {lore.terms.slice(0, 3).map((t) => (
              <Pressable key={t.term} onPress={() => onExplain({ groupId: lore.group_id, term: t.term })} style={styles.chip}>
                <Text style={styles.chipText}>{t.term}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.hint}>
            <Text style={styles.hintText}>
              {[lore.photo_count && `${lore.photo_count} photo${lore.photo_count > 1 ? 's' : ''}`, lore.replay_count && 'replay', `${lore.message_count} msgs`]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            <Icon name="chevron.left" size={12} color={colors.textSecondary} />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { flex: 1, backgroundColor: '#000' },
  replay: { position: 'absolute', left: 20, right: 20 },
  textCover: { position: 'absolute', left: 28, right: 28, gap: 10 },
  bigQuote: { color: colors.text, fontSize: 24, lineHeight: 32, fontWeight: '600', letterSpacing: -0.3 },
  scrim: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '55%' },
  meta: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 18, gap: 8 },
  kicker: { color: 'rgba(255,255,255,0.75)', fontSize: 13, fontWeight: '600' },
  title: { color: 'white', fontSize: 28, fontWeight: '800', letterSpacing: -0.5, lineHeight: 33 },
  people: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  peopleText: { color: 'rgba(255,255,255,0.85)', fontSize: 14, fontWeight: '600', marginLeft: 4, flexShrink: 1 },
  story: { color: 'rgba(255,255,255,0.9)', fontSize: 15, lineHeight: 21 },
  bottomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2, gap: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, flexShrink: 1 },
  chip: { paddingHorizontal: 10, height: 26, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.16)', justifyContent: 'center' },
  chipText: { color: 'white', fontSize: 13, fontWeight: '600' },
  hint: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  hintText: { color: colors.textSecondary, fontSize: 12 },
});
