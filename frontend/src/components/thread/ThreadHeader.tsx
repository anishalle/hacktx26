import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar, GroupAvatar } from '../Avatar';
import { GlassCircle } from '../GlassCircle';
import { Icon } from '../Icon';
import { colors } from '@/theme';

type Props = {
  title: string;
  subtitle: string;
  avatarUrl: string | null;
  isGroup: boolean;
  onBack: () => void;
  onCall?: () => void;
};

export const HEADER_ROW = 56;

/** Floating thread header: liquid-glass circle buttons over the wallpaper, like Instagram on iOS 26. */
export function ThreadHeader({ title, subtitle, avatarUrl, isGroup, onBack, onCall }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 2 }]} pointerEvents="box-none">
      <LinearGradient
        colors={['#eddae7', '#eddae7', 'rgba(237,218,231,0.9)', 'rgba(237,218,231,0)']}
        locations={[0, 0.72, 0.84, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={styles.row}>
        <GlassCircle onPress={onBack} accessibilityLabel="Back">
          <Icon name="chevron.left" size={20} weight="medium" />
        </GlassCircle>
        <Pressable style={styles.center}>
          {isGroup && !avatarUrl ? <GroupAvatar uris={[null, null]} size={38} /> : <Avatar uri={avatarUrl} size={38} />}
          <View style={styles.titles}>
            <View style={styles.titleLine}>
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              <Icon name="chevron.right" size={11} weight="semibold" color={colors.textSecondary} style={{ marginLeft: 4 }} />
            </View>
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          </View>
        </Pressable>
        <View style={styles.actions}>
          <GlassCircle onPress={onCall} accessibilityLabel="Audio call">
            <Icon name="phone" size={20} />
          </GlassCircle>
          <GlassCircle onPress={onCall} accessibilityLabel="Video call">
            <Icon name="video" size={20} />
          </GlassCircle>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, paddingBottom: 26, zIndex: 10 },
  row: { flexDirection: 'row', alignItems: 'center', height: HEADER_ROW, paddingHorizontal: 12, gap: 8 },
  center: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 9, minWidth: 0 },
  titles: { flex: 1, minWidth: 0 },
  titleLine: { flexDirection: 'row', alignItems: 'center' },
  title: { color: colors.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  subtitle: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },
  actions: { flexDirection: 'row', gap: 8 },
});
