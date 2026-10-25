import { HStack, Host, Image, List, RNHostView, Section, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits,
  accessibilityElement,
  accessibilityLabel,
  contentShape,
  font,
  foregroundStyle,
  listStyle,
  onTapGesture,
  shapes,
} from '@expo/ui/swift-ui/modifiers';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';

import { Avatar } from '@/components/Avatar';
import { useSession } from '@/state/session';
import { colors } from '@/theme';

const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

/** Hidden demo-user switcher (no auth): the whole app re-renders as the picked user. */
export default function SwitchUserSheet() {
  const router = useRouter();
  const { users, me, setMe } = useSession();
  return (
    <Host style={{ flex: 1 }} colorScheme="light">
      <List modifiers={[listStyle('insetGrouped')]}>
        <Section title="Switch Profile" footer={<Text>Demo profiles. No sign-in needed.</Text>}>
          {users.map((u) => {
            const active = u.id === me?.id;
            return (
              <HStack
                key={u.id}
                spacing={12}
                modifiers={[
                  contentShape(shapes.rectangle()),
                  onTapGesture(() => {
                    Haptics.selectionAsync();
                    setMe(u.id);
                    router.back();
                  }),
                  accessibilityElement('ignore'),
                  accessibilityLabel(`${u.display_name}, @${u.username}${active ? ', current profile' : ''}`),
                  accessibilityAddTraits(active ? ['isButton', 'isSelected'] : ['isButton']),
                ]}
              >
                <RNHostView matchContents>
                  <Avatar uri={u.avatar_url} name={u.display_name} size={40} />
                </RNHostView>
                <VStack alignment="leading" spacing={1}>
                  <Text modifiers={[font({ size: 17, weight: 'semibold' })]}>{u.display_name}</Text>
                  <Text modifiers={[font({ size: 15 }), secondary]}>{`@${u.username}`}</Text>
                </VStack>
                <Spacer />
                {active ? <Image systemName="checkmark" color={colors.blue} size={17} /> : null}
              </HStack>
            );
          })}
        </Section>
      </List>
    </Host>
  );
}
