import { Button, HStack, Host } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, disabled, tint } from '@expo/ui/swift-ui/modifiers';
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

/** Private suggestion card above the composer: light glass, native SwiftUI buttons. Slides and fades in. */
export function NudgeBanner({ banner, onRewrite, onKeepMine, onAddAside, onSubmitAside, onDismiss }: Props) {
  const [anim] = useState(() => new Animated.Value(0));
  const [meaning, setMeaning] = useState('');

  useEffect(() => {
    anim.setValue(0);
    Animated.spring(anim, { toValue: 1, useNativeDriver: true, damping: 18, stiffness: 220, mass: 0.8 }).start();
  }, [anim, banner.kind]);

  const term = banner.kind === 'unknown' ? banner.data.unknown_terms[0]?.term : null;
  const rewriteLabel = banner.busy ? 'Rewriting…' : 'Rewrite';

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
        <View style={styles.top}>
          <Icon name="sparkles" size={16} color={colors.blue} weight="semibold" style={{ marginTop: 1 }} />
          <Text style={styles.message}>{banner.data.message}</Text>
          <Pressable
            onPress={banner.kind === 'check' ? onKeepMine : onDismiss}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Dismiss suggestion"
          >
            <Icon name="xmark.circle.fill" size={20} color={colors.textTertiary} />
          </Pressable>
        </View>

        {banner.kind === 'check' ? (
          <View style={styles.actions}>
            {/* matchContents measures once, so remount when a label changes. */}
            <Host matchContents colorScheme="light" key={rewriteLabel}>
              <HStack spacing={8}>
                <Button
                  label={rewriteLabel}
                  systemImage="wand.and.sparkles"
                  onPress={onRewrite}
                  modifiers={[buttonStyle('glassProminent'), tint(colors.blue), controlSize('regular'), disabled(banner.busy)]}
                />
                <Button
                  label="Keep Mine"
                  onPress={onKeepMine}
                  modifiers={[buttonStyle('glass'), controlSize('regular'), disabled(banner.busy)]}
                />
              </HStack>
            </Host>
          </View>
        ) : banner.asideOpen ? (
          <View style={styles.asideRow}>
            <TextInput
              autoFocus
              value={meaning}
              onChangeText={setMeaning}
              placeholder={`What does “${term}” mean?`}
              placeholderTextColor={colors.textTertiary}
              style={styles.asideInput}
              returnKeyType="done"
              keyboardAppearance="light"
              onSubmitEditing={() => onSubmitAside(meaning)}
              editable={!banner.busy}
            />
            <Pressable
              onPress={() => onSubmitAside(meaning)}
              disabled={banner.busy || !meaning.trim()}
              style={[styles.asideGo, !meaning.trim() && { opacity: 0.4 }]}
              accessibilityRole="button"
              accessibilityLabel="Add aside"
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
            <Host matchContents colorScheme="light">
              <Button label="Add Aside" systemImage="text.bubble" onPress={onAddAside} modifiers={[buttonStyle('glass')]} />
            </Host>
            <Text style={styles.hint}>or tap Send anyway</Text>
          </View>
        )}
      </Glass>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 10, paddingBottom: 6 },
  card: { borderRadius: 24, borderCurve: 'continuous', padding: 14, overflow: 'hidden' },
  top: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  message: { flex: 1, color: colors.text, fontSize: 15, lineHeight: 20 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10, marginLeft: 26 },
  hint: { color: colors.textSecondary, fontSize: 13 },
  asideRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, marginLeft: 26 },
  asideInput: {
    flex: 1,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.grouped,
    paddingHorizontal: 14,
    color: colors.text,
    fontSize: 15,
  },
  asideGo: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.blue,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
