import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { LoreReplay } from '@/api';
import { Avatar } from '@/components/Avatar';
import { CaptionBubble } from '@/components/call/CaptionBubble';
import { Icon } from '@/components/Icon';
import type { SpeakerCaption } from '@/hooks/useCall';
import { firstName } from '@/lib/format';
import { useSession } from '@/state/session';
import { colors } from '@/theme';

type Props = {
  replay: LoreReplay;
  /** Pauses when false (the card scrolled away). */
  active: boolean;
  /** Smaller layout inside the detail panel. */
  compact?: boolean;
};

const MAX_SPEAKERS = 4;

/**
 * An instant replay: the call audio with each speaker's caption bubble building word by word in
 * sync with it, like the live call. Mock replays have no audio; a silent clock drives them instead.
 */
export function ReplayPlayer({ replay, active, compact }: Props) {
  const { userById } = useSession();
  const { width } = useWindowDimensions();
  const hasAudio = !!replay.audio_url;
  const player = useAudioPlayer(hasAudio ? { uri: replay.audio_url } : null, { updateInterval: 100 });
  const status = useAudioPlayerStatus(player);

  // Silent clock for replays without audio (mock mode).
  const [clockMs, setClockMs] = useState(0);
  const [clockOn, setClockOn] = useState(false);
  const startedAt = useRef(0);
  // The clock only runs while the card is on screen.
  const clockRunning = clockOn && active;
  useEffect(() => {
    if (!clockRunning) return;
    startedAt.current = Date.now() - clockMs;
    const t = setInterval(() => {
      const ms = Date.now() - startedAt.current;
      if (ms >= replay.duration_ms) {
        setClockMs(replay.duration_ms);
        setClockOn(false);
      } else setClockMs(ms);
    }, 100);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart only on play/pause
  }, [clockRunning, replay.duration_ms]);

  const playing = hasAudio ? status.playing : clockRunning;
  const positionMs = hasAudio ? status.currentTime * 1000 : clockMs;
  const done = hasAudio ? status.didJustFinish || positionMs >= replay.duration_ms - 50 : clockMs >= replay.duration_ms;

  useEffect(() => {
    if (!active && hasAudio) player.pause();
  }, [active, hasAudio, player]);

  const toggle = async () => {
    Haptics.selectionAsync();
    if (playing) {
      if (hasAudio) player.pause();
      else setClockOn(false);
      return;
    }
    if (hasAudio) {
      await setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
      if (done) await player.seekTo(0);
      player.play();
    } else {
      if (done) setClockMs(0);
      setClockOn(true);
    }
  };

  const speakers = useMemo(
    () => [...new Set(replay.captions.map((c) => c.user_id))].slice(0, MAX_SPEAKERS),
    [replay.captions],
  );
  const started = playing || positionMs > 0;
  const captions = useMemo(() => {
    const out: Record<string, SpeakerCaption> = {};
    for (const id of speakers) {
      const mine = replay.captions.filter((c) => c.user_id === id);
      const finished = mine.filter((c) => c.end_ms <= positionMs).map((c) => c.text).slice(-2);
      const now = mine.find((c) => c.start_ms <= positionMs && positionMs < c.end_ms);
      let live: SpeakerCaption['live'] = null;
      if (now) {
        const words = now.text.split(' ');
        const shown = Math.max(1, Math.ceil(((positionMs - now.start_ms) / Math.max(1, now.end_ms - now.start_ms)) * words.length));
        live = { turnId: `${now.start_ms}`, text: words.slice(0, shown).join(' ') };
      }
      // Before playing, show each speaker's first line as a preview.
      if (!started && mine[0]) live = { turnId: 'preview', text: mine[0].text };
      out[id] = { finished: started ? finished : [], live, updatedAt: positionMs };
    }
    return out;
  }, [speakers, replay.captions, positionMs, started]);

  const colWidth = Math.max(140, (width - 48) / Math.min(speakers.length, 2) - 12);
  const progress = Math.min(1, positionMs / Math.max(1, replay.duration_ms));

  return (
    <View style={[styles.wrap, compact && styles.compact]}>
      <View style={styles.speakers}>
        {speakers.map((id, i) => {
          const user = userById(id);
          return (
            <View key={id} style={[styles.speaker, { width: colWidth }]}>
              <View style={styles.bubbleSlot}>
                <CaptionBubble caption={captions[id]} maxWidth={colWidth - 8} small={compact} tail={i % 2 ? 'right' : 'left'} persist />
              </View>
              <Avatar uri={user?.avatar_url} size={compact ? 32 : 44} />
              <Text style={styles.name} numberOfLines={1}>
                {user ? firstName(user.display_name) : 'Someone'}
              </Text>
            </View>
          );
        })}
      </View>
      <View style={styles.controls}>
        <Pressable onPress={toggle} style={styles.play} hitSlop={8} accessibilityLabel={playing ? 'Pause replay' : 'Play replay'}>
          <Icon name={playing ? 'pause.fill' : done && started ? 'arrow.counterclockwise' : 'play.fill'} size={18} color="black" />
        </Pressable>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${progress * 100}%` }]} />
        </View>
        <Text style={styles.time}>{Math.round(replay.duration_ms / 1000)}s</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 18 },
  compact: { gap: 12 },
  speakers: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 12 },
  speaker: { alignItems: 'center', gap: 6 },
  bubbleSlot: { minHeight: 96, justifyContent: 'flex-end', alignSelf: 'stretch', alignItems: 'center' },
  name: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 4 },
  play: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'white', alignItems: 'center', justifyContent: 'center' },
  track: { flex: 1, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)', overflow: 'hidden' },
  fill: { height: 4, backgroundColor: 'white' },
  time: { color: colors.textSecondary, fontSize: 12, fontVariant: ['tabular-nums'] },
});
