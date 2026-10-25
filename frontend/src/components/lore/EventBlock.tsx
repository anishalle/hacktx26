import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Lore, LoreEvent, LoreSnippet, Message } from '@/api';
import { Icon } from '@/components/Icon';
import { MessageRow, type RunPos } from '@/components/thread/rows';
import { usePlaybackControls, type PlaybackItem } from '@/state/playback';
import { useMe, useSession } from '@/state/session';
import { colors } from '@/theme';

import { ReplayPlayer } from './ReplayPlayer';

type Props = {
  lore: Lore;
  event: LoreEvent;
  /** False for the hero event: the page already shows its photo, quote or audio at the top. */
  showAnchor: boolean;
  onOpenPhoto: (m: Message) => void;
  queue?: PlaybackItem[];
};

/** "9:41 PM" */
export function clockLabel(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const h = d.getHours() % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() >= 12 ? 'PM' : 'AM'}`;
}

/** A snippet as a real message, so it renders with the thread's own bubbles. Spoken lines have no id. */
export function snippetMessage(s: LoreSnippet, groupId: number): Message {
  return {
    id: s.message_id ?? 0,
    group_id: groupId,
    sender_id: s.user?.id ?? null,
    kind: 'text',
    text: s.text,
    ts: s.ts,
    reply_to: null,
    reactions: s.reactions,
  };
}

/** iMessage run positions for a list of senders. */
function runs(senders: (string | null)[]): RunPos[] {
  return senders.map((s, i) => {
    const prev = i > 0 && senders[i - 1] === s;
    const next = i < senders.length - 1 && senders[i + 1] === s;
    return prev && next ? 'middle' : prev ? 'last' : next ? 'first' : 'single';
  });
}

/**
 * One event on the moment page's timeline: its time, the photo / quote / call replay, the real
 * messages and spoken lines around it as read-only bubbles, and a way back into the chat.
 */
export function EventBlock({ lore, event, showAnchor, onOpenPhoto, queue }: Props) {
  const me = useMe();
  const router = useRouter();
  const { userById } = useSession();
  const { replay: current, play, seek } = usePlaybackControls();
  const replay = event.replay;

  type Row = { message: Message; mine: boolean; spoken: LoreSnippet | null };
  const rows: Row[] = [];
  if (showAnchor && event.message && event.kind !== 'replay') {
    rows.push({ message: event.message, mine: event.message.sender_id === me.id, spoken: null });
  }
  for (const s of event.snippets) {
    rows.push({ message: snippetMessage(s, lore.group_id), mine: s.is_me, spoken: s.start_ms != null && replay ? s : null });
  }
  const positions = runs(rows.map((r) => r.message.sender_id));

  const jumpTo = event.message?.id ?? event.snippets.find((s) => s.message_id)?.message_id ?? null;
  const showInChat = () => {
    if (!jumpTo) return;
    Haptics.selectionAsync();
    router.push({ pathname: '/thread/[id]', params: { id: String(lore.group_id), around: String(jumpTo), name: lore.group_name } });
  };

  const seekTo = (s: LoreSnippet) => {
    if (!replay || s.start_ms == null) return;
    Haptics.selectionAsync();
    const at = s.start_ms;
    if (current?.id === replay.id) seek(at);
    else {
      play(lore, replay, queue);
      // The clip loads on the next tick; seek once it's the current one.
      setTimeout(() => seek(at), 250);
    }
  };

  const kindIcon = event.kind === 'replay' ? 'waveform' : event.kind === 'photo' ? 'photo' : 'quote.bubble';

  return (
    <View style={styles.block}>
      <View style={styles.when}>
        <Icon name={kindIcon} size={12} color={colors.textSecondary} />
        <Text style={styles.time}>
          {clockLabel(event.at)}
          {event.kind === 'replay' ? ' · from the call' : ''}
        </Text>
      </View>

      {event.kind === 'replay' && replay ? (
        <View style={styles.media}>
          <ReplayPlayer lore={lore} replay={replay} variant="full" queue={queue} />
        </View>
      ) : null}

      {rows.length ? (
        <View style={styles.rows}>
          {rows.map((r, i) => {
            const sender = r.message.sender_id ? userById(r.message.sender_id) : undefined;
            const pos = positions[i];
            const row = (
              <MessageRow
                message={r.message}
                mine={r.mine}
                sender={sender}
                showName={!r.mine && (pos === 'single' || pos === 'first')}
                showAvatar={!r.mine && (pos === 'single' || pos === 'last')}
                run={pos}
                readOnly
                meId={me.id}
                background={colors.bg}
                userById={userById}
                onOpenPhoto={onOpenPhoto}
              />
            );
            const key = `${r.message.id}:${i}`;
            return r.spoken ? (
              <Pressable
                key={key}
                onPress={() => seekTo(r.spoken!)}
                accessibilityRole="button"
                accessibilityLabel={`Play from “${r.message.text}”`}
              >
                {row}
              </Pressable>
            ) : (
              <View key={key}>{row}</View>
            );
          })}
        </View>
      ) : null}

      {jumpTo ? (
        <Pressable onPress={showInChat} hitSlop={6} style={styles.link} accessibilityRole="link">
          <Text style={styles.linkText}>Show in Chat</Text>
          <Icon name="chevron.forward" size={11} color={colors.blue} weight="semibold" />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 8 },
  when: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16 },
  time: { color: colors.textSecondary, fontSize: 13 },
  media: { paddingHorizontal: 16, marginTop: 4 },
  rows: { paddingHorizontal: 6 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingHorizontal: 16, paddingVertical: 6 },
  linkText: { color: colors.blue, fontSize: 15 },
});
