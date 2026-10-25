import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { useSession } from '@/state/session';
import { colors } from '@/theme';

/** Hidden demo-user switcher (no auth): the whole app re-renders as the picked user. */
export default function SwitchUserSheet() {
  const router = useRouter();
  const { users, me, setMe } = useSession();
  return (
    <ScrollView style={styles.sheet} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Switch account</Text>
      <Text style={styles.subtitle}>Demo users · no sign-in</Text>
      {users.map((u) => {
        const active = u.id === me?.id;
        return (
          <Pressable
            key={u.id}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            onPress={() => {
              Haptics.selectionAsync();
              setMe(u.id);
              router.back();
            }}>
            <Avatar uri={u.avatar_url} size={48} />
            <View style={styles.body}>
              <Text style={styles.username}>{u.username}</Text>
              <Text style={styles.name}>{u.display_name}</Text>
            </View>
            {active ? (
              <Icon name="checkmark.circle.fill" size={24} color={colors.blue} />
            ) : (
              <View style={styles.radio} />
            )}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.sheetBg },
  content: { paddingTop: 28, paddingBottom: 40 },
  title: { color: colors.text, fontSize: 17, fontWeight: '700', textAlign: 'center' },
  subtitle: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', marginTop: 4, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 9 },
  body: { flex: 1, marginLeft: 12 },
  username: { color: colors.text, fontSize: 15, fontWeight: '600' },
  name: { color: colors.textSecondary, fontSize: 14, marginTop: 1 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: colors.textTertiary },
});
