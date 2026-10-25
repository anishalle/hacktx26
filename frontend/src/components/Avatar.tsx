import { Image } from 'expo-image';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors } from '@/theme';

import { Icon } from './Icon';

type Props = { uri: string | null | undefined; size: number; style?: StyleProp<ViewStyle>; ring?: string };

/** Round avatar; falls back to Instagram's default gray silhouette. */
export function Avatar({ uri, size, style, ring }: Props) {
  const r = size / 2;
  const ringStyle = ring ? { borderWidth: Math.max(1.5, size / 22), borderColor: ring } : null;
  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={[{ width: size, height: size, borderRadius: r, backgroundColor: colors.surface }, ringStyle, style as object]}
        contentFit="cover"
        transition={120}
      />
    );
  }
  return (
    <View
      style={[
        styles.fallback,
        { width: size, height: size, borderRadius: r },
        ringStyle,
        style,
      ]}>
      <Icon name="person.fill" size={size * 0.92} color={colors.silhouette} style={{ marginTop: size * 0.2 }} />
    </View>
  );
}

/** Group without a photo: two overlapping member avatars, like Instagram. */
export function GroupAvatar({ uris, size, style }: { uris: (string | null)[]; size: number; style?: StyleProp<ViewStyle> }) {
  const inner = size * 0.68;
  return (
    <View style={[{ width: size, height: size }, style]}>
      <Avatar uri={uris[1] ?? null} size={inner} style={{ position: 'absolute', top: 0, right: 0 }} />
      <Avatar
        uri={uris[0] ?? null}
        size={inner}
        ring={colors.bg}
        style={{ position: 'absolute', bottom: 0, left: 0 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    backgroundColor: colors.silhouetteBg,
    alignItems: 'center',
    overflow: 'hidden',
  },
});
