import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/Avatar';
import { BrandMark } from '@/components/BrandMark';
import { Icon } from '@/components/Icon';
import { useAsks } from '@/state/asks';
import { useInbox } from '@/state/inbox';
import { useMe } from '@/state/session';
import { colors } from '@/theme';
export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const me = useMe();
  const router = useRouter();
  const { items } = useInbox();
  const { pendingIncoming } = useAsks();
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="never"
      style={styles.screen}
      contentContainerStyle={{ paddingTop: insets.top + 28, paddingHorizontal: 24, paddingBottom: 120 }}
    >
      <Text style={styles.eyebrow}>YOUR LITTLE CORNER</Text>
      <Text style={styles.title}>Hey, {me.display_name.split(' ')[0]}.</Text>
      <View style={styles.card}>
        <Avatar uri={me.avatar_url} name={me.display_name} size={80} />
        <Text style={styles.name}>{me.display_name}</Text>
        <Text style={styles.username}>@{me.username}</Text>
        {me.phonetic_hint ? (
          <View style={styles.pronunciation}>
            <Icon name="waveform" size={14} color={colors.blue} />
            <Text style={styles.hint}>{me.phonetic_hint}</Text>
          </View>
        ) : null}
        <View style={styles.stat}>
          <Text style={styles.number}>{items.length}</Text>
          <Text style={styles.statText}>conversations you’re part of</Text>
        </View>
      </View>
      <Text style={styles.section}>MAKE YOURSELF AT HOME</Text>
      <Pressable accessibilityRole="button" onPress={() => router.push('/requests')} style={styles.row}>
        <View style={styles.rowIcon}>
          <Icon name="bubble.left.and.text.bubble.right" size={20} color={colors.blue} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowTitle}>A little help from you</Text>
          <Text style={styles.rowSub}>
            {pendingIncoming
              ? `${pendingIncoming} questions waiting for your perspective`
              : 'The questions and answers you share'}
          </Text>
        </View>
        <Icon name="chevron.right" size={12} color={colors.textTertiary} />
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => router.push('/switch-user')} style={styles.row}>
        <View style={styles.rowIcon}>
          <Icon name="person.2" size={20} color={colors.blue} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowTitle}>Switch profile</Text>
          <Text style={styles.rowSub}>See the conversation from another side</Text>
        </View>
        <Icon name="chevron.right" size={12} color={colors.textTertiary} />
      </Pressable>
      <View style={styles.footer}>
        <BrandMark size={22} />
        <Text style={styles.footerText}>A little context. A closer connection.</Text>
      </View>
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  eyebrow: { color: colors.blue, fontSize: 10, fontWeight: '700', letterSpacing: 2 },
  title: { color: colors.text, fontSize: 34, fontWeight: '700', letterSpacing: -1, marginTop: 10, marginBottom: 26 },
  card: {
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.separator,
    borderRadius: 28,
    padding: 28,
  },
  name: { color: colors.text, fontSize: 24, fontWeight: '600', letterSpacing: -0.6, marginTop: 18 },
  username: { color: colors.textSecondary, fontSize: 14, marginTop: 5 },
  pronunciation: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    backgroundColor: colors.accentSoft,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 16,
  },
  hint: { color: colors.blue, fontSize: 13 },
  stat: {
    borderTopWidth: 1,
    borderColor: colors.separator,
    width: '100%',
    alignItems: 'center',
    marginTop: 24,
    paddingTop: 20,
    gap: 4,
  },
  number: { color: colors.text, fontSize: 25, fontWeight: '600' },
  statText: { color: colors.textSecondary, fontSize: 12 },
  section: { color: colors.textTertiary, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, marginTop: 28, marginBottom: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderColor: colors.separator,
  },
  rowIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowSub: { color: colors.textSecondary, fontSize: 12, lineHeight: 18, marginTop: 4 },
  footer: { alignItems: 'center', marginTop: 36, gap: 12 },
  footerText: { color: colors.textTertiary, fontSize: 12 },
});
