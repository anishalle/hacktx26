import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { api, type Explanation, type MemberAsk, type Message, type User } from '@/api';
import { Avatar } from '@/components/Avatar';
import { BoldText } from '@/components/BoldText';
import { Icon } from '@/components/Icon';
import { firstName } from '@/lib/format';
import { useAsks } from '@/state/asks';
import { threadJump } from '@/state/bus';
import { useMe, useSession } from '@/state/session';
import { colors } from '@/theme';

type Phase = 'loading' | 'done' | 'error';

const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** Feature 1: a private explanation of one message (or a bare term from catch-up). Never posts anything. */
export default function ExplainSheet() {
  const params = useLocalSearchParams<{ groupId: string; messageId?: string; text?: string; term?: string; image?: string }>();
  const groupId = Number(params.groupId);
  const messageId = params.messageId ? Number(params.messageId) : undefined;
  const router = useRouter();
  const me = useMe();
  const asks = useAsks();

  const [result, setResult] = useState<Explanation | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await api.explain(
          { group_id: groupId, user_id: me.id, ...(messageId !== undefined ? { message_id: messageId } : { term: params.term }) },
          ctrl.signal,
        );
        if (ctrl.signal.aborted) return;
        setResult(res);
        setPhase('done');
        if (res.ask?.existing) asks.upsert(res.ask.existing);
        Haptics.selectionAsync();
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase('error');
      }
    })();
    return () => ctrl.abort();
    // `asks` changes on every frame; only (re)load when the target or attempt changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, messageId, params.term, me.id, attempt]);

  const jump = (id: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    threadJump.emit({ groupId, messageId: id });
    router.back();
  };

  const openCatchup = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.replace({ pathname: '/catchup', params: { groupId: String(groupId) } });
  };

  const quote = params.text ?? params.term;
  const subtitle =
    phase === 'loading'
      ? 'Figuring out what this means…'
      : result?.status === 'explained'
        ? 'From this group’s history'
        : result?.status === 'general'
          ? 'Not defined in this chat'
          : result?.status === 'plain'
            ? 'Nothing unusual here'
            : phase === 'error'
              ? 'Something went wrong'
              : 'Not explained in this chat yet';

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
          <Icon name="questionmark" size={18} color="white" weight="bold" />
        </LinearGradient>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>What this means</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
        </View>
        {phase === 'loading' ? <ActivityIndicator color={colors.textSecondary} /> : null}
      </View>

      {params.image ? (
        <View style={styles.photoQuote}>
          <Image source={{ uri: params.image }} style={styles.photoThumb} contentFit="cover" />
          {params.text && params.text !== 'Photo' ? (
            <Text style={[styles.quoteText, { flex: 1 }]} numberOfLines={4}>
              “{params.text}”
            </Text>
          ) : null}
        </View>
      ) : quote ? (
        <View style={styles.quote}>
          <Text style={styles.quoteText} numberOfLines={4}>
            {params.term && !params.text ? quote : `“${quote}”`}
          </Text>
        </View>
      ) : null}

      {phase === 'loading' ? <Skeleton lines={3} /> : null}

      {phase === 'error' ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error ?? 'Something went wrong.'}</Text>
          <Pressable
            onPress={() => {
              setPhase('loading');
              setError(null);
              setAttempt((n) => n + 1);
            }}
            style={styles.retry}
          >
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {result && phase === 'done' ? <Result result={result} groupId={groupId} onJump={jump} onCatchup={openCatchup} /> : null}

      <View style={styles.footer}>
        <Text style={styles.footerNote}>
          <Icon name="lock.fill" size={10} color={colors.textTertiary} /> Only you can see this. Nothing is posted to the chat.
        </Text>
      </View>
    </ScrollView>
  );
}

function Result({
  result,
  groupId,
  onJump,
  onCatchup,
}: {
  result: Explanation;
  groupId: number;
  onJump: (id: number) => void;
  onCatchup: () => void;
}) {
  const me = useMe();
  const { userById } = useSession();
  const asks = useAsks();
  const live = result.term ? asks.findOutgoing(groupId, result.term) : undefined;
  // A live answer that arrived after this explanation was built.
  const lateAnswer = live?.status === 'answered' && !result.human_sources.some((h) => h.ask_id === live.id) ? live : undefined;

  return (
    <View>
      <View style={styles.meaningCard}>
        {result.status === 'general' ? <Text style={styles.label}>Not defined in this chat; generally it means…</Text> : null}
        <BoldText text={result.meaning} style={styles.meaning} />
        {result.status === 'plain' ? (
          <Pressable onPress={onCatchup} style={({ pressed }) => [styles.action, pressed && { opacity: 0.7 }]}>
            <Icon name="sparkles" size={14} color="white" weight="semibold" />
            <Text style={styles.actionText}>Catch me up instead</Text>
          </Pressable>
        ) : null}
      </View>

      {result.person ? <PersonCard user={result.person} /> : null}

      {result.human_sources.length || lateAnswer ? (
        <View style={styles.section}>
          {result.human_sources.map((h) => (
            <HumanCard key={h.ask_id} user={h.user} answer={h.answer} at={h.answered_at} />
          ))}
          {lateAnswer ? (
            <HumanCard
              user={lateAnswer.asked_user}
              answer={lateAnswer.answer ?? ''}
              at={lateAnswer.answered_at ?? lateAnswer.created_at}
            />
          ) : null}
        </View>
      ) : null}

      {result.sources.length ? (
        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Icon name="text.bubble" size={15} color={colors.textSecondary} />
            <Text style={styles.sectionTitle}>Where this came from</Text>
          </View>
          {result.sources.slice(0, 3).map((m) => (
            <SourceRow key={m.id} message={m} sender={userById(m.sender_id)} meId={me.id} onPress={() => onJump(m.id)} />
          ))}
        </View>
      ) : null}

      {(result.status === 'unknown' || result.status === 'general') &&
      result.ask &&
      !result.human_sources.length &&
      !lateAnswer ? (
        <AskCard result={result} groupId={groupId} ask={live ?? result.ask.existing ?? undefined} />
      ) : null}

      {result.status !== 'plain' ? <FollowUp result={result} groupId={groupId} /> : null}
    </View>
  );
}

function SourceRow({ message, sender, meId, onPress }: { message: Message; sender?: User; meId: string; onPress: () => void }) {
  const name = message.sender_id === meId ? 'You' : sender ? firstName(sender.display_name) : 'Someone';
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.source, pressed && { backgroundColor: 'rgba(255,255,255,0.06)' }]}
    >
      <Avatar uri={sender?.avatar_url} size={28} />
      <View style={{ flex: 1 }}>
        <Text style={styles.sourceMeta}>
          {name} · {shortDate(message.ts)}
        </Text>
        {message.image ? (
          <View style={styles.sourcePhoto}>
            <Image source={{ uri: message.image.url }} style={styles.sourceThumb} contentFit="cover" />
            <Text style={[styles.sourceText, { flex: 1 }]} numberOfLines={3}>
              {message.text || 'Photo'}
            </Text>
          </View>
        ) : (
          <Text style={styles.sourceText} numberOfLines={3}>
            {message.text}
          </Text>
        )}
      </View>
      <Icon name="arrow.up.forward" size={12} color={colors.textTertiary} style={{ marginTop: 4 }} />
    </Pressable>
  );
}

function HumanCard({ user, answer, at }: { user: User; answer: string; at: string }) {
  return (
    <View style={styles.human}>
      <View style={styles.humanHead}>
        <Avatar uri={user.avatar_url} size={22} />
        <Text style={styles.humanName}>From {firstName(user.display_name)}</Text>
        <Text style={styles.humanDate}>· {shortDate(at)}</Text>
      </View>
      <Text style={styles.humanText}>{answer}</Text>
    </View>
  );
}

function PersonCard({ user }: { user: User }) {
  return (
    <View style={styles.person}>
      <Avatar uri={user.avatar_url} size={44} />
      <View style={{ flex: 1 }}>
        <Text style={styles.personName}>{user.display_name}</Text>
        <Text style={styles.personSub}>
          @{user.username}
          {user.phonetic_hint ? ` · says it “${user.phonetic_hint}”` : ''}
        </Text>
      </View>
    </View>
  );
}

function AskCard({ result, groupId, ask }: { result: Explanation; groupId: number; ask?: MemberAsk }) {
  const me = useMe();
  const asks = useAsks();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const who = ask?.asked_user ?? result.ask!.user;
  const name = firstName(who.display_name);

  const send = async () => {
    if (busy || !result.term) return;
    setBusy(true);
    setErr(null);
    try {
      const created = await api.askMember({
        group_id: groupId,
        user_id: me.id,
        term: result.term,
        ...(result.message_id !== null ? { message_id: result.message_id } : {}),
      });
      asks.upsert(created);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.askCard}>
      <View style={styles.humanHead}>
        <Avatar uri={who.avatar_url} size={22} />
        <Text style={styles.humanName}>{name}</Text>
      </View>
      {!ask ? (
        <>
          <Text style={styles.askText}>Want me to ask {name} what this means, without making it a thing?</Text>
          <Pressable
            onPress={send}
            disabled={busy}
            style={({ pressed }) => [styles.action, (pressed || busy) && { opacity: 0.7 }]}
          >
            {busy ? <ActivityIndicator size="small" color="white" /> : <Icon name="paperplane.fill" size={13} color="white" />}
            <Text style={styles.actionText}>Ask {name}</Text>
          </Pressable>
          {err ? <Text style={styles.errorText}>{err}</Text> : null}
        </>
      ) : ask.status === 'pending' ? (
        <Text style={styles.askText}>Asked {name} privately. Their answer will show up here.</Text>
      ) : (
        <Text style={styles.askText}>{name} passed on this one.</Text>
      )}
    </View>
  );
}

function FollowUp({ result, groupId }: { result: Explanation; groupId: number }) {
  const me = useMe();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Explanation[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    const question = q.trim();
    if (!question || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.explain({
        group_id: groupId,
        user_id: me.id,
        explanation_id: result.explanation_id,
        follow_up: question,
        ...(result.message_id !== null ? { message_id: result.message_id } : result.term ? { term: result.term } : {}),
      });
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
    <View style={styles.section}>
      {answers.map((a, i) => (
        <View key={i} style={styles.answer}>
          <Text style={styles.answerQ}>{a.follow_up}</Text>
          <BoldText text={a.meaning} style={styles.answerText} />
        </View>
      ))}
      <View style={styles.askRow}>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Ask something else about this…"
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
    <View style={{ gap: 10, paddingVertical: 14 }}>
      {Array.from({ length: lines }).map((_, i) => (
        <Animated.View key={i} style={[styles.skel, { opacity: pulse, width: i === lines - 1 ? '62%' : '92%' }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.sheetBg },
  content: { paddingTop: 26, paddingHorizontal: 18, paddingBottom: 72 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  headerIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontSize: 20, fontWeight: '700' },
  subtitle: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.sparkle, paddingLeft: 12, paddingVertical: 2, marginBottom: 6 },
  quoteText: { color: colors.textSecondary, fontSize: 15, fontStyle: 'italic', lineHeight: 21 },
  photoQuote: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 6 },
  photoThumb: { width: 72, height: 72, borderRadius: 12, backgroundColor: colors.surface },
  sourcePhoto: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  sourceThumb: { width: 40, height: 40, borderRadius: 8, backgroundColor: colors.surface },
  meaningCard: {
    marginTop: 10,
    gap: 12,
    padding: 18,
    borderRadius: 22,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.separator,
  },
  label: { color: colors.sparkle, fontSize: 13, fontWeight: '600' },
  meaning: { color: colors.text, fontSize: 17, lineHeight: 24 },
  section: { marginTop: 18 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  sectionTitle: { color: colors.textSecondary, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  source: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 8, paddingHorizontal: 4, borderRadius: 10 },
  sourceMeta: { color: colors.textSecondary, fontSize: 12, marginBottom: 2 },
  sourceText: { color: colors.text, fontSize: 15, lineHeight: 20 },
  human: { backgroundColor: colors.surface, borderRadius: 16, padding: 14, marginBottom: 8 },
  humanHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  humanName: { color: colors.text, fontSize: 14, fontWeight: '600' },
  humanDate: { color: colors.textTertiary, fontSize: 13 },
  humanText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  person: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 16,
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 12,
  },
  personName: { color: colors.text, fontSize: 16, fontWeight: '600' },
  personSub: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  askCard: {
    marginTop: 18,
    borderRadius: 16,
    padding: 14,
    backgroundColor: 'rgba(0,122,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(0,122,255,0.16)',
    gap: 10,
  },
  askText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  action: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.action,
    paddingHorizontal: 14,
    height: 34,
    borderRadius: 17,
  },
  actionText: { color: 'white', fontSize: 14, fontWeight: '600' },
  answer: { backgroundColor: colors.surface, borderRadius: 16, padding: 14, marginBottom: 12 },
  answerQ: { color: colors.textSecondary, fontSize: 13, marginBottom: 6 },
  answerText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  askRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  askInput: {
    flex: 1,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surface,
    paddingHorizontal: 16,
    color: colors.text,
    fontSize: 15,
  },
  askGo: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.action,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skel: { height: 12, borderRadius: 6, backgroundColor: colors.separator },
  footer: { marginTop: 28, alignItems: 'center' },
  footerNote: { color: colors.textTertiary, fontSize: 12 },
  errorBox: { marginTop: 16, alignItems: 'flex-start', gap: 10 },
  errorText: { color: '#FF6B6B', fontSize: 14, marginTop: 6 },
  retry: { backgroundColor: colors.surface, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  retryText: { color: colors.text, fontWeight: '600' },
});
