import { Image } from 'expo-image';
import { forwardRef, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Animated as RNAnimated,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputInstance,
} from 'react-native';
import Animated from 'react-native-reanimated';

import type { Span } from '@/api';
import { colors } from '@/theme';

import { Icon } from '../Icon';
import { AppsStrip, springLayout, type AppsMode, type ComposerApps } from './AppsStrip';

const LINE = 22;
const PAD_V = 7;
const MIN_H = LINE + PAD_V * 2;
const MAX_H = LINE * 6 + PAD_V * 2;
const HAIRLINE = '#C6C6C8';

export type { ComposerApps };

type Props = {
  value: string;
  onChangeText: (t: string) => void;
  highlights: Span[] | null;
  sendLabel: string;
  sending: boolean;
  onSend: () => void;
  /** "iMessage" in DMs, "Message" in groups. */
  placeholder: string;
  reply: { name: string; text: string; photoUri?: string | null } | null;
  onCancelReply: () => void;
  /** A picked photo waiting to be sent; the text becomes its caption. */
  attachment: { uri: string; width: number; height: number } | null;
  onRemoveAttachment: () => void;
  apps: ComposerApps;
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

/** iMessage composer: apps cluster, then a white capsule with reply/photo preview and the send circle. */
export const Composer = forwardRef<TextInputInstance, Props>(function Composer(
  {
    value,
    onChangeText,
    highlights,
    sendLabel,
    sending,
    onSend,
    placeholder,
    reply,
    onCancelReply,
    attachment,
    onRemoveAttachment,
    apps,
  },
  ref,
) {
  const hasText = value.trim().length > 0;
  const canSend = hasText || !!attachment;
  // Track the content height ourselves: a multiline input doesn't shrink back after a programmatic clear.
  const [contentHeight, setContentHeight] = useState(MIN_H);
  const inputHeight = Math.min(MAX_H, Math.max(MIN_H, value ? contentHeight : 0));
  const [glow] = useState(() => new RNAnimated.Value(0));

  const [expanded, setExpanded] = useState(false);
  const mode: AppsMode = expanded ? 'expanded' : value.length > 0 || attachment ? 'compact' : 'idle';
  // Replying brings the input back.
  useEffect(() => {
    if (reply) setExpanded(false);
  }, [reply]);

  useEffect(() => {
    if (!highlights) return;
    glow.setValue(1);
    RNAnimated.timing(glow, { toValue: 0, duration: 2400, useNativeDriver: false }).start();
  }, [highlights, glow]);

  return (
    <View style={styles.outer}>
      <AppsStrip
        mode={mode}
        apps={apps}
        onExpand={() => {
          Keyboard.dismiss();
          setExpanded(true);
        }}
        onCollapse={() => setExpanded(false)}
      />
      <Animated.View
        layout={springLayout}
        style={[styles.capsule, expanded && styles.capsuleHidden]}
        pointerEvents={expanded ? 'none' : 'auto'}
      >
        <RNAnimated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            styles.border,
            { borderColor: glow.interpolate({ inputRange: [0, 1], outputRange: [HAIRLINE, colors.blue] }) },
          ]}
        />
        {reply ? (
          <View style={styles.preview}>
            <View style={styles.replyBar} />
            <View style={styles.replyBody}>
              <Text style={styles.replyName} numberOfLines={1}>
                {reply.name}
              </Text>
              {reply.photoUri ? (
                <View style={styles.replyPhoto}>
                  <Image source={{ uri: reply.photoUri }} style={styles.replyThumb} contentFit="cover" />
                  <Text style={styles.replyText}>Photo</Text>
                </View>
              ) : (
                <Text style={styles.replyText} numberOfLines={1}>
                  {reply.text}
                </Text>
              )}
            </View>
            <Pressable onPress={onCancelReply} hitSlop={10} accessibilityRole="button" accessibilityLabel="Cancel reply">
              <Icon name="xmark.circle.fill" size={20} color={colors.textTertiary} />
            </Pressable>
          </View>
        ) : null}
        {attachment ? (
          <View style={styles.preview}>
            <View>
              <Image source={{ uri: attachment.uri }} style={styles.attachThumb} contentFit="cover" accessibilityLabel="Photo to send" />
              <Pressable
                onPress={onRemoveAttachment}
                hitSlop={8}
                style={styles.attachClose}
                accessibilityRole="button"
                accessibilityLabel="Remove photo"
              >
                <Icon name="xmark.circle.fill" size={20} color={colors.textSecondary} />
              </Pressable>
            </View>
          </View>
        ) : null}
        <View style={styles.inputRow}>
          <View style={styles.inputWrap}>
            <TextInput
              ref={ref}
              value={value}
              onChangeText={onChangeText}
              placeholder={attachment ? 'Add comment or Send' : placeholder}
              placeholderTextColor={colors.textTertiary}
              style={[styles.input, { height: inputHeight }]}
              onContentSizeChange={(e) => setContentHeight(e.nativeEvent.contentSize.height)}
              scrollEnabled={contentHeight > MAX_H}
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
            <Pressable
              onPress={onSend}
              disabled={sending}
              hitSlop={8}
              style={styles.send}
              accessibilityRole="button"
              accessibilityLabel={sendLabel}
            >
              {sending ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <Icon name="arrow.up" size={15} weight="bold" color="white" />
              )}
            </Pressable>
          ) : null}
        </View>
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  outer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 10, paddingTop: 6, paddingBottom: 8 },
  capsule: {
    flex: 1,
    minWidth: 0,
    backgroundColor: colors.bg,
    borderRadius: 18,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  capsuleHidden: { flexGrow: 0, flexBasis: 0, width: 0, opacity: 0 },
  border: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth * 2 },
  preview: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8, paddingLeft: 10, paddingRight: 8 },
  replyBar: { width: 3, alignSelf: 'stretch', borderRadius: 1.5, backgroundColor: colors.blue },
  replyBody: { flex: 1, minWidth: 0 },
  replyName: { color: colors.blue, fontSize: 13, fontWeight: '600' },
  replyText: { color: colors.textSecondary, fontSize: 15, marginTop: 1 },
  replyPhoto: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  replyThumb: { width: 32, height: 32, borderRadius: 6, backgroundColor: colors.bubbleIn },
  attachThumb: { width: 56, height: 56, borderRadius: 10, borderCurve: 'continuous', backgroundColor: colors.bubbleIn },
  attachClose: { position: 'absolute', top: -6, right: -8, backgroundColor: colors.bg, borderRadius: 10 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', paddingRight: 3 },
  inputWrap: { flex: 1 },
  input: {
    color: colors.text,
    fontSize: 17,
    lineHeight: LINE,
    paddingHorizontal: 12,
    paddingTop: PAD_V,
    paddingBottom: PAD_V,
    maxHeight: MAX_H,
  },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, color: 'transparent' },
  send: {
    width: 30,
    height: 30,
    borderRadius: 15,
    marginBottom: 3,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.blue,
  },
  highlight: { backgroundColor: colors.highlight, color: colors.text, borderRadius: 4 },
});
