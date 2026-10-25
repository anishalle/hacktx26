import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatCount } from '@/lib/format';
import { colors } from '@/theme';

import { Glass } from '../GlassCircle';
import { Icon } from '../Icon';

/** Floating "Catch me up (1,204 unread)" pill at the top of a busy thread. */
export function CatchupPill({ count, top, onPress }: { count: number; top: number; onPress: () => void }) {
  const [anim] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.spring(anim, { toValue: 1, useNativeDriver: true, damping: 16, stiffness: 180, delay: 250 }).start();
  }, [anim]);
  return (
    <Animated.View
      style={[
        styles.wrap,
        {
          top,
          opacity: anim,
          transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }],
        },
      ]}
      pointerEvents="box-none">
      <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => pressed && { transform: [{ scale: 0.97 }] }}>
        <Glass interactive style={styles.pill}>
          <View style={styles.tint} />
          <LinearGradient colors={['#A033FF', '#5B51F5', '#3797F0']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.spark}>
            <Icon name="sparkles" size={12} color="white" weight="semibold" />
          </LinearGradient>
          <Text style={styles.text}>
            Catch me up <Text style={styles.count}>({formatCount(count)} unread)</Text>
          </Text>
        </Glass>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 9 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 40,
    paddingLeft: 8,
    paddingRight: 16,
    borderRadius: 20,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  tint: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(30,30,36,0.82)' },
  spark: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  text: { color: colors.text, fontSize: 15, fontWeight: '600' },
  count: { color: colors.textSecondary, fontWeight: '500' },
});
