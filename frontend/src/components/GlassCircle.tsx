import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

const liquid = isLiquidGlassAvailable();

/** Liquid-glass surface on iOS 26, blur fallback elsewhere. */
export function Glass({
  style,
  children,
  interactive,
  dark = false,
}: {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  interactive?: boolean;
  dark?: boolean;
}) {
  if (liquid) {
    return (
      <GlassView style={style} glassEffectStyle="regular" colorScheme={dark ? 'dark' : 'light'} isInteractive={interactive}>
        {children}
      </GlassView>
    );
  }
  return (
    <View style={[style, styles.clip]}>
      <BlurView
        tint={dark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
        intensity={80}
        style={StyleSheet.absoluteFill}
      />
      {children}
    </View>
  );
}

export function GlassCircle({
  size = 44,
  onPress,
  children,
  accessibilityLabel,
  dark = false,
}: {
  size?: number;
  onPress?: () => void;
  children: ReactNode;
  accessibilityLabel?: string;
  /** Dark glass, for controls over calls and photos. */
  dark?: boolean;
}) {
  return (
    <Pressable onPress={onPress} hitSlop={6} accessibilityRole="button" accessibilityLabel={accessibilityLabel}>
      <Glass interactive dark={dark} style={[styles.circle, { width: size, height: size, borderRadius: size / 2 }]}>
        {children}
      </Glass>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  circle: { alignItems: 'center', justifyContent: 'center' },
});
