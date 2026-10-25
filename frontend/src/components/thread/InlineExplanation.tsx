import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { api, type Message } from '@/api';
import { explanationKey, readExplanation, saveExplanation } from '@/features/explanationCache';
import { useMe } from '@/state/session';
import { colors } from '@/theme';
import { Icon } from '../Icon';

export function InlineExplanation({ message, onOpen, onClose, onMore }: { message: Message; onOpen: () => void; onClose: () => void; onMore: () => void }) {
  const me = useMe();
  const key = explanationKey(me.id, message.group_id, message.id);
  const [result, setResult] = useState(() => readExplanation(key));
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [reveal] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.spring(reveal, { toValue: 1, damping: 23, stiffness: 230, mass: 0.8, useNativeDriver: Platform.OS !== 'web' }).start();
    const ctrl = new AbortController();
    if (!readExplanation(key)) {
      api.explain({ group_id: message.group_id, user_id: me.id, message_id: message.id }, ctrl.signal).then(answer => {
        if (ctrl.signal.aborted) return;
        saveExplanation(key, answer);
        setResult(answer);
      }).catch(() => { if (!ctrl.signal.aborted) setError(true); });
    }
    return () => ctrl.abort();
  }, [key, me.id, message.group_id, message.id, attempt, reveal]);
  const sentence = result?.meaning.replace(/\*\*/g, '').split(/(?<=[.!?])\s+/)[0];
  return <Animated.View testID="inline-explanation" style={[styles.wrap, { opacity: reveal, transform: [{ translateY: reveal.interpolate({ inputRange: [0, 1], outputRange: [9, 0] }) }, { scale: reveal.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }] }]}>
    <View style={styles.bubble}>
      <Pressable accessibilityRole="button" accessibilityLabel={error ? 'Retry explanation' : 'Ask about this message'} disabled={!result && !error} onPress={error ? () => { setError(false); setAttempt(value => value + 1); } : onOpen} style={styles.answer}>
        {result ? <Text numberOfLines={4} style={styles.text}>{sentence}</Text> : error ? <Text style={styles.text}>Couldn’t explain this. Tap to retry.</Text> : <View style={styles.loading}><ActivityIndicator size="small" color={colors.blue} /><Text style={styles.hint}>One moment…</Text></View>}
      </Pressable>
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" accessibilityLabel="More message actions" onPress={onMore} style={styles.icon}><Text style={styles.more}>···</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss explanation" onPress={onClose} style={styles.icon}><Icon name="xmark" size={12} /></Pressable>
      </View>
    </View>
    <View style={styles.tail} />
  </Animated.View>;
}
const styles = StyleSheet.create({
  wrap: { alignSelf: 'stretch', marginBottom: 9, marginTop: 5, maxWidth: 310 },
  bubble: { backgroundColor: '#fffafd', borderRadius: 21, borderWidth: 1, borderColor: '#ffffff', shadowColor: '#6c4665', shadowOpacity: 0.12, shadowRadius: 14, shadowOffset: { width: 0, height: 5 } },
  answer: { padding: 15, paddingBottom: 7, minHeight: 44 },
  text: { color: '#594452', fontSize: 14, lineHeight: 20 },
  loading: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  hint: { color: colors.textSecondary, fontSize: 12 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', paddingRight: 5 },
  icon: { width: 36, height: 32, justifyContent: 'center', alignItems: 'center' },
  more: { color: colors.textSecondary, fontSize: 23, marginTop: -7 },
  tail: { position: 'absolute', width: 12, height: 12, backgroundColor: '#fffafd', bottom: -5, left: 22, transform: [{ rotate: '45deg' }] },
});
