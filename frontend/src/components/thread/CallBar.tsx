import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Call, User } from '@/api';
import { firstName } from '@/lib/format';
import { colors } from '@/theme';

import { Avatar } from '../Avatar';
import { Glass } from '../GlassCircle';
import { Icon } from '../Icon';

/** "Swayam started a call · Join" bar under the thread header while the group has an active call. */
export function CallBar({ call, top, meId, onJoin }: { call: Call; top: number; meId: string; onJoin: () => void }) {
  const inCall = call.members.filter((m) => !m.left_at);
  const starter = call.members.find((m) => m.user.id === call.started_by)?.user;
  const joined = inCall.some((m) => m.user.id === meId);
  const who = (u?: User) => (!u ? 'Someone' : u.id === meId ? 'You' : firstName(u.display_name));
  return (
    <View style={[styles.wrap, { top }]} pointerEvents="box-none">
      <Pressable onPress={onJoin} accessibilityRole="button" style={({ pressed }) => pressed && { transform: [{ scale: 0.98 }] }}>
        <Glass interactive style={styles.bar}>
          <View style={styles.tint} />
          <View style={styles.icon}>
            <Icon name="phone.fill" size={13} color="white" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title} numberOfLines={1}>
              {who(starter)} started a call
            </Text>
            <Text style={styles.sub} numberOfLines={1}>
              {inCall.length} in the call
            </Text>
          </View>
          <View style={styles.faces}>
            {inCall.slice(0, 3).map((m, i) => (
              <Avatar key={m.user.id} uri={m.user.avatar_url} size={22} style={i ? { marginLeft: -7 } : undefined} />
            ))}
          </View>
          <Text style={styles.join}>{joined ? 'Return' : 'Join'}</Text>
        </Glass>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 12, right: 12, zIndex: 9 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 50, paddingHorizontal: 12, borderRadius: 18, overflow: 'hidden' },
  tint: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(30,30,36,0.82)' },
  icon: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#30D158', alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontSize: 14, fontWeight: '600' },
  sub: { color: colors.textSecondary, fontSize: 12, marginTop: 1 },
  faces: { flexDirection: 'row' },
  join: { color: '#30D158', fontSize: 15, fontWeight: '700', marginLeft: 4 },
});
