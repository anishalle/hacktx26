import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatCount } from '@/lib/format';
import { colors } from '@/theme';

import { Avatar, GroupAvatar } from '../Avatar';
import { Glass } from '../GlassCircle';
import { Icon } from '../Icon';

type Props = {
  title: string;
  avatarUrl: string | null;
  /** Other members' photos, for a group without its own avatar. */
  memberAvatars?: (string | null)[];
  /** The same members' names, for initials. */
  memberNames?: string[];
  isGroup: boolean;
  /** Unread threads elsewhere, shown next to the back chevron ("‹ 12"). */
  unreadCount: number;
  onBack: () => void;
  onOpenInfo: () => void;
  onVideo: () => void;
  onAudio: () => void;
};

export const HEADER_ROW = 76;

/** iMessage header: glass back capsule, centered avatar over "Name ›", glass call capsule. */
export function ThreadHeader({ title, avatarUrl, memberAvatars, memberNames, isGroup, unreadCount, onBack, onOpenInfo, onVideo, onAudio }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 2 }]} pointerEvents="box-none">
      {/* Blurs what scrolls under the solid part, so bubble text never ghosts through behind the name. */}
      <BlurView tint="light" intensity={40} style={styles.blur} pointerEvents="none" />
      <LinearGradient
        colors={['rgba(255,255,255,0.92)', 'rgba(255,255,255,0.92)', 'rgba(255,255,255,0)']}
        // Solid through the name line so bubbles scrolling underneath never collide with it.
        locations={[0, 0.86, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={styles.row} pointerEvents="box-none">
        <Pressable
          onPress={onBack}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={unreadCount ? `Back, ${unreadCount} unread` : 'Back'}
        >
          <Glass interactive style={[styles.capsule, styles.back]}>
            <Icon name="chevron.backward" size={17} weight="semibold" color={colors.blue} />
            {unreadCount > 0 ? <Text style={styles.count}>{formatCount(unreadCount)}</Text> : null}
          </Glass>
        </Pressable>

        <View style={styles.center} pointerEvents="box-none">
          <Pressable
            onPress={onOpenInfo}
            hitSlop={4}
            style={styles.identity}
            accessibilityRole="button"
            accessibilityLabel={`${title}, details`}
          >
            {isGroup && !avatarUrl ? (
              <GroupAvatar uris={memberAvatars ?? [null, null]} names={memberNames} size={44} />
            ) : (
              <Avatar uri={avatarUrl} name={title} size={44} />
            )}
            <View style={styles.nameLine}>
              <Text style={styles.name} numberOfLines={1}>
                {title}
              </Text>
              <Icon name="chevron.forward" size={9} weight="semibold" color={colors.textSecondary} />
            </View>
          </Pressable>
        </View>

        <Glass interactive style={styles.capsule}>
          <Pressable onPress={onVideo} style={styles.callBtn} accessibilityRole="button" accessibilityLabel="FaceTime video">
            <Icon name="video.fill" size={19} color={colors.blue} />
          </Pressable>
          <Pressable onPress={onAudio} style={styles.callBtn} accessibilityRole="button" accessibilityLabel="FaceTime audio">
            <Icon name="phone.fill" size={17} color={colors.blue} />
          </Pressable>
        </Glass>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, paddingBottom: 18, zIndex: 10 },
  // Ends where the gradient starts fading (86%), so the blur's hard edge sits under 92% white.
  blur: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 24 },
  row: {
    height: HEADER_ROW,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  capsule: { height: 44, borderRadius: 22, flexDirection: 'row', alignItems: 'center' },
  back: { minWidth: 44, paddingHorizontal: 13, gap: 4, justifyContent: 'center' },
  count: { color: colors.blue, fontSize: 17 },
  callBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  center: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, alignItems: 'center', justifyContent: 'center' },
  identity: { alignItems: 'center', gap: 4, maxWidth: 200 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  name: { color: colors.text, fontSize: 12, flexShrink: 1 },
});
