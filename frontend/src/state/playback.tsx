import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { createContext, ReactNode, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Lore, LoreCaption, LoreReplay } from '@/api';

/** One replay in the queue, with the moment it belongs to. */
export type PlaybackItem = { lore: Lore; replay: LoreReplay };

type Controls = {
  lore: Lore | null;
  replay: LoreReplay | null;
  captions: LoreCaption[];
  playing: boolean;
  queue: PlaybackItem[];
  hasNext: boolean;
  /** Load `replay` (or resume it if it is already loaded) and play. `queue` is what `next()` walks. */
  play: (lore: Lore, replay: LoreReplay, queue?: PlaybackItem[]) => void;
  toggle: () => void;
  seek: (ms: number) => void;
  next: () => void;
  pause: () => void;
  /** Stop and unload; the accessory hides. */
  close: () => void;
};

type Playback = Controls & { positionMs: number };

// Two contexts so screens that only need the controls don't re-render on every clock tick.
const ControlsContext = createContext<Controls | null>(null);
const PositionContext = createContext(0);

const TICK_MS = 100;

/** The caption being spoken at `ms`, else the last one already said (null before the first). */
export function captionAt(captions: LoreCaption[], ms: number): LoreCaption | null {
  let last: LoreCaption | null = null;
  for (const c of captions) {
    if (c.start_ms > ms) break;
    last = c;
  }
  return last;
}

/**
 * The app-wide replay player behind the Now Playing accessory: one expo-audio player whose clip is
 * swapped with `replace`. Replays without audio (mock mode) run on a silent clock instead.
 */
export function PlaybackProvider({ children }: { children: ReactNode }) {
  const player = useAudioPlayer(null, { updateInterval: TICK_MS });
  const status = useAudioPlayerStatus(player);
  const [current, setCurrent] = useState<PlaybackItem | null>(null);
  const [queue, setQueue] = useState<PlaybackItem[]>([]);
  const audioModeSet = useRef(false);

  const replay = current?.replay ?? null;
  const hasAudio = !!replay?.audio_url;
  const durationMs = replay?.duration_ms ?? 0;

  // Silent clock: `clockStart` is the wall time at position 0, so seeking just moves it.
  const [clockMs, setClockMs] = useState(0);
  const [clockOn, setClockOn] = useState(false);
  const clockStart = useRef(0);
  useEffect(() => {
    if (!clockOn || !durationMs) return;
    const t = setInterval(() => {
      const ms = Date.now() - clockStart.current;
      if (ms >= durationMs) {
        setClockMs(durationMs);
        setClockOn(false);
      } else setClockMs(ms);
    }, TICK_MS);
    return () => clearInterval(t);
  }, [clockOn, durationMs]);

  const startClock = (fromMs: number) => {
    clockStart.current = Date.now() - fromMs;
    setClockMs(fromMs);
    setClockOn(true);
  };

  const positionMs = hasAudio ? status.currentTime * 1000 : clockMs;
  const playing = hasAudio ? status.playing : clockOn;
  const atEnd = durationMs > 0 && positionMs >= durationMs - 250;

  const start = useCallback(
    async (item: PlaybackItem) => {
      setCurrent(item);
      setClockOn(false);
      setClockMs(0);
      if (!item.replay.audio_url) {
        player.pause();
        clockStart.current = Date.now();
        setClockOn(true);
        return;
      }
      if (!audioModeSet.current) {
        audioModeSet.current = true;
        await setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
      }
      player.replace({ uri: item.replay.audio_url });
      player.play();
    },
    [player],
  );

  const resume = () => {
    if (hasAudio) {
      if (atEnd) player.seekTo(0);
      player.play();
    } else startClock(atEnd ? 0 : clockMs);
  };

  const pause = () => {
    if (hasAudio) player.pause();
    else setClockOn(false);
  };

  const nextItem = useMemo(() => {
    if (!current) return null;
    const i = queue.findIndex((q) => q.replay.id === current.replay.id);
    return i >= 0 ? (queue[i + 1] ?? null) : null;
  }, [current, queue]);

  // Latest closures for the control functions below and the finish effect.
  const latest = useRef({ current, playing, resume, pause, start, nextItem, hasAudio });
  useEffect(() => {
    latest.current = { current, playing, resume, pause, start, nextItem, hasAudio };
  });

  // Roll into the next queued replay when one finishes.
  const finished = hasAudio ? status.didJustFinish : !!replay && clockMs >= durationMs;
  useEffect(() => {
    const l = latest.current;
    if (finished && l.nextItem) l.start(l.nextItem);
  }, [finished]);

  const controls = useMemo<Controls>(
    () => ({
      lore: current?.lore ?? null,
      replay,
      captions: replay?.captions ?? [],
      playing,
      queue,
      hasNext: !!nextItem,
      play: (lore, r, q) => {
        const l = latest.current;
        if (q) setQueue(q);
        else if (l.current?.replay.id !== r.id) setQueue([{ lore, replay: r }]);
        if (l.current?.replay.id === r.id) {
          if (!l.playing) l.resume();
        } else l.start({ lore, replay: r });
      },
      toggle: () => {
        const l = latest.current;
        if (!l.current) return;
        if (l.playing) l.pause();
        else l.resume();
      },
      seek: (ms) => {
        const l = latest.current;
        if (!l.current) return;
        const clamped = Math.max(0, Math.min(ms, l.current.replay.duration_ms));
        if (l.hasAudio) player.seekTo(clamped / 1000);
        else {
          clockStart.current = Date.now() - clamped;
          setClockMs(clamped);
        }
      },
      next: () => {
        const l = latest.current;
        if (l.nextItem) l.start(l.nextItem);
      },
      pause: () => latest.current.pause(),
      close: () => {
        player.pause();
        setClockOn(false);
        setClockMs(0);
        setCurrent(null);
        setQueue([]);
      },
    }),
    [current, replay, playing, queue, nextItem, player],
  );

  return (
    <ControlsContext value={controls}>
      <PositionContext value={current ? positionMs : 0}>{children}</PositionContext>
    </ControlsContext>
  );
}

/** Playback controls and state without the position; doesn't re-render while the clip plays. */
export function usePlaybackControls() {
  const ctx = use(ControlsContext);
  if (!ctx) throw new Error('usePlaybackControls outside PlaybackProvider');
  return ctx;
}

/** Everything, including `positionMs` (re-renders every tick while playing). */
export function usePlayback(): Playback {
  const controls = usePlaybackControls();
  const positionMs = use(PositionContext);
  return useMemo(() => ({ ...controls, positionMs }), [controls, positionMs]);
}
