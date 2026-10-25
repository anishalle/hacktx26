import { useDockScroll } from '@/components/navigation/DockMotion';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar, GroupAvatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { useInbox } from '@/state/inbox';
import { colors } from '@/theme';

export default function CallsScreen() {
  const onDockScroll = useDockScroll();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { items, status, error, refresh } = useInbox();
  return <View style={[styles.screen, { paddingTop: insets.top }]}>
    <LinearGradient colors={['#f3dfe9', '#e5e0ef', '#f4e9ed']} style={StyleSheet.absoluteFill} />
    <View style={styles.header}><Text style={styles.title}>Calls</Text><Text style={styles.subtitle}>A little face time.</Text></View>
    <FlatList onScroll={onDockScroll} scrollEventThrottle={32} data={items} numColumns={2} keyExtractor={item => String(item.group.id)} columnWrapperStyle={styles.row}
      contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 110 }}
      refreshing={status === 'loading'} onRefresh={refresh}
      ListEmptyComponent={<View style={styles.empty}>{status === 'loading' ? <ActivityIndicator color={colors.blue} /> : <Text style={styles.subtitle}>{error || 'Your conversations will appear here.'}</Text>}</View>}
      renderItem={({ item, index }) => <Pressable accessibilityRole="button" accessibilityLabel={'Call ' + item.group.name} onPress={() => router.push({ pathname: '/call/[groupId]', params: { groupId: item.group.id, name: item.group.name } })} style={({ pressed }) => [styles.tile, { backgroundColor: index % 2 ? '#ece7f4cc' : '#fff8fccc', opacity: pressed ? 0.75 : 1 }]}>
        <Text numberOfLines={2} style={styles.name}>{item.group.name}</Text>
        <View style={styles.avatar}>{item.group.is_dm || item.group.avatar_url ? <Avatar uri={item.group.avatar_url} size={76} /> : <GroupAvatar uris={[null, null]} size={76} />}</View>
        <View style={styles.tileFooter}><Text style={styles.videoLabel}>Video call</Text><BlurView tint="light" intensity={40} style={styles.videoButton}><Icon name="video.fill" size={20} color={colors.blue} /></BlurView></View>
      </Pressable>}
    />
  </View>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 26, paddingTop: 32, paddingBottom: 28 },
  title: { color: colors.text, fontSize: 34, fontWeight: '600', letterSpacing: -1.3 },
  subtitle: { color: colors.textSecondary, fontSize: 14, marginTop: 8 },
  row: { gap: 12, marginBottom: 12 },
  tile: { flex: 1, maxWidth: '49%', minHeight: 220, padding: 16, borderRadius: 28, borderWidth: 1, borderColor: '#ffffffcc' },
  name: { color: colors.text, fontWeight: '600', fontSize: 15, minHeight: 38 },
  avatar: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 15 },
  tileFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  videoLabel: { color: colors.textSecondary, fontSize: 11 },
  videoButton: { width: 42, height: 42, borderRadius: 21, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: '#ffffff99' },
  empty: { paddingVertical: 60, alignItems: 'center' },
});
