import { HStack, Host, Image, List, RNHostView, Section, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits,
  accessibilityElement,
  accessibilityLabel,
  contentShape,
  font,
  foregroundStyle,
  lineLimit,
  listStyle,
  onTapGesture,
  shapes,
} from '@expo/ui/swift-ui/modifiers';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useMemo } from 'react';

import type { User } from '@/api';
import { Avatar } from '@/components/Avatar';
import { useSession } from '@/state/session';
import { colors } from '@/theme';

const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

/** "Dad. 52, engineer…" → "Dad": the about's first sentence, without its period. */
function role(about: string | null | undefined) {
  const text = about?.trim();
  if (!text) return null;
  const first = (text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text).replace(/\.$/, '').trim();
  return first || null;
}

/** Families together: by last name, then first (a one-word name is its own last name). */
function byFamily(a: User, b: User) {
  const key = (u: User) => {
    const parts = u.display_name.trim().split(/\s+/);
    return [parts[parts.length - 1], parts[0]];
  };
  const [al, af] = key(a);
  const [bl, bf] = key(b);
  return al.localeCompare(bl, undefined, { sensitivity: 'base' }) || af.localeCompare(bf, undefined, { sensitivity: 'base' });
}

/** Hidden demo-user switcher (no auth): the whole app re-renders as the picked user. */
export default function SwitchUserSheet() {
  const router = useRouter();
  const { users, me, setMe } = useSession();
  const sorted = useMemo(() => [...users].sort(byFamily), [users]);
  return (
    <Host style={{ flex: 1 }} colorScheme="light">
      <List modifiers={[listStyle('insetGrouped')]}>
        <Section title="Switch Profile" footer={<Text>Demo profiles. No sign-in needed.</Text>}>
          {sorted.map((u) => {
            const active = u.id === me?.id;
            const who = role(u.about);
            const subtitle = who ? `${who} · @${u.username}` : `@${u.username}`;
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
                  accessibilityLabel(`${u.display_name}, ${who ? `${who}, ` : ''}@${u.username}${active ? ', current profile' : ''}`),
                  accessibilityAddTraits(active ? ['isButton', 'isSelected'] : ['isButton']),
                ]}
              >
                <RNHostView matchContents>
                  <Avatar uri={u.avatar_url} name={u.display_name} size={40} />
                </RNHostView>
                <VStack alignment="leading" spacing={1}>
                  <Text modifiers={[font({ size: 17, weight: 'semibold' })]}>{u.display_name}</Text>
                  <Text modifiers={[font({ size: 15 }), secondary, lineLimit(1)]}>{subtitle}</Text>
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
