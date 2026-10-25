import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';

/** Renders `**bold**` segments from a model's meaning (explain sheet, call card). */
export function BoldText({ text, style }: { text: string; style: StyleProp<TextStyle> }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <Text style={style}>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') ? (
          <Text key={i} style={styles.bold}>
            {p.slice(2, -2)}
          </Text>
        ) : (
          p
        ),
      )}
    </Text>
  );
}

const styles = StyleSheet.create({ bold: { fontWeight: '700' } });
