import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { Link, useRouter } from 'expo-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Alert, Pressable, Share, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { ScrollView as GestureScrollView } from 'react-native-gesture-handler';

import { api, type Lore, type LoreSnippet, type Message, type Reaction } from '@/api';
import { GlassCircle } from '@/components/GlassCircle';
import { Icon } from '@/components/Icon';
import { firstName } from '@/lib/format';
import { loreSubtitle } from '@/lib/lore';
import { usePlaybackControls, type PlaybackItem } from '@/state/playback';
import { useMe, useSession } from '@/state/session';
import { colors } from '@/theme';

import { AudioTile } from './AudioTile';
import { heroPhoto, LoreThumb } from './MomentRow';

/**
 * Zoom from the card's hero into the moment page's hero. If the source frame comes out wrong on a
 * transformed deck card, turn this off and the Link falls back to a plain push.
 */
const APPLE_ZOOM = true;

// ---------------------------------------------------------------------------
// Actions shared by the deck, the archive and the moment page
// ---------------------------------------------------------------------------
export type LoreActions = {
  togglePin: (lore: Lore) => Promise<void>;
  /** The thread, scrolled to `messageId` (default: the moment's hero or anchor message). */
  openInChat: (lore: Lore, messageId?: number | null) => void;
  share: (lore: Lore) => void;
  /** Asks first (an Alert), then removes it from the group's Lore. */
  confirmRemove: (lore: Lore) => void;
  remove: (lore: Lore) => Promise<void>;
  /** The replay to play for a moment, if it has one. */
  replayOf: (lore: Lore) => PlaybackItem | null;
};

/** The URL that best stands for a moment when sharing: its photo, else its call audio. */
export function loreShareUrl(lore: Lore) {
  return heroPhoto(lore)?.image?.url ?? lore.events.find((e) => e.replay)?.replay?.audio_url ?? lore.cover.replay?.audio_url ?? null;
}

/** The message "Open in Chat" lands on: the hero, else the chat anchor, else the first snippet. */
export function loreJumpId(lore: Lore) {
  const hero = lore.events[0];
  return hero?.message?.id ?? lore.anchor_message_id ?? hero?.snippets.find((s) => s.message_id)?.message_id ?? null;
}

/**
 * Pin, share, open and remove. `onChange` gets optimistic patches (and the rollback on failure);
 * `onRemoved` fires once a removal succeeds.
 */
export function useLoreActions({
  onChange,
  onRemoved,
}: {
  onChange?: (id: number, patch: Partial<Lore>) => void;
  onRemoved?: (id: number) => void;
} = {}): LoreActions {
  const me = useMe();
  const router = useRouter();

  const togglePin = useCallback(
    async (lore: Lore) => {
      const pinned = !lore.pinned;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onChange?.(lore.id, { pinned });
      try {
        const res = await (pinned ? api.pinLore(lore.id, me.id) : api.unpinLore(lore.id, me.id));
        onChange?.(lore.id, { pinned: res.pinned });
      } catch (e) {
        onChange?.(lore.id, { pinned: lore.pinned });
        Alert.alert(pinned ? 'Couldn’t Pin' : 'Couldn’t Unpin', e instanceof Error ? e.message : String(e));
      }
    },
    [me.id, onChange],
  );

  const openInChat = useCallback(
    (lore: Lore, messageId?: number | null) => {
      Haptics.selectionAsync();
      const around = messageId ?? loreJumpId(lore);
      router.push({
        pathname: '/thread/[id]',
        params: { id: String(lore.group_id), name: lore.group_name, ...(around ? { around: String(around) } : {}) },
      });
    },
    [router],
  );

  const share = useCallback((lore: Lore) => {
    const url = loreShareUrl(lore);
    Share.share({ title: lore.title, message: url ? `${lore.title}\n${url}` : lore.title, ...(url ? { url } : {}) }).catch(() => {});
  }, []);

  const remove = useCallback(
    async (lore: Lore) => {
      try {
        await api.removeLore(lore.id, me.id);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onRemoved?.(lore.id);
      } catch (e) {
        Alert.alert('Couldn’t Remove It', e instanceof Error ? e.message : String(e));
      }
    },
    [me.id, onRemoved],
  );

  const confirmRemove = useCallback(
    (lore: Lore) =>
      Alert.alert('Remove from Lore?', `“${lore.title}” leaves ${lore.group_name}’s Lore for everyone.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => void remove(lore) },
      ]),
    [remove],
  );

  const replayOf = useCallback((lore: Lore): PlaybackItem | null => {
    const replay = lore.events.find((e) => e.kind === 'replay' && e.replay)?.replay ?? lore.cover.replay;
    return replay ? { lore, replay } : null;
  }, []);

  return useMemo(
    () => ({ togglePin, openInChat, share, confirmRemove, remove, replayOf }),
    [togglePin, openInChat, share, confirmRemove, remove, replayOf],
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------
type Props = {
  lore: Lore;
  actions: LoreActions;
  /** Back cards in the deck show only their header row; tapping one brings it forward. */
  peek?: boolean;
  onPeekPress?: () => void;
  /** The deck's replays, so the accessory's ⏭ walks them. */
  queue?: PlaybackItem[];
  onOpenPhoto?: (m: Message) => void;
};

/** The top reaction as a tapback badge, e.g. 😭 3. */
function topReaction(reactions: Reaction[]) {
  if (!reactions.length) return null;
  const counts = new Map<string, number>();
  for (const r of reactions) counts.set(r.emoji, (counts.get(r.emoji) ?? 0) + 1);
  const [emoji, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { emoji, n };
}

function ReactionBadge({ reactions, style }: { reactions: Reaction[]; style?: object }) {
  const top = topReaction(reactions);
  if (!top) return null;
  return (
    <View style={[styles.reaction, style]} pointerEvents="none">
      <Text style={styles.reactionEmoji}>{top.emoji}</Text>
      {reactions.length > 1 ? <Text style={styles.reactionCount}>{reactions.length}</Text> : null}
    </View>
  );
}

/**
 * One moment in the deck: who and when, the serif title (the only AI text), the hero photo / audio /
 * quote, a few real lines people sent, and the rest of the photos. Tap to open, hold for the menu.
 */
export function MomentCard({ lore, actions, peek, onPeekPress, queue, onOpenPhoto }: Props) {
  if (peek) {
    return (
      <Pressable
        onPress={onPeekPress}
        style={[styles.card, styles.peekCard]}
        accessibilityRole="button"
        accessibilityLabel={`Show ${lore.title}`}
      >
        <View style={styles.peekRow}>
          <LoreThumb lore={lore} size={28} radius={7} />
          <Text style={styles.peekTitle} numberOfLines={1}>
            {lore.title}
          </Text>
          <Icon name="chevron.up" size={13} color={colors.textTertiary} weight="semibold" />
        </View>
      </Pressable>
    );
  }
  return <FrontCard lore={lore} actions={actions} queue={queue} onOpenPhoto={onOpenPhoto} />;
}

function FrontCard({ lore, actions, queue, onOpenPhoto }: Omit<Props, 'peek' | 'onPeekPress'>) {
  const playback = usePlaybackControls();
  const hero = lore.events[0] ?? null;
  const photo = heroPhoto(lore);
  const replayItem = actions.replayOf(lore);
  const media = lore.media.filter((m) => m.image && m.id !== photo?.id);

  // The hero's own lines first, then the other events'; 2 when the image row or a long quote needs the room.
  const longQuote = lore.hero_kind === 'quote' && (hero?.message?.text.length ?? 0) > 110;
  const snippets = useMemo(() => {
    const all = [...(hero?.snippets ?? []), ...lore.events.slice(1).flatMap((e) => e.snippets)];
    return all.slice(0, media.length || longQuote ? 2 : 3);
  }, [hero, lore.events, media.length, longQuote]);

  const onSnippet = (s: LoreSnippet) => {
    if (s.start_ms != null && replayItem) {
      Haptics.selectionAsync();
      const at = s.start_ms;
      if (playback.replay?.id === replayItem.replay.id) playback.seek(at);
      else {
        playback.play(lore, replayItem.replay, queue);
        // The clip loads on the next tick; seek once it's the current one.
        setTimeout(() => playback.seek(at), 250);
      }
      return;
    }
    if (s.message_id) actions.openInChat(lore, s.message_id);
  };

  let heroView: ReactNode = null;
  if (lore.hero_kind === 'photo' && photo?.image) {
    heroView = (
      <View style={styles.photoWrap}>
        <Image
          source={{ uri: photo.image.url }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={200}
          accessibilityLabel={photo.image_description ?? 'Photo'}
        />
        <ReactionBadge reactions={photo.reactions} style={styles.photoReaction} />
      </View>
    );
  } else if (lore.hero_kind === 'replay' && replayItem) {
    heroView = <AudioTile lore={lore} replay={replayItem.replay} queue={queue} />;
  } else if (lore.hero_kind === 'video') {
    // Reserved: nothing builds video events yet.
    heroView = (
      <View style={[styles.photoWrap, styles.videoStub]}>
        <Icon name="video.fill" size={30} color={colors.textSecondary} />
      </View>
    );
  } else if (hero?.message) {
    heroView = <QuoteBubble message={hero.message} />;
  }

  return (
    <Link href={{ pathname: '/lore/[id]', params: { id: String(lore.id) } }} asChild>
      <Link.Trigger>
        <Pressable style={styles.card} accessibilityRole="button" accessibilityLabel={lore.title}>
          <View style={styles.header}>
            <LoreThumb lore={lore} size={40} radius={10} avatarBadge />
            <View style={styles.headerText}>
              <Text style={styles.group} numberOfLines={1}>
                {lore.group_name}
              </Text>
              <Text style={styles.sub} numberOfLines={1}>
                {loreSubtitle(lore, { group: false })}
              </Text>
            </View>
            <GlassCircle size={34} onPress={() => actions.togglePin(lore)} accessibilityLabel={lore.pinned ? 'Unpin' : 'Pin'}>
              <Icon name={lore.pinned ? 'pin.fill' : 'pin'} size={15} color={lore.pinned ? colors.blue : colors.text} weight="medium" />
            </GlassCircle>
          </View>

          <Text style={styles.title} numberOfLines={2}>
            {lore.title}
          </Text>

          {heroView ? (
            <View style={heroView && lore.hero_kind === 'photo' ? styles.heroFill : styles.hero}>
              {APPLE_ZOOM ? (
                <Link.AppleZoom>
                  <View collapsable={false} style={styles.zoomSource}>
                    {heroView}
                  </View>
                </Link.AppleZoom>
              ) : (
                heroView
              )}
            </View>
          ) : null}

          {snippets.length ? (
            <FitStack style={styles.snippets}>
              {snippets.map((s, i) => (
                <MiniBubble key={`${s.message_id ?? 's'}:${i}`} snippet={s} onPress={() => onSnippet(s)} />
              ))}
            </FitStack>
          ) : null}

          {media.length ? (
            <GestureScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.mediaRow}
              contentContainerStyle={styles.mediaContent}
            >
              {media.map((m) => (
                <Pressable
                  key={m.id}
                  onPress={() => onOpenPhoto?.(m)}
                  accessibilityRole="imagebutton"
                  accessibilityLabel={m.image_description ?? 'Photo'}
                >
                  <Image source={{ uri: m.image!.url }} style={styles.mediaTile} contentFit="cover" transition={150} />
                </Pressable>
              ))}
            </GestureScrollView>
          ) : null}
        </Pressable>
      </Link.Trigger>
      <Link.Menu>
        <Link.MenuAction icon={lore.pinned ? 'pin.slash' : 'pin'} onPress={() => actions.togglePin(lore)}>
          {lore.pinned ? 'Unpin' : 'Pin'}
        </Link.MenuAction>
        <Link.MenuAction icon="bubble.left.and.bubble.right" onPress={() => actions.openInChat(lore)}>
          Open in Chat
        </Link.MenuAction>
        {replayItem ? (
          <Link.MenuAction icon="play.fill" onPress={() => playback.play(lore, replayItem.replay, queue)}>
            Play
          </Link.MenuAction>
        ) : null}
        <Link.MenuAction icon="square.and.arrow.up" onPress={() => actions.share(lore)}>
          Share
        </Link.MenuAction>
        <Link.MenuAction icon="trash" destructive onPress={() => actions.confirmRemove(lore)}>
          Remove from Lore
        </Link.MenuAction>
      </Link.Menu>
    </Link>
  );
}

/** The quote moment's hero: the key message as a big incoming bubble under its sender's name. */
export function QuoteBubble({ message, large }: { message: Message; large?: boolean }) {
  const me = useMe();
  const { userById } = useSession();
  const who = message.sender_id ? userById(message.sender_id) : undefined;
  const sender = message.sender_id === me.id ? 'You' : who ? firstName(who.display_name) : null;
  return (
    <View style={styles.quote}>
      {sender ? <Text style={styles.quoteName}>{sender}</Text> : null}
      <View>
        <View style={[styles.quoteBubble, large && styles.quoteBubbleLarge]}>
          <Text style={[styles.quoteText, large && styles.quoteTextLarge]} numberOfLines={large ? undefined : 4}>
            {message.text}
          </Text>
        </View>
        <ReactionBadge reactions={message.reactions} style={styles.quoteReaction} />
      </View>
    </View>
  );
}

/**
 * Stacks its children top-down and hides any the card can't show whole: a long quote or a two-line
 * title leaves less room, and the card clips at its fixed height instead of cutting a bubble in half.
 */
function FitStack({ children, style }: { children: ReactNode[]; style: StyleProp<ViewStyle> }) {
  const [room, setRoom] = useState(0);
  const [ends, setEnds] = useState<Record<number, number>>({});
  return (
    <View style={style} onLayout={(e) => setRoom(e.nativeEvent.layout.height)}>
      {children.map((child, i) => (
        <View
          key={i}
          onLayout={(e) => {
            const end = e.nativeEvent.layout.y + e.nativeEvent.layout.height;
            setEnds((prev) => (prev[i] === end ? prev : { ...prev, [i]: end }));
          }}
          // Hidden until measured, so a bubble that won't fit never flashes in cut off.
          style={{ opacity: room > 0 && ends[i] != null && ends[i] <= room + 0.5 ? 1 : 0 }}
        >
          {child}
        </View>
      ))}
    </View>
  );
}

function MiniBubble({ snippet: s, onPress }: { snippet: LoreSnippet; onPress: () => void }) {
  const name = s.is_me ? 'You' : s.user ? firstName(s.user.display_name) : null;
  const spoken = s.start_ms != null;
  return (
    <Pressable
      onPress={onPress}
      style={[styles.mini, s.is_me && styles.miniMine]}
      accessibilityRole="button"
      accessibilityLabel={`${name ?? 'Someone'}: ${s.text}`}
    >
      {name ? (
        <Text style={[styles.miniName, s.is_me && styles.miniNameMine]}>
          {name}
          {spoken ? ' · said' : ''}
        </Text>
      ) : null}
      <View style={[styles.miniRow, s.is_me && styles.miniRowMine]}>
        <View style={[styles.miniBubble, s.is_me && styles.miniBubbleMine]}>
          <Text style={[styles.miniText, s.is_me && styles.miniTextMine]} numberOfLines={2}>
            {s.text}
          </Text>
        </View>
        {s.reactions.length ? (
          <Text style={styles.miniReactions}>
            {topReaction(s.reactions)?.emoji} {s.reactions.length}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export const CARD_RADIUS = 28;

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: colors.bg,
    borderRadius: CARD_RADIUS,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    boxShadow: '0 12px 30px rgba(0,0,0,0.08)',
    padding: 18,
    gap: 12,
    overflow: 'hidden',
  },
  peekCard: { paddingVertical: 6 },
  peekRow: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 28 },
  peekTitle: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '600' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerText: { flex: 1, minWidth: 0 },
  group: { color: colors.text, fontSize: 15, fontWeight: '600' },
  sub: { color: colors.textSecondary, fontSize: 13, marginTop: 1 },
  title: { color: colors.text, fontFamily: 'ui-serif', fontSize: 26, fontWeight: '600', lineHeight: 31 },
  // A photo takes whatever room is left; audio and quotes keep their size and center in it.
  heroFill: { flex: 1, minHeight: 96 },
  hero: { flexGrow: 1, flexShrink: 0, justifyContent: 'center' },
  // Link.AppleZoom needs one non-collapsable native child, or it hides the hero.
  zoomSource: { flexGrow: 1, justifyContent: 'center' },
  photoWrap: {
    flex: 1,
    minHeight: 96,
    borderRadius: 18,
    borderCurve: 'continuous',
    overflow: 'hidden',
    backgroundColor: colors.surfaceAlt,
  },
  videoStub: { alignItems: 'center', justifyContent: 'center' },
  photoReaction: { top: 10, right: 10 },
  reaction: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    minWidth: 26,
    height: 26,
    paddingHorizontal: 6,
    borderRadius: 13,
    backgroundColor: colors.bg,
    borderWidth: 2,
    borderColor: colors.bg,
    boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
    justifyContent: 'center',
  },
  reactionEmoji: { fontSize: 13 },
  reactionCount: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  quote: { gap: 4, alignItems: 'flex-start' },
  quoteName: { color: colors.textSecondary, fontSize: 13, marginLeft: 14 },
  quoteBubble: {
    backgroundColor: colors.bubbleIn,
    borderRadius: 22,
    borderCurve: 'continuous',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  quoteBubbleLarge: { borderRadius: 24, paddingHorizontal: 18, paddingVertical: 14 },
  quoteText: { color: colors.text, fontSize: 20, lineHeight: 26 },
  quoteTextLarge: { fontSize: 22, lineHeight: 29 },
  quoteReaction: { top: -12, right: -10 },
  // Audio and quote heroes keep their size (a photo stops at its minimum); the snippets give way
  // and drop what doesn't fit.
  snippets: { gap: 6, flexShrink: 1, minHeight: 0, overflow: 'hidden' },
  mini: { alignItems: 'flex-start', gap: 2 },
  miniMine: { alignItems: 'flex-end' },
  miniName: { color: colors.textSecondary, fontSize: 11, marginLeft: 12 },
  miniNameMine: { marginLeft: 0, marginRight: 12 },
  miniRow: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '88%' },
  miniRowMine: { flexDirection: 'row-reverse' },
  miniBubble: { backgroundColor: colors.bubbleIn, borderRadius: 17, borderCurve: 'continuous', paddingHorizontal: 12, paddingVertical: 7, flexShrink: 1 },
  miniBubbleMine: { backgroundColor: colors.blue },
  miniText: { color: colors.text, fontSize: 15, lineHeight: 20 },
  miniTextMine: { color: '#FFFFFF' },
  miniReactions: { color: colors.textSecondary, fontSize: 12 },
  mediaRow: { marginHorizontal: -18, flexGrow: 0 },
  mediaContent: { paddingHorizontal: 18, gap: 8 },
  mediaTile: { width: 150, height: 110, borderRadius: 16, borderCurve: 'continuous', backgroundColor: colors.surfaceAlt },
});
