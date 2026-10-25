import { Image } from 'expo-image';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Message } from '@/api';
import { callColors as colors } from '@/theme';

import { Icon } from '../Icon';

/** Full-screen photo: black backdrop, the image contained, tap anywhere or × to close. */
export function PhotoViewer({ message, onClose }: { message: Message | null; onClose: () => void }) {
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
        {message?.text ? (
          <Text style={[styles.caption, { bottom: insets.bottom + 24 }]} numberOfLines={4}>
            {message.text}
          </Text>
        ) : null}
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
  caption: { position: 'absolute', left: 20, right: 20, color: colors.text, fontSize: 16, lineHeight: 22, textAlign: 'center' },
});
