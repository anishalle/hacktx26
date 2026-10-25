import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, USE_MOCKS, type CallJoin } from '@/api';
import { Avatar } from '@/components/Avatar';
import { CallExplainCard, type CardState } from '@/components/call/CallExplainCard';
import { Icon } from '@/components/Icon';
import { useCall, type Participant } from '@/hooks/useCall';
import { ChimeVideo, isChimeAvailable } from '@/lib/callEngine';
import { firstName } from '@/lib/format';
import { useMe, useSession } from '@/state/session';
import { colors } from '@/theme';

/** Feature 4: a group call (Amazon Chime) with a private, always-visible ? that explains what was just said. */
export default function CallScreen() {
  const { groupId: gid, name } = useLocalSearchParams<{ groupId: string; name?: string }>();
  const groupId = Number(gid);
  const router = useRouter();
  const me = useMe();
  const supported = USE_MOCKS || isChimeAvailable;
  const [join, setJoin] = useState<CallJoin | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    api
      .joinCall(groupId, me.id)
      .then((j) => (cancelled ? api.leaveCall(j.call.id, me.id).catch(() => {}) : setJoin(j)))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [groupId, me.id, supported]);

  if (!supported) {
    return (
      <Notice
        title="Calls need the iOS dev build"
        body={'Expo Go can’t load the Chime calling module.\nRun `npx expo run:ios` in frontend/, or start with EXPO_PUBLIC_USE_MOCKS=1 for a scripted call.'}
        onClose={() => router.back()}
      />
    );
  }
  if (error) return <Notice title="Couldn’t start the call" body={error} onClose={() => router.back()} />;
  if (!join) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color={colors.textSecondary} />
        <Text style={styles.dim}>Starting the call…</Text>
      </View>
    );
  }
  return <CallRoom join={join} groupName={name ?? ''} onLeft={() => router.back()} />;
}

function CallRoom({ join, groupName, onLeft }: { join: CallJoin; groupName: string; onLeft: () => void }) {
  const insets = useSafeAreaInsets();
  const me = useMe();
  const { userById } = useSession();
  const call = useCall(join, me.id);
  const [card, setCard] = useState<CardState | null>(null);
  const left = useRef(false);

  // Leaving is explicit, but unmounting any other way still takes this member out of the call.
  const leave = useCallback(async () => {
    if (left.current) return;
    left.current = true;
    await api.leaveCall(join.call.id, me.id).catch(() => {});
  }, [join.call.id, me.id]);
  useEffect(() => () => void leave(), [leave]);

  const explain = useCallback(
    async (atMs: number) => {
      setCard({ phase: 'loading', atMs });
      try {
        const result = await api.explainCall(join.call.id, { user_id: me.id, at_ms: atMs, pending_results: call.pendingResults() });
        setCard((c) => (c?.atMs === atMs ? { phase: 'done', atMs, result } : c));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (e) {
        setCard((c) => (c?.atMs === atMs ? { phase: 'error', atMs, message: e instanceof Error ? e.message : String(e) } : c));
      }
    },
    [join.call.id, me.id, call],
  );

  const elapsed = useElapsed(call.state === 'connected' ? join.call.started_at : null);
  const status =
    call.state === 'connected' ? elapsed : call.state === 'reconnecting' ? 'Reconnecting…' : call.state === 'ended' ? 'Call ended' : 'Connecting…';
  const speaker = call.caption?.userId ? userById(call.caption.userId) : undefined;

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.screen}>
      <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.groupName} numberOfLines={1}>
          {groupName || 'Group call'}
        </Text>
        <View style={styles.statusRow}>
          <Text style={styles.dim}>{status}</Text>
          {call.transcribing ? (
            <View style={styles.liveChip}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>Live captions</Text>
            </View>
          ) : null}
        </View>
      </View>

      <Tiles participants={call.participants} />

      {call.error ? <Text style={styles.callError}>{call.error}</Text> : null}

      <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
        {card ? (
          <CallExplainCard card={card} groupId={join.call.group_id} meId={me.id} onRetry={explain} onDismiss={() => setCard(null)} />
        ) : call.caption ? (
          <Text style={[styles.caption, call.caption.partial && styles.captionPartial]} numberOfLines={2}>
            <Text style={styles.captionName}>{speaker ? firstName(speaker.display_name) : 'Someone'}: </Text>
            {call.caption.text}
          </Text>
        ) : null}

        <View style={styles.controlsRow}>
          <View style={styles.controls}>
            <Control icon={call.muted ? 'mic.slash.fill' : 'mic.fill'} active={call.muted} label={call.muted ? 'Unmute' : 'Mute'} onPress={call.toggleMute} />
            <Control icon={call.videoOff ? 'video.slash.fill' : 'video.fill'} active={call.videoOff} label={call.videoOff ? 'Turn camera on' : 'Turn camera off'} onPress={call.toggleVideo} />
            <Pressable
              onPress={async () => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                await leave();
                onLeft();
              }}
              style={[styles.control, styles.leave]}
              accessibilityLabel="Leave call">
              <Icon name="phone.down.fill" size={24} color="white" />
            </Pressable>
          </View>
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              void explain(Date.now());
            }}
            accessibilityLabel="Explain what was just said"
            style={({ pressed }) => [pressed && { transform: [{ scale: 0.94 }] }]}>
            <LinearGradient colors={['#A033FF', '#5B51F5', '#3797F0']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.question}>
              <Icon name="questionmark" size={26} weight="bold" color="white" />
            </LinearGradient>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function Tiles({ participants }: { participants: Participant[] }) {
  const { userById } = useSession();
  const cols = participants.length > 2 ? 2 : 1;
  return (
    <View style={styles.grid}>
      {participants.map((p) => {
        const user = p.userId ? userById(p.userId) : undefined;
        const label = p.isLocal ? 'You' : user ? firstName(user.display_name) : 'Joining…';
        return (
          <View key={p.attendeeId} style={[styles.tile, { width: cols === 2 ? '48.5%' : '100%' }, p.speaking && styles.speaking]}>
            {p.tileId !== undefined ? (
              <ChimeVideo tileId={p.tileId} mirror={p.isLocal} style={StyleSheet.absoluteFill} />
            ) : (
              <Avatar uri={user?.avatar_url} size={participants.length > 2 ? 64 : 92} />
            )}
            <View style={styles.tileLabel}>
              {p.muted ? <Icon name="mic.slash.fill" size={11} color="white" /> : null}
              <Text style={styles.tileName}>{label}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

function Control({ icon, active, label, onPress }: { icon: 'mic.fill' | 'mic.slash.fill' | 'video.fill' | 'video.slash.fill'; active: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      style={[styles.control, active && styles.controlActive]}
      accessibilityLabel={label}>
      <Icon name={icon} size={22} color={active ? '#111' : 'white'} />
    </Pressable>
  );
}

function Notice({ title, body, onClose }: { title: string; body: string; onClose: () => void }) {
  return (
    <View style={[styles.screen, styles.center, { paddingHorizontal: 32 }]}>
      <Icon name="phone.badge.waveform" size={38} color={colors.textSecondary} />
      <Text style={styles.noticeTitle}>{title}</Text>
      <Text style={styles.noticeBody}>{body}</Text>
      <Pressable onPress={onClose} style={styles.noticeBtn}>
        <Text style={styles.noticeBtnText}>Close</Text>
      </Pressable>
    </View>
  );
}

/** "m:ss" since `startedAt`, ticking every second; empty while null. */
function useElapsed(startedAt: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return '';
  const s = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', gap: 12 },
  top: { alignItems: 'center', paddingHorizontal: 20, paddingBottom: 12, gap: 4 },
  groupName: { color: colors.text, fontSize: 20, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dim: { color: colors.textSecondary, fontSize: 14 },
  liveChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, height: 22, borderRadius: 11, backgroundColor: 'rgba(255,255,255,0.1)' },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#FF3B30' },
  liveText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  grid: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 10, alignContent: 'stretch' },
  tile: {
    flexGrow: 1,
    minHeight: 150,
    borderRadius: 22,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  speaking: { borderColor: colors.sparkle },
  tileLabel: {
    position: 'absolute',
    left: 10,
    bottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  tileName: { color: 'white', fontSize: 13, fontWeight: '600' },
  callError: { color: '#FF6B6B', fontSize: 13, textAlign: 'center', paddingHorizontal: 20, paddingTop: 8 },
  bottom: { paddingHorizontal: 14, paddingTop: 12, gap: 14 },
  caption: { color: colors.text, fontSize: 16, lineHeight: 22, textAlign: 'center', paddingHorizontal: 8 },
  captionPartial: { color: colors.textSecondary },
  captionName: { fontWeight: '700', color: colors.text },
  controlsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  controls: { flexDirection: 'row', gap: 14 },
  control: { width: 58, height: 58, borderRadius: 29, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' },
  controlActive: { backgroundColor: 'white' },
  leave: { backgroundColor: '#FF3B30' },
  question: { width: 62, height: 62, borderRadius: 31, alignItems: 'center', justifyContent: 'center' },
  noticeTitle: { color: colors.text, fontSize: 20, fontWeight: '700', textAlign: 'center' },
  noticeBody: { color: colors.textSecondary, fontSize: 15, lineHeight: 21, textAlign: 'center' },
  noticeBtn: { marginTop: 8, backgroundColor: colors.surface, paddingHorizontal: 22, paddingVertical: 10, borderRadius: 12 },
  noticeBtnText: { color: colors.text, fontSize: 15, fontWeight: '600' },
});
