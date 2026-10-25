import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, type Lore } from '@/api';
import { GlassCircle } from '@/components/GlassCircle';
import { Icon } from '@/components/Icon';
import { LoreCard } from '@/components/lore/LoreCard';
import { useMe } from '@/state/session';
import { colors } from '@/theme';

/** One lore entry on its own (related lore, "See the lore"): each hop pushes another, back pops. */
export default function LoreEntryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const me = useMe();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [lore, setLore] = useState<Lore | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getLore(Number(id), me.id)
      .then((d) => !cancelled && setLore(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [id, me.id]);

  return (
    <View style={styles.screen}>
      {lore ? (
        <LoreCard lore={lore} width={width} height={height} active onRemoved={() => router.back()} />
      ) : (
        <View style={styles.center}>{error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={colors.textSecondary} />}</View>
      )}
      <View style={[styles.back, { top: insets.top + 6 }]}>
        <GlassCircle onPress={() => router.back()} accessibilityLabel="Back">
          <Icon name="chevron.left" size={20} weight="medium" />
        </GlassCircle>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  error: { color: '#FF6B6B', fontSize: 15 },
  back: { position: 'absolute', left: 12 },
});
