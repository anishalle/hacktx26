import { Image } from 'expo-image';
import { memo, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { Message, Reaction, User } from '@/api';
import { colors } from '@/theme';

import { Avatar } from '../Avatar';
import { MessageMenu } from './MessageMenu';

export const AVATAR = 28;
const GUTTER = 12;

export type RunPos = 'single' | 'first' | 'middle' | 'last';

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*){1,3}$/u;

type MessageRowProps = {
  message: Message;
  mine: boolean;
  sender: User | undefined;
  showName: boolean;
  showAvatar: boolean;
  run: RunPos;
  tint: string;
  highlighted: boolean;
  replied: { name: string; text: string } | null;
  userById: (id: string) => User | undefined;
  onReact: (m: Message, emoji: string) => void;
  onReply: (m: Message) => void;
  onCopy: (m: Message) => void;
  onExplain: (m: Message) => void;
  onOpenPhoto: (m: Message) => void;
};

function corners(run: RunPos, mine: boolean) {
  const big = 22;
  const small = 6;
  const top = run === 'single' || run === 'first' ? big : small;
  const bottom = run === 'single' || run === 'last' ? big : small;
  return mine
    ? { borderTopRightRadius: top, borderBottomRightRadius: bottom, borderTopLeftRadius: big, borderBottomLeftRadius: big }
    : { borderTopLeftRadius: top, borderBottomLeftRadius: bottom, borderTopRightRadius: big, borderBottomRightRadius: big };
}

export const MessageRow = memo(function MessageRow(p: MessageRowProps) {
  const { message: m, mine, run } = p;
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
  const maxBubble = Math.round(width * (mine ? 0.74 : 0.72));
  const pending = m.id < 0;
  const photo = m.kind === 'photo' && m.image ? m.image : null;

  const textBubble = (
    <Pressable
      onPress={() => {
        const now = Date.now();
        if (now - lastTap.current < 280) p.onReact(m, '❤️');
        lastTap.current = now;
      }}>
      <View
        style={[
          emojiOnly ? styles.emojiWrap : styles.bubble,
          { maxWidth: maxBubble },
          !emojiOnly && corners(run, mine),
          !emojiOnly && { backgroundColor: mine ? p.tint : colors.bubbleIn },
          pending && { opacity: 0.7 },
        ]}>
        <Text style={emojiOnly ? styles.emoji : styles.text}>{m.text}</Text>
        {!emojiOnly ? (
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, corners(run, mine), styles.flash, { opacity: flash }]} />
        ) : null}
      </View>
    </Pressable>
  );

  let bubble = textBubble;
  if (photo) {
    // Fit the photo in 65% of the width and 320 pt of height, keeping its shape.
    const aspect = photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 1;
    const w = Math.min(width * 0.65, 320 * aspect);
    bubble = (
      <View style={{ alignItems: mine ? 'flex-end' : 'flex-start', gap: 2 }}>
        <Pressable onPress={() => p.onOpenPhoto(m)} accessibilityRole="imagebutton" accessibilityLabel={m.image_description ?? 'Photo'}>
          <Image
            source={{ uri: photo.url }}
            style={[styles.photo, { width: w, height: w / aspect }, pending && { opacity: 0.7 }]}
            contentFit="cover"
            transition={150}
          />
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.photoFlash, { opacity: flash }]} />
        </Pressable>
        {m.text ? textBubble : null}
      </View>
    );
  }

  return (
    <View style={[styles.row, mine ? styles.rowMine : null, { marginTop: run === 'single' || run === 'first' ? 6 : 2 }]}>
      {!mine ? (
        <View style={[styles.avatarSlot, { marginBottom: m.reactions.length ? 20 : 0 }]}>
          {p.showAvatar ? <Avatar uri={p.sender?.avatar_url} size={AVATAR} /> : null}
        </View>
      ) : null}
      <View style={[styles.col, { alignItems: mine ? 'flex-end' : 'flex-start' }]}>
        {p.showName && p.sender ? <Text style={styles.name}>{p.sender.username}</Text> : null}
        {p.replied ? (
          <View style={[styles.quote, mine ? { alignItems: 'flex-end' } : null]}>
            <Text style={styles.quoteLabel}>{mine ? 'You replied to ' : 'Replied to '}{p.replied.name}</Text>
            <View style={styles.quoteBubble}>
              <Text style={styles.quoteText} numberOfLines={2}>
                {p.replied.text}
              </Text>
            </View>
          </View>
        ) : null}
        <MessageMenu
          onReact={(e) => p.onReact(m, e)}
          onReply={() => p.onReply(m)}
          onCopy={() => p.onCopy(m)}
          onExplain={() => p.onExplain(m)}>
          {bubble}
        </MessageMenu>
        {m.reactions.length ? (
          <ReactionPill reactions={m.reactions} mine={mine} userById={p.userById} onPress={() => p.onReact(m, m.reactions[0].emoji)} />
        ) : null}
      </View>
    </View>
  );
});

function ReactionPill({
  reactions,
  mine,
  userById,
  onPress,
}: {
  reactions: Reaction[];
  mine: boolean;
  userById: (id: string) => User | undefined;
  onPress: () => void;
}) {
  const emojis = [...new Set(reactions.map((r) => r.emoji))].slice(0, 3);
  const reactors = reactions.slice(0, 2);
  return (
    <Pressable onPress={onPress} style={[styles.pill, mine ? { marginRight: 10 } : { marginLeft: 10 }]}>
      <Text style={styles.pillEmoji}>{emojis.join('')}</Text>
      {reactions.length > 1 ? (
        <View style={styles.pillAvatars}>
          {reactors.map((r, i) => (
            <Avatar key={r.user_id} uri={userById(r.user_id)?.avatar_url} size={16} style={{ marginLeft: i ? -4 : 2 }} />
          ))}
          {reactions.length > 2 ? <Text style={styles.pillCount}>{reactions.length}</Text> : null}
        </View>
      ) : null}
    </Pressable>
  );
}

export function TimeSeparator({ label }: { label: string }) {
  return <Text style={styles.sep}>{label}</Text>;
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

export function SeenBy({ users, isDm }: { users: User[]; isDm: boolean }) {
  if (!users.length) return null;
  if (isDm) return <Text style={styles.seenText}>Seen</Text>;
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
        <Avatar key={u.id} uri={u.avatar_url} size={18} ring="#18191C" style={{ marginLeft: i ? -4 : 0 }} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: GUTTER },
  rowMine: { justifyContent: 'flex-end' },
  avatarSlot: { width: AVATAR, marginRight: 8 },
  col: { maxWidth: '76%' },
  name: { color: colors.textSecondary, fontSize: 12, marginLeft: 14, marginBottom: 4, marginTop: 6 },
  bubble: { paddingHorizontal: 14, paddingVertical: 9, overflow: 'hidden' },
  text: { color: '#FFFFFF', fontSize: 17, lineHeight: 22, letterSpacing: -0.2 },
  emojiWrap: { paddingHorizontal: 2 },
  emoji: { fontSize: 40, lineHeight: 48 },
  flash: { backgroundColor: 'rgba(255,255,255,0.28)' },
  photo: { borderRadius: 18, backgroundColor: colors.bubbleIn },
  photoFlash: { borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.28)' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bubbleIn,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: '#18191C',
    paddingHorizontal: 6,
    height: 26,
    marginTop: -5,
  },
  pillEmoji: { fontSize: 13 },
  pillAvatars: { flexDirection: 'row', alignItems: 'center', marginLeft: 3 },
  pillCount: { color: colors.textSecondary, fontSize: 12, marginLeft: 4 },
  quote: { marginBottom: -10, paddingBottom: 12, marginTop: 4 },
  quoteLabel: { color: colors.textSecondary, fontSize: 12, marginBottom: 4, marginHorizontal: 12 },
  quoteBubble: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8, paddingBottom: 16 },
  quoteText: { color: colors.textSecondary, fontSize: 14 },
  sep: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 22,
    marginBottom: 10,
    letterSpacing: 0.2,
  },
  system: {
    color: colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    marginVertical: 14,
    paddingHorizontal: 40,
    lineHeight: 18,
  },
  seen: { flexDirection: 'row', alignSelf: 'flex-end', alignItems: 'center', paddingHorizontal: GUTTER, marginTop: 8 },
  seenExtra: {
    height: 18,
    paddingHorizontal: 6,
    borderRadius: 9,
    backgroundColor: '#2C2F34',
    justifyContent: 'center',
    marginRight: 4,
  },
  seenExtraText: { color: colors.textSecondary, fontSize: 10, fontWeight: '600' },
  seenText: { color: colors.textSecondary, fontSize: 12, alignSelf: 'flex-end', marginRight: GUTTER, marginTop: 4 },
});
