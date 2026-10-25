import { BlurView } from 'expo-blur';
import { GlassContainer, GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { SFSymbol } from 'expo-symbols';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { colors } from '@/theme';

import { Icon } from '../Icon';

const liquid = isLiquidGlassAvailable();
const AnimatedGlassView = Animated.createAnimatedComponent(GlassView);

export const TILE = 34;
export const springLayout = LinearTransition.springify().damping(20).stiffness(220);

export type ComposerApps = {
  onPhotos: () => void;
  onCamera: () => void;
  /** Only while the thread has unread messages. */
  onCatchup?: () => void;
  /** Explains the last incoming message; absent when there is none. */
  onExplain?: () => void;
  onLore: () => void;
  /** Guess that Lore: posts a round in the chat. Groups only. */
  onGame?: () => void;
  onCall: () => void;
};

/** idle: photos, camera, more. expanded: every app. compact (typing): one chevron. */
export type AppsMode = 'idle' | 'expanded' | 'compact';

type Tile = { key: string; icon: SFSymbol; label: string; onPress: () => void };

/** One round glass tile. Each tile is a direct child of the GlassContainer so neighbors merge. */
function GlassTile({ tile }: { tile: Tile }) {
  const body: ReactNode = (
    <Pressable onPress={tile.onPress} hitSlop={5} style={styles.hit} accessibilityRole="button" accessibilityLabel={tile.label}>
      <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
        <Icon name={tile.icon} size={16} weight="semibold" color={colors.text} />
      </Animated.View>
    </Pressable>
  );
  const shape: StyleProp<ViewStyle> = styles.tile;
  if (liquid) {
    return (
      <AnimatedGlassView
        layout={springLayout}
        entering={FadeIn.duration(180)}
        exiting={FadeOut.duration(120)}
        isInteractive
        colorScheme="light"
        glassEffectStyle="regular"
        style={shape}
      >
        {body}
      </AnimatedGlassView>
    );
  }
  return (
    <Animated.View layout={springLayout} entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)} style={[shape, styles.clip]}>
      <BlurView tint="systemChromeMaterialLight" intensity={80} style={StyleSheet.absoluteFill} />
      {body}
    </Animated.View>
  );
}

/** iMessage's apps cluster left of the input: grows into a strip of tiles, shrinks to a chevron. */
export function AppsStrip({
  mode,
  apps,
  onExpand,
  onCollapse,
}: {
  mode: AppsMode;
  apps: ComposerApps;
  onExpand: () => void;
  onCollapse: () => void;
}) {
  // Every app collapses the strip first, so the input comes back.
  const run = (fn: () => void) => () => {
    onCollapse();
    fn();
  };
  const photos: Tile = { key: 'photos', icon: 'photo.on.rectangle', label: 'Photos', onPress: run(apps.onPhotos) };
  const camera: Tile = { key: 'camera', icon: 'camera.fill', label: 'Camera', onPress: run(apps.onCamera) };
  const more: Tile = { key: 'more', icon: 'chevron.right', label: 'More apps', onPress: onExpand };

  let tiles: Tile[];
  if (mode === 'compact') tiles = [more];
  else if (mode === 'idle') tiles = [photos, camera, more];
  else {
    tiles = [photos, camera];
    if (apps.onCatchup) tiles.push({ key: 'catchup', icon: 'text.bubble', label: 'Catch Up', onPress: run(apps.onCatchup) });
    if (apps.onExplain)
      tiles.push({ key: 'explain', icon: 'questionmark.bubble', label: 'Explain last message', onPress: run(apps.onExplain) });
    tiles.push({ key: 'lore', icon: 'sparkles.rectangle.stack', label: 'Lore', onPress: run(apps.onLore) });
    if (apps.onGame) tiles.push({ key: 'game', icon: 'dice', label: 'Guess that Lore', onPress: run(apps.onGame) });
    tiles.push(
      { key: 'call', icon: 'video.fill', label: 'Call', onPress: run(apps.onCall) },
      { key: 'less', icon: 'chevron.left', label: 'Hide apps', onPress: onCollapse },
    );
  }

  return (
    <Animated.View layout={springLayout} style={styles.wrap}>
      {liquid ? (
        <GlassContainer spacing={8} style={styles.row}>
          {tiles.map((t) => (
            <GlassTile key={t.key} tile={t} />
          ))}
        </GlassContainer>
      ) : (
        <View style={styles.row}>
          {tiles.map((t) => (
            <GlassTile key={t.key} tile={t} />
          ))}
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tile: { width: TILE, height: TILE, borderRadius: TILE / 2 },
  clip: { overflow: 'hidden' },
  hit: { width: TILE, height: TILE, alignItems: 'center', justifyContent: 'center' },
});
