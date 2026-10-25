import type { SymbolViewProps } from 'expo-symbols';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/theme';

import { Icon } from './Icon';

/** Static chrome for the tabs this demo doesn't implement. */
export function Placeholder({ icon, title }: { icon: SymbolViewProps['name']; title: string }) {
  return (
    <ScrollView contentContainerStyle={styles.wrap} style={{ backgroundColor: colors.bg }}>
      <View style={styles.circle}>
        <Icon name={icon} size={34} color={colors.text} />
      </View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>Not part of this demo. Open Messages.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingBottom: 80 },
  circle: {
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 2,
    borderColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  body: { color: colors.textSecondary, fontSize: 15 },
});
