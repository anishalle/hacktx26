import { Button, HStack, Host, Label, Text as SwiftText } from '@expo/ui/swift-ui';
import {
  buttonBorderShape,
  buttonStyle,
  controlSize,
  font,
  foregroundStyle,
  lineLimit,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';

import type { Call, User } from '@/api';
import { firstName } from '@/lib/format';
import { colors } from '@/theme';

import { Glass } from '../GlassCircle';

/** "Mia started a call · 3 people · Join" glass capsule under the thread header while a call is live. */
export function CallBar({ call, top, meId, onJoin }: { call: Call; top: number; meId: string; onJoin: () => void }) {
  const inCall = call.members.filter((m) => !m.left_at);
  const starter = call.members.find((m) => m.user.id === call.started_by)?.user;
  const joined = inCall.some((m) => m.user.id === meId);
  const who = (u?: User) => (!u ? 'Someone' : u.id === meId ? 'You' : firstName(u.display_name));
  const title = `${who(starter)} started a call`;
  const people = `${inCall.length} ${inCall.length === 1 ? 'person' : 'people'}`;
  const action = joined ? 'Return' : 'Join';
  return (
    <View style={[styles.wrap, { top }]} pointerEvents="box-none">
      <Glass style={styles.bar}>
        {/* matchContents measures once, so remount when a label changes. */}
        <Host matchContents colorScheme="light" key={`${title}|${people}|${action}`}>
          <HStack spacing={10}>
            <Label
              title={title}
              systemImage="video.fill"
              modifiers={[font({ size: 15, weight: 'semibold' }), lineLimit(1)]}
            />
            <SwiftText modifiers={[font({ size: 13 }), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>
              {people}
            </SwiftText>
            <Button
              label={action}
              onPress={onJoin}
              modifiers={[buttonStyle('borderedProminent'), tint(colors.green), buttonBorderShape('capsule'), controlSize('small')]}
            />
          </HStack>
        </Host>
      </Glass>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 12, right: 12, alignItems: 'center', zIndex: 9 },
  bar: { paddingLeft: 16, paddingRight: 8, paddingVertical: 8, borderRadius: 26, overflow: 'hidden' },
});
