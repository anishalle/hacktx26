import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { NudgeBannerState } from '@/hooks/useNudge';
import { colors } from '@/theme';

import { Glass } from '../GlassCircle';
import { Icon } from '../Icon';

type Props = {
  banner: NonNullable<NudgeBannerState>;
  onRewrite: () => void;
  onKeepMine: () => void;
  onAddAside: () => void;
  onSubmitAside: (meaning: string) => void;
  onDismiss: () => void;
};

/** Private suggestion card above the composer. Slides and fades in. */
export function NudgeBanner({ banner, onRewrite, onKeepMine, onAddAside, onSubmitAside, onDismiss }: Props) {
  const [anim] = useState(() => new Animated.Value(0));
  const [meaning, setMeaning] = useState('');

  useEffect(() => {
    anim.setValue(0);
    Animated.spring(anim, { toValue: 1, useNativeDriver: true, damping: 18, stiffness: 220, mass: 0.8 }).start();
  }, [anim, banner.kind]);

  const term = banner.kind === 'unknown' ? banner.data.unknown_terms[0]?.term : null;

  return (
    <Animated.View
      style={[
        styles.wrap,
        {
          opacity: anim,
          transform: [
            { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) },
            { scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) },
          ],
        },
      ]}
    >
      <Glass style={styles.card}>
        <View style={styles.tint} />
        <View style={styles.top}>
          <LinearGradient
            colors={['#007AFF', '#0875E8', '#116DD6']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.spark}
          >
            <Icon name="sparkles" size={14} color="white" weight="semibold" />
          </LinearGradient>
          <Text style={styles.message}>{banner.data.message}</Text>
          <Pressable
            onPress={banner.kind === 'check' ? onKeepMine : onDismiss}
            hitSlop={10}
            accessibilityLabel="Dismiss suggestion"
          >
            <Icon name="xmark" size={12} weight="semibold" color={colors.textSecondary} />
          </Pressable>
        </View>

        {banner.kind === 'check' ? (
          <View style={styles.actions}>
            <Pressable
              onPress={onRewrite}
              disabled={banner.busy}
              style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
            >
              {banner.busy ? (
                <ActivityIndicator size="small" color="#000" />
              ) : (
                <>
                  <Icon name="wand.and.sparkles" size={14} color="#000" weight="semibold" />
                  <Text style={styles.primaryText}>Rewrite</Text>
                </>
              )}
            </Pressable>
            <Pressable
              onPress={onKeepMine}
              disabled={banner.busy}
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryText}>Keep mine</Text>
            </Pressable>
          </View>
        ) : banner.asideOpen ? (
          <View style={styles.asideRow}>
            <TextInput
              autoFocus
              value={meaning}
              onChangeText={setMeaning}
              placeholder={`What does “${term}” mean?`}
              placeholderTextColor={colors.textSecondary}
              style={styles.asideInput}
              returnKeyType="done"
              onSubmitEditing={() => onSubmitAside(meaning)}
              editable={!banner.busy}
            />
            <Pressable
              onPress={() => onSubmitAside(meaning)}
              disabled={banner.busy || !meaning.trim()}
              style={[styles.asideGo, !meaning.trim() && { opacity: 0.4 }]}
            >
              {banner.busy ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <Icon name="arrow.up" size={15} weight="bold" color="white" />
              )}
            </Pressable>
          </View>
        ) : (
          <View style={styles.actions}>
            <Pressable onPress={onAddAside} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
              <Icon name="text.bubble" size={14} color="#000" weight="semibold" />
              <Text style={styles.primaryText}>Add aside</Text>
            </Pressable>
            <Text style={styles.hint}>or tap Send anyway</Text>
          </View>
        )}
      </Glass>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 10, paddingBottom: 8 },
  card: { borderRadius: 22, padding: 12, overflow: 'hidden' },
  tint: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(245,248,255,0.94)' },
  top: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  spark: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  message: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 19 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, marginLeft: 36 },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#F5F5F5',
    borderRadius: 16,
    paddingHorizontal: 14,
    height: 32,
    minWidth: 96,
    justifyContent: 'center',
  },
  primaryText: { color: '#000', fontSize: 14, fontWeight: '600' },
  secondary: {
    borderRadius: 16,
    paddingHorizontal: 14,
    height: 32,
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  secondaryText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.7 },
  hint: { color: colors.textSecondary, fontSize: 13 },
  asideRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, marginLeft: 36 },
  asideInput: {
    flex: 1,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 14,
    color: colors.text,
    fontSize: 15,
  },
  asideGo: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.action,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
