import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { colors } from '@/theme';

export const QUICK_REACTIONS = ['❤️', '😂', '😮', '😢', '😡', '👍'] as const;
type Props = { children: ReactElement; onReact: (emoji: string) => void; onReply: () => void; onCopy: () => void; onExplain: () => void; actionsVisible?: boolean; onCloseActions?: () => void };

/** Browser equivalent of the native menu; retains all existing message actions. */
export function MessageMenu({ children, onReact, onReply, onCopy, onExplain, actionsVisible = false, onCloseActions }: Props) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const held = useRef(false);
  const cancel = () => { if (timer.current) clearTimeout(timer.current); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const close = () => { setOpen(false); onCloseActions?.(); };
  const action = (run: () => void) => { close(); run(); };
  return <>
    <div tabIndex={0} role="group" aria-label="Message. Hold to explain." style={{ maxWidth: '100%', WebkitTouchCallout: 'none', userSelect: 'none' }}
      onContextMenu={event => { event.preventDefault(); cancel(); setOpen(true); }}
      onPointerDownCapture={event => { cancel(); held.current = false; origin.current = { x: event.clientX, y: event.clientY }; timer.current = setTimeout(() => { held.current = true; onExplain(); }, 450); }}
      onPointerMoveCapture={event => { if (Math.abs(event.clientX - origin.current.x) + Math.abs(event.clientY - origin.current.y) > 12) cancel(); }}
      onPointerUpCapture={cancel} onPointerCancelCapture={cancel}
      onClickCapture={event => { if (held.current) { event.preventDefault(); event.stopPropagation(); held.current = false; } }}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onExplain(); } else if (event.shiftKey && event.key === 'F10') { event.preventDefault(); setOpen(true); } }}>
      {children}
    </div>
    <Modal transparent visible={open || actionsVisible} animationType="fade" onRequestClose={close}>
      <View style={styles.overlay}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close message actions" style={StyleSheet.absoluteFill} onPress={close} />
        <BlurView tint="light" intensity={80} style={styles.menu}>
          <View style={styles.reactions}>{QUICK_REACTIONS.map(emoji => <Pressable key={emoji} accessibilityRole="button" accessibilityLabel={'React ' + emoji} onPress={() => action(() => onReact(emoji))} style={styles.reaction}><Text style={styles.emoji}>{emoji}</Text></Pressable>)}</View>
          {[{ label: 'Reply', run: onReply }, { label: 'Copy', run: onCopy }, { label: 'Explain', run: onExplain }].map(item => <Pressable key={item.label} accessibilityRole="button" onPress={() => action(item.run)} style={styles.action}><Text style={styles.label}>{item.label}</Text></Pressable>)}
        </BlurView>
      </View>
    </Modal>
  </>;
}
const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#40304433', padding: 20 },
  menu: { width: '100%', maxWidth: 340, borderRadius: 28, overflow: 'hidden', backgroundColor: '#fff8fce6', borderWidth: 1, borderColor: '#ffffff' },
  reactions: { flexDirection: 'row', justifyContent: 'space-around', padding: 10 },
  reaction: { padding: 8, minWidth: 44, minHeight: 44 },
  emoji: { fontSize: 23 },
  action: { minHeight: 52, justifyContent: 'center', paddingHorizontal: 24, borderTopWidth: 1, borderColor: '#e5d6e2' },
  label: { fontSize: 16, color: colors.text },
});
