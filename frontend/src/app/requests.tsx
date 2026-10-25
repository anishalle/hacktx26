import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { api, type MemberAsk } from '@/api';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { firstName } from '@/lib/format';
import { useAsks } from '@/state/asks';
import { useMe } from '@/state/session';
import { colors } from '@/theme';

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

      {pending.map((a) => (
        <PendingAsk key={a.id} ask={a} />
      ))}
      {!pending.length && !done.length ? (
        <Text style={styles.empty}>When a newcomer can’t find what something means, their private question shows up here.</Text>
      ) : null}

      {done.length ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Earlier</Text>
          {done.map((a) => (
            <View key={a.id} style={styles.doneRow}>
              <Avatar uri={a.for_user.avatar_url} size={28} />
              <View style={{ flex: 1 }}>
                <Text style={styles.doneTitle}>
                  {firstName(a.for_user.display_name)} · “{a.term}”
                </Text>
                <Text style={styles.doneSub} numberOfLines={2}>
                  {a.status === 'answered' ? (a.posted_message_id ? `Explained in chat: ${a.answer}` : a.answer) : 'You passed'}
                </Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.footer}>
        <Text style={styles.footerNote}>
          <Icon name="lock.fill" size={10} color={colors.textTertiary} /> Only the two of you see a request and its answer.
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
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Avatar uri={ask.for_user.avatar_url} size={28} />
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
        <Pressable onPress={() => respond('private')} disabled={!canSend} style={[styles.primary, !canSend && { opacity: 0.4 }]}>
          {busy === 'private' ? (
            <ActivityIndicator size="small" color="white" />
          ) : (
            <Icon name="lock.fill" size={12} color="white" />
          )}
          <Text style={styles.primaryText}>Send privately</Text>
        </Pressable>
        <Pressable onPress={() => respond('chat')} disabled={!canSend} style={[styles.secondary, !canSend && { opacity: 0.4 }]}>
          {busy === 'chat' ? <ActivityIndicator size="small" color={colors.text} /> : null}
          <Text style={styles.secondaryText}>Explain in chat</Text>
        </Pressable>
        <Pressable onPress={() => respond('decline')} disabled={!!busy} hitSlop={8}>
          <Text style={styles.decline}>Not now</Text>
        </Pressable>
      </View>
      {err ? <Text style={styles.errorText}>{err}</Text> : null}
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
  empty: { color: colors.textSecondary, fontSize: 15, lineHeight: 21, marginTop: 12 },
  card: { backgroundColor: colors.surface, borderRadius: 16, padding: 14, marginTop: 10, gap: 10 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  cardGroup: { flex: 1, color: colors.textTertiary, fontSize: 13 },
  prompt: { color: colors.text, fontSize: 15, lineHeight: 21 },
  bold: { fontWeight: '700' },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.sparkle, paddingLeft: 10 },
  quoteText: { color: colors.textSecondary, fontSize: 14, fontStyle: 'italic', lineHeight: 19 },
  input: {
    minHeight: 44,
    maxHeight: 120,
    borderRadius: 14,
    backgroundColor: colors.sheetBg,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    color: colors.text,
    fontSize: 15,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.action,
    paddingHorizontal: 14,
    height: 34,
    borderRadius: 17,
  },
  primaryText: { color: 'white', fontSize: 14, fontWeight: '600' },
  secondary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.separator,
    paddingHorizontal: 14,
    height: 34,
    borderRadius: 17,
  },
  secondaryText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  decline: { color: colors.textSecondary, fontSize: 14, fontWeight: '600', marginLeft: 4 },
  section: { marginTop: 24 },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 6,
  },
  doneRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 8 },
  doneTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  doneSub: { color: colors.textSecondary, fontSize: 14, marginTop: 2 },
  footer: { marginTop: 28, alignItems: 'center' },
  footerNote: { color: colors.textTertiary, fontSize: 12 },
  errorText: { color: '#FF6B6B', fontSize: 14 },
});
