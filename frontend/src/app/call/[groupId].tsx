import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  LayoutAnimation,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, USE_MOCKS, type CallJoin, type Lore } from '@/api';
import { Avatar, GroupAvatar } from '@/components/Avatar';
import { CallExplainCard, type CardState } from '@/components/call/CallExplainCard';
import { CaptionBubble } from '@/components/call/CaptionBubble';
import { Icon } from '@/components/Icon';
import { useCall, type Participant, type SpeakerCaption } from '@/hooks/useCall';
import { ChimeVideo, isChimeAvailable } from '@/lib/callEngine';
import { firstName } from '@/lib/format';
import { useRealtime } from '@/state/realtime';
import { useMe, useSession } from '@/state/session';
import { colors } from '@/theme';

const PANEL_H = 128;
const PIP = { w: 108, h: 148 };
const GAP = 12;
const SPEAKING_MS = 1500; // a fresh caption counts as speaking (Chime volume also does)

/** Feature 4: a FaceTime-style group call (Amazon Chime) with live per-speaker captions and a private ?. */
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

type Frame = { x: number; y: number; w: number; h: number; side: 'left' | 'right' };

/** FaceTime's staggered column (alternating sides, overlapping a little), or a plain 2-column grid. */
function layoutTiles(n: number, width: number, top: number, bottom: number, grid: boolean): Frame[] {
  const areaH = Math.max(160, bottom - top);
  if (n === 1) return [{ x: GAP, y: top, w: width - GAP * 2, h: areaH, side: 'left' }];
  if (grid) {
    const rows = Math.ceil(n / 2);
    const w = (width - GAP * 3) / 2;
    const h = Math.min(w * 1.3, (areaH - GAP * (rows - 1)) / rows);
    return Array.from({ length: n }, (_, i) => ({
      x: GAP + (i % 2) * (w + GAP),
      y: top + Math.floor(i / 2) * (h + GAP),
      w,
      h,
      side: i % 2 ? 'right' : 'left',
    }));
  }
  const w = width * 0.58;
  const h = Math.min(w * 1.05, areaH / (1 + 0.82 * (n - 1)));
  const step = n > 1 ? Math.min(h * 0.82, (areaH - h) / (n - 1)) : 0;
  return Array.from({ length: n }, (_, i) => ({
    x: i % 2 ? width - GAP - w : GAP,
    y: top + i * step,
    w,
    h,
    side: i % 2 ? 'right' : 'left',
  }));
}

function CallRoom({ join, groupName, onLeft }: { join: CallJoin; groupName: string; onLeft: () => void }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const me = useMe();
  const { userById } = useSession();
  const call = useCall(join, me.id);
  const [card, setCard] = useState<CardState | null>(null);
  const [grid, setGrid] = useState(false);
  const [panelShown, setPanelShown] = useState(true);
  const [panelY] = useState(() => new Animated.Value(0));
  const now = useNow(500);
  const left = useRef(false);
  // Lore: a moment the call just had ("that was lore"), offered to keep while it's fresh.
  const [lore, setLore] = useState<{ l: Lore; kept: boolean } | null>(null);
  useRealtime((frame) => {
    if (frame.type !== 'lore.updated' || frame.data.source !== 'call' || frame.data.call_id !== join.call.id) return;
    const l = frame.data;
    if (l.status === 'suggested') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setLore({ l, kept: false });
    } else setLore((cur) => (cur?.l.id === l.id ? (l.status === 'kept' ? { l, kept: true } : null) : cur));
  });
  useEffect(() => {
    if (!lore?.kept) return;
    const t = setTimeout(() => setLore(null), 2500);
    return () => clearTimeout(t);
  }, [lore?.kept]);
  const keepLore = async () => {
    if (!lore || lore.kept) return;
    const id = lore.l.id;
    setLore({ ...lore, kept: true });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await api.keepLore(id, me.id).catch(() => setLore((cur) => (cur?.l.id === id ? { ...cur, kept: false } : cur)));
  };
  const dismissLore = () => {
    if (!lore) return;
    void api.dismissLore(lore.l.id, me.id).catch(() => {});
    setLore(null);
  };

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
        const result = await api.explainCall(join.call.id, { user_id: me.id, at_ms: atMs });
        setCard((c) => (c?.atMs === atMs ? { phase: 'done', atMs, result } : c));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (e) {
        setCard((c) => (c?.atMs === atMs ? { phase: 'error', atMs, message: e instanceof Error ? e.message : String(e) } : c));
      }
    },
    [join.call.id, me.id],
  );
  const ask = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void explain(Date.now());
  };

  // FaceTime: tapping the video slides the controls panel up out of the way (and back).
  const togglePanel = () => {
    const show = !panelShown;
    setPanelShown(show);
    Animated.spring(panelY, { toValue: show ? 0 : -(PANEL_H + insets.top + 24), useNativeDriver: true, bounciness: 4 }).start();
  };

  const remotes = call.participants.filter((p) => !p.isLocal);
  const local = call.participants.find((p) => p.isLocal);
  const speaking = (p: Participant) => p.speaking || (!!p.userId && now - (call.captions[p.userId]?.updatedAt ?? 0) < SPEAKING_MS);
  const areaTop = insets.top + PANEL_H + 24;
  const areaBottom = height - insets.bottom - PIP.h - 28;
  const frames = layoutTiles(remotes.length, width, areaTop, areaBottom, grid);
  const people = call.participants.length;
  const status =
    call.state === 'connected'
      ? `${people} ${people === 1 ? 'person' : 'people'} active`
      : call.state === 'reconnecting'
        ? 'Reconnecting…'
        : call.state === 'ended'
          ? 'Call ended'
          : 'Connecting…';
  const captionNote =
    call.captionStatus === 'connecting' || call.captionStatus === 'reconnecting'
      ? 'Starting live captions…'
      : call.captionStatus === 'error'
        ? (call.error ?? 'Live captions are unavailable')
        : call.state !== 'ended' && call.error
          ? call.error
          : null;

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.screen}>
      <Pressable style={StyleSheet.absoluteFill} onPress={togglePanel} accessibilityLabel="Show or hide call controls">
        {remotes.length === 0 ? (
          <View style={[styles.waiting, { top: areaTop, bottom: height - areaBottom }]}>
            <GroupAvatar uris={[null, null]} size={88} />
            <Text style={styles.waitingText}>Waiting for others to join…</Text>
          </View>
        ) : null}
        {remotes.map((p, i) => (
          <Tile key={p.attendeeId} p={p} frame={frames[i]} speaking={speaking(p)} big={remotes.length === 1} />
        ))}
      </Pressable>

      {/* Captions sit above every tile, each anchored to its speaker's tile. */}
      {remotes.map((p, i) => {
        const f = frames[i];
        if (!f || !p.userId) return null;
        const maxWidth = Math.min(width - GAP * 2, f.w + 60);
        const x = f.side === 'left' ? f.x + 8 : Math.max(GAP, f.x + f.w - 8 - maxWidth);
        return (
          <View key={`cap-${p.attendeeId}`} pointerEvents="none" style={[styles.captionSlot, { left: x, top: f.y + f.h - 18, width: maxWidth }]}>
            <CaptionBubble caption={call.captions[p.userId]} maxWidth={maxWidth} tail={f.side} />
          </View>
        );
      })}

      {/* Your own tile: picture-in-picture, bottom right, with your caption above it. */}
      {local ? (
        <>
          <View style={[styles.pipCaption, { right: GAP, bottom: insets.bottom + 16 + PIP.h + 10, width: width * 0.55 }]} pointerEvents="none">
            <CaptionBubble caption={call.captions[me.id] as SpeakerCaption | undefined} maxWidth={width * 0.55} small tail="right" />
          </View>
          <View style={[styles.pip, { right: GAP, bottom: insets.bottom + 16 }, speaking(local) && styles.speaking]}>
            {local.tileId !== undefined && !call.videoOff ? (
              <ChimeVideo tileId={local.tileId} mirror style={StyleSheet.absoluteFill} />
            ) : (
              <Avatar uri={userById(me.id)?.avatar_url} size={56} />
            )}
            {call.muted ? (
              <View style={styles.pipMuted}>
                <Icon name="mic.slash.fill" size={11} color="white" />
              </View>
            ) : null}
          </View>
        </>
      ) : null}

      {remotes.length > 1 ? (
        <Pressable
          onPress={() => {
            Haptics.selectionAsync();
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setGrid((g) => !g);
          }}
          style={[styles.gridPill, { left: GAP, bottom: insets.bottom + 16 }]}
          accessibilityLabel={grid ? 'Staggered layout' : 'Grid layout'}>
          <BlurView tint="dark" intensity={60} style={[StyleSheet.absoluteFill, grid && styles.gridPillOn]} />
          <Icon name="square.grid.2x2.fill" size={15} color={grid ? '#111' : 'white'} />
          <Text style={[styles.gridText, grid && { color: '#111' }]}>Grid</Text>
        </Pressable>
      ) : null}

      {/* When the panel is tucked away, the ? stays one tap away. */}
      {!panelShown ? (
        <Pressable onPress={ask} style={[styles.floatingAsk, { bottom: insets.bottom + 20 }]} accessibilityLabel="Explain what was just said">
          <QuestionDot size={54} />
        </Pressable>
      ) : null}

      <Animated.View style={[styles.panelWrap, { top: insets.top + 6, transform: [{ translateY: panelY }] }]}>
        <BlurView tint="dark" intensity={70} style={styles.panel}>
          <View style={styles.panelRow}>
            <GroupAvatar uris={[null, null]} size={40} />
            <View style={styles.panelTitles}>
              <Text style={styles.panelName} numberOfLines={1}>
                {groupName || 'Group call'}
              </Text>
              <Text style={styles.panelStatus} numberOfLines={1}>
                {status}
              </Text>
            </View>
            <Pressable
              onPress={async () => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                await leave();
                onLeft();
              }}
              style={styles.leave}
              accessibilityLabel="Leave call">
              <Text style={styles.leaveText}>Leave</Text>
            </Pressable>
          </View>
          <View style={styles.controls}>
            <Control icon={call.muted ? 'mic.slash.fill' : 'mic.fill'} active={call.muted} label={call.muted ? 'Unmute' : 'Mute'} onPress={call.toggleMute} />
            <Control icon={call.videoOff ? 'video.slash.fill' : 'video.fill'} active={call.videoOff} label={call.videoOff ? 'Turn camera on' : 'Turn camera off'} onPress={call.toggleVideo} />
            <Pressable onPress={ask} accessibilityLabel="Explain what was just said" style={({ pressed }) => [pressed && { transform: [{ scale: 0.94 }] }]}>
              <QuestionDot size={50} />
            </Pressable>
          </View>
        </BlurView>
        {captionNote ? <Text style={styles.captionNote}>{captionNote}</Text> : null}
      </Animated.View>

      {lore ? (
        <View style={[styles.loreWrap, { top: insets.top + PANEL_H + (captionNote ? 40 : 18) }]}>
          <BlurView tint="dark" intensity={70} style={styles.lore}>
            <Icon name="sparkles" size={14} color={colors.sparkle} />
            <Text style={styles.loreTitle} numberOfLines={1}>
              {lore.kept ? 'Kept to Lore' : lore.l.title}
            </Text>
            {lore.kept ? (
              <Icon name="checkmark" size={14} color="white" weight="bold" />
            ) : (
              <>
                <Pressable onPress={keepLore} style={styles.loreKeep} accessibilityLabel="Keep this moment as lore">
                  <Text style={styles.loreKeepText}>Keep</Text>
                </Pressable>
                <Pressable onPress={dismissLore} hitSlop={8} accessibilityLabel="Not now">
                  <Icon name="xmark" size={12} color={colors.textSecondary} />
                </Pressable>
              </>
            )}
          </BlurView>
        </View>
      ) : null}

      {card ? (
        <View style={[styles.cardWrap, { bottom: insets.bottom + 12 }]}>
          <CallExplainCard card={card} groupId={join.call.group_id} meId={me.id} onRetry={explain} onDismiss={() => setCard(null)} />
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

function Tile({ p, frame, speaking, big }: { p: Participant; frame: Frame | undefined; speaking: boolean; big: boolean }) {
  const { userById } = useSession();
  if (!frame) return null;
  const user = p.userId ? userById(p.userId) : undefined;
  return (
    <View style={[styles.tile, { left: frame.x, top: frame.y, width: frame.w, height: frame.h }, speaking && styles.speaking]}>
      {p.tileId !== undefined ? (
        <ChimeVideo tileId={p.tileId} mirror={false} style={StyleSheet.absoluteFill} />
      ) : (
        <Avatar uri={user?.avatar_url} size={big ? 110 : 76} />
      )}
      <View style={styles.tileLabel}>
        {p.muted ? <Icon name="mic.slash.fill" size={11} color="white" /> : null}
        <Text style={styles.tileName} numberOfLines={1}>
          {user ? firstName(user.display_name) : 'Joining…'}
        </Text>
      </View>
    </View>
  );
}

function QuestionDot({ size }: { size: number }) {
  return (
    <LinearGradient
      colors={['#A033FF', '#5B51F5', '#3797F0']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="questionmark" size={size * 0.42} weight="bold" color="white" />
    </LinearGradient>
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
      <Icon name={icon} size={21} color={active ? '#111' : 'white'} />
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

/** Date.now(), refreshed every `ms` (drives the speaking glow from caption timestamps). */
function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', gap: 12 },
  dim: { color: colors.textSecondary, fontSize: 14 },
  waiting: { position: 'absolute', left: 0, right: 0, alignItems: 'center', justifyContent: 'center', gap: 14 },
  waitingText: { color: colors.textSecondary, fontSize: 15 },
  tile: {
    position: 'absolute',
    borderRadius: 18,
    backgroundColor: '#1C1C1E',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  speaking: { borderColor: colors.sparkle, shadowColor: colors.sparkle, shadowOpacity: 0.6, shadowRadius: 12, shadowOffset: { width: 0, height: 0 } },
  tileLabel: {
    position: 'absolute',
    left: 8,
    top: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.45)',
    maxWidth: '85%',
  },
  tileName: { color: 'white', fontSize: 12, fontWeight: '600' },
  captionSlot: { position: 'absolute', zIndex: 5 },
  pipCaption: { position: 'absolute', zIndex: 6, alignItems: 'flex-end' },
  pip: {
    position: 'absolute',
    width: PIP.w,
    height: PIP.h,
    borderRadius: 16,
    backgroundColor: '#2C2C2E',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
    zIndex: 4,
  },
  pipMuted: { position: 'absolute', left: 6, bottom: 6, width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  gridPill: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 17,
    overflow: 'hidden',
    zIndex: 4,
  },
  gridPillOn: { backgroundColor: 'white' },
  gridText: { color: 'white', fontSize: 15, fontWeight: '600' },
  floatingAsk: { position: 'absolute', alignSelf: 'center', zIndex: 7 },
  panelWrap: { position: 'absolute', left: 10, right: 10, zIndex: 8 },
  panel: { height: PANEL_H, borderRadius: 26, overflow: 'hidden', paddingHorizontal: 14, paddingTop: 12, backgroundColor: 'rgba(28,28,30,0.55)' },
  panelRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  panelTitles: { flex: 1, minWidth: 0 },
  panelName: { color: 'white', fontSize: 16, fontWeight: '700' },
  panelStatus: { color: colors.textSecondary, fontSize: 13, marginTop: 1 },
  leave: { backgroundColor: '#FF3B30', height: 34, paddingHorizontal: 16, borderRadius: 17, justifyContent: 'center' },
  leaveText: { color: 'white', fontSize: 15, fontWeight: '700' },
  controls: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', marginTop: 12 },
  control: { width: 50, height: 50, borderRadius: 25, backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' },
  controlActive: { backgroundColor: 'white' },
  captionNote: { color: colors.textSecondary, fontSize: 12, textAlign: 'center', marginTop: 8 },
  cardWrap: { position: 'absolute', left: 10, right: 10, zIndex: 9 },
  loreWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 8 },
  lore: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    maxWidth: '88%',
    height: 40,
    paddingLeft: 14,
    paddingRight: 12,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: 'rgba(28,28,30,0.55)',
  },
  loreTitle: { color: 'white', fontSize: 14, fontWeight: '600', flexShrink: 1 },
  loreKeep: { backgroundColor: 'white', borderRadius: 13, height: 26, paddingHorizontal: 12, justifyContent: 'center' },
  loreKeepText: { color: 'black', fontSize: 13, fontWeight: '700' },
  noticeTitle: { color: colors.text, fontSize: 20, fontWeight: '700', textAlign: 'center' },
  noticeBody: { color: colors.textSecondary, fontSize: 15, lineHeight: 21, textAlign: 'center' },
  noticeBtn: { marginTop: 8, backgroundColor: colors.surface, paddingHorizontal: 22, paddingVertical: 10, borderRadius: 12 },
  noticeBtnText: { color: colors.text, fontSize: 15, fontWeight: '600' },
});
