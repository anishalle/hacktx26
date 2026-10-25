import * as Haptics from 'expo-haptics';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Lore, LoreCaption, LoreReplay } from '@/api';
import { Icon } from '@/components/Icon';
import { firstName } from '@/lib/format';
import { captionAt, usePlayback, usePlaybackControls, type PlaybackItem } from '@/state/playback';
import { useSession } from '@/state/session';
import { colors } from '@/theme';

type Props = {
  lore: Lore;
  replay: LoreReplay;
  /** What `next()` walks once this one ends (the deck's other replays). */
  queue?: PlaybackItem[];
  /** `card`: the deck hero. `large`: the moment page hero. */
  size?: 'card' | 'large';
};

/** Cheap deterministic noise so a replay keeps the same waveform. */
function noise(seed: number) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Bar heights in [0, 1]: tall where someone is talking, low in the gaps. */
export function waveform(replay: LoreReplay, bars: number) {
  const dur = Math.max(1, replay.duration_ms);
  return Array.from({ length: bars }, (_, i) => {
    const t = ((i + 0.5) / bars) * dur;
    const talking = replay.captions.some((c) => c.start_ms <= t && t < c.end_ms);
    const n = noise(replay.id * 131 + i);
    return talking ? 0.4 + 0.6 * n : 0.12 + 0.16 * n;
  });
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * An audio moment: `play.circle.fill`, a waveform that fills as the clip plays, and the line being
 * said. Driven by the app-wide PlaybackProvider, so playing here brings up the Now Playing accessory.
 */
export function AudioTile({ lore, replay, queue, size = 'card' }: Props) {
  const { replay: current, playing, play, toggle } = usePlaybackControls();
  const active = current?.id === replay.id;
  const large = size === 'large';
  const onPlay = () => {
    Haptics.selectionAsync();
    if (active) toggle();
    else play(lore, replay, queue);
  };
  return (
    <View style={[styles.tile, large && styles.tileLarge]}>
      <View style={styles.top}>
        <Pressable
          onPress={onPlay}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={active && playing ? 'Pause' : `Play ${lore.title}`}
        >
          <Icon name={active && playing ? 'pause.circle.fill' : 'play.circle.fill'} size={large ? 56 : 44} color={colors.blue} />
        </Pressable>
        {active ? <LiveWave replay={replay} large={large} /> : <Wave replay={replay} large={large} positionMs={0} />}
      </View>
      {active ? <LiveLine captions={replay.captions} large={large} /> : <Line caption={replay.captions[0] ?? null} large={large} />}
    </View>
  );
}

function LiveWave({ replay, large }: { replay: LoreReplay; large: boolean }) {
  const { positionMs } = usePlayback();
  return <Wave replay={replay} large={large} positionMs={positionMs} />;
}

const SEEK_STEP_MS = 5000;

function Wave({ replay, large, positionMs }: { replay: LoreReplay; large: boolean; positionMs: number }) {
  const { replay: current, seek } = usePlaybackControls();
  const bars = useMemo(() => waveform(replay, large ? 44 : 32), [replay, large]);
  const [width, setWidth] = useState(0);
  const progress = Math.min(1, positionMs / Math.max(1, replay.duration_ms));
  const height = large ? 52 : 36;
  const active = current?.id === replay.id;
  return (
    <View style={styles.waveCol}>
      <Pressable
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        // Seeking only makes sense once this clip is the one loaded.
        disabled={!active || !width}
        onPress={(e) => seek((e.nativeEvent.locationX / width) * replay.duration_ms)}
        style={[styles.wave, { height }]}
        accessibilityRole="adjustable"
        accessibilityLabel="Replay position"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
        accessibilityState={{ disabled: !active }}
        // VoiceOver's swipe up/down: 5 s either way.
        accessibilityActions={active ? [{ name: 'increment' }, { name: 'decrement' }] : []}
        onAccessibilityAction={(e) => {
          if (!active) return;
          const step = e.nativeEvent.actionName === 'increment' ? SEEK_STEP_MS : -SEEK_STEP_MS;
          seek(Math.min(replay.duration_ms, Math.max(0, positionMs + step)));
        }}
      >
        {bars.map((h, i) => (
          <View
            key={i}
            pointerEvents="none"
            style={[
              styles.bar,
              { height: Math.max(3, h * height), backgroundColor: (i + 0.5) / bars.length <= progress ? colors.blue : 'rgba(0,122,255,0.28)' },
            ]}
          />
        ))}
      </Pressable>
      <Text style={styles.time}>{positionMs > 0 ? `${clock(positionMs)} / ${clock(replay.duration_ms)}` : clock(replay.duration_ms)}</Text>
    </View>
  );
}

function LiveLine({ captions, large }: { captions: LoreCaption[]; large: boolean }) {
  const { positionMs } = usePlayback();
  return <Line caption={captionAt(captions, positionMs) ?? captions[0] ?? null} large={large} />;
}

function Line({ caption, large }: { caption: LoreCaption | null; large: boolean }) {
  const { userById } = useSession();
  if (!caption) return null;
  const who = userById(caption.user_id);
  return (
    <Text style={[styles.line, large && styles.lineLarge]} numberOfLines={large ? 3 : 2}>
      {who ? <Text style={styles.speaker}>{firstName(who.display_name)}: </Text> : null}
      {caption.text}
    </Text>
  );
}

const styles = StyleSheet.create({
  tile: { backgroundColor: colors.accentSoft, borderRadius: 18, borderCurve: 'continuous', padding: 14, gap: 10 },
  tileLarge: { borderRadius: 22, padding: 18, gap: 14 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  waveCol: { flex: 1, gap: 4 },
  wave: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  bar: { width: 3, borderRadius: 1.5 },
  time: { color: colors.textSecondary, fontSize: 12, fontVariant: ['tabular-nums'] },
  line: { color: colors.text, fontSize: 15, lineHeight: 20 },
  lineLarge: { fontSize: 17, lineHeight: 23 },
  speaker: { fontWeight: '600' },
});
