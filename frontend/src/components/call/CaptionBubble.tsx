import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import type { SpeakerCaption } from '@/hooks/useCall';

const HIDE_AFTER_MS = 4000;
const PAD_H = 12;
const PAD_V = 8;
const BG = 'rgba(255,248,253,0.94)';

type Props = {
  caption: SpeakerCaption | undefined;
  /** Width the text wraps at (the bubble shrinks to fit shorter text). */
  maxWidth: number;
  small?: boolean;
  /** Which side the little tail sits on, toward the speaker's tile. */
  tail: 'left' | 'right';
};

/**
 * A speaker's live caption. The bubble grows with the words of the turn in progress up to three
 * lines; past that, older lines slide up under a fade at the top. Finished turns stay above the live
 * one (dimmer) until pushed out. It fades away after a few seconds of silence.
 */
export function CaptionBubble({ caption, maxWidth, small, tail }: Props) {
  const fontSize = small ? 13 : 15;
  const lineHeight = small ? 17 : 20;
  const maxHeight = lineHeight * 3 + PAD_V * 2;
  const [size] = useState(() => new Animated.ValueXY({ x: 0, y: 0 }));
  const [opacity] = useState(() => new Animated.Value(0));
  const [measured, setMeasured] = useState({ w: 0, h: 0 });

  const updatedAt = caption?.updatedAt ?? 0;
  const hasText = !!caption && (caption.finished.length > 0 || !!caption.live?.text);

  // Show on every update; fade out once the speaker has been quiet for a while.
  useEffect(() => {
    if (!hasText) return;
    Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: false }).start();
    const t = setTimeout(
      () => Animated.timing(opacity, { toValue: 0, duration: 450, useNativeDriver: false }).start(),
      Math.max(0, HIDE_AFTER_MS - (Date.now() - updatedAt)),
    );
    return () => clearTimeout(t);
  }, [updatedAt, hasText, opacity]);

  useEffect(() => {
    if (!measured.w) return;
    Animated.timing(size, {
      toValue: { x: measured.w + PAD_H * 2, y: Math.min(measured.h + PAD_V * 2, maxHeight) },
      duration: 140,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [measured, maxHeight, size]);

  if (!caption) return null;
  // One line break between turns; the live turn (if any) is last and brightest.
  const turns = [...caption.finished.map((text) => ({ text, live: false })), ...(caption.live?.text ? [{ text: caption.live.text, live: true }] : [])];
  const body = turns.map((t, i) => (
    <Text key={i} style={t.live ? styles.live : styles.finished}>
      {i ? '\n' : ''}
      {t.text}
    </Text>
  ));
  const textStyle = { fontSize, lineHeight };
  const overflowing = measured.h + PAD_V * 2 > maxHeight;

  return (
    <View pointerEvents="none" style={{ width: maxWidth, alignItems: tail === 'left' ? 'flex-start' : 'flex-end' }}>
      {/* Invisible copy that measures the full text at the wrap width. */}
      <Text
        style={[styles.text, textStyle, styles.measure, { width: maxWidth - PAD_H * 2 }]}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          if (Math.abs(width - measured.w) > 0.5 || Math.abs(height - measured.h) > 0.5) setMeasured({ w: width, h: height });
        }}>
        {body}
      </Text>
      <Animated.View style={{ opacity }}>
        <View style={[styles.tail, tail === 'left' ? { left: 16 } : { right: 16 }]} />
        <Animated.View style={[styles.bubble, { width: size.x, height: size.y }]}>
          <Text style={[styles.text, textStyle, styles.bottom, { width: measured.w }]}>{body}</Text>
          {overflowing ? (
            <LinearGradient colors={[BG, 'rgba(255,248,253,0)']} style={styles.fade} pointerEvents="none" />
          ) : null}
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: { backgroundColor: BG, borderRadius: 18, overflow: 'hidden' },
  tail: {
    position: 'absolute',
    top: -5,
    width: 12,
    height: 12,
    backgroundColor: BG,
    transform: [{ rotate: '45deg' }],
    borderRadius: 2,
  },
  text: { color: '#332936', fontWeight: '500' },
  measure: { position: 'absolute', opacity: 0, alignSelf: 'flex-start' },
  // Anchored to the bottom so the newest line stays in view and older ones slide up and out.
  bottom: { position: 'absolute', left: PAD_H, bottom: PAD_V },
  finished: { color: '#766575' },
  live: { color: '#332936' },
  fade: { position: 'absolute', top: 0, left: 0, right: 0, height: 22 },
});
