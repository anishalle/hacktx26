import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, FlatList, KeyboardAvoidingView, Modal, Platform,
  Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import {
  api, DemoUser, Explanation, Member, MemberAsk, Message,
} from '../lib/api';

const USERS: { id: DemoUser; name: string }[] = [
  { id: 'priya', name: 'Priya' },
  { id: 'swayam', name: 'Swayam' },
  { id: 'alex', name: 'Alex' },
];
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Please try again.';
const date = (value: string) =>
  new Date(value).toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

function BoldText({ children }: { children: string }) {
  return (
    <Text style={s.meaning}>
      {children.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
        part.startsWith('**')
          ? <Text key={index} style={s.bold}>{part.slice(2, -2)}</Text>
          : part)}
    </Text>
  );
}

function Action({
  label, onPress, secondary = false, disabled = false,
}: {
  label: string; onPress: () => void; secondary?: boolean; disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button" accessibilityLabel={label}
      disabled={disabled} onPress={onPress}
      style={[s.action, secondary && s.secondary, disabled && s.disabled]}
    >
      <Text style={[s.actionText, secondary && s.secondaryText]}>{label}</Text>
    </Pressable>
  );
}

export default function ChatScreen() {
  const [user, setUser] = useState<DemoUser>('priya');
  return <ChatSession key={user} user={user} onUserChange={setUser} />;
}

function ChatSession({ user, onUserChange }: {
  user: DemoUser; onUserChange: (user: DemoUser) => void;
}) {
  const activeUser = useRef<DemoUser | null>(user);
  const [messages, setMessages] = useState<Message[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [asks, setAsks] = useState<MemberAsk[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [chatError, setChatError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [selected, setSelected] = useState<Message | null>(null);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [explainLoading, setExplainLoading] = useState(false);
  const [explainError, setExplainError] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [inbox, setInbox] = useState(false);
  const [profiles, setProfiles] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [replyBusy, setReplyBusy] = useState<string | null>(null);
  const [privateError, setPrivateError] = useState('');
  const [highlight, setHighlight] = useState<string | null>(null);
  const [historyView, setHistoryView] = useState(false);
  const list = useRef<FlatList<Message>>(null);
  const explainController = useRef<AbortController | null>(null);
  const navigationVersion = useRef(0);

  const closeSheet = useCallback(() => {
    explainController.current?.abort();
    setSelected(null);
    setExplanation(null);
    setExplainLoading(false);
    setExplainError('');
  }, []);

  const loadLatest = useCallback(async () => {
    const owner = user;
    const version = ++navigationVersion.current;
    setLoading(true);
    try {
      const page = await api.messages(owner);
      if (activeUser.current !== owner || navigationVersion.current !== version) return;
      setMessages(page.messages);
      setHasMore(page.has_more);
      setHistoryView(false);
      setHighlight(null);
      setChatError('');
      setTimeout(() => list.current?.scrollToEnd({ animated: false }), 100);
    } catch (error) {
      if (activeUser.current === owner) setChatError(errorText(error));
    } finally {
      if (activeUser.current === owner) setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    activeUser.current = user;
    const controller = new AbortController();
    api.messages(user, '', controller.signal).then(page => {
      if (controller.signal.aborted) return;
      setMessages(page.messages);
      setHasMore(page.has_more);
      setTimeout(() => list.current?.scrollToEnd({ animated: false }), 100);
    }).catch(error => {
      if (!controller.signal.aborted) setChatError(errorText(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    api.members(user, controller.signal).then(rows => {
      if (!controller.signal.aborted) setMembers(rows);
    }).catch(() => {});
    return () => {
      controller.abort();
      explainController.current?.abort();
      activeUser.current = null;
    };
  }, [user]);

  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    const poll = async () => {
      if (running) return;
      running = true;
      try {
        const rows = await api.asks(user, controller.signal);
        if (!controller.signal.aborted) {
          setAsks(rows);
          setPrivateError('');
        }
      } catch (error) {
        if (!controller.signal.aborted) setPrivateError(errorText(error));
      } finally {
        running = false;
      }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 4000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [user]);

  useEffect(() => {
    if (historyView || loading) return;
    const controller = new AbortController();
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        const page = await api.messages(user, '', controller.signal);
        if (!controller.signal.aborted) {
          setMessages(previous => {
            const combined = new Map(previous.map(row => [row.id, row]));
            page.messages.forEach(row => combined.set(row.id, row));
            return [...combined.values()].sort(
              (a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id),
            );
          });
        }
      } catch {
        // An explicit refresh reports connection errors without interrupting reading.
      } finally {
        running = false;
      }
    }, 4000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [user, historyView, loading]);

  async function loadOlder() {
    if (!messages.length || loadingOlder) return;
    const owner = user;
    const version = navigationVersion.current;
    setLoadingOlder(true);
    try {
      const page = await api.messages(user, '?before=' + encodeURIComponent(messages[0].id));
      if (activeUser.current !== owner || version !== navigationVersion.current) return;
      setMessages(previous => {
        const combined = new Map([...page.messages, ...previous].map(row => [row.id, row]));
        return [...combined.values()];
      });
      setHasMore(page.has_more);
    } catch (error) {
      if (activeUser.current === owner) setChatError(errorText(error));
    } finally {
      setLoadingOlder(false);
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    const owner = user;
    setSending(true);
    try {
      await api.send(user, text);
      if (activeUser.current !== owner) return;
      setDraft('');
      await loadLatest();
    } catch (error) {
      if (activeUser.current === owner) setChatError(errorText(error));
    } finally {
      if (activeUser.current === owner) setSending(false);
    }
  }

  async function explain(message: Message, follow?: string) {
    explainController.current?.abort();
    const controller = new AbortController();
    explainController.current = controller;
    const previousId = follow ? explanation?.id : undefined;
    if (!follow) {
      setExplanation(null);
      setFollowUp('');
      setQuestion('What does “' + message.text.slice(0, 900) + '” mean?');
    }
    setSelected(message);
    setExplainLoading(true);
    setExplainError('');
    try {
      const result = await api.explain(user, message.id, follow, previousId, controller.signal);
      if (!controller.signal.aborted) {
        setExplanation(result);
        setFollowUp('');
      }
    } catch (error) {
      if (!controller.signal.aborted) setExplainError(errorText(error));
    } finally {
      if (!controller.signal.aborted) setExplainLoading(false);
    }
  }

  async function jump(message: Message) {
    closeSheet();
    const owner = user;
    const version = ++navigationVersion.current;
    setHistoryView(true);
    setLoading(true);
    try {
      const page = await api.messages(user, '?around=' + encodeURIComponent(message.id));
      if (activeUser.current !== owner || navigationVersion.current !== version) return;
      setMessages(page.messages);
      setHasMore(false);
      setHighlight(message.id);
      setChatError('');
      const index = page.messages.findIndex(row => row.id === message.id);
      setTimeout(() => list.current?.scrollToIndex({
        index: Math.max(0, index), animated: true, viewPosition: 0.4,
      }), 200);
    } catch (error) {
      if (activeUser.current === owner) setChatError(errorText(error));
    } finally {
      if (activeUser.current === owner) setLoading(false);
    }
  }

  async function askSender() {
    if (!selected || !question.trim() || asking) return;
    const owner = user;
    setAsking(true);
    setExplainError('');
    try {
      const result = await api.ask(user, selected.id, question.trim());
      if (activeUser.current !== owner) return;
      setAsks(previous => [result, ...previous.filter(row => row.id !== result.id)]);
    } catch (error) {
      if (activeUser.current === owner) setExplainError(errorText(error));
    } finally {
      if (activeUser.current === owner) setAsking(false);
    }
  }

  async function reply(ask: MemberAsk, decline = false) {
    const owner = user;
    setReplyBusy(ask.id);
    try {
      const result = await api.answer(user, ask.id, answers[ask.id], decline);
      if (activeUser.current !== owner) return;
      setAsks(previous => previous.map(row => row.id === result.id ? result : row));
      setPrivateError('');
    } catch (error) {
      if (activeUser.current === owner) setPrivateError(errorText(error));
    } finally {
      if (activeUser.current === owner) setReplyBusy(null);
    }
  }

  const selectedAsk = asks.find(row =>
    row.message_id === selected?.id && row.requester_id === user);
  const pendingCount = asks.filter(row =>
    row.recipient_id === user && row.status === 'pending').length;
  const receivedCount = asks.filter(row =>
    row.requester_id === user && row.status === 'answered').length;

  return (
    <SafeAreaView style={s.screen}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={s.header}>
          <View style={s.headerLine}>
            <View>
              <Text style={s.eyebrow}>A LITTLE CONTEXT GOES A LONG WAY</Text>
              <Text style={s.title}>The Longhorns <Text style={s.flower}>✳</Text></Text>
            </View>
            <Pressable accessibilityRole="button" onPress={() => setProfiles(true)}>
              <Text style={s.memberPill}>{members.length || 3} members</Text>
            </Pressable>
          </View>
          <Text style={s.subtitle}>Hold any message, or tap ? to get the inside story.</Text>
          <View style={s.userRow}>
            <Text style={s.small}>Demo as</Text>
            {USERS.map(item => (
              <Pressable
                key={item.id} accessibilityRole="button"
                accessibilityState={{ selected: user === item.id }}
                onPress={() => {
                  if (item.id !== user) {
                    activeUser.current = null;
                    onUserChange(item.id);
                  }
                }}
                style={[s.userChip, user === item.id && s.activeChip]}
              >
                <Text style={user === item.id ? s.activeChipText : s.small}>{item.name}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable accessibilityRole="button" onPress={() => setInbox(true)} style={s.inboxButton}>
            <Text style={s.inboxText}>Private explanations</Text>
            <Text style={s.small}>
              {pendingCount ? `${pendingCount} to answer` :
                receivedCount ? `${receivedCount} answered` : 'Only you & the sender'} →
            </Text>
          </Pressable>
        </View>

        {chatError ? <View style={s.notice}>
          <Text accessibilityRole="alert" style={s.error}>{chatError}</Text>
          <Action label="Refresh chat" onPress={() => { void loadLatest(); }} secondary />
        </View> : null}
        {historyView && <View style={s.historyBanner}>
          <Text style={s.small}>Viewing the original conversation</Text>
          <Action label="Back to latest" onPress={() => { void loadLatest(); }} secondary />
        </View>}
        {loading ? <View style={s.center}><ActivityIndicator color="#35614b" /></View> :
          <FlatList
            ref={list} data={messages} keyExtractor={item => item.id}
            contentContainerStyle={s.messageList}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={hasMore ? <Action
              label={loadingOlder ? 'Loading…' : 'Load earlier messages'}
              disabled={loadingOlder} secondary onPress={() => { void loadOlder(); }}
            /> : undefined}
            ListEmptyComponent={<Text style={s.empty}>No messages yet. Say hello.</Text>}
            onScrollToIndexFailed={({ index, averageItemLength }) => {
              list.current?.scrollToOffset({ offset: averageItemLength * index, animated: true });
              setTimeout(() => list.current?.scrollToIndex({
                index, animated: true, viewPosition: 0.4,
              }), 300);
            }}
            renderItem={({ item }) => (
              <View style={[s.messageRow, item.sender_id === user && s.ownRow]}>
                <View style={s.avatar}><Text style={s.avatarText}>{item.sender_name[0]}</Text></View>
                <View style={s.bubbleColumn}>
                  <Text style={s.metadata}>{item.sender_name} · {date(item.ts)}</Text>
                  <Pressable
                    onLongPress={() => { void explain(item); }} delayLongPress={450}
                    accessibilityLabel={`${item.sender_name}: ${item.text}. Hold to explain.`}
                    style={[s.bubble, item.sender_id === user && s.ownBubble,
                      highlight === item.id && s.highlight]}
                  >
                    <Text style={s.messageText}>{item.text}</Text>
                  </Pressable>
                </View>
                <Pressable
                  onPress={() => { void explain(item); }} hitSlop={10}
                  accessibilityRole="button" accessibilityLabel={'Explain: ' + item.text}
                  style={s.questionButton}
                ><Text style={s.questionMark}>?</Text></Pressable>
              </View>
            )}
          />}
        <View style={s.composer}>
          <TextInput
            style={s.composerInput} value={draft} onChangeText={setDraft}
            placeholder="Message the group…" accessibilityLabel="Message the group"
            multiline maxLength={8000} editable={!sending}
          />
          <Action label={sending ? 'Sending…' : 'Send'} disabled={!draft.trim() || sending}
            onPress={() => { void send(); }} />
        </View>
      </KeyboardAvoidingView>

      <Modal visible={!!selected} transparent animationType="slide" onRequestClose={closeSheet}>
        <View style={s.overlay}>
          <Pressable style={s.backdrop} onPress={closeSheet} accessibilityLabel="Dismiss explanation" />
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.sheet}>
            <SafeAreaView edges={['bottom']} style={s.sheetInner}>
              <View style={s.grabber} />
              <View style={s.sheetHeader}>
                <Text style={s.sheetTitle}>A little context</Text>
                <Action label="Close" onPress={closeSheet} secondary />
              </View>
              <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.sheetContent}>
                <Text style={s.privacy}>Private to you. Nothing is posted to the group.</Text>
                <Text style={s.quote}>“{selected?.text}”</Text>
                {explainLoading && <View style={s.loadingRow}>
                  <ActivityIndicator color="#35614b" />
                  <Text style={s.small}>Figuring out what this means…</Text>
                </View>}
                {explainError ? <View style={s.gap}>
                  <Text accessibilityRole="alert" style={s.error}>{explainError}</Text>
                  <Action label="Try again" secondary onPress={() => {
                    if (selected) void explain(selected);
                  }} />
                </View> : null}
                {explanation && !explainLoading && <>
                  <BoldText>{explanation.meaning}</BoldText>
                  {explanation.sources.length > 0 && <Text style={s.sectionLabel}>WHERE THIS CAME FROM</Text>}
                  {explanation.sources.map(source => (
                    <Pressable key={source.id} style={s.source} onPress={() => { void jump(source); }}
                      accessibilityRole="button" accessibilityLabel={'Jump to message: ' + source.text}>
                      <Text style={s.metadata}>{source.sender_name} · {date(source.ts)}</Text>
                      <Text style={s.sourceText}>{source.text}</Text>
                      <Text style={s.link}>View in chat ↗</Text>
                    </Pressable>
                  ))}
                  {explanation.human_sources.map(source => (
                    <View key={source.id} style={s.source}>
                      <Text style={s.metadata}>Private answer from {source.recipient_name} · {date(source.answered_at)}</Text>
                      <Text style={s.sourceText}>{source.answer}</Text>
                    </View>
                  ))}
                  {explanation.kind === 'person' && members.filter(member =>
                    (selected?.text + ' ' + explanation.meaning).toLowerCase().includes(member.name.toLowerCase())
                  ).map(member => (
                    <View key={member.id} style={s.source}>
                      <Text style={s.bold}>{member.name}</Text>
                      <Text style={s.small}>Group member · joined {date(member.joined_at)}</Text>
                    </View>
                  ))}
                </>}
                {selectedAsk ? !explanation?.human_sources.some(source => source.id === selectedAsk.id) && <View style={s.privateCard}>
                  <Text style={s.bold}>
                    {selectedAsk.status === 'pending' ? 'Sent privately to ' + selectedAsk.recipient_name :
                      selectedAsk.status === 'declined' ? selectedAsk.recipient_name + ' passed on this request' :
                        selectedAsk.recipient_name + ' explained'}
                  </Text>
                  <Text style={s.sourceText}>{selectedAsk.answer ||
                    (selectedAsk.status === 'pending' ? 'Their answer will appear here and in your private inbox.' :
                      'They chose not to add an explanation.')}</Text>
                </View> : (explanation?.can_ask_sender || (!!explainError && selected?.sender_id !== user)) &&
                  <View style={s.privateCard}>
                    <Text style={s.bold}>Ask {selected?.sender_name} privately?</Text>
                    <Text style={s.small}>They can explain or pass. Only the two of you see the request and reply.</Text>
                    <TextInput style={s.input} value={question} onChangeText={setQuestion}
                      accessibilityLabel="Private question for the sender" multiline maxLength={1000} />
                    <Action label={asking ? 'Asking…' : 'Ask ' + selected?.sender_name}
                      disabled={asking || !question.trim()} onPress={() => { void askSender(); }} />
                  </View>}
                {explanation && <View style={s.gap}>
                  <Text style={s.sectionLabel}>ASK SOMETHING ELSE ABOUT THIS</Text>
                  <TextInput
                    style={s.input} placeholder="What else would you like to know?"
                    accessibilityLabel="Follow-up question" value={followUp}
                    onChangeText={setFollowUp} maxLength={1000} multiline
                  />
                  <Action label="Ask follow-up" disabled={!followUp.trim() || explainLoading}
                    onPress={() => { if (selected) void explain(selected, followUp.trim()); }} />
                </View>}
              </ScrollView>
            </SafeAreaView>
          </KeyboardAvoidingView>
        </View>
      </Modal>

      <Modal visible={inbox} transparent animationType="slide" onRequestClose={() => setInbox(false)}>
        <View style={s.overlay}>
          <Pressable style={s.backdrop} onPress={() => setInbox(false)} accessibilityLabel="Dismiss private inbox" />
          <SafeAreaView edges={['bottom']} style={s.sheet}>
            <View style={s.sheetHeader}>
              <Text style={s.sheetTitle}>Private explanations</Text>
              <Action label="Close" secondary onPress={() => setInbox(false)} />
            </View>
            <ScrollView contentContainerStyle={s.sheetContent} keyboardShouldPersistTaps="handled">
              <Text style={s.privacy}>Requests and replies are only visible to the two participants.</Text>
              {privateError ? <Text accessibilityRole="alert" style={s.error}>{privateError}</Text> : null}
              {!asks.length && <Text style={s.empty}>Your private requests will appear here.</Text>}
              {asks.map(ask => (
                <View key={ask.id} style={s.privateCard}>
                  <Text style={s.bold}>{ask.recipient_id === user
                    ? ask.requester_name + ' asked you' : 'You asked ' + ask.recipient_name}</Text>
                  <Text style={s.quote}>“{ask.message_text}”</Text>
                  <Text style={s.sourceText}>{ask.question}</Text>
                  {ask.status === 'answered' ? <View style={s.source}>
                    <Text style={s.metadata}>{ask.recipient_name} replied</Text>
                    <Text style={s.meaning}>{ask.answer}</Text>
                  </View> : ask.status === 'declined'
                    ? <Text style={s.small}>Passed on this request.</Text>
                    : ask.recipient_id !== user
                      ? <Text style={s.small}>Waiting for their answer.</Text>
                      : <>
                        <TextInput
                          style={s.input} multiline maxLength={2000}
                          placeholder="Add a short explanation…"
                          accessibilityLabel={'Reply to ' + ask.requester_name}
                          value={answers[ask.id] || ''}
                          onChangeText={text => setAnswers(previous => ({ ...previous, [ask.id]: text }))}
                        />
                        <Action label="Send private answer" disabled={!!replyBusy || !answers[ask.id]?.trim()}
                          onPress={() => { void reply(ask); }} />
                        <Action label="Pass" secondary disabled={!!replyBusy}
                          onPress={() => { void reply(ask, true); }} />
                      </>}
                </View>
              ))}
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>

      <Modal visible={profiles} transparent animationType="fade" onRequestClose={() => setProfiles(false)}>
        <View style={s.overlay}>
          <Pressable style={s.backdrop} onPress={() => setProfiles(false)} accessibilityLabel="Dismiss members" />
          <SafeAreaView edges={['bottom']} style={s.sheet}>
            <View style={s.sheetHeader}>
              <Text style={s.sheetTitle}>The group</Text>
              <Action label="Close" secondary onPress={() => setProfiles(false)} />
            </View>
            <View style={s.sheetContent}>
              {members.map(member => (
                <View key={member.id} style={s.source}>
                  <Text style={s.bold}>{member.name}{member.id === user ? ' (you)' : ''}</Text>
                  <Text style={s.small}>Joined {date(member.joined_at)}</Text>
                </View>
              ))}
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f6f5ef' },
  flex: { flex: 1 },
  header: { paddingHorizontal: 22, paddingTop: 18, paddingBottom: 12, backgroundColor: '#fffef9', borderBottomWidth: 1, borderColor: '#e4e7dc', gap: 12 },
  headerLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  eyebrow: { fontSize: 9, fontWeight: '700', color: '#70836e', letterSpacing: 1.1 },
  title: { fontSize: 28, fontWeight: '700', color: '#203e30', marginTop: 5 },
  flower: { color: '#ce7a50' },
  memberPill: { fontSize: 11, color: '#506652', backgroundColor: '#edf0e6', borderRadius: 12, padding: 8 },
  subtitle: { color: '#687366', fontSize: 13, lineHeight: 19 },
  small: { fontSize: 12, color: '#637060', lineHeight: 18 },
  userRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  userChip: { borderRadius: 20, backgroundColor: '#f1f2ea', paddingVertical: 7, paddingHorizontal: 13 },
  activeChip: { backgroundColor: '#35614b' },
  activeChipText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  inboxButton: { borderRadius: 10, padding: 12, backgroundColor: '#f1f2ea', flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 5 },
  inboxText: { color: '#35614b', fontSize: 12, fontWeight: '700' },
  messageList: { padding: 18, gap: 18, paddingBottom: 24 },
  messageRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginBottom: 17 },
  ownRow: { paddingLeft: 20 },
  avatar: { width: 30, height: 30, borderRadius: 11, backgroundColor: '#e0e8d9', alignItems: 'center', justifyContent: 'center', marginBottom: 3 },
  avatarText: { fontWeight: '700', fontSize: 13, color: '#456349' },
  bubbleColumn: { flex: 1, gap: 5 },
  metadata: { fontSize: 10, lineHeight: 16, color: '#788170' },
  bubble: { backgroundColor: '#fffef9', borderRadius: 16, borderBottomLeftRadius: 4, borderWidth: 1, borderColor: '#e4e7dc', padding: 14 },
  ownBubble: { backgroundColor: '#e3eddd' },
  highlight: { borderColor: '#b8773f', borderWidth: 2, backgroundColor: '#fff0cf' },
  messageText: { color: '#293a2e', fontSize: 15, lineHeight: 22 },
  questionButton: { width: 30, height: 36, alignItems: 'center', justifyContent: 'center' },
  questionMark: { fontSize: 15, color: '#537356', fontWeight: '700', backgroundColor: '#e5eadd', width: 23, height: 23, textAlign: 'center', borderRadius: 12, lineHeight: 23 },
  composer: { flexDirection: 'row', padding: 14, gap: 9, borderTopWidth: 1, borderColor: '#e4e7dc', backgroundColor: '#fffef9', alignItems: 'center' },
  composerInput: { flex: 1, padding: 12, borderRadius: 16, backgroundColor: '#f1f2ea', color: '#293a2e', maxHeight: 110, fontSize: 14 },
  action: { backgroundColor: '#35614b', paddingVertical: 11, paddingHorizontal: 16, borderRadius: 12, alignItems: 'center' },
  actionText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  secondary: { backgroundColor: '#edf0e6' },
  secondaryText: { color: '#35614b' },
  disabled: { opacity: 0.45 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { textAlign: 'center', color: '#788170', fontSize: 14, padding: 24 },
  notice: { padding: 14, gap: 9, backgroundColor: '#fff0e6' },
  error: { color: '#9c3c2c', fontSize: 13, lineHeight: 20 },
  historyBanner: { padding: 10, gap: 7, backgroundColor: '#f8eacb' },
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#17281e77' },
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  sheet: { maxHeight: '88%', minHeight: '35%', backgroundColor: '#fffef9', borderTopLeftRadius: 26, borderTopRightRadius: 26, overflow: 'hidden' },
  sheetInner: { flexShrink: 1 },
  grabber: { width: 35, height: 4, borderRadius: 4, backgroundColor: '#d7ddce', alignSelf: 'center', marginTop: 10 },
  sheetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, gap: 10 },
  sheetTitle: { fontSize: 21, fontWeight: '700', color: '#203e30' },
  sheetContent: { paddingHorizontal: 22, paddingBottom: 30, gap: 16 },
  privacy: { fontSize: 11, lineHeight: 17, color: '#73816e' },
  quote: { color: '#5a6956', fontSize: 14, lineHeight: 22, backgroundColor: '#f1f2ea', padding: 13, borderRadius: 10 },
  loadingRow: { flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 15 },
  meaning: { fontSize: 16, lineHeight: 25, color: '#283e2e' },
  bold: { fontWeight: '700', color: '#283e2e' },
  sectionLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1.3, color: '#7b866e', marginTop: 7 },
  source: { borderWidth: 1, borderColor: '#e1e7d8', borderRadius: 12, padding: 13, gap: 6 },
  sourceText: { color: '#41553f', fontSize: 13, lineHeight: 21 },
  link: { color: '#35614b', fontSize: 11, fontWeight: '700', marginTop: 3 },
  input: { borderWidth: 1, borderColor: '#dce3d3', borderRadius: 12, padding: 13, fontSize: 14, color: '#293a2e', minHeight: 48, backgroundColor: '#fffef9' },
  privateCard: { backgroundColor: '#edf2e7', padding: 16, borderRadius: 16, gap: 12 },
  gap: { gap: 12 },
});
