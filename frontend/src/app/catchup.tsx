import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Fragment, useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { api, type CatchupAnswer, type CatchupBullet, type CatchupSection, type CatchupTerm } from '@/api';
import { Icon } from '@/components/Icon';
import { useExplain } from '@/features/explain';
import { formatCount } from '@/lib/format';
import { catchupMarkRead, threadJump } from '@/state/bus';
import { useMe } from '@/state/session';
import { colors, type } from '@/theme';

const SECTIONS: { key: CatchupSection; title: string }[] = [
  { key: 'happened', title: 'What happened' },
  { key: 'decisions', title: 'Decided' },
  { key: 'open', title: 'Still open' },
];

type Phase = 'streaming' | 'done' | 'error';

/** Feature 3: streams POST /catchup (SSE) into a native form sheet. Never changes read state. */
export default function CatchupSheet() {
  const { groupId: gid, since } = useLocalSearchParams<{ groupId: string; since?: string }>();
  const groupId = Number(gid);
  const router = useRouter();
  const me = useMe();
  const onExplain = useExplain();

  const [unread, setUnread] = useState<number | null>(null);
  const [bullets, setBullets] = useState<CatchupBullet[]>([]);
  const [terms, setTerms] = useState<CatchupTerm[]>([]);
  const [phase, setPhase] = useState<Phase>('streaming');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const body = { group_id: groupId, user_id: me.id, ...(since ? { since_message_id: Number(since) } : {}) };
        for await (const ev of api.catchupStream(body, ctrl.signal)) {
          if (ctrl.signal.aborted) return;
          switch (ev.event) {
            case 'meta':
              setUnread(ev.data.unread_count);
              break;
            case 'bullet':
              setBullets((b) => [...b, ev.data]);
              Haptics.selectionAsync();
              break;
            case 'term':
              setTerms((x) => (x.some((y) => y.term === ev.data.term) ? x : [...x, ev.data]));
              break;
            case 'done':
              setPhase('done');
              return;
            case 'error':
              setError(ev.data.message);
              setPhase('error');
              return;
          }
        }
        if (!ctrl.signal.aborted) setPhase((p) => (p === 'streaming' ? 'done' : p));
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase('error');
      }
    })();
    return () => ctrl.abort();
  }, [groupId, me.id, since, attempt]);

  const jump = (messageId: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    threadJump.emit({ groupId, messageId });
    router.back();
  };

  return (
    <ScrollView
      style={styles.sheet}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <View style={styles.header}>
        <LinearGradient
          colors={['#007AFF', '#0875E8', '#116DD6']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.headerIcon}
        >
          <Icon name="sparkles" size={18} color="white" weight="semibold" />
        </LinearGradient>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Catch up</Text>
          <Text style={styles.subtitle}>
            {unread === null
              ? 'Reading what you missed…'
              : phase === 'streaming'
                ? `Reading ${formatCount(unread)} messages…`
                : `${formatCount(unread)} messages since you last read`}
          </Text>
        </View>
        {phase === 'streaming' ? <ActivityIndicator color={colors.textSecondary} /> : null}
      </View>

      {phase === 'error' ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error ?? 'Something went wrong.'}</Text>
          <Pressable
            onPress={() => {
              setBullets([]);
              setTerms([]);
              setPhase('streaming');
              setError(null);
              setAttempt((n) => n + 1);
            }}
            style={({ pressed }) => [styles.retry, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.retryText}>Try Again</Text>
          </Pressable>
        </View>
      ) : null}

      {SECTIONS.map((s) => {
        const list = bullets.filter((b) => b.section === s.key);
        if (!list.length && phase !== 'streaming') return null;
        return (
          <View key={s.key} style={styles.section}>
            <Text style={styles.sectionTitle}>{s.title}</Text>
            <View style={styles.card}>
              {list.map((b, i) => (
                <Fragment key={`${b.start_message_id}-${i}`}>
                  {i ? <View style={styles.sep} /> : null}
                  <BulletRow bullet={b} onPress={() => jump(b.start_message_id)} />
                </Fragment>
              ))}
              {!list.length ? <Skeleton lines={s.key === 'happened' ? 3 : 1} /> : null}
            </View>
          </View>
        );
      })}

      {terms.length ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Terms you might not know</Text>
          <View style={[styles.card, styles.cardPadded, styles.chips]}>
            {terms.map((term) => (
              <Pressable
                key={term.term}
                onPress={() => onExplain({ groupId, term: term.term })}
                style={({ pressed }) => [styles.chip, pressed && { opacity: 0.6 }]}
              >
                <Text style={styles.chipText}>{term.term}</Text>
                <Icon name="questionmark.circle" size={14} color={colors.blue} />
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {phase === 'done' ? <Ask groupId={groupId} userId={me.id} since={since ? Number(since) : undefined} onJump={jump} /> : null}

      <View style={styles.footer}>
        <Text style={styles.footerNote}>
          <Icon name="lock.fill" size={10} color={colors.textSecondary} /> Only you can see this. Your messages stay unread.
        </Text>
        <Pressable
          onPress={() => {
            catchupMarkRead.emit({ groupId });
            router.back();
          }}
          hitSlop={8}
        >
          <Text style={styles.markRead}>Mark as Read</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function BulletRow({ bullet, onPress }: { bullet: CatchupBullet; onPress: () => void }) {
  const [anim] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(anim, { toValue: 1, duration: 320, useNativeDriver: true }).start();
  }, [anim]);
  return (
    <Animated.View
      style={{ opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }}
    >
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.bullet, pressed && styles.pressed]}
      >
        <View style={styles.dot} />
        <Text style={styles.bulletText}>{bullet.text}</Text>
        <Icon name="arrow.up.forward" size={12} color={colors.textTertiary} style={{ marginTop: 4 }} />
      </Pressable>
    </Animated.View>
  );
}

function Skeleton({ lines }: { lines: number }) {
  const [pulse] = useState(() => new Animated.Value(0.35));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.8, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.35, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <View style={{ gap: 10, paddingVertical: 16, paddingLeft: 32, paddingRight: 16 }}>
      {Array.from({ length: lines }).map((_, i) => (
        <Animated.View key={i} style={[styles.skel, { opacity: pulse, width: i === lines - 1 ? '62%' : '92%' }]} />
      ))}
    </View>
  );
}

function Ask({
  groupId,
  userId,
  since,
  onJump,
}: {
  groupId: number;
  userId: string;
  since?: number;
  onJump: (id: number) => void;
}) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<(CatchupAnswer & { question: string }) | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    const question = q.trim();
    if (!question || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.catchupAsk({
        group_id: groupId,
        user_id: userId,
        question,
        ...(since ? { since_message_id: since } : {}),
      });
      setAnswer({ ...res, question });
      setQ('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.section}>
      {answer ? (
        <View style={[styles.card, styles.cardPadded, { marginBottom: 12 }]}>
          <Text style={styles.answerQ}>{answer.question}</Text>
          <Text style={styles.answerText}>{answer.answer}</Text>
          {answer.sources.length ? (
            <View style={[styles.chips, { marginTop: 10 }]}>
              {answer.sources.map((s, i) => (
                <Pressable key={i} onPress={() => onJump(s.start_message_id)} style={styles.sourceChip}>
                  <Icon name="arrow.up.forward" size={11} color={colors.blue} />
                  <Text style={styles.sourceText}>Jump to messages</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      <View style={styles.askRow}>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Ask about what you missed…"
          placeholderTextColor={colors.textSecondary}
          style={styles.askInput}
          returnKeyType="send"
          onSubmitEditing={submit}
          keyboardAppearance="light"
          editable={!busy}
        />
        <Pressable onPress={submit} disabled={!q.trim() || busy} style={[styles.askGo, (!q.trim() || busy) && { opacity: 0.4 }]}>
          {busy ? (
            <ActivityIndicator size="small" color="white" />
          ) : (
            <Icon name="arrow.up" size={15} weight="bold" color="white" />
          )}
        </Pressable>
      </View>
      {err ? <Text style={styles.errorText}>{err}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.grouped },
  content: { paddingTop: 26, paddingHorizontal: 16, paddingBottom: 72 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 6, paddingHorizontal: 2 },
  headerIcon: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, ...type.title2 },
  subtitle: { color: colors.textSecondary, ...type.footnote, marginTop: 2 },
  section: { marginTop: 22 },
  sectionTitle: { color: colors.textSecondary, ...type.footnote, textTransform: 'uppercase', marginHorizontal: 16, marginBottom: 7 },
  card: { backgroundColor: colors.surface, borderRadius: 22, borderCurve: 'continuous', overflow: 'hidden' },
  cardPadded: { padding: 16 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: 32 },
  pressed: { backgroundColor: 'rgba(0,0,0,0.05)' },
  bullet: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 11, paddingHorizontal: 16 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.blue, marginTop: 9 },
  bulletText: { flex: 1, color: colors.text, fontSize: 17, lineHeight: 23 },
  skel: { height: 12, borderRadius: 6, backgroundColor: colors.surfaceAlt },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.accentSoft,
  },
  chipText: { color: colors.blue, fontSize: 15, fontWeight: '600' },
  answerQ: { color: colors.textSecondary, ...type.footnote, marginBottom: 6 },
  answerText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  sourceChip: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 28 },
  sourceText: { color: colors.blue, ...type.footnote, fontWeight: '600' },
  askRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  askInput: {
    flex: 1,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surface,
    paddingHorizontal: 16,
    color: colors.text,
    fontSize: 17,
  },
  askGo: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.action,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: { marginTop: 28, alignItems: 'center', gap: 12 },
  footerNote: { color: colors.textSecondary, ...type.caption },
  markRead: { color: colors.action, fontSize: 17, fontWeight: '600', paddingVertical: 6 },
  errorBox: { marginTop: 16, alignItems: 'flex-start', gap: 10, marginHorizontal: 2 },
  errorText: { color: colors.red, fontSize: 15, marginTop: 6 },
  retry: { backgroundColor: colors.action, paddingHorizontal: 16, height: 36, borderRadius: 18, justifyContent: 'center' },
  retryText: { color: 'white', fontSize: 15, fontWeight: '600' },
});
