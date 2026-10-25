import * as Haptics from 'expo-haptics';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { Lore, LoreReplay } from '@/api';
import { Avatar } from '@/components/Avatar';
import { CaptionBubble } from '@/components/call/CaptionBubble';
import { Icon } from '@/components/Icon';
import type { SpeakerCaption } from '@/hooks/useCall';
import { firstName } from '@/lib/format';
import { usePlayback, usePlaybackControls, type PlaybackItem } from '@/state/playback';
import { useSession } from '@/state/session';
import { callColors as colors } from '@/theme';

type Props = {
  lore: Lore;
  replay: LoreReplay;
  /** `full`: the moment page's timeline panel. `card`: a smaller panel. */
  variant?: 'card' | 'full';
  queue?: PlaybackItem[];
};

const MAX_SPEAKERS = 4;

/**
 * An instant replay on a dark call-style panel: each speaker's caption bubble builds word by word
 * in sync with the clip, like the live call. It reads and drives the app-wide PlaybackProvider, so
 * it stays in step with the Now Playing accessory.
 */
export function ReplayPlayer({ lore, replay, variant = 'full', queue }: Props) {
  const { replay: current } = usePlaybackControls();
  return current?.id === replay.id ? (
    <LiveReplay lore={lore} replay={replay} variant={variant} queue={queue} />
  ) : (
    <ReplayBody lore={lore} replay={replay} variant={variant} queue={queue} positionMs={0} active={false} />
  );
}

function LiveReplay(props: Props) {
  const { positionMs } = usePlayback();
  return <ReplayBody {...props} positionMs={positionMs} active />;
}

function ReplayBody({
  lore,
  replay,
  variant = 'full',
  queue,
  positionMs,
  active,
}: Props & { positionMs: number; active: boolean }) {
  const { userById } = useSession();
  const { width } = useWindowDimensions();
  const { playing: anyPlaying, play, toggle, seek } = usePlaybackControls();
  const playing = active && anyPlaying;
  const compact = variant === 'card';
  const done = active && positionMs >= replay.duration_ms - 250;

  const onPlay = () => {
    Haptics.selectionAsync();
    if (active) toggle();
    else play(lore, replay, queue);
  };

  const speakers = useMemo(
    () => [...new Set(replay.captions.map((c) => c.user_id))].slice(0, MAX_SPEAKERS),
    [replay.captions],
  );
  const started = active && (playing || positionMs > 0);
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

  // The panel sits inside the page's 16 pt gutters with its own padding.
  const inner = width - 32 - (compact ? 24 : 32);
  const colWidth = Math.max(130, inner / Math.min(Math.max(speakers.length, 1), 2) - 12);
  const progress = Math.min(1, positionMs / Math.max(1, replay.duration_ms));
  const [trackWidth, setTrackWidth] = useState(0);

  return (
    <View style={[styles.panel, compact && styles.panelCompact]}>
      <View style={styles.speakers}>
        {speakers.map((id, i) => {
          const user = userById(id);
          return (
            <View key={id} style={[styles.speaker, { width: colWidth }]}>
              <View style={[styles.bubbleSlot, compact && styles.bubbleSlotCompact]}>
                <CaptionBubble caption={captions[id]} maxWidth={colWidth - 8} small={compact} tail={i % 2 ? 'right' : 'left'} persist />
              </View>
              <Avatar uri={user?.avatar_url} name={user?.display_name} size={compact ? 32 : 44} />
              <Text style={styles.name} numberOfLines={1}>
                {user ? firstName(user.display_name) : 'Someone'}
              </Text>
            </View>
          );
        })}
      </View>
      <View style={styles.controls}>
        <Pressable onPress={onPlay} style={styles.play} hitSlop={8} accessibilityRole="button" accessibilityLabel={playing ? 'Pause replay' : 'Play replay'}>
          <Icon name={playing ? 'pause.fill' : done ? 'arrow.counterclockwise' : 'play.fill'} size={18} color="black" />
        </Pressable>
        <Pressable
          style={styles.trackHit}
          onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
          disabled={!active || !trackWidth}
          onPress={(e) => seek((e.nativeEvent.locationX / trackWidth) * replay.duration_ms)}
          accessibilityRole="adjustable"
          accessibilityLabel="Replay position"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
        >
          <View style={styles.track} pointerEvents="none">
            <View style={[styles.fill, { width: `${progress * 100}%` }]} />
          </View>
        </Pressable>
        <Text style={styles.time}>{Math.round(replay.duration_ms / 1000)}s</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: colors.bg, borderRadius: 22, borderCurve: 'continuous', padding: 16, gap: 18 },
  panelCompact: { borderRadius: 18, padding: 12, gap: 12 },
  speakers: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 12 },
  speaker: { alignItems: 'center', gap: 6 },
  bubbleSlot: { minHeight: 96, justifyContent: 'flex-end', alignSelf: 'stretch', alignItems: 'center' },
  bubbleSlotCompact: { minHeight: 64 },
  name: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 4 },
  play: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'white', alignItems: 'center', justifyContent: 'center' },
  trackHit: { flex: 1, height: 44, justifyContent: 'center' },
  track: { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)', overflow: 'hidden' },
  fill: { height: 4, backgroundColor: 'white' },
  time: { color: colors.textSecondary, fontSize: 12, fontVariant: ['tabular-nums'] },
});
