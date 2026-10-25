import { StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

/** iMessage keeps the transcript on plain white. */
export function Wallpaper() {
  return <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]} pointerEvents="none" />;
}
