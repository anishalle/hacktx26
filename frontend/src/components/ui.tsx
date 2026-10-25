import { Pressable, StyleSheet, Text } from 'react-native';

export function Button({ label, onPress, disabled = false, secondary = false }: {
  label: string; onPress: () => void; disabled?: boolean; secondary?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={[styles.button, secondary && styles.secondary, disabled && { opacity: 0.45 }]}>
    <Text style={[styles.buttonText, secondary && { color: '#24594c' }]}>{label}</Text>
  </Pressable>;
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f5f6f0' },
  content: { padding: 24, gap: 20, width: '100%', maxWidth: 600, alignSelf: 'center' },
  title: { fontSize: 30, fontWeight: '700', color: '#19392f' },
  subtitle: { fontSize: 16, lineHeight: 24, color: '#56645e' },
  label: { fontSize: 13, fontWeight: '700', color: '#56645e', textTransform: 'uppercase', letterSpacing: 1 },
  card: { backgroundColor: '#fff', borderRadius: 20, padding: 22, gap: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  name: { fontSize: 22, fontWeight: '600', color: '#19392f' },
  button: { minHeight: 48, paddingHorizontal: 18, paddingVertical: 14, borderRadius: 14, backgroundColor: '#24594c', alignItems: 'center', justifyContent: 'center' },
  secondary: { backgroundColor: '#e9f0eb' },
  buttonText: { fontSize: 15, fontWeight: '600', color: '#fff' },
  error: { color: '#a32b32', fontSize: 15, lineHeight: 22 },
});
