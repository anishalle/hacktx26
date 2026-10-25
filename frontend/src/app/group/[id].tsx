import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Button,
  Form,
  HStack,
  Host,
  Image as SwiftImage,
  ProgressView,
  RNHostView,
  Section,
  Spacer,
  Text as SwiftText,
  Toggle,
  VStack,
} from '@expo/ui/swift-ui';
import {
  buttonStyle,
  controlSize,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  listRowBackground,
  multilineTextAlignment,
} from '@expo/ui/swift-ui/modifiers';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { SFSymbol } from 'expo-symbols';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { api, type GroupDetail, type Lore } from '@/api';
import { Avatar, GroupAvatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { useInbox } from '@/state/inbox';
import { useMe } from '@/state/session';
import { colors } from '@/theme';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });
const hideAlertsKey = (groupId: number) => `hide_alerts_${groupId}`;

function shortDate(iso: string) {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** The moment's thumbnail: its photo, a waveform tile for a call, or a quote tile. */
function LoreThumb({ lore }: { lore: Lore }) {
  const photo = lore.cover.photo?.image?.url;
  if (photo) return <Image source={{ uri: photo }} style={styles.thumb} contentFit="cover" />;
  const replay = !!lore.cover.replay;
  return (
    <View style={[styles.thumb, styles.thumbTile, { backgroundColor: replay ? colors.blue : colors.accentSoft }]}>
      <Icon name={replay ? 'waveform' : 'quote.bubble.fill'} size={20} color={replay ? '#FFFFFF' : colors.blue} />
    </View>
  );
}

/** Group info sheet (iMessage's "Details"): calls and apps, recent Lore, members, Hide Alerts. */
export default function GroupInfoScreen() {
  const params = useLocalSearchParams<{ id: string; name?: string }>();
  const groupId = Number(params.id);
  const router = useRouter();
  const me = useMe();
  const inbox = useInbox();
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [lore, setLore] = useState<Lore[] | null>(null);
  const [hideAlerts, setHideAlerts] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getGroup(groupId, me.id)
      .then((g) => !cancelled && setGroup(g))
      .catch(() => {});
    api
      .getLoreFeed(me.id, { group_id: groupId, limit: 3 })
      .then((f) => !cancelled && setLore(f.items.slice(0, 3)))
      .catch(() => !cancelled && setLore([]));
    AsyncStorage.getItem(hideAlertsKey(groupId))
      .then((v) => !cancelled && setHideAlerts(v === '1'))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [groupId, me.id]);

  const name = group?.name ?? params.name ?? '';
  const others = useMemo(() => (group?.members ?? []).filter((m) => m.user.id !== me.id), [group, me.id]);
  const isDm = !!group?.is_dm;
  const avatarUrl = group?.avatar_url ?? (isDm ? (others[0]?.user.avatar_url ?? null) : null);
  const unread = (inbox.items.find((it) => it.group.id === groupId)?.unread_count ?? 0) > 0;

  // Close the sheet, then go: the thread stays underneath.
  const go = (fn: () => void) => () => {
    Haptics.selectionAsync();
    router.back();
    fn();
  };
  const openCall = go(() => router.push({ pathname: '/call/[groupId]', params: { groupId: String(groupId), name } }));
  const openLoreTab = go(() => router.push({ pathname: '/reels', params: { group: String(groupId) } }));

  const actions: { label: string; icon: SFSymbol; onPress: () => void }[] = [
    { label: 'Audio', icon: 'phone.fill', onPress: openCall },
    { label: 'Video', icon: 'video.fill', onPress: openCall },
    ...(unread
      ? [
          {
            label: 'Catch Up',
            icon: 'text.bubble.fill' as SFSymbol,
            onPress: go(() => router.push({ pathname: '/catchup', params: { groupId: String(groupId) } })),
          },
        ]
      : []),
    { label: 'Lore', icon: 'sparkles.rectangle.stack.fill', onPress: openLoreTab },
  ];

  const setHide = (on: boolean) => {
    setHideAlerts(on);
    AsyncStorage.setItem(hideAlertsKey(groupId), on ? '1' : '0').catch(() => {});
  };

  return (
    <Host style={{ flex: 1 }} colorScheme="light">
      <Form>
        <Section modifiers={[listRowBackground('clear')]}>
          <VStack spacing={8} modifiers={[frame({ maxWidth: Infinity })]}>
            <RNHostView matchContents>
              {isDm || group?.avatar_url ? (
                <Avatar uri={avatarUrl} name={name} size={72} />
              ) : (
                <GroupAvatar
                  uris={others.slice(0, 2).map((m) => m.user.avatar_url)}
                  names={others.slice(0, 2).map((m) => m.user.display_name)}
                  size={72}
                />
              )}
            </RNHostView>
            <SwiftText modifiers={[font({ size: 22, weight: 'bold' }), multilineTextAlignment('center')]}>{name}</SwiftText>
            {group && !isDm ? <SwiftText modifiers={[font({ size: 15 }), secondary]}>{`${group.member_count} people`}</SwiftText> : null}
          </VStack>
        </Section>

        <Section modifiers={[listRowBackground('clear')]}>
          <HStack spacing={8}>
            {actions.map((a) => (
              <Button key={a.label} onPress={a.onPress} modifiers={[buttonStyle('bordered'), controlSize('large')]}>
                <VStack spacing={4} modifiers={[frame({ maxWidth: Infinity })]}>
                  {/* A fixed box so taller symbols (the Lore stack) don't make their button taller. */}
                  <SwiftImage systemName={a.icon} size={18} modifiers={[frame({ height: 22 })]} />
                  <SwiftText modifiers={[font({ size: 12, weight: 'medium' })]}>{a.label}</SwiftText>
                </VStack>
              </Button>
            ))}
          </HStack>
        </Section>

        <Section title="Lore">
          {lore === null ? (
            <ProgressView />
          ) : lore.length === 0 ? (
            <SwiftText modifiers={[secondary]}>Moments your group keeps show up here.</SwiftText>
          ) : (
            lore.map((l) => (
              <Button key={l.id} onPress={go(() => router.push({ pathname: '/lore/[id]', params: { id: String(l.id) } }))}>
                <HStack spacing={12}>
                  <RNHostView matchContents>
                    <LoreThumb lore={l} />
                  </RNHostView>
                  <VStack alignment="leading" spacing={2}>
                    <SwiftText modifiers={[font({ size: 17, weight: 'semibold' }), foregroundStyle('primary'), lineLimit(2)]}>
                      {l.title}
                    </SwiftText>
                    {/* A plain gray: hierarchical secondary picks up the Button's blue tint. */}
                    <SwiftText modifiers={[font({ size: 13 }), foregroundStyle(colors.textSecondary)]}>{shortDate(l.started_at)}</SwiftText>
                  </VStack>
                  <Spacer />
                </HStack>
              </Button>
            ))
          )}
          <Button label="See All in Lore" onPress={openLoreTab} />
        </Section>

        {group ? (
          <Section title={isDm ? 'Contact' : `${group.member_count} Members`}>
            {group.members.map((mem) => (
              <HStack key={mem.user.id} spacing={12}>
                <RNHostView matchContents>
                  <Avatar uri={mem.user.avatar_url} name={mem.user.display_name} size={36} />
                </RNHostView>
                <VStack alignment="leading" spacing={1}>
                  <SwiftText modifiers={[font({ size: 17 })]}>
                    {mem.user.id === me.id ? `${mem.user.display_name} (You)` : mem.user.display_name}
                  </SwiftText>
                  <SwiftText modifiers={[font({ size: 13 }), secondary]}>{`@${mem.user.username}`}</SwiftText>
                  {mem.user.phonetic_hint ? (
                    <HStack spacing={4}>
                      <SwiftImage systemName="waveform" size={11} color={colors.textSecondary} />
                      <SwiftText modifiers={[font({ size: 13 }), secondary]}>{mem.user.phonetic_hint}</SwiftText>
                    </HStack>
                  ) : null}
                </VStack>
                <Spacer />
              </HStack>
            ))}
          </Section>
        ) : (
          <Section>
            <ProgressView />
          </Section>
        )}

        <Section footer={<SwiftText>Mutes notifications from this conversation on this device.</SwiftText>}>
          <Toggle label="Hide Alerts" systemImage="bell.slash" isOn={hideAlerts} onIsOnChange={setHide} />
        </Section>
      </Form>
    </Host>
  );
}

const styles = StyleSheet.create({
  thumb: { width: 44, height: 44, borderRadius: 10, borderCurve: 'continuous', backgroundColor: colors.bubbleIn },
  thumbTile: { alignItems: 'center', justifyContent: 'center' },
});
