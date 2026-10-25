import { Button, Form, HStack, Host, Image, LabeledContent, RNHostView, Section, Text, VStack } from '@expo/ui/swift-ui';
import { badge, contentShape, font, foregroundStyle, onTapGesture, shapes } from '@expo/ui/swift-ui/modifiers';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';

import { api } from '@/api';
import { Avatar } from '@/components/Avatar';
import { useAsks } from '@/state/asks';
import { useMe } from '@/state/session';
import { colors } from '@/theme';

const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });
const tertiary = foregroundStyle({ type: 'hierarchical', style: 'tertiary' });

/** You: a short settings-style SwiftUI Form, so it skips the RN ScrollView the other tabs use. */
export default function ProfileScreen() {
  const me = useMe();
  const router = useRouter();
  const { pendingIncoming } = useAsks();
  const [pinned, setPinned] = useState<number | null>(null);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      api
        .getLoreFeed(me.id, { pinned: true, limit: 1 })
        .then((feed) => !cancelled && setPinned(feed.counts.pinned))
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }, [me.id]),
  );
  const openPinned = () => router.navigate({ pathname: '/reels', params: { pinned: '1' } });
  return (
    <>
      <Stack.Title large>You</Stack.Title>
      <Host style={{ flex: 1 }} colorScheme="light">
        <Form>
          <Section>
            <HStack spacing={16}>
              <RNHostView matchContents>
                <Avatar uri={me.avatar_url} name={me.display_name} size={72} />
              </RNHostView>
              <VStack alignment="leading" spacing={2}>
                <Text modifiers={[font({ size: 22, weight: 'bold' })]}>{me.display_name}</Text>
                <Text modifiers={[secondary]}>{`@${me.username}`}</Text>
              </VStack>
            </HStack>
            {me.about ? <Text modifiers={[font({ size: 15 }), secondary]}>{me.about}</Text> : null}
          </Section>
          <Section title="About You">
            <LabeledContent label="Pronounced">
              {me.phonetic_hint ? (
                <HStack spacing={6}>
                  <Text>{me.phonetic_hint}</Text>
                  <Image systemName="waveform" color={colors.blue} />
                </HStack>
              ) : (
                <Text modifiers={[secondary]}>Not Set</Text>
              )}
            </LabeledContent>
          </Section>
          <Section>
            <Button
              label="Message Requests"
              systemImage="bubble.left.and.text.bubble.right"
              onPress={() => router.push('/requests')}
              modifiers={pendingIncoming ? [badge(String(pendingIncoming))] : undefined}
            />
            <Button label="Switch Profile" systemImage="person.2" onPress={() => router.push('/switch-user')} />
          </Section>
          <Section title="Lore">
            <LabeledContent
              label="Pinned Moments"
              modifiers={[contentShape(shapes.rectangle()), onTapGesture(openPinned)]}
            >
              <HStack spacing={8}>
                <Text modifiers={[secondary]}>{pinned == null ? '–' : String(pinned)}</Text>
                <Image systemName="chevron.forward" size={13} modifiers={[tertiary]} />
              </HStack>
            </LabeledContent>
          </Section>
        </Form>
      </Host>
    </>
  );
}
