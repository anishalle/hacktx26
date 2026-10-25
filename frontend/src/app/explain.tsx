import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, type Explanation, type MemberAsk, type Message, type User } from '@/api';
import { Avatar } from '@/components/Avatar';
import { BoldText } from '@/components/BoldText';
import { CloudBackdrop } from '@/components/CloudBackdrop';
import { GlassCircle } from '@/components/GlassCircle';
import { Icon } from '@/components/Icon';
import { explanationKey, readExplanation, saveExplanation } from '@/features/explanationCache';
import { firstName } from '@/lib/format';
import { useAsks } from '@/state/asks';
import { threadJump } from '@/state/bus';
import { useMe, useSession } from '@/state/session';
import { colors } from '@/theme';

type Params = { groupId: string; messageId?: string; text?: string; term?: string; image?: string };
const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export default function ExplainSheet() {
  const params = useLocalSearchParams<Params>();
  const me = useMe();
  return <ExplanationConversation key={JSON.stringify([me.id, params.groupId, params.messageId, params.term])} params={params} />;
}

function ExplanationConversation({ params }: { params: Params }) {
  const router = useRouter();
  const me = useMe();
  const asks = useAsks();
  const groupId = Number(params.groupId);
  const messageId = params.messageId ? Number(params.messageId) : undefined;
  const key = explanationKey(me.id, groupId, messageId, params.term);
  const [result, setResult] = useState<Explanation | null>(() => readExplanation(key));
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState(false);
  const [turns, setTurns] = useState<{ question: string; answer: string }[]>([]);
  const pending = useRef<AbortController | null>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const cached = readExplanation(key);
    if (!cached) {
      api.explain({ group_id: groupId, user_id: me.id, ...(messageId !== undefined ? { message_id: messageId } : { term: params.term }) }, ctrl.signal)
        .then(answer => {
          if (ctrl.signal.aborted) return;
          saveExplanation(key, answer);
          setResult(answer);
          if (answer.ask?.existing) asks.upsert(answer.ask.existing);
        }).catch(e => { if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : 'Could not load this explanation.'); });
    }
    return () => { ctrl.abort(); pending.current?.abort(); };
    // Context updates do not re-request a completed explanation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, groupId, messageId, params.term, me.id, attempt]);

  const submit = async () => {
    const text = question.trim();
    if (!text || busy || !result) return;
    setBusy(true);
    setError(null);
    const ctrl = new AbortController();
    pending.current = ctrl;
    try {
      const answer = await api.explain({
        group_id: groupId, user_id: me.id, explanation_id: result.explanation_id, follow_up: text,
        ...(messageId !== undefined ? { message_id: messageId } : result.term ? { term: result.term } : {}),
      }, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setTurns(previous => [...previous, { question: text, answer: answer.meaning }]);
      setQuestion('');
    } catch (e) { if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : 'Could not send. Try again.'); }
    finally { if (!ctrl.signal.aborted) setBusy(false); }
  };

  return <View style={page.screen}>
    <CloudBackdrop />
    <SafeAreaView style={page.screen}>
      <KeyboardAvoidingView style={page.screen} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={page.header}>
          <GlassCircle onPress={() => router.back()} accessibilityLabel="Back to conversation"><Icon name="chevron.left" size={19} /></GlassCircle>
          <Text style={page.headerText}>A little context</Text>
          <View style={{ width: 44 }} />
        </View>
        <ScrollView ref={scroll} contentContainerStyle={page.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}
          onContentSizeChange={() => { if (turns.length) scroll.current?.scrollToEnd({ animated: true }); }}>
          <View style={page.quote}>
            {params.image && <Image source={{ uri: params.image }} style={page.photo} contentFit="cover" />}
            <Text style={page.quoteText}>{params.text || params.term || 'This conversation'}</Text>
          </View>
          {!result && !error && <ActivityIndicator color={colors.blue} style={{ marginVertical: 26 }} />}
          {result && <View style={page.response}><BoldText text={result.meaning} style={page.answerText} /></View>}
          {turns.map((turn, index) => <View key={index} style={page.turn}>
            <View style={page.question}><Text style={page.questionText}>{turn.question}</Text></View>
            <View style={page.response}><BoldText text={turn.answer} style={page.answerText} /></View>
          </View>)}
          {busy && <ActivityIndicator color={colors.blue} style={{ alignSelf: 'flex-start', margin: 20 }} />}
          {error && <View accessibilityRole="alert" style={page.error}>
            <Text style={page.errorText}>{error}</Text>
            {!result && <Pressable accessibilityRole="button" onPress={() => { setError(null); setAttempt(value => value + 1); }}><Text style={page.contextLink}>Try again</Text></Pressable>}
          </View>}
          {result && <Pressable accessibilityRole="button" accessibilityState={{ expanded: details }} onPress={() => setDetails(value => !value)} style={page.contextButton}><Text style={page.contextLink}>{details ? 'Hide context' : 'More context'}</Text></Pressable>}
          {result && details && <Result result={result} groupId={groupId} onJump={id => { threadJump.emit({ groupId, messageId: id }); router.back(); }} onCatchup={() => router.replace({ pathname: '/catchup', params: { groupId: String(groupId) } })} />}
        </ScrollView>
        <View style={page.composerWrap}>
          <View style={page.composer}>
            <TextInput accessibilityLabel="Ask about this message" placeholder="Ask about this…" placeholderTextColor="#8b7c8d" value={question} onChangeText={setQuestion} editable={!busy} onSubmitEditing={submit} returnKeyType="send" style={page.input} maxLength={2000} />
            <Pressable accessibilityRole="button" accessibilityLabel="Send question" disabled={!question.trim() || busy || !result} onPress={submit} style={[page.send, (!question.trim() || busy || !result) && { opacity: 0.4 }]}><Icon name="arrow.up" color="#fff" size={19} /></Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </View>;
}
const page = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 18, paddingBottom: 8 },
  headerText: { color: '#6f6178', fontSize: 13 },
  content: { padding: 24, paddingTop: 35, paddingBottom: 50, width: '100%', maxWidth: 620, alignSelf: 'center' },
  quote: { alignSelf: 'flex-end', maxWidth: '92%', backgroundColor: '#ffffff77', borderWidth: 1, borderColor: '#ffffffbb', borderRadius: 25, borderBottomRightRadius: 8, padding: 18, marginBottom: 28 },
  quoteText: { color: '#5f506b', fontSize: 15, lineHeight: 23 },
  photo: { width: 180, height: 130, borderRadius: 15, marginBottom: 12 },
  response: { alignSelf: 'flex-start', maxWidth: '96%', backgroundColor: '#fffafcdd', paddingHorizontal: 19, paddingVertical: 17, borderRadius: 26, borderBottomLeftRadius: 8, marginBottom: 18 },
  answerText: { color: '#42374c', fontSize: 17, lineHeight: 26 },
  turn: { marginTop: 6 },
  question: { alignSelf: 'flex-end', maxWidth: '90%', borderRadius: 24, borderBottomRightRadius: 8, backgroundColor: '#efd9e9', padding: 16, marginBottom: 18 },
  questionText: { color: '#554357', fontSize: 15, lineHeight: 23 },
  contextButton: { alignSelf: 'flex-start', paddingVertical: 12, paddingHorizontal: 4 },
  contextLink: { color: '#7d6b85', fontSize: 12 },
  error: { paddingVertical: 14, gap: 12 },
  errorText: { color: '#964758', fontSize: 14, lineHeight: 21 },
  composerWrap: { padding: 18, paddingTop: 10, width: '100%', maxWidth: 620, alignSelf: 'center' },
  composer: { flexDirection: 'row', alignItems: 'center', padding: 6, borderRadius: 30, borderWidth: 1, borderColor: '#fff', backgroundColor: '#ffffffcc', shadowColor: '#8e7695', shadowOpacity: 0.1, shadowRadius: 18, shadowOffset: { width: 0, height: 4 } },
  input: { flex: 1, minWidth: 0, minHeight: 44, paddingHorizontal: 15, fontSize: 15, color: colors.text },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#a782a3', alignItems: 'center', justifyContent: 'center' },
});

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
  const lateAnswer =
    live?.status === 'answered' && !result.human_sources.some((h) => h.ask_id === live.id) ? live : undefined;

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
          {lateAnswer ? <HumanCard user={lateAnswer.asked_user} answer={lateAnswer.answer ?? ''} at={lateAnswer.answered_at ?? lateAnswer.created_at} /> : null}
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

      {(result.status === 'unknown' || result.status === 'general') && result.ask && !result.human_sources.length && !lateAnswer ? (
        <AskCard result={result} groupId={groupId} ask={live ?? result.ask.existing ?? undefined} />
      ) : null}

    </View>
  );
}

function SourceRow({ message, sender, meId, onPress }: { message: Message; sender?: User; meId: string; onPress: () => void }) {
  const name = message.sender_id === meId ? 'You' : sender ? firstName(sender.display_name) : 'Someone';
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.source, pressed && { backgroundColor: 'rgba(255,255,255,0.06)' }]}>
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
          <Pressable onPress={send} disabled={busy} style={({ pressed }) => [styles.action, (pressed || busy) && { opacity: 0.7 }]}>
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


const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.sheetBg },
  content: { paddingTop: 26, paddingHorizontal: 18, paddingBottom: 72 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  headerIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontSize: 20, fontWeight: '700' },
  subtitle: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.sparkle, paddingLeft: 12, paddingVertical: 2, marginBottom: 6 },
  quoteText: { color: colors.textSecondary, fontSize: 15, fontStyle: 'italic', lineHeight: 21 },
  photoQuote: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 6 },
  photoThumb: { width: 72, height: 72, borderRadius: 12, backgroundColor: colors.surface },
  sourcePhoto: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  sourceThumb: { width: 40, height: 40, borderRadius: 8, backgroundColor: colors.surface },
  meaningCard: { marginTop: 10, gap: 10 },
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
    backgroundColor: 'rgba(124, 92, 255, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(160, 130, 255, 0.3)',
    gap: 10,
  },
  askText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  action: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.blue,
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
  askGo: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.blue, alignItems: 'center', justifyContent: 'center' },
  skel: { height: 12, borderRadius: 6, backgroundColor: '#3A3D44' },
  footer: { marginTop: 28, alignItems: 'center' },
  footerNote: { color: colors.textTertiary, fontSize: 12 },
  errorBox: { marginTop: 16, alignItems: 'flex-start', gap: 10 },
  errorText: { color: '#FF6B6B', fontSize: 14, marginTop: 6 },
  retry: { backgroundColor: colors.surface, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  retryText: { color: colors.text, fontWeight: '600' },
});
