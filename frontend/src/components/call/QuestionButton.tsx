import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';

interface QuestionButtonProps {
  onTap: () => void;
  onLongPressStart: () => void;
  isLoading: boolean;
  disabled?: boolean;
}

export function QuestionButton({ onTap, onLongPressStart, isLoading, disabled }: QuestionButtonProps) {
  const [motion] = useState(() => new Animated.Value(0));
  const [press] = useState(() => new Animated.Value(0));
  const held = useRef(false);
  const [pressed, setPressed] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (active) setReducedMotion(value); });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReducedMotion);
    return () => { active = false; subscription.remove(); };
  }, []);
  useEffect(() => {
    if (reducedMotion) { motion.setValue(0); return; }
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(motion, { toValue: 1, duration: isLoading ? 650 : 2200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(motion, { toValue: 0, duration: isLoading ? 650 : 2200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    animation.start();
    return () => animation.stop();
  }, [motion, reducedMotion, isLoading]);
  const deform = (value: number) => {
    setPressed(value === 1);
    if (reducedMotion) { press.setValue(value); return; }
    Animated.spring(press, { toValue: value, speed: 18, bounciness: 9, useNativeDriver: true }).start();
  };
  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Explain recent conversation"
        accessibilityHint="Tap for a short explanation. Hold to ask a private question."
        accessibilityState={{ disabled: !!disabled || isLoading, busy: isLoading }}
        disabled={disabled || isLoading}
        onPressIn={() => { held.current = false; deform(1); }}
        onPressOut={() => deform(0)}
        onPress={() => { if (!held.current) { void Haptics.selectionAsync().catch(() => {}); onTap(); } }}
        onLongPress={() => { held.current = true; void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}); onLongPressStart(); }}
        delayLongPress={450}
        hitSlop={8}
      >
        <Animated.View style={[styles.float, { transform: [{ translateY: motion.interpolate({ inputRange: [0, 1], outputRange: [0, -5] }) }, { rotate: motion.interpolate({ inputRange: [0, 1], outputRange: ['-4deg', '4deg'] }) }] }]}>
          <Animated.View style={[styles.blob, { opacity: disabled ? 0.5 : 1, transform: [
            { scaleX: press.interpolate({ inputRange: [0, 1], outputRange: [1, 1.15] }) },
            { scaleY: press.interpolate({ inputRange: [0, 1], outputRange: [1, 0.83] }) },
          ] }]}>
            <View style={styles.highlight} />
            <View style={styles.eyes}>
              <View style={[styles.eye, pressed && styles.happyEye, isLoading && styles.thinkingEye]} />
              <View style={[styles.eye, pressed && styles.happyEye]} />
            </View>
            <View style={[styles.mouth, pressed && { width: 12, height: 5 }]} />
          </Animated.View>
        </Animated.View>
      </Pressable>
      <Text style={styles.hint}>{isLoading ? 'Thinking' : pressed ? 'Ask away' : 'Your context'}</Text>
    </View>
  );
}
const styles = StyleSheet.create({
  container: { position: 'absolute', bottom: 118, right: 26, alignItems: 'center', zIndex: 100 },
  float: { padding: 5 },
  blob: { width: 66, height: 65, backgroundColor: '#76b9ff', borderTopLeftRadius: 29, borderTopRightRadius: 35, borderBottomLeftRadius: 34, borderBottomRightRadius: 25, alignItems: 'center', justifyContent: 'center', shadowColor: '#428ce0', shadowOpacity: 0.25, shadowOffset: { width: 0, height: 7 }, shadowRadius: 16, elevation: 5 },
  highlight: { position: 'absolute', top: 7, left: 13, width: 22, height: 7, borderRadius: 8, backgroundColor: '#a9d6ff', transform: [{ rotate: '-24deg' }] },
  eyes: { flexDirection: 'row', gap: 13, marginTop: 7 },
  eye: { width: 6, height: 12, borderRadius: 5, backgroundColor: '#101923' },
  happyEye: { height: 7, borderTopLeftRadius: 5, borderTopRightRadius: 5 },
  thinkingEye: { height: 5, marginTop: 4 },
  mouth: { width: 6, height: 3, borderRadius: 5, backgroundColor: '#233e59', marginTop: 6 },
  hint: { color: '#9da9b8', fontSize: 10, marginTop: 6 },
});
