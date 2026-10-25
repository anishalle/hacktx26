import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { colors } from '@/theme';

/** Placeholder for Feature 1 (hold-to-explain). See src/features/explain.ts. */
export default function ExplainSheet() {
  const { text, term } = useLocalSearchParams<{ text?: string; term?: string; groupId?: string }>();
  return (
    <View style={styles.sheet}>
      <View style={styles.badge}>
        <Icon name="questionmark" size={22} weight="bold" color="white" />
      </View>
      <Text style={styles.title}>Explain coming soon</Text>
      {term ? (
        <Text style={styles.quote}>“{term}”</Text>
      ) : text ? (
        <Text style={styles.quote} numberOfLines={3}>
          “{text}”
        </Text>
      ) : null}
      <Text style={styles.body}>Hold-to-explain will tell you what this means, using the group’s own history.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.sheetBg, alignItems: 'center', paddingTop: 32, paddingHorizontal: 28, gap: 10 },
  badge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#7C5CFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { color: colors.text, fontSize: 20, fontWeight: '700' },
  quote: { color: colors.text, fontSize: 16, fontStyle: 'italic', textAlign: 'center' },
  body: { color: colors.textSecondary, fontSize: 15, textAlign: 'center', lineHeight: 20 },
});
