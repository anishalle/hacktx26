import { Button, HStack, Host } from '@expo/ui/swift-ui';
import { buttonBorderShape, buttonStyle, controlSize, disabled, tint } from '@expo/ui/swift-ui/modifiers';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { Lore } from '@/api';
import { LoreThumb } from '@/components/lore/MomentRow';
import { firstName } from '@/lib/format';
import { colors } from '@/theme';

type Props = {
  lore: Lore;
  onKeep: () => Promise<void>;
  onDismiss: () => void;
};

/**
 * Under a moment's messages, like an iMessage system card: anyone in the group can keep it as Lore
 * (first tap wins) or pass. Just the title and a real line from the moment, no AI prose.
 */
export function LoreSuggestionCard({ lore, onKeep, onDismiss }: Props) {
  const [busy, setBusy] = useState(false);
  const keep = async () => {
    if (busy) return;
    setBusy(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    try {
      await onKeep();
    } finally {
      setBusy(false);
    }
  };
  const first = lore.events.flatMap((e) => e.snippets)[0] ?? null;
  const who = first ? (first.is_me ? 'You' : first.user ? firstName(first.user.display_name) : null) : null;
  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <View style={styles.top}>
          <LoreThumb lore={lore} size={44} radius={10} />
          <View style={styles.text}>
            <Text style={styles.ask}>Keep as Lore?</Text>
            <Text style={styles.title} numberOfLines={2}>
              {lore.title}
            </Text>
          </View>
        </View>
        {first ? (
          <Text style={styles.snippet} numberOfLines={2}>
            {who ? <Text style={styles.who}>{who}: </Text> : null}
            {first.text}
          </Text>
        ) : null}
        {/* matchContents measures once, so remount when the buttons change. */}
        <Host matchContents style={styles.actions} key={busy ? 'busy' : 'idle'}>
          <HStack spacing={10}>
            <Button
              label="Keep"
              systemImage="sparkles.rectangle.stack"
              onPress={keep}
              modifiers={[
                buttonStyle('borderedProminent'),
                tint(colors.blue),
                buttonBorderShape('capsule'),
                controlSize('small'),
                disabled(busy),
              ]}
            />
            <Button
              label="Not Now"
              onPress={onDismiss}
              modifiers={[buttonStyle('bordered'), buttonBorderShape('capsule'), controlSize('small'), disabled(busy)]}
            />
          </HStack>
        </Host>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', marginVertical: 12 },
  card: {
    width: 280,
    backgroundColor: colors.bg,
    borderRadius: 20,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    boxShadow: '0 4px 14px rgba(0,0,0,0.06)',
    padding: 14,
    gap: 10,
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  text: { flex: 1, minWidth: 0 },
  ask: { color: colors.textSecondary, fontSize: 13 },
  title: { color: colors.text, fontSize: 17, fontWeight: '600', lineHeight: 22, marginTop: 1 },
  snippet: { color: colors.textSecondary, fontSize: 15, lineHeight: 20 },
  who: { color: colors.text, fontWeight: '600' },
  actions: { alignSelf: 'center', marginTop: 2 },
});
