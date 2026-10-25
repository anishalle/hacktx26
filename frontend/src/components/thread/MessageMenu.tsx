import { type ReactElement } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/theme';
export const QUICK_REACTIONS = ['❤️', '😂', '😮', '😢', '😡', '👍'] as const;
type Props = { children: ReactElement; onReact: (emoji: string) => void; onReply: () => void; onCopy: () => void; onExplain: () => void; actionsVisible?: boolean; onCloseActions?: () => void };
/** Long press belongs to the message; supplementary actions stay available from its explanation. */
export function MessageMenu({ children, onReact, onReply, onCopy, onExplain, actionsVisible = false, onCloseActions }: Props) {
  const action = (run: () => void) => { onCloseActions?.(); run(); };
  return <View>{children}<Modal transparent visible={actionsVisible} animationType="fade" onRequestClose={onCloseActions}>
    <View style={styles.overlay}><Pressable accessibilityLabel="Close message actions" accessibilityRole="button" style={StyleSheet.absoluteFill} onPress={onCloseActions} /><View style={styles.menu}>
      <View style={styles.reactions}>{QUICK_REACTIONS.map(emoji => <Pressable key={emoji} accessibilityRole="button" accessibilityLabel={'React ' + emoji} onPress={() => action(() => onReact(emoji))} style={styles.reaction}><Text style={styles.emoji}>{emoji}</Text></Pressable>)}</View>
      {[{ label: 'Reply', run: onReply }, { label: 'Copy', run: onCopy }, { label: 'Explain', run: onExplain }].map(item => <Pressable key={item.label} accessibilityRole="button" onPress={() => action(item.run)} style={styles.action}><Text style={styles.label}>{item.label}</Text></Pressable>)}
    </View></View>
  </Modal></View>;
}
const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#40304433', padding: 20 },
  menu: { width: '100%', maxWidth: 340, borderRadius: 28, backgroundColor: '#fff8fc', borderWidth: 1, borderColor: '#ffffff', overflow: 'hidden' },
  reactions: { flexDirection: 'row', justifyContent: 'space-around', padding: 10 },
  reaction: { padding: 8, minWidth: 44, minHeight: 44 },
  emoji: { fontSize: 23 },
  action: { minHeight: 52, justifyContent: 'center', paddingHorizontal: 24, borderTopWidth: 1, borderColor: '#e5d6e2' },
  label: { fontSize: 16, color: colors.text },
});
