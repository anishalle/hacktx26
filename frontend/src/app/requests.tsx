import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { Fragment, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { api, type MemberAsk } from '@/api';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { firstName } from '@/lib/format';
import { useAsks } from '@/state/asks';
import { useMe } from '@/state/session';
import { colors, type } from '@/theme';

/** Feature 1, the other side: newcomers privately asked this member what a term means. */
export default function RequestsSheet() {
  const { incoming } = useAsks();
  const pending = incoming.filter((a) => a.status === 'pending');
  const done = incoming.filter((a) => a.status !== 'pending');

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
          <Icon name="questionmark.bubble.fill" size={17} color="white" />
        </LinearGradient>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Requests</Text>
          <Text style={styles.subtitle}>{pending.length ? `${pending.length} waiting on you` : 'Nobody is waiting on you'}</Text>
        </View>
      </View>

      {pending.length ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Waiting on you</Text>
          <View style={{ gap: 12 }}>
            {pending.map((a) => (
              <PendingAsk key={a.id} ask={a} />
            ))}
          </View>
        </View>
      ) : null}
      {!pending.length && !done.length ? (
        <View style={[styles.section, styles.card, styles.cardPadded]}>
          <Text style={styles.empty}>When a newcomer can’t find what something means, their private question shows up here.</Text>
        </View>
      ) : null}

      {done.length ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Earlier</Text>
          <View style={styles.card}>
            {done.map((a, i) => (
              <Fragment key={a.id}>
                {i ? <View style={styles.sep} /> : null}
                <View style={styles.doneRow}>
                  <Avatar uri={a.for_user.avatar_url} name={a.for_user.display_name} size={28} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.doneTitle}>
                      {firstName(a.for_user.display_name)} · “{a.term}”
                    </Text>
                    <Text style={styles.doneSub} numberOfLines={2}>
                      {a.status === 'answered' ? (a.posted_message_id ? `Explained in chat: ${a.answer}` : a.answer) : 'You passed'}
                    </Text>
                  </View>
                </View>
              </Fragment>
            ))}
          </View>
        </View>
      ) : null}

      <View style={styles.footer}>
        <Text style={styles.footerNote}>
          <Icon name="lock.fill" size={10} color={colors.textSecondary} /> Only the two of you see a request and its answer.
        </Text>
      </View>
    </ScrollView>
  );
}

function PendingAsk({ ask }: { ask: MemberAsk }) {
  const me = useMe();
  const asks = useAsks();
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState<'private' | 'chat' | 'decline' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const name = firstName(ask.for_user.display_name);

  const respond = async (mode: 'private' | 'chat' | 'decline') => {
    if (busy) return;
    const text = answer.trim();
    if (mode !== 'decline' && !text) return;
    setBusy(mode);
    setErr(null);
    try {
      const updated = await api.answerAsk(ask.id, {
        user_id: me.id,
        ...(mode === 'decline' ? { decline: true } : { answer: text, post_in_chat: mode === 'chat' }),
      });
      asks.upsert(updated);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const canSend = !!answer.trim() && !busy;
  // The button that is sending keeps full strength behind its spinner; the others fade.
  const dim = (pressed: boolean, mode: 'private' | 'chat') =>
    busy === mode || pressed ? { opacity: 0.7 } : !canSend ? { opacity: 0.4 } : null;
  return (
    <View style={[styles.card, styles.cardPadded, { gap: 12 }]}>
      <View style={styles.cardHead}>
        <Avatar uri={ask.for_user.avatar_url} name={ask.for_user.display_name} size={28} />
        <Text style={styles.cardName}>{name}</Text>
        <Text style={styles.cardGroup} numberOfLines={1}>
          · {ask.group_name}
        </Text>
      </View>
      <Text style={styles.prompt}>
        {name} held on “<Text style={styles.bold}>{ask.term}</Text>” and I couldn’t find where it’s explained. Want to add a
        one-line explanation? Only they will see it.
      </Text>
      {ask.message ? (
        <View style={styles.quote}>
          <Text style={styles.quoteText} numberOfLines={3}>
            “{ask.message.text}”
          </Text>
        </View>
      ) : null}
      <TextInput
        value={answer}
        onChangeText={setAnswer}
        placeholder={`What does “${ask.term}” mean?`}
        placeholderTextColor={colors.textSecondary}
        style={styles.input}
        multiline
        keyboardAppearance="light"
        editable={!busy}
      />
      <View style={styles.actions}>
        <Pressable
          onPress={() => respond('private')}
          disabled={!canSend}
          style={({ pressed }) => [styles.primary, dim(pressed, 'private')]}
        >
          {busy === 'private' ? (
            <ActivityIndicator size="small" color="white" />
          ) : (
            <Icon name="lock.fill" size={12} color="white" />
          )}
          <Text style={styles.primaryText}>Send Privately</Text>
        </Pressable>
        <Pressable
          onPress={() => respond('chat')}
          disabled={!canSend}
          style={({ pressed }) => [styles.secondary, dim(pressed, 'chat')]}
        >
          {busy === 'chat' ? <ActivityIndicator size="small" color={colors.action} /> : null}
          <Text style={styles.secondaryText}>Explain in Chat</Text>
        </Pressable>
        <Pressable onPress={() => respond('decline')} disabled={!!busy} hitSlop={8}>
          <Text style={styles.decline}>Not Now</Text>
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
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginLeft: 54 },
  empty: { color: colors.textSecondary, fontSize: 15, lineHeight: 21 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  cardGroup: { flex: 1, color: colors.textSecondary, ...type.footnote },
  prompt: { color: colors.text, fontSize: 15, lineHeight: 21 },
  bold: { fontWeight: '700' },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.blue, paddingLeft: 10 },
  quoteText: { color: colors.textSecondary, fontSize: 15, fontStyle: 'italic', lineHeight: 20 },
  input: {
    minHeight: 44,
    maxHeight: 120,
    borderRadius: 12,
    borderCurve: 'continuous',
    backgroundColor: colors.grouped,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    color: colors.text,
    fontSize: 17,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.action,
    paddingHorizontal: 16,
    height: 36,
    borderRadius: 18,
  },
  primaryText: { color: 'white', fontSize: 15, fontWeight: '600' },
  secondary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(120,120,128,0.16)',
    paddingHorizontal: 16,
    height: 36,
    borderRadius: 18,
  },
  secondaryText: { color: colors.action, fontSize: 15, fontWeight: '600' },
  decline: { color: colors.textSecondary, fontSize: 15, fontWeight: '600', marginLeft: 4 },
  doneRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 11, paddingHorizontal: 16 },
  doneTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  doneSub: { color: colors.textSecondary, fontSize: 15, marginTop: 2 },
  footer: { marginTop: 28, alignItems: 'center' },
  footerNote: { color: colors.textSecondary, ...type.caption },
  errorText: { color: colors.red, fontSize: 15 },
});
