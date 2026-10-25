import { NativeTabs } from 'expo-router/native-tabs';
import { useInbox } from '@/state/inbox';
import { colors } from '@/theme';

export const unstable_settings = { anchor: 'inbox' };

export default function TabsLayout() {
  const { unreadThreads } = useInbox();
  return (
    <NativeTabs
      tintColor={colors.blue}
      iconColor={colors.textSecondary}
      backgroundColor={colors.bg}
      badgeBackgroundColor={colors.blue}
      minimizeBehavior="never"
      disableTransparentOnScrollEdge
    >
      <NativeTabs.Trigger name="inbox">
        <NativeTabs.Trigger.Icon
          sf={{ default: 'bubble.left.and.bubble.right', selected: 'bubble.left.and.bubble.right.fill' }}
        />
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
        {unreadThreads > 0 ? <NativeTabs.Trigger.Badge>{String(unreadThreads)}</NativeTabs.Trigger.Badge> : null}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="reels">
        <NativeTabs.Trigger.Icon sf={{ default: 'play.rectangle', selected: 'play.rectangle.fill' }} />
        <NativeTabs.Trigger.Label>Lore</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search">
        <NativeTabs.Trigger.Icon sf="magnifyingglass" />
        <NativeTabs.Trigger.Label>Find</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="profile">
        <NativeTabs.Trigger.Icon sf={{ default: 'person.crop.circle', selected: 'person.crop.circle.fill' }} />
        <NativeTabs.Trigger.Label>You</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="home" hidden />
    </NativeTabs>
  );
}
