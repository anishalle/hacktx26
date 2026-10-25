import * as Haptics from 'expo-haptics';
import { memo, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import type { LoreGame, LoreGameOption, Message, User } from '@/api';
import { Glass } from '@/components/GlassCircle';
import { firstName } from '@/lib/format';
import { canReveal, resultLine, showsCounts, votedLine, withMyVote } from '@/lib/games';
import { groupTint, tintWash } from '@/lib/lore';
import { colors, mixHex } from '@/theme';

import { Avatar } from '../Avatar';
import { Icon } from '../Icon';
import { AVATAR } from './rows';

const GUTTER = 10;
const TAIL_PAD = 6;
/** Neutral iOS fill: a wrong or missing guess, so green only ever means "correct". */
const NEUTRAL = 'rgba(118,118,128,0.12)';
const NEUTRAL_PICK = 'rgba(118,118,128,0.22)';

type Props = {
  message: Message;
  game: LoreGame;
  mine: boolean;
  sender: User | undefined;
  showName: boolean;
  showAvatar: boolean;
  /** Reserve the avatar column next to incoming bubbles (group chats). */
  avatars: boolean;
  meId: string;
  highlighted?: boolean;
  onVote: (message: Message, game: LoreGame, choice: string) => Promise<void>;
  onHint: (message: Message, game: LoreGame) => Promise<void>;
  onReveal: (message: Message, game: LoreGame) => Promise<void>;
  onOpenLore: (loreId: number) => void;
};

/**
 * Guess that Lore, in the thread like an iOS 26 Messages poll: a name-free version of a kept
 * moment, "Who was it?", shared hints and one vote per member until the reveal.
 * Built from React Native views on purpose: a SwiftUI host that measures tall content inside the
 * inverted FlatList draws it out of place on first mount.
 */
export const GameBubble = memo(function GameBubble(p: Props) {
  const { message: m, mine, meId } = p;
  const { width } = useWindowDimensions();
  const cardWidth = Math.min(330, Math.round(width * 0.8));
  const tint = groupTint(m.group_id);
  const ink = mixHex(tint, '#000000', 0.32);

  // My pick shows at once; the server's answer (or a frame) replaces it.
  const [pending, setPending] = useState<string | null>(null);
  const voteSeq = useRef(0);
  const [busy, setBusy] = useState<'hint' | 'reveal' | null>(null);
  const game = pending ? withMyVote(p.game, pending) : p.game;
  const revealed = game.status === 'revealed';
  const counts = showsCounts(game);
  const revealable = canReveal(game, meId, m.ts);
  const hintsLeft = Math.max(0, game.hints_total - game.hints.length);

  const vote = async (choice: string) => {
    if (revealed || game.my_vote === choice) return;
    Haptics.selectionAsync();
    const seq = ++voteSeq.current;
    setPending(choice);
    try {
      await p.onVote(m, p.game, choice);
    } finally {
      if (seq === voteSeq.current) setPending(null);
    }
  };
  const hint = async () => {
    if (busy) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setBusy('hint');
    try {
      await p.onHint(m, p.game);
    } finally {
      setBusy(null);
    }
  };
  const reveal = async () => {
    if (busy) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setBusy('reveal');
    try {
      await p.onReveal(m, p.game);
    } finally {
      setBusy(null);
    }
  };

  // Celebrate once when the reveal lands while the bubble is on screen.
  const wasRevealed = useRef(revealed);
  useEffect(() => {
    if (revealed && !wasRevealed.current) {
      wasRevealed.current = true;
      Haptics.notificationAsync(
        game.my_vote && game.my_vote === game.answer?.id
          ? Haptics.NotificationFeedbackType.Success
          : Haptics.NotificationFeedbackType.Warning,
      );
    }
  }, [revealed, game.my_vote, game.answer?.id]);

  const result = revealed ? resultLine(game, meId) : null;
  const right = !!game.my_vote && game.my_vote === game.answer?.id;

  const card = (
    <View
      style={[styles.card, { width: cardWidth }, p.highlighted && styles.cardHighlighted]}
      accessibilityLabel={`Guess that Lore. ${game.prompt}. ${game.question}`}
    >
      <View style={styles.header}>
        <Icon name="sparkles" size={14} weight="semibold" color={tint} />
        <Text style={[styles.kicker, { color: ink }]}>Guess that Lore</Text>
        <View style={{ flex: 1 }} />
        <Icon name="dice" size={15} weight="medium" color={colors.textTertiary} />
      </View>

      <Text style={styles.prompt}>{game.prompt}</Text>
      <Text style={styles.question}>{game.question}</Text>

      {game.hints.length || (hintsLeft > 0 && !revealed) ? (
        <View style={styles.hints}>
          {game.hints.map((h, i) => (
            <Animated.View key={i} entering={FadeIn.duration(220)} style={[styles.hint, { backgroundColor: tintWash(tint, 0.12) }]}>
              <Icon name="lightbulb.fill" size={12} color={ink} style={styles.hintIcon} />
              <Text style={styles.hintText}>{h}</Text>
            </Animated.View>
          ))}
          {hintsLeft > 0 && !revealed ? (
            <Pressable
              onPress={hint}
              disabled={!!busy}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Show a hint, ${hintsLeft} left`}
              style={styles.hintButtonHit}
            >
              <Glass interactive style={styles.hintButton}>
                {busy === 'hint' ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : (
                  <Icon name="lightbulb" size={13} weight="semibold" color={ink} />
                )}
                <Text style={[styles.hintButtonText, { color: ink }]}>
                  {game.hints.length ? 'Another Hint' : 'Hint'}
                </Text>
                <Text style={styles.hintLeft}>{hintsLeft} left</Text>
              </Glass>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <View style={styles.options}>
        {game.options.map((o) => (
          <OptionRow
            key={o.user.id}
            option={o}
            game={game}
            meId={meId}
            tint={tint}
            counts={counts}
            onPress={() => vote(o.user.id)}
          />
        ))}
      </View>

      {revealed ? (
        <Animated.View entering={FadeIn.duration(260)} style={[styles.result, { backgroundColor: right ? tintWash(colors.green, 0.12) : NEUTRAL }]}>
          <View style={styles.resultTop}>
            <Icon name={right ? 'party.popper.fill' : 'sparkles'} size={16} color={right ? colors.green : colors.textSecondary} />
            <Text style={styles.resultLine}>{result}</Text>
          </View>
          {game.lore_title ? <Text style={styles.loreTitle}>{game.lore_title}</Text> : null}
        </Animated.View>
      ) : null}

      <View style={styles.footer}>
        <Text style={styles.footerText}>{revealed ? `${votedLine(game)} · Revealed` : votedLine(game)}</Text>
        {revealed ? (
          <Pressable
            onPress={() => {
              Haptics.selectionAsync();
              p.onOpenLore(game.lore_id);
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Open this moment in Lore"
            style={[styles.primary, { backgroundColor: colors.blue }]}
          >
            <Icon name="sparkles.rectangle.stack" size={13} weight="semibold" color="#FFFFFF" />
            <Text style={styles.primaryText}>Open Lore</Text>
          </Pressable>
        ) : revealable ? (
          <Pressable
            onPress={reveal}
            disabled={!!busy}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Reveal the answer"
            style={styles.reveal}
          >
            {busy === 'reveal' ? <ActivityIndicator size="small" color={colors.blue} /> : null}
            <Text style={styles.revealText}>Reveal</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );

  return (
    <View style={[styles.row, mine && styles.rowMine, { marginTop: 8 }]}>
      {!mine && p.avatars ? (
        <View style={styles.avatarSlot}>
          {p.showAvatar ? <Avatar uri={p.sender?.avatar_url} name={p.sender?.display_name} size={AVATAR} /> : null}
        </View>
      ) : null}
      <View style={[styles.col, { alignItems: mine ? 'flex-end' : 'flex-start' }]}>
        {p.showName && p.sender ? <Text style={styles.name}>{firstName(p.sender.display_name)}</Text> : null}
        <View style={[mine ? { paddingRight: TAIL_PAD } : { paddingLeft: TAIL_PAD }, m.id < 0 && { opacity: 0.7 }]}>{card}</View>
      </View>
    </View>
  );
});

/** One answer: avatar and name, tap to vote; after you vote, a fill and the count; after the reveal, who picked it. */
function OptionRow({
  option,
  game,
  meId,
  tint,
  counts,
  onPress,
}: {
  option: LoreGameOption;
  game: LoreGame;
  meId: string;
  tint: string;
  counts: boolean;
  onPress: () => void;
}) {
  const { user } = option;
  const revealed = game.status === 'revealed';
  const picked = game.my_vote === user.id;
  const correct = revealed && game.answer?.id === user.id;
  const dim = revealed && !correct;
  const name = user.id === meId ? 'You' : firstName(user.display_name);

  const share = counts && game.total_votes > 0 ? option.votes / game.total_votes : 0;
  const fill = useSharedValue(share);
  useEffect(() => {
    fill.value = withTiming(share, { duration: 360 });
  }, [share, fill]);
  const fillStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.value }] }));

  // The group tint marks my pick only while the round is open; after it, green is the answer alone.
  const fillColor = correct ? tintWash(colors.green, 0.18) : picked ? (revealed ? NEUTRAL_PICK : tintWash(tint, 0.22)) : NEUTRAL;

  return (
    <Pressable
      onPress={onPress}
      disabled={revealed}
      accessibilityRole="button"
      accessibilityState={{ selected: picked, disabled: revealed }}
      accessibilityLabel={`${name}${counts ? `, ${option.votes} ${option.votes === 1 ? 'vote' : 'votes'}` : ''}${correct ? ', the answer' : ''}`}
      style={({ pressed }) => [styles.option, pressed && !revealed && styles.optionPressed, dim && styles.optionDim]}
    >
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.fill, { backgroundColor: fillColor }, fillStyle]} />
      <Mark picked={picked} correct={correct} revealed={revealed} tint={tint} />
      <Avatar uri={user.avatar_url} name={user.display_name} size={28} />
      <Text style={[styles.optionName, (picked || correct) && styles.optionNameStrong]} numberOfLines={1}>
        {name}
      </Text>
      {revealed && option.voters.length ? <Voters users={option.voters} /> : null}
      {counts ? <Text style={styles.count}>{option.votes}</Text> : null}
    </Pressable>
  );
}

/** The leading circle: empty, my pick (tint check), the answer (green check) or my miss (grey x). */
function Mark({ picked, correct, revealed, tint }: { picked: boolean; correct: boolean; revealed: boolean; tint: string }) {
  if (correct) return <Icon name="checkmark.circle.fill" size={22} color={colors.green} />;
  if (revealed && picked) return <Icon name="xmark.circle.fill" size={22} color={colors.textTertiary} />;
  if (picked) return <Icon name="checkmark.circle.fill" size={22} color={tint} />;
  return <View style={styles.ring} />;
}

function Voters({ users }: { users: User[] }) {
  const shown = users.slice(0, 3);
  const extra = users.length - shown.length;
  return (
    <View style={styles.voters} accessibilityLabel={`Picked by ${users.map((u) => firstName(u.display_name)).join(', ')}`}>
      {shown.map((u, i) => (
        <Avatar key={u.id} uri={u.avatar_url} name={u.display_name} size={24} ring={colors.bg} style={i ? { marginLeft: -7 } : null} />
      ))}
      {extra > 0 ? <Text style={styles.votersExtra}>+{extra}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: GUTTER },
  rowMine: { justifyContent: 'flex-end' },
  avatarSlot: { width: AVATAR, marginRight: 2 },
  col: { maxWidth: '88%' },
  name: { color: colors.textSecondary, fontSize: 11, marginLeft: TAIL_PAD + 12, marginBottom: 2, marginTop: 4 },
  card: {
    backgroundColor: colors.bg,
    borderRadius: 22,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    boxShadow: '0 4px 16px rgba(0,0,0,0.07)',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    gap: 10,
  },
  // A jump to the round (Lore's "Open in Chat", catch-up) frames it briefly; the thread clears it.
  cardHighlighted: { borderColor: colors.blue, borderWidth: 2 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  kicker: { fontSize: 13, fontWeight: '600' },
  prompt: { color: colors.text, fontFamily: 'ui-serif', fontSize: 20, fontWeight: '600', lineHeight: 25 },
  question: { color: colors.textSecondary, fontSize: 15, marginTop: -4 },
  hints: { gap: 6 },
  hint: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, borderRadius: 12, borderCurve: 'continuous', paddingHorizontal: 10, paddingVertical: 7 },
  hintIcon: { marginTop: 2 },
  hintText: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 19 },
  hintButtonHit: { alignSelf: 'flex-start' },
  hintButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 30,
    paddingHorizontal: 12,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
  },
  hintButtonText: { fontSize: 14, fontWeight: '600' },
  hintLeft: { color: colors.textSecondary, fontSize: 13 },
  options: { gap: 6 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    minHeight: 44,
    paddingHorizontal: 10,
    borderRadius: 12,
    borderCurve: 'continuous',
    backgroundColor: colors.grouped,
    overflow: 'hidden',
  },
  optionPressed: { backgroundColor: colors.bubbleInPressed },
  optionDim: { opacity: 0.45 },
  fill: { transformOrigin: 'left', borderRadius: 12 },
  ring: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: colors.textTertiary },
  optionName: { flex: 1, color: colors.text, fontSize: 16 },
  optionNameStrong: { fontWeight: '600' },
  count: { color: colors.textSecondary, fontSize: 15, fontVariant: ['tabular-nums'], minWidth: 14, textAlign: 'right' },
  voters: { flexDirection: 'row', alignItems: 'center' },
  votersExtra: { color: colors.textSecondary, fontSize: 11, fontWeight: '600', marginLeft: 3 },
  result: { borderRadius: 12, borderCurve: 'continuous', paddingHorizontal: 12, paddingVertical: 9, gap: 3 },
  resultTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  resultLine: { color: colors.text, fontSize: 15, fontWeight: '600' },
  loreTitle: { color: colors.text, fontFamily: 'ui-serif', fontSize: 16, fontWeight: '600', lineHeight: 21 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 30 },
  footerText: { color: colors.textSecondary, fontSize: 13 },
  reveal: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4, height: 30 },
  revealText: { color: colors.blue, fontSize: 15, fontWeight: '600' },
  primary: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 30, paddingHorizontal: 13, borderRadius: 15 },
  primaryText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
});
