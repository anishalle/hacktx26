import { NativeTabs } from 'expo-router/native-tabs';

import { useInbox } from '@/state/inbox';
import { colors } from '@/theme';

export const unstable_settings = { anchor: 'inbox' };

/** Instagram's floating pill tab bar = the native iOS 26 liquid-glass tab bar, icons only. */
export default function TabsLayout() {
  const { unreadThreads } = useInbox();
  return (
    <NativeTabs tintColor={colors.text} iconColor={colors.text} badgeBackgroundColor={colors.red} minimizeBehavior="never">
      <NativeTabs.Trigger name="home">
        <NativeTabs.Trigger.Icon sf={{ default: 'house', selected: 'house.fill' }} />
        <NativeTabs.Trigger.Label hidden>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="reels">
        <NativeTabs.Trigger.Icon sf={{ default: 'play.rectangle', selected: 'play.rectangle.fill' }} />
        <NativeTabs.Trigger.Label hidden>Reels</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="inbox">
        <NativeTabs.Trigger.Icon sf={{ default: 'paperplane', selected: 'paperplane.fill' }} />
        <NativeTabs.Trigger.Label hidden>Messages</NativeTabs.Trigger.Label>
        {unreadThreads > 0 ? <NativeTabs.Trigger.Badge>{String(unreadThreads)}</NativeTabs.Trigger.Badge> : null}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search">
        <NativeTabs.Trigger.Icon sf="magnifyingglass" />
        <NativeTabs.Trigger.Label hidden>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="profile">
        <NativeTabs.Trigger.Icon sf={{ default: 'person.crop.circle', selected: 'person.crop.circle.fill' }} />
        <NativeTabs.Trigger.Label hidden>Profile</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
