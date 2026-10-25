import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { api, type Explanation } from '@/api';
import { Avatar } from '@/components/Avatar';
import { BoldText } from '@/components/BoldText';
import { Glass } from '@/components/GlassCircle';
import { Icon } from '@/components/Icon';
import { firstName } from '@/lib/format';
import { useSession } from '@/state/session';
import { colors } from '@/theme';

const AUTO_DISMISS_MS = 15_000;

export type CardState =
  | { phase: 'loading'; atMs: number }
  | { phase: 'done'; atMs: number; result: Explanation }
  | { phase: 'error'; atMs: number; message: string };

type Props = {
  card: CardState;
  groupId: number;
  meId: string;
  onRetry: (atMs: number) => void;
  onDismiss: () => void;
};

/**
 * Feature 4: the private card over the call after a ? tap. One-line meaning, who said it,
 * chat-history evidence and a follow-up box. Auto-dismisses after 15 s unless in use.
 */
export function CallExplainCard({ card, groupId, meId, onRetry, onDismiss }: Props) {
  const { userById } = useSession();
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [q, setQ] = useState('');
  const [answers, setAnswers] = useState<Explanation[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const holding = card.phase === 'loading' || busy || focused || !!q || answers.length > 0;

  // 15 s countdown, restarted whenever the card stops being in use.
  const [progress] = useState(() => new Animated.Value(1));
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  });
  useEffect(() => {
    if (holding) {
      progress.setValue(1);
      return;
    }
    const anim = Animated.timing(progress, { toValue: 0, duration: AUTO_DISMISS_MS, useNativeDriver: false });
    anim.start(({ finished }) => finished && dismissRef.current());
    return () => anim.stop();
  }, [holding, progress, card]);

  const result = card.phase === 'done' ? card.result : null;
  const saidBy = result?.said_by ? (result.said_by.id === meId ? 'you' : firstName(result.said_by.display_name)) : null;

  const followUp = async () => {
    const question = q.trim();
    if (!question || busy || !result) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.explain({ group_id: groupId, user_id: meId, explanation_id: result.explanation_id, follow_up: question });
      setAnswers((a) => [...a, { ...res, follow_up: res.follow_up ?? question }]);
      setQ('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Glass style={styles.card}>
      <Pressable onPress={onDismiss} style={styles.head} hitSlop={6} accessibilityLabel="Dismiss">
        <LinearGradient colors={['#A033FF', '#5B51F5', '#3797F0']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.badge}>
          <Icon name="questionmark" size={13} weight="bold" color="white" />
        </LinearGradient>
        <Text style={styles.title} numberOfLines={1}>
          {card.phase === 'loading'
            ? 'Catching what was just said…'
            : result?.status === 'no_speech'
              ? 'Nothing to explain yet'
              : saidBy
                ? `What ${saidBy} meant`
                : 'What that meant'}
        </Text>
        {card.phase === 'loading' ? <ActivityIndicator size="small" color={colors.textSecondary} /> : <Icon name="xmark" size={13} color={colors.textSecondary} />}
      </Pressable>

      {card.phase === 'error' ? (
        <View style={styles.row}>
          <Text style={styles.error}>{card.message}</Text>
          <Pressable onPress={() => onRetry(card.atMs)} hitSlop={8}>
            <Text style={styles.link}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {result ? (
        <>
          {result.status === 'general' ? <Text style={styles.label}>Not defined in this chat; generally it means…</Text> : null}
          {result.status === 'unknown' && result.heard ? <Text style={styles.label}>I caught: “{result.heard}”</Text> : null}
          <BoldText text={result.meaning} style={styles.meaning} />
          {result.sources.slice(0, 2).map((m) => {
            const sender = m.sender_id ? userById(m.sender_id) : undefined;
            return (
              <View key={m.id} style={styles.source}>
                <Avatar uri={sender?.avatar_url} size={18} />
                <Text style={styles.sourceText} numberOfLines={1}>
                  <Text style={styles.sourceName}>{sender ? firstName(sender.display_name) : 'Someone'} in chat: </Text>
                  {m.text}
                </Text>
              </View>
            );
          })}
          {result.human_sources.slice(0, 1).map((h) => (
            <Text key={h.ask_id} style={styles.sourceText} numberOfLines={2}>
              <Text style={styles.sourceName}>From {firstName(h.user.display_name)}: </Text>
              {h.answer}
            </Text>
          ))}
          {answers.map((a, i) => (
            <View key={i} style={styles.answer}>
              <Text style={styles.answerQ}>{a.follow_up}</Text>
              <BoldText text={a.meaning} style={styles.answerText} />
            </View>
          ))}
          {result.status !== 'no_speech' ? (
            <View style={styles.askRow}>
              <TextInput
                value={q}
                onChangeText={setQ}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder="Ask something else about this…"
                placeholderTextColor={colors.textSecondary}
                style={styles.askInput}
                returnKeyType="send"
                onSubmitEditing={followUp}
                keyboardAppearance="dark"
                editable={!busy}
              />
              <Pressable onPress={followUp} disabled={!q.trim() || busy} style={[styles.askGo, (!q.trim() || busy) && { opacity: 0.4 }]}>
                {busy ? <ActivityIndicator size="small" color="white" /> : <Icon name="arrow.up" size={13} weight="bold" color="white" />}
              </Pressable>
            </View>
          ) : null}
          {err ? <Text style={styles.error}>{err}</Text> : null}
        </>
      ) : null}

      <View style={styles.footer}>
        <Icon name="lock.fill" size={9} color={colors.textTertiary} />
        <Text style={styles.footerText}>Only you can see this.</Text>
      </View>
      <Animated.View
        style={[styles.timer, { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]}
      />
    </Glass>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 22, padding: 14, paddingBottom: 12, gap: 8, overflow: 'hidden', backgroundColor: 'rgba(28,31,36,0.72)' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badge: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { color: colors.sparkle, fontSize: 13, fontWeight: '600' },
  meaning: { color: colors.text, fontSize: 17, lineHeight: 23 },
  source: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sourceText: { flex: 1, color: colors.textSecondary, fontSize: 13 },
  sourceName: { color: colors.text, fontWeight: '600' },
  answer: { backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 12, padding: 10 },
  answerQ: { color: colors.textSecondary, fontSize: 12, marginBottom: 4 },
  answerText: { color: colors.text, fontSize: 15, lineHeight: 20 },
  askRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  askInput: { flex: 1, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.08)', paddingHorizontal: 14, color: colors.text, fontSize: 14 },
  askGo: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.blue, alignItems: 'center', justifyContent: 'center' },
  error: { flex: 1, color: '#FF6B6B', fontSize: 13 },
  link: { color: colors.blue, fontSize: 14, fontWeight: '600' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  footerText: { color: colors.textTertiary, fontSize: 11 },
  timer: { position: 'absolute', left: 0, bottom: 0, height: 2, backgroundColor: colors.sparkle, opacity: 0.6 },
});
