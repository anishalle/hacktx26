import { Image } from 'expo-image';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Message } from '@/api';
import { callColors as colors } from '@/theme';

import { Icon } from '../Icon';

type Props = {
  message: Message | null;
  onClose: () => void;
  /** "Save to Lore" in the bottom toolbar; the button only shows when a handler is passed. */
  onSaveToLore?: (m: Message) => void;
  /** The photo already anchors a kept moment: the button reads "In Lore" and does nothing. */
  kept?: boolean;
};

/** Full-screen photo: black backdrop, the image contained, tap anywhere or × to close. */
export function PhotoViewer({ message, onClose, onSaveToLore, kept }: Props) {
  const insets = useSafeAreaInsets();
  const image = message?.image;
  return (
    <Modal visible={!!image} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close photo">
        {image ? (
          <Image
            source={{ uri: image.url }}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            accessibilityLabel={message?.image_description ?? 'Photo'}
          />
        ) : null}
        <View style={[styles.close, { top: insets.top + 8 }]}>
          <Icon name="xmark" size={16} weight="bold" color="white" />
        </View>
        <View style={[styles.bottom, { bottom: insets.bottom + 16 }]} pointerEvents="box-none">
          {message?.text ? (
            <Text style={styles.caption} numberOfLines={4}>
              {message.text}
            </Text>
          ) : null}
          {message && onSaveToLore ? (
            <Pressable
              // Kept: still takes the tap, so it doesn't fall through and close the viewer.
              onPress={() => (kept ? undefined : onSaveToLore(message))}
              accessibilityRole="button"
              accessibilityState={{ disabled: !!kept }}
              accessibilityLabel={kept ? 'In Lore' : 'Save to Lore'}
              style={({ pressed }) => [styles.action, pressed && !kept && styles.actionPressed]}
            >
              <Icon name={kept ? 'sparkles' : 'sparkles.rectangle.stack'} size={17} weight="semibold" color="white" />
              <Text style={styles.actionLabel}>{kept ? 'In Lore' : 'Save to Lore'}</Text>
            </Pressable>
          ) : null}
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000' },
  close: {
    position: 'absolute',
    right: 16,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottom: { position: 'absolute', left: 20, right: 20, alignItems: 'center', gap: 14 },
  caption: { color: colors.text, fontSize: 16, lineHeight: 22, textAlign: 'center' },
  action: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  actionPressed: { backgroundColor: 'rgba(255,255,255,0.28)' },
  actionLabel: { color: 'white', fontSize: 15, fontWeight: '600' },
});
