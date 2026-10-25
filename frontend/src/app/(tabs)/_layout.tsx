import { NativeTabs } from 'expo-router/native-tabs';

import { NowPlayingAccessory, useNowPlaying } from '@/components/shell/NowPlayingAccessory';
import { useLoreBadge } from '@/hooks/useLoreBadge';
import { useAsks } from '@/state/asks';
import { useInbox } from '@/state/inbox';
import { colors } from '@/theme';

export const unstable_settings = { anchor: 'inbox' };

/** Apple Music-style tabs: each tab is its own native Stack, with Now Playing riding above the bar. */
export default function TabsLayout() {
  const { unreadThreads } = useInbox();
  const { pendingIncoming } = useAsks();
  const nowPlaying = useNowPlaying();
  const newLore = useLoreBadge();
  return (
    <NativeTabs
      tintColor={colors.blue}
      badgeBackgroundColor={colors.red}
      minimizeBehavior="onScrollDown"
      // The accessory stays mounted; hiding it here animates it in and out.
      unstable_nativeProps={{ ios: { bottomAccessoryHidden: !nowPlaying } }}
    >
      <NativeTabs.BottomAccessory>
        <NowPlayingAccessory />
      </NativeTabs.BottomAccessory>
      <NativeTabs.Trigger name="inbox">
        <NativeTabs.Trigger.Icon sf={{ default: 'message', selected: 'message.fill' }} />
        <NativeTabs.Trigger.Label>Messages</NativeTabs.Trigger.Label>
        {unreadThreads > 0 ? <NativeTabs.Trigger.Badge>{String(unreadThreads)}</NativeTabs.Trigger.Badge> : null}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="reels">
        <NativeTabs.Trigger.Icon
          sf={{ default: 'sparkles.rectangle.stack', selected: 'sparkles.rectangle.stack.fill' }}
        />
        <NativeTabs.Trigger.Label>Lore</NativeTabs.Trigger.Label>
        {newLore > 0 ? <NativeTabs.Trigger.Badge>{String(newLore)}</NativeTabs.Trigger.Badge> : null}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="profile">
        <NativeTabs.Trigger.Icon sf={{ default: 'person.crop.circle', selected: 'person.crop.circle.fill' }} />
        <NativeTabs.Trigger.Label>You</NativeTabs.Trigger.Label>
        {pendingIncoming > 0 ? <NativeTabs.Trigger.Badge>{String(pendingIncoming)}</NativeTabs.Trigger.Badge> : null}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search" role="search" />
      <NativeTabs.Trigger name="home" hidden />
    </NativeTabs>
  );
}
