import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { memo, useEffect, useRef, useState, type ReactElement } from 'react';
import { ActionSheetIOS, Animated, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { Message, Reaction, User } from '@/api';
import { firstName } from '@/lib/format';
import { colors } from '@/theme';

import { Avatar } from '../Avatar';
import { Icon } from '../Icon';
import { MessageMenu, QUICK_REACTIONS } from './MessageMenu';

export const AVATAR = 28;
const GUTTER = 10;
/** Room on the tail side of every bubble, so a run lines up and the tail fits inside the menu host. */
const TAIL_PAD = 6;

export type RunPos = 'single' | 'first' | 'middle' | 'last';

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*){1,3}$/u;

type MessageRowProps = {
  message: Message;
  mine: boolean;
  sender: User | undefined;
  showName: boolean;
  showAvatar: boolean;
  /** Reserve the avatar column next to incoming bubbles (group chats). Defaults to true. */
  avatars?: boolean;
  run: RunPos;
  /** Outgoing bubble color. Defaults to iMessage blue. */
  tint?: string;
  highlighted?: boolean;
  replied?: { name: string; text: string } | null;
  /** Marks my own tapbacks blue. */
  meId?: string;
  /** Lore and other read-only transcripts: no double-tap, no context menu. */
  readOnly?: boolean;
  /** The surface behind the row; the tail's cut and the tapback ring use it. Defaults to white. */
  background?: string;
  userById?: (id: string) => User | undefined;
  onReact?: (m: Message, emoji: string) => void;
  onReply?: (m: Message) => void;
  onCopy?: (m: Message) => void;
  onExplain?: (m: Message) => void;
  onSaveToLore?: (m: Message) => void;
  onOpenPhoto?: (m: Message) => void;
  /** This photo anchors a kept Lore moment: a small sparkles badge on its corner. */
  kept?: boolean;
};

function corners(run: RunPos, mine: boolean) {
  const big = 18;
  const small = 5;
  const top = run === 'single' || run === 'first' ? big : small;
  const bottom = run === 'single' || run === 'last' ? big : small;
  return mine
    ? { borderTopRightRadius: top, borderBottomRightRadius: bottom, borderTopLeftRadius: big, borderBottomLeftRadius: big }
    : { borderTopLeftRadius: top, borderBottomLeftRadius: bottom, borderTopRightRadius: big, borderBottomRightRadius: big };
}

/**
 * iMessage tail: a square of bubble color fills the bottom corner and runs past the edge, then a
 * background-colored shape with a large rounded corner carves the concave outer curve.
 */
function Tail({ mine, color, background }: { mine: boolean; color: string; background: string }) {
  return (
    <>
      <View pointerEvents="none" style={[styles.tailFill, mine ? { right: -7 } : { left: -7 }, { backgroundColor: color }]} />
      <View pointerEvents="none" style={[styles.tailCut, mine ? styles.tailCutMine : styles.tailCutTheirs, { backgroundColor: background }]} />
    </>
  );
}

export const MessageRow = memo(function MessageRow(p: MessageRowProps) {
  const { message: m, mine, run, readOnly } = p;
  const [flash] = useState(() => new Animated.Value(0));
  const lastTap = useRef(0);

  useEffect(() => {
    if (!p.highlighted) return;
    flash.setValue(0);
    Animated.sequence([
      Animated.timing(flash, { toValue: 1, duration: 220, useNativeDriver: true }),
      Animated.timing(flash, { toValue: 0.15, duration: 380, useNativeDriver: true }),
      Animated.timing(flash, { toValue: 1, duration: 260, useNativeDriver: true }),
      Animated.timing(flash, { toValue: 0, duration: 1400, delay: 600, useNativeDriver: true }),
    ]).start();
  }, [p.highlighted, flash]);

  const emojiOnly = EMOJI_ONLY.test(m.text.trim());
  // The native context menu host sizes to its content, so the bubble needs an explicit max width to wrap.
  const { width } = useWindowDimensions();
  const maxBubble = Math.round(width * 0.75);
  const pending = m.id < 0;
  const photo = m.kind === 'photo' && m.image ? m.image : null;
  const fill = mine ? (p.tint ?? colors.blue) : colors.bubbleIn;
  const tailed = !emojiOnly && (run === 'single' || run === 'last');
  const avatars = p.avatars ?? true;
  const background = p.background ?? colors.bg;

  const sheet = (actions: [string, () => void][]) =>
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [...actions.map(([label]) => label), 'Cancel'], cancelButtonIndex: actions.length },
      (i) => actions[i]?.[1](),
    );
  const photoMenu = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const actions: [string, () => void][] = [
      ['Explain', () => p.onExplain?.(m)],
      ['Reply', () => p.onReply?.(m)],
      // The same six tapbacks as the text menu, one sheet deeper (after the first one has gone).
      [
        'Tapback…',
        () => setTimeout(() => sheet(QUICK_REACTIONS.map((e) => [e, () => p.onReact?.(m, e)] as [string, () => void])), 50),
      ],
    ];
    if (m.text) actions.push(['Copy', () => p.onCopy?.(m)]);
    if (p.onSaveToLore) actions.push(['Save to Lore', () => p.onSaveToLore?.(m)]);
    sheet(actions);
  };

  const textBubble = (
    <Pressable
      disabled={readOnly || !p.onReact}
      onLongPress={photo ? photoMenu : undefined}
      onPress={() => {
        const now = Date.now();
        if (now - lastTap.current < 280) p.onReact?.(m, '❤️');
        lastTap.current = now;
      }}
    >
      <View>
        {/* Behind the bubble: the tail's fill square would otherwise paint over the first letters. */}
        {tailed ? <Tail mine={mine} color={fill} background={background} /> : null}
        <View
          style={[
            emojiOnly ? styles.emojiWrap : styles.bubble,
            { maxWidth: maxBubble },
            !emojiOnly && corners(run, mine),
            !emojiOnly && { backgroundColor: fill },
          ]}
        >
          <Text style={emojiOnly ? styles.emoji : [styles.text, { color: mine ? '#FFFFFF' : colors.text }]}>{m.text}</Text>
          {!emojiOnly ? (
            <Animated.View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, corners(run, mine), styles.flash, { opacity: flash }]}
            />
          ) : null}
        </View>
      </View>
    </Pressable>
  );

  const pad = (child: ReactElement) => (
    <View style={[mine ? { paddingRight: TAIL_PAD } : { paddingLeft: TAIL_PAD }, pending && { opacity: 0.7 }]}>{child}</View>
  );
  const menu = (child: ReactElement) =>
    readOnly ? (
      child
    ) : (
      <MessageMenu
        onReact={(e) => p.onReact?.(m, e)}
        onReply={() => p.onReply?.(m)}
        onCopy={() => p.onCopy?.(m)}
        onExplain={() => p.onExplain?.(m)}
        onSaveToLore={p.onSaveToLore ? () => p.onSaveToLore?.(m) : undefined}
      >
        {child}
      </MessageMenu>
    );

  let body = menu(pad(textBubble));
  if (photo) {
    // Fit the photo in 65% of the width and 320 pt of height, keeping its shape.
    const aspect = photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 1;
    const w = Math.min(width * 0.65, 320 * aspect);
    const h = w / aspect;
    const image = (
      <Pressable
        onPress={() => p.onOpenPhoto?.(m)}
        onLongPress={readOnly ? undefined : photoMenu}
        disabled={!p.onOpenPhoto && readOnly}
        accessibilityRole="imagebutton"
        accessibilityLabel={m.image_description ?? 'Photo'}
      >
        <Image source={{ uri: photo.url }} style={[styles.photo, { width: w, height: h }]} contentFit="cover" transition={150} />
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.photoFlash, { opacity: flash }]} />
        {p.kept ? (
          <View pointerEvents="none" style={styles.keptBadge} accessibilityLabel="In Lore">
            <Icon name="sparkles" size={13} weight="semibold" color="#FFFFFF" />
          </View>
        ) : null}
      </Pressable>
    );
    // Photos take the action sheet instead of the SwiftUI menu: a menu host around a photo in the
    // inverted list draws it below its row on first mount, over the next message.
    body = (
      <View style={{ alignItems: mine ? 'flex-end' : 'flex-start', gap: 2 }}>
        {pad(image)}
        {m.text ? pad(textBubble) : null}
      </View>
    );
  }

  const reacted = m.reactions.length > 0;
  return (
    <View
      style={[
        styles.row,
        mine ? styles.rowMine : null,
        { marginTop: (run === 'single' || run === 'first' ? 6 : 2) + (reacted ? 18 : 0) },
      ]}
    >
      {!mine && avatars ? (
        <View style={styles.avatarSlot}>
          {p.showAvatar ? <Avatar uri={p.sender?.avatar_url} name={p.sender?.display_name} size={AVATAR} /> : null}
        </View>
      ) : null}
      <View style={[styles.col, { alignItems: mine ? 'flex-end' : 'flex-start' }]}>
        {p.showName && p.sender ? <Text style={styles.name}>{firstName(p.sender.display_name)}</Text> : null}
        {p.replied ? (
          <View style={[styles.quote, mine ? { alignItems: 'flex-end', marginRight: TAIL_PAD } : { marginLeft: TAIL_PAD }]}>
            <Text style={styles.quoteLabel}>
              {mine ? 'You replied to ' : 'Replied to '}
              {p.replied.name}
            </Text>
            <View style={styles.quoteBubble}>
              <Text style={styles.quoteText} numberOfLines={2}>
                {p.replied.text}
              </Text>
            </View>
          </View>
        ) : null}
        <View>
          {body}
          {reacted ? (
            <Tapback
              reactions={m.reactions}
              mine={mine}
              meId={p.meId}
              ring={background}
              userById={p.userById}
              onPress={readOnly || !p.onReact ? undefined : () => p.onReact?.(m, m.reactions[0].emoji)}
            />
          ) : null}
        </View>
      </View>
    </View>
  );
});

/** Tapback badge on the bubble's top corner: leading on my messages, trailing on theirs. */
function Tapback({
  reactions,
  mine,
  meId,
  ring,
  userById,
  onPress,
}: {
  reactions: Reaction[];
  mine: boolean;
  meId?: string;
  ring: string;
  userById?: (id: string) => User | undefined;
  onPress?: () => void;
}) {
  const emojis = [...new Set(reactions.map((r) => r.emoji))].slice(0, 3);
  const minePicked = !!meId && reactions.some((r) => r.user_id === meId);
  const who = reactions
    .map((r) => (r.user_id === meId ? 'you' : userById?.(r.user_id)?.display_name))
    .filter(Boolean)
    .join(', ');
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={`${emojis.join(' ')}${who ? ` from ${who}` : ''}`}
      style={[styles.tapback, mine ? { left: -12 } : { right: -12 }, { borderColor: ring }, minePicked && { backgroundColor: colors.blue }]}
    >
      <Text style={styles.tapbackEmoji}>{emojis.join('')}</Text>
      {reactions.length > emojis.length ? (
        <Text style={[styles.tapbackCount, minePicked && { color: '#FFFFFF' }]}>{reactions.length}</Text>
      ) : null}
    </Pressable>
  );
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function clock(d: Date) {
  const h = d.getHours() % 12 || 12;
  return `${h}:${d.getMinutes().toString().padStart(2, '0')} ${d.getHours() >= 12 ? 'PM' : 'AM'}`;
}

/** iMessage's separator: "Today 3:29 PM", "Yesterday …", "Saturday …", "Sat, Oct 12 at …". */
export function separatorParts(iso: string, now = new Date()) {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (dayDiff === 0) return { day: 'Today', time: clock(d) };
  if (dayDiff === 1) return { day: 'Yesterday', time: clock(d) };
  if (dayDiff > 1 && dayDiff < 7) return { day: WEEKDAYS[d.getDay()], time: clock(d) };
  const year = d.getFullYear() !== now.getFullYear() ? `, ${d.getFullYear()}` : '';
  return { day: `${WEEKDAYS[d.getDay()].slice(0, 3)}, ${MONTHS[d.getMonth()]} ${d.getDate()}${year}`, time: `at ${clock(d)}` };
}

export function TimeSeparator({ ts }: { ts: string }) {
  const { day, time } = separatorParts(ts);
  return (
    <Text style={styles.sep}>
      <Text style={styles.sepDay}>{day}</Text> {time}
    </Text>
  );
}

export function SystemLine({ text, names }: { text: string; names: Set<string> }) {
  const parts = text.split(/(\s+)/);
  return (
    <Text style={styles.system}>
      {parts.map((w, i) =>
        names.has(w.toLowerCase().replace(/[^\p{L}\p{N}._]/gu, '')) ? (
          <Text key={i} style={{ fontWeight: '700', color: colors.text }}>
            {w}
          </Text>
        ) : (
          w
        ),
      )}
    </Text>
  );
}

/**
 * Receipt under the newest message. A DM reads "Read 3:29 PM" (the time only when this session
 * saw the read happen) or "Delivered"; a group shows a mini stack of who has read it.
 */
export function SeenBy({
  users,
  isDm,
  readAt,
  delivered,
}: {
  users: User[];
  isDm: boolean;
  readAt?: number | null;
  delivered?: boolean;
}) {
  if (isDm) {
    if (users.length)
      return (
        <Text style={styles.receipt}>
          <Text style={styles.receiptStrong}>Read</Text>
          {readAt ? ` ${clock(new Date(readAt))}` : ''}
        </Text>
      );
    return delivered ? <Text style={[styles.receipt, styles.receiptStrong]}>Delivered</Text> : null;
  }
  if (!users.length) return null;
  const shown = users.slice(0, 5);
  const extra = users.length - shown.length;
  return (
    <View style={styles.seen}>
      {extra > 0 ? (
        <View style={styles.seenExtra}>
          <Text style={styles.seenExtraText}>+{extra}</Text>
        </View>
      ) : null}
      {shown.map((u, i) => (
        <Avatar key={u.id} uri={u.avatar_url} name={u.display_name} size={18} ring={colors.bg} style={{ marginLeft: i ? -4 : 0 }} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: GUTTER },
  rowMine: { justifyContent: 'flex-end' },
  // Above the bubble column so the tail's background-colored cut never paints over the avatar.
  avatarSlot: { width: AVATAR, marginRight: 2, zIndex: 2 },
  col: { maxWidth: '84%' },
  name: { color: colors.textSecondary, fontSize: 11, marginLeft: TAIL_PAD + 12, marginBottom: 2, marginTop: 4 },
  bubble: { paddingHorizontal: 12, paddingVertical: 7, overflow: 'hidden', borderCurve: 'continuous' },
  text: { color: '#FFFFFF', fontSize: 17, lineHeight: 22 },
  emojiWrap: { paddingHorizontal: 2 },
  emoji: { fontSize: 40, lineHeight: 48 },
  flash: { backgroundColor: 'rgba(0,122,255,0.18)' },
  tailFill: { position: 'absolute', bottom: 0, width: 27, height: 20 },
  tailCut: { position: 'absolute', bottom: -8, width: 26, height: 38 },
  tailCutMine: { right: -26, borderBottomLeftRadius: 24 },
  tailCutTheirs: { left: -26, borderBottomRightRadius: 24 },
  photo: { borderRadius: 18, borderCurve: 'continuous', backgroundColor: colors.bubbleIn },
  photoFlash: { borderRadius: 18, backgroundColor: 'rgba(0,122,255,0.18)' },
  keptBadge: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tapback: {
    position: 'absolute',
    // Mostly above the bubble, so a wide badge never covers the first line's last word.
    top: -20,
    minWidth: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
    backgroundColor: colors.bubbleIn,
    paddingHorizontal: 5,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  tapbackEmoji: { fontSize: 14 },
  tapbackCount: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  quote: { marginBottom: -10, paddingBottom: 12, marginTop: 4 },
  quoteLabel: { color: colors.textSecondary, fontSize: 12, marginBottom: 4, marginHorizontal: 12 },
  quoteBubble: {
    borderColor: colors.bubbleIn,
    borderWidth: 1,
    borderRadius: 18,
    borderCurve: 'continuous',
    paddingHorizontal: 12,
    paddingVertical: 7,
    paddingBottom: 16,
  },
  quoteText: { color: colors.textSecondary, fontSize: 15 },
  sep: { color: colors.textSecondary, fontSize: 12, textAlign: 'center', marginTop: 20, marginBottom: 8 },
  sepDay: { fontWeight: '600' },
  system: {
    color: colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    marginVertical: 14,
    paddingHorizontal: 40,
    lineHeight: 18,
  },
  receipt: { color: colors.textSecondary, fontSize: 13, alignSelf: 'flex-end', marginRight: GUTTER + TAIL_PAD, marginTop: 3 },
  receiptStrong: { fontWeight: '600' },
  seen: {
    flexDirection: 'row',
    alignSelf: 'flex-end',
    alignItems: 'center',
    paddingHorizontal: GUTTER + TAIL_PAD,
    marginTop: 6,
  },
  seenExtra: {
    height: 18,
    paddingHorizontal: 6,
    borderRadius: 9,
    backgroundColor: colors.bubbleIn,
    justifyContent: 'center',
    marginRight: 4,
  },
  seenExtraText: { color: colors.textSecondary, fontSize: 11, fontWeight: '600' },
});
