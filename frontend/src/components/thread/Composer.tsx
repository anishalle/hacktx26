import { Image } from 'expo-image';
import { forwardRef, useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, TextInput, View, type TextInputInstance } from 'react-native';

import type { Span } from '@/api';
import { colors } from '@/theme';

import { Icon } from '../Icon';

const LINE = 22;
const PAD_V = 8;

type Props = {
  value: string;
  onChangeText: (t: string) => void;
  highlights: Span[] | null;
  sendLabel: string;
  sending: boolean;
  onSend: () => void;
  reply: { name: string; text: string } | null;
  onCancelReply: () => void;
  /** A picked photo waiting to be sent; the text becomes its caption. */
  attachment: { uri: string; width: number; height: number } | null;
  onPickPhoto: () => void;
  onRemoveAttachment: () => void;
};

/** Overlay runs: plain text is transparent (the input shows it), changed spans get a highlight. */
function segments(text: string, spans: Span[] | null) {
  if (!spans?.length) return [<Text key="all">{text}</Text>];
  const out = [];
  let cursor = 0;
  [...spans]
    .sort((a, b) => a.start - b.start)
    .forEach((s, i) => {
      const start = Math.max(cursor, Math.min(s.start, text.length));
      const end = Math.min(text.length, s.end);
      if (start > cursor) out.push(<Text key={`p${i}`}>{text.slice(cursor, start)}</Text>);
      if (end > start)
        out.push(
          <Text key={`h${i}`} style={styles.highlight}>
            {text.slice(start, end)}
          </Text>,
        );
      cursor = Math.max(cursor, end);
    });
  if (cursor < text.length) out.push(<Text key="tail">{text.slice(cursor)}</Text>);
  return out;
}

/** Instagram DM composer: dark pill, blue camera button, icons that swap to a blue "Send". */
export const Composer = forwardRef<TextInputInstance, Props>(function Composer(
  { value, onChangeText, highlights, sendLabel, sending, onSend, reply, onCancelReply, attachment, onPickPhoto, onRemoveAttachment },
  ref,
) {
  const hasText = value.trim().length > 0;
  const canSend = hasText || !!attachment;
  // Track the content height ourselves: a multiline input doesn't shrink back after a programmatic clear.
  const [contentHeight, setContentHeight] = useState(LINE + PAD_V * 2);
  const inputHeight = Math.min(120, Math.max(LINE + PAD_V * 2, value ? contentHeight : 0));
  const [glow] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!highlights) return;
    glow.setValue(1);
    Animated.timing(glow, { toValue: 0, duration: 2400, useNativeDriver: false }).start();
  }, [highlights, glow]);

  return (
    <View style={styles.outer}>
      {reply ? (
        <View style={styles.reply}>
          <View style={{ flex: 1 }}>
            <Text style={styles.replyTitle}>
              Replying to <Text style={{ fontWeight: '700' }}>{reply.name}</Text>
            </Text>
            <Text style={styles.replyText} numberOfLines={1}>
              {reply.text}
            </Text>
          </View>
          <Pressable onPress={onCancelReply} hitSlop={10}>
            <Icon name="xmark" size={14} color={colors.textSecondary} />
          </Pressable>
        </View>
      ) : null}
      <Animated.View
        style={[
          styles.box,
          {
            borderColor: glow.interpolate({ inputRange: [0, 1], outputRange: ['rgba(160,51,255,0)', 'rgba(160,51,255,0.9)'] }),
          },
        ]}>
        {attachment ? (
          <View style={styles.attachment}>
            <Image
              source={{ uri: attachment.uri }}
              style={[styles.thumb, { aspectRatio: Math.max(0.5, Math.min(2, attachment.width / attachment.height)) }]}
              contentFit="cover"
              accessibilityLabel="Photo to send"
            />
            <Pressable onPress={onRemoveAttachment} hitSlop={8} style={styles.thumbClose} accessibilityLabel="Remove photo">
              <Icon name="xmark" size={11} weight="bold" color="white" />
            </Pressable>
          </View>
        ) : null}
        <View style={styles.row}>
          <Pressable onPress={onPickPhoto} style={styles.camera} accessibilityRole="button" accessibilityLabel="Choose a photo">
            <Icon name="plus" size={18} color="white" />
          </Pressable>
          <View style={styles.inputWrap}>
            <TextInput
              ref={ref}
              value={value}
              onChangeText={onChangeText}
              accessibilityLabel="Message"
              placeholder={attachment ? 'Add a caption...' : 'Message...'}
              placeholderTextColor={colors.textSecondary}
              style={[styles.input, { height: inputHeight }]}
              onContentSizeChange={(e) => setContentHeight(e.nativeEvent.contentSize.height)}
              scrollEnabled={contentHeight > 120}
              multiline
              keyboardAppearance="light"
              selectionColor={colors.blue}
            />
            {highlights ? (
              <Text pointerEvents="none" style={[styles.input, styles.overlay]}>
                {segments(value, highlights)}
              </Text>
            ) : null}
          </View>
          {canSend ? (
            <Pressable onPress={onSend} disabled={sending} hitSlop={8} style={styles.sendBtn} accessibilityRole="button">
              {sending ? (
                <ActivityIndicator size="small" color={colors.blue} />
              ) : (
                <Text style={styles.send}>{sendLabel}</Text>
              )}
            </Pressable>
          ) : (
            <View style={styles.icons}>
              <Pressable onPress={onPickPhoto} hitSlop={6} accessibilityLabel="Send a photo">
                <Icon name="photo" size={24} />
              </Pressable>
            </View>
          )}
        </View>
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  outer: { paddingHorizontal: 10, paddingBottom: 6 },
  reply: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginBottom: 6,
    gap: 10,
  },
  replyTitle: { color: colors.text, fontSize: 13 },
  replyText: { color: colors.textSecondary, fontSize: 13, marginTop: 1 },
  box: { backgroundColor: '#ffffffcc', borderRadius: 26, borderWidth: 1.5 },
  row: { flexDirection: 'row', alignItems: 'flex-end', minHeight: 48, paddingLeft: 5, paddingRight: 14, paddingVertical: 5 },
  attachment: { alignSelf: 'flex-start', marginTop: 10, marginLeft: 10 },
  thumb: { height: 150, borderRadius: 16, backgroundColor: colors.surface },
  thumbClose: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  camera: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.blue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputWrap: { flex: 1 },
  input: {
    color: colors.text,
    fontSize: 17,
    lineHeight: LINE,
    paddingHorizontal: 10,
    paddingTop: PAD_V,
    paddingBottom: PAD_V,
    maxHeight: 120,
  },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, color: 'transparent' },
  icons: { flexDirection: 'row', alignItems: 'center', gap: 14, height: 38 },
  sendBtn: { height: 38, justifyContent: 'center', paddingLeft: 4 },
  send: { color: colors.blue, fontSize: 16, fontWeight: '700' },
  highlight: { backgroundColor: colors.highlight, color: '#FFFFFF', borderRadius: 4 },
});
