import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { api, type Explanation, type Lore, type MemberAsk, type Message, type User } from '@/api';
import { Avatar } from '@/components/Avatar';
import { BoldText } from '@/components/BoldText';
import { Icon } from '@/components/Icon';
import { LoreThumb } from '@/components/lore/MomentRow';
import { firstName } from '@/lib/format';
import { loreSubtitle } from '@/lib/lore';
import { useAsks } from '@/state/asks';
import { threadJump } from '@/state/bus';
import { useMe, useSession } from '@/state/session';
import { colors, type } from '@/theme';

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

      {phase === 'loading' ? (
        <Section>
          <Skeleton lines={3} />
        </Section>
      ) : null}

      {phase === 'error' ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error ?? 'Something went wrong.'}</Text>
          <Pressable
            onPress={() => {
              setPhase('loading');
              setError(null);
              setAttempt((n) => n + 1);
            }}
            style={({ pressed }) => [styles.action, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.actionText}>Try Again</Text>
          </Pressable>
        </View>
      ) : null}

      {result && phase === 'done' ? <Result result={result} groupId={groupId} onJump={jump} onCatchup={openCatchup} /> : null}

      <View style={styles.footer}>
        <Text style={styles.footerNote}>
          <Icon name="lock.fill" size={10} color={colors.textSecondary} /> Only you can see this. Nothing is posted to the chat.
        </Text>
      </View>
    </ScrollView>
  );
}

/** An inset-grouped section: a footnote-caps header over a white card. */
function Section({ title, children, padded }: { title?: string; children: ReactNode; padded?: boolean }) {
  return (
    <View style={styles.section}>
      {title ? <Text style={styles.sectionTitle}>{title}</Text> : null}
      <View style={[styles.card, padded && styles.cardPadded]}>{children}</View>
    </View>
  );
}

/** Rows inside one card, split by inset hairlines. */
function Rows({ children, inset = 16 }: { children: ReactNode[]; inset?: number }) {
  return children.map((child, i) => (
    <Fragment key={i}>
      {i ? <View style={[styles.sep, { marginLeft: inset }]} /> : null}
      {child}
    </Fragment>
  ));
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
      <Section padded>
        <View style={{ gap: 12 }}>
          {result.status === 'general' ? <Text style={styles.label}>Not defined in this chat; generally it means…</Text> : null}
          <BoldText text={result.meaning} style={styles.meaning} />
          {result.status === 'plain' ? (
            <Pressable onPress={onCatchup} style={({ pressed }) => [styles.action, pressed && { opacity: 0.7 }]}>
              <Icon name="sparkles" size={14} color="white" weight="semibold" />
              <Text style={styles.actionText}>Catch Me Up Instead</Text>
            </Pressable>
          ) : null}
        </View>
      </Section>

      {result.person ? (
        <Section>
          <PersonCard user={result.person} />
        </Section>
      ) : null}

      {result.lore?.length ? (
        <Section title="Lore">
          <Rows inset={76}>
            {result.lore.map((l) => (
              <LoreRow key={l.id} lore={l} />
            ))}
          </Rows>
        </Section>
      ) : null}

      {result.human_sources.length || lateAnswer ? (
        <Section title="From members">
          <Rows>
            {[
              ...result.human_sources.map((h) => (
                <HumanCard key={h.ask_id} user={h.user} answer={h.answer} at={h.answered_at} />
              )),
              ...(lateAnswer
                ? [
                    <HumanCard
                      key="late"
                      user={lateAnswer.asked_user}
                      answer={lateAnswer.answer ?? ''}
                      at={lateAnswer.answered_at ?? lateAnswer.created_at}
                    />,
                  ]
                : []),
            ]}
          </Rows>
        </Section>
      ) : null}

      {result.sources.length ? (
        <Section title="Where this came from">
          <Rows inset={54}>
            {result.sources.slice(0, 3).map((m) => (
              <SourceRow key={m.id} message={m} sender={userById(m.sender_id)} meId={me.id} onPress={() => onJump(m.id)} />
            ))}
          </Rows>
        </Section>
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

/** The kept moment behind a term: opens it full screen in place of this sheet. */
function LoreRow({ lore }: { lore: Lore }) {
  const router = useRouter();
  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        router.replace({ pathname: '/lore/[id]', params: { id: String(lore.id) } });
      }}
      accessibilityRole="button"
      accessibilityLabel={lore.title}
      style={({ pressed }) => [styles.lore, pressed && styles.pressed]}
    >
      <LoreThumb lore={lore} size={48} radius={10} />
      <View style={{ flex: 1 }}>
        <Text style={styles.loreTitle} numberOfLines={2}>
          {lore.title}
        </Text>
        <Text style={styles.loreSub} numberOfLines={1}>
          {loreSubtitle(lore, { weekday: false, people: false })}
        </Text>
      </View>
      <Icon name="chevron.right" size={13} color={colors.textTertiary} weight="semibold" />
    </Pressable>
  );
}

function SourceRow({ message, sender, meId, onPress }: { message: Message; sender?: User; meId: string; onPress: () => void }) {
  const name = message.sender_id === meId ? 'You' : sender ? firstName(sender.display_name) : 'Someone';
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.source, pressed && styles.pressed]}>
      <Avatar uri={sender?.avatar_url} name={sender?.display_name} size={28} />
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
        <Avatar uri={user.avatar_url} name={user.display_name} size={22} />
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
      <Avatar uri={user.avatar_url} name={user.display_name} size={44} />
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
    <Section title="Ask a member" padded>
      <View style={{ gap: 10 }}>
        <View style={styles.humanHead}>
          <Avatar uri={who.avatar_url} name={who.display_name} size={22} />
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
    </Section>
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
        <View key={i} style={[styles.card, styles.cardPadded, { marginBottom: 12 }]}>
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
    <View style={{ gap: 10, padding: 16 }}>
      {Array.from({ length: lines }).map((_, i) => (
        <Animated.View key={i} style={[styles.skel, { opacity: pulse, width: i === lines - 1 ? '62%' : '92%' }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.grouped },
  content: { paddingTop: 26, paddingHorizontal: 16, paddingBottom: 72 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14, paddingHorizontal: 2 },
  headerIcon: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, ...type.title2 },
  subtitle: { color: colors.textSecondary, ...type.footnote, marginTop: 2 },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.blue, paddingLeft: 12, paddingVertical: 2, marginHorizontal: 2, marginBottom: 4 },
  quoteText: { color: colors.textSecondary, fontSize: 15, fontStyle: 'italic', lineHeight: 21 },
  photoQuote: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 2, marginBottom: 4 },
  photoThumb: { width: 72, height: 72, borderRadius: 12, borderCurve: 'continuous', backgroundColor: colors.surfaceAlt },
  section: { marginTop: 22 },
  sectionTitle: { color: colors.textSecondary, ...type.footnote, textTransform: 'uppercase', marginHorizontal: 16, marginBottom: 7 },
  card: { backgroundColor: colors.surface, borderRadius: 22, borderCurve: 'continuous', overflow: 'hidden' },
  cardPadded: { padding: 16 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator },
  pressed: { backgroundColor: 'rgba(0,0,0,0.05)' },
  label: { color: colors.blue, ...type.footnote, fontWeight: '600' },
  meaning: { color: colors.text, fontSize: 17, lineHeight: 24 },
  lore: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 16 },
  loreTitle: { color: colors.text, ...type.headline, lineHeight: 22 },
  loreSub: { color: colors.textSecondary, ...type.subheadline, marginTop: 1 },
  source: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 11, paddingHorizontal: 16 },
  sourceMeta: { color: colors.textSecondary, ...type.footnote, marginBottom: 2 },
  sourceText: { color: colors.text, fontSize: 15, lineHeight: 20 },
  sourcePhoto: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  sourceThumb: { width: 40, height: 40, borderRadius: 8, borderCurve: 'continuous', backgroundColor: colors.surfaceAlt },
  human: { padding: 16 },
  humanHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  humanName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  humanDate: { color: colors.textSecondary, ...type.footnote },
  humanText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  person: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 16 },
  personName: { color: colors.text, ...type.headline },
  personSub: { color: colors.textSecondary, ...type.footnote, marginTop: 2 },
  askText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  action: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.action,
    paddingHorizontal: 16,
    height: 36,
    borderRadius: 18,
  },
  actionText: { color: 'white', fontSize: 15, fontWeight: '600' },
  answerQ: { color: colors.textSecondary, ...type.footnote, marginBottom: 6 },
  answerText: { color: colors.text, fontSize: 15, lineHeight: 21 },
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
  skel: { height: 12, borderRadius: 6, backgroundColor: colors.surfaceAlt },
  footer: { marginTop: 28, alignItems: 'center' },
  footerNote: { color: colors.textSecondary, ...type.caption },
  errorBox: { marginTop: 16, alignItems: 'flex-start', gap: 10, marginHorizontal: 2 },
  errorText: { color: colors.red, fontSize: 15, marginTop: 6 },
});
