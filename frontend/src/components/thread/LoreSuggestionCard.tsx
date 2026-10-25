import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Lore } from '@/api';
import { Icon } from '@/components/Icon';
import { colors } from '@/theme';

type Props = {
  lore: Lore;
  onKeep: () => Promise<void>;
  onDismiss: () => void;
};

/** Under a moment's messages: anyone in the group can keep it as lore (first tap wins) or pass. */
export function LoreSuggestionCard({ lore, onKeep, onDismiss }: Props) {
  const [busy, setBusy] = useState(false);
  const keep = async () => {
    if (busy) return;
    setBusy(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      await onKeep();
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <LinearGradient colors={['#A033FF', '#5B51F5', '#3797F0']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.badge}>
          <Icon name="sparkles" size={13} color="white" weight="semibold" />
        </LinearGradient>
        <View style={{ flex: 1 }}>
          <Text style={styles.ask}>Keep this as lore?</Text>
          <Text style={styles.title} numberOfLines={2}>
            “{lore.title}”
          </Text>
        </View>
        <Pressable onPress={onDismiss} hitSlop={8} accessibilityLabel="Not now" style={styles.dismiss}>
          <Icon name="xmark" size={12} color={colors.textSecondary} />
        </Pressable>
        <Pressable onPress={keep} style={({ pressed }) => [styles.keep, pressed && { opacity: 0.7 }]} accessibilityRole="button">
          {busy ? <ActivityIndicator size="small" color="black" /> : <Text style={styles.keepText}>Keep</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, marginVertical: 10 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(124, 92, 255, 0.12)',
    borderColor: 'rgba(160, 130, 255, 0.35)',
    borderWidth: 1,
    borderRadius: 18,
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 10,
  },
  badge: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  ask: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  title: { color: colors.text, fontSize: 14, fontWeight: '600', marginTop: 1 },
  dismiss: { padding: 6 },
  keep: { backgroundColor: 'white', borderRadius: 14, paddingHorizontal: 14, height: 30, justifyContent: 'center', minWidth: 62, alignItems: 'center' },
  keepText: { color: 'black', fontWeight: '700', fontSize: 14 },
});
