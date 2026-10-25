import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Call, Group, Lore, LoreReplay } from '@/api';
import { Avatar, GroupAvatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { firstName } from '@/lib/format';
import { useActiveCalls } from '@/state/calls';
import { useInbox } from '@/state/inbox';
import { captionAt, usePlayback, usePlaybackControls } from '@/state/playback';
import { useSession } from '@/state/session';
import { colors } from '@/theme';

type NowPlaying =
  | { kind: 'call'; call: Call; group: Group | null }
  | { kind: 'replay'; lore: Lore; replay: LoreReplay };

const liquid = isLiquidGlassAvailable();

/**
 * What the accessory shows: a live call in one of my groups that I'm not in, else the loaded
 * replay, else nothing (the tabs layout hides the accessory).
 */
export function useNowPlaying(): NowPlaying | null {
  const { me } = useSession();
  const { byGroup } = useActiveCalls();
  const { items } = useInbox();
  const { lore, replay } = usePlaybackControls();
  return useMemo(() => {
    const live = Object.values(byGroup)
      .filter((c) => {
        const inCall = c.members.filter((m) => !m.left_at);
        return inCall.length > 0 && !inCall.some((m) => m.user.id === me?.id);
      })
      .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
    if (live) return { kind: 'call', call: live, group: items.find((it) => it.group.id === live.group_id)?.group ?? null };
    if (lore && replay) return { kind: 'replay', lore, replay };
    return null;
  }, [byGroup, items, me?.id, lore, replay]);
}

/**
 * Apple Music-style Now Playing row above the tab bar. Always mounted; NativeTabs renders it once
 * per placement, so every bit of state comes from context.
 */
export function NowPlayingAccessory() {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  const now = useNowPlaying();
  // Keep the last content while the accessory animates out.
  const [shown, setShown] = useState(now);
  if (now && now !== shown) setShown(now);
  if (!shown) return null;
  const inline = placement === 'inline';
  return shown.kind === 'call' ? (
    <CallRow call={shown.call} group={shown.group} inline={inline} />
  ) : (
    <ReplayRow lore={shown.lore} replay={shown.replay} inline={inline} />
  );
}

function CallRow({ call, group, inline }: { call: Call; group: Group | null; inline: boolean }) {
  const { me } = useSession();
  const inCall = call.members.filter((m) => !m.left_at && m.user.id !== me?.id);
  const name = group?.name ?? 'Call';
  const names = inCall.slice(0, 2).map((m) => firstName(m.user.display_name));
  const open = () => router.push({ pathname: '/call/[groupId]', params: { groupId: String(call.group_id), name } });
  const join = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    open();
  };
  return (
    <Pressable
      onPress={open}
      style={[styles.row, inline && styles.inlineRow]}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${inCall.length} in call`}
    >
      {inline ? null : group?.avatar_url || inCall.length < 2 ? (
        <Avatar uri={group?.avatar_url ?? inCall[0]?.user.avatar_url} name={name} size={36} style={styles.art} />
      ) : (
        <GroupAvatar uris={inCall.map((m) => m.user.avatar_url)} size={36} />
      )}
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {name}
        </Text>
        {inline ? null : (
          <Text style={styles.sub} numberOfLines={1}>
            {names.length ? `${names.join(', ')} · ` : ''}
            {inCall.length} in call
          </Text>
        )}
      </View>
      <Pressable onPress={join} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Join ${name}`}>
        {liquid ? (
          <GlassView style={[styles.join, inline && styles.joinInline]} tintColor={colors.green} isInteractive>
            <Text style={styles.joinText}>Join</Text>
          </GlassView>
        ) : (
          <View style={[styles.join, inline && styles.joinInline, { backgroundColor: colors.green }]}>
            <Text style={styles.joinText}>Join</Text>
          </View>
        )}
      </Pressable>
    </Pressable>
  );
}

function ReplayRow({ lore, replay, inline }: { lore: Lore; replay: LoreReplay; inline: boolean }) {
  const { playing, hasNext, toggle, next } = usePlaybackControls();
  const cover = lore.cover.photo?.image?.url;
  const open = () => router.push({ pathname: '/lore/[id]', params: { id: String(lore.id) } });
  return (
    <Pressable
      onPress={open}
      style={[styles.row, inline && styles.inlineRow]}
      accessibilityRole="button"
      accessibilityLabel={lore.title}
    >
      {inline ? null : cover ? (
        <Image source={{ uri: cover }} style={styles.art} contentFit="cover" />
      ) : (
        <View style={[styles.art, styles.wave]}>
          <Icon name="waveform" size={18} color="white" />
        </View>
      )}
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {lore.title}
        </Text>
        {inline ? null : <LiveCaption replay={replay} fallback={lore.group_name} />}
      </View>
      <Pressable
        onPress={() => {
          Haptics.selectionAsync();
          toggle();
        }}
        hitSlop={8}
        style={styles.button}
        accessibilityRole="button"
        accessibilityLabel={playing ? 'Pause' : 'Play'}
      >
        <Icon name={playing ? 'pause.fill' : 'play.fill'} size={inline ? 17 : 20} />
      </Pressable>
      {inline ? null : (
        <Pressable
          onPress={next}
          disabled={!hasNext}
          hitSlop={8}
          style={styles.button}
          accessibilityRole="button"
          accessibilityLabel="Next"
        >
          <Icon name="forward.fill" size={20} color={hasNext ? colors.text : colors.textTertiary} />
        </Pressable>
      )}
    </Pressable>
  );
}

/** "Maya: no way he did that", following the playhead. Only this line re-renders on each tick. */
function LiveCaption({ replay, fallback }: { replay: LoreReplay; fallback: string }) {
  const { positionMs } = usePlayback();
  const { userById } = useSession();
  const line = captionAt(replay.captions, positionMs) ?? (positionMs ? null : (replay.captions[0] ?? null));
  const who = line ? userById(line.user_id) : undefined;
  return (
    <Text style={styles.sub} numberOfLines={1}>
      {line ? `${who ? `${firstName(who.display_name)}: ` : ''}${line.text}` : fallback}
    </Text>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 8, paddingRight: 6 },
  inlineRow: { paddingLeft: 14, paddingRight: 4, gap: 6 },
  art: { width: 36, height: 36, borderRadius: 8, borderCurve: 'continuous', overflow: 'hidden' },
  wave: { backgroundColor: colors.blue, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 15, fontWeight: '600' },
  sub: { color: colors.textSecondary, fontSize: 13, marginTop: 1 },
  button: { width: 36, height: 44, alignItems: 'center', justifyContent: 'center' },
  join: {
    height: 32,
    paddingHorizontal: 16,
    borderRadius: 16,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  joinInline: { height: 28, paddingHorizontal: 12, borderRadius: 14 },
  joinText: { color: 'white', fontSize: 15, fontWeight: '600' },
});
