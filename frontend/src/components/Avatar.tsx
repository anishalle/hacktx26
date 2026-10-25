import { Image } from 'expo-image';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors } from '@/theme';

import { Icon } from './Icon';

type Props = { uri: string | null | undefined; size: number; style?: StyleProp<ViewStyle>; ring?: string; name?: string };

/** Personal initials keep people recognizable when they haven't added a photo. */
export function Avatar({ uri, size, style, ring, name }: Props) {
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
    <View style={[styles.fallback, { width: size, height: size, borderRadius: r }, ringStyle, style]}>
      {name?.trim() ? (
        <Text style={{ color: colors.silhouette, fontSize: size * 0.32, fontWeight: '600', letterSpacing: -0.4 }}>
          {name
            .trim()
            .split(/\s+/)
            .slice(0, 2)
            .map((word) => Array.from(word)[0])
            .join('')
            .toUpperCase()}
        </Text>
      ) : (
        <Icon name="person.fill" size={size * 0.46} color={colors.silhouette} />
      )}
    </View>
  );
}

/** Overlapping member avatars for groups without a photo. */
export function GroupAvatar({
  uris,
  size,
  style,
  ring = colors.bg,
}: {
  uris: (string | null)[];
  size: number;
  style?: StyleProp<ViewStyle>;
  /** The cut-out ring around the front face; pass the surface color on dark screens. */
  ring?: string;
}) {
  const inner = size * 0.68;
  return (
    <View style={[{ width: size, height: size }, style]}>
      <Avatar uri={uris[1] ?? null} size={inner} style={{ position: 'absolute', top: 0, right: 0 }} />
      <Avatar uri={uris[0] ?? null} size={inner} ring={ring} style={{ position: 'absolute', bottom: 0, left: 0 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    backgroundColor: colors.silhouetteBg,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
});
