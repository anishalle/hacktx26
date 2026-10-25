import { StyleSheet, View } from 'react-native';
import { colors } from '@/theme';

export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
      <View style={[styles.orbit, { width: size * 0.68, height: size * 0.68, borderRadius: size, left: 0, top: 0 }]} />
      <View
        style={[
          styles.orbit,
          { width: size * 0.68, height: size * 0.68, borderRadius: size, right: 0, bottom: 0, borderColor: colors.blue },
        ]}
      />
    </View>
  );
}
const styles = StyleSheet.create({ orbit: { position: 'absolute', borderWidth: 2.5, borderColor: colors.text } });
