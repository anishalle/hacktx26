import { Image } from 'expo-image';
import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Lore, Message } from '@/api';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { groupTint, loreSubtitle } from '@/lib/lore';
import { colors } from '@/theme';

/** The photo a moment leads with: its hero photo event, else the derived cover. */
export function heroPhoto(lore: Lore): Message | null {
  const hero = lore.events[0];
  if (hero?.kind === 'photo' && hero.message?.image) return hero.message;
  return lore.cover.photo?.image ? lore.cover.photo : null;
}

type ThumbProps = {
  lore: Lore;
  size: number;
  /** A landscape tile instead of a square (`size` is then the width). */
  height?: number;
  radius?: number;
  /** Non-photo moments show the group's people with a kind badge instead of a flat tile. */
  avatarBadge?: boolean;
};

/** Photo, blue `waveform` tile for audio, or a group-tinted `quote.bubble` tile. */
export function LoreThumb({ lore, size, height = size, radius = Math.round(size * 0.22), avatarBadge }: ThumbProps) {
  const photo = heroPhoto(lore);
  const box = { width: size, height, borderRadius: radius };
  if (photo?.image) {
    return <Image source={{ uri: photo.image.url }} style={[styles.thumb, box]} contentFit="cover" transition={150} />;
  }
  const audio = lore.hero_kind === 'replay';
  const icon = audio ? 'waveform' : lore.hero_kind === 'video' ? 'video.fill' : avatarBadge ? 'quote.opening' : 'quote.bubble';
  if (avatarBadge) {
    const who = lore.people[0];
    const badge = Math.round(size * 0.48);
    return (
      <View style={{ width: size, height: size }}>
        <Avatar uri={who?.avatar_url} name={who?.display_name ?? lore.group_name} size={size} />
        <View
          style={[
            styles.badge,
            { width: badge, height: badge, borderRadius: badge / 2, backgroundColor: audio ? colors.blue : groupTint(lore.group_id) },
          ]}
        >
          <Icon name={icon} size={badge * 0.55} color="white" weight="semibold" />
        </View>
      </View>
    );
  }
  return (
    <View style={[styles.thumb, styles.tile, box, { backgroundColor: audio ? colors.blue : groupTint(lore.group_id) }]}>
      <Icon name={icon} size={Math.min(size, height) * 0.42} color="white" weight="medium" />
    </View>
  );
}

type Props = {
  lore: Lore;
  /** `row`: the archive list. `card`: a horizontal "More from" card, title only. */
  variant?: 'row' | 'card';
  /** Draw the hairline under the row (all but the last in a section). */
  separator?: boolean;
};

/** An archived moment: thumbnail, title, "Design team · Oct 12", and a pin when I've pinned it. */
export function MomentRow({ lore, variant = 'row', separator = true }: Props) {
  const href = { pathname: '/lore/[id]' as const, params: { id: String(lore.id) } };
  if (variant === 'card') {
    return (
      <Link href={href} asChild>
        <Pressable accessibilityLabel={lore.title}>
          {({ pressed }) => (
            <View style={[styles.card, pressed && styles.pressedCard]}>
              <LoreThumb lore={lore} size={150} height={110} radius={16} />
              <Text style={styles.cardTitle} numberOfLines={2}>
                {lore.title}
              </Text>
            </View>
          )}
        </Pressable>
      </Link>
    );
  }
  const sub = loreSubtitle(lore, { weekday: false, people: false });
  return (
    <Link href={href} asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${lore.title}, ${sub}${lore.pinned ? ', pinned' : ''}`}
      >
        {/* Link's Slot flattens `style`, so a style function would be dropped: the pressed fill lives
            on an inner view instead. */}
        {({ pressed }) => (
          <View style={[styles.row, pressed && styles.pressed]}>
            <LoreThumb lore={lore} size={64} radius={14} />
            <View style={styles.text}>
              <Text style={styles.title} numberOfLines={2}>
                {lore.title}
              </Text>
              <Text style={styles.sub} numberOfLines={1}>
                {sub}
              </Text>
            </View>
            {lore.pinned ? <Icon name="pin.fill" size={13} color={colors.textTertiary} /> : null}
            <Icon name="chevron.forward" size={13} color={colors.textTertiary} weight="semibold" />
            {separator ? <View style={styles.separator} /> : null}
          </View>
        )}
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  thumb: { backgroundColor: colors.surfaceAlt, borderCurve: 'continuous', overflow: 'hidden' },
  tile: { alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    right: -3,
    bottom: -3,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.bg,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, minHeight: 84 },
  pressed: { backgroundColor: 'rgba(0,0,0,0.05)' },
  text: { flex: 1, minWidth: 0, gap: 3 },
  title: { color: colors.text, fontSize: 17, fontWeight: '600', lineHeight: 22 },
  sub: { color: colors.textSecondary, fontSize: 13 },
  separator: {
    position: 'absolute',
    left: 92,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator,
  },
  card: { width: 150, gap: 8 },
  pressedCard: { opacity: 0.7 },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '600', lineHeight: 20 },
});
