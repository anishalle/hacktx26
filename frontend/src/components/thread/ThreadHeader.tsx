import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@/theme';
import { Avatar } from '../Avatar';
import { GlassCircle } from '../GlassCircle';
import { Icon } from '../Icon';
type Props = {
  title: string;
  subtitle: string;
  avatarUrl: string | null;
  isGroup: boolean;
  onBack: () => void;
  onCall?: () => void;
};
export const HEADER_ROW = 64;
export function ThreadHeader({ title, subtitle, avatarUrl, onBack, onCall }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 2 }]} pointerEvents="box-none">
      <LinearGradient
        colors={['#F8F9FC', '#F8F9FC', 'rgba(248,249,252,0)']}
        locations={[0, 0.8, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={styles.row}>
        <GlassCircle size={40} onPress={onBack} accessibilityLabel="Back to chats">
          <Icon name="chevron.left" size={18} />
        </GlassCircle>
        <Avatar uri={avatarUrl} name={title} size={40} style={{ borderRadius: 14 }} />
        <View style={styles.titles}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        {onCall ? (
          <Pressable onPress={onCall} accessibilityRole="button" accessibilityLabel="Start group call" style={styles.call}>
            <Icon name="video.fill" size={19} color={colors.blue} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, paddingBottom: 24, zIndex: 10 },
  row: { height: HEADER_ROW, paddingHorizontal: 16, gap: 12, flexDirection: 'row', alignItems: 'center' },
  titles: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 16, fontWeight: '600', letterSpacing: -0.3 },
  subtitle: { color: colors.textSecondary, fontSize: 11, marginTop: 4 },
  call: {
    width: 44,
    height: 44,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DCE5F3',
    backgroundColor: colors.accentSoft,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
