import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { User } from '@/api';
import { colors } from '@/theme';

import { Avatar } from '../Avatar';

const NOTES = ['grandma’s after the game?', 'tournament szn 🏐', 'need a 4th for 314 study', 'It’s the weekend', 'back lot again'];

/** Decorative Instagram "Notes" row: avatars with a thought bubble above. */
export function NotesRow({ me, others }: { me: User; others: User[] }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      <Note user={me} label="Your note" note="Note…" muted />
      {others.slice(0, 5).map((u, i) => (
        <Note key={u.id} user={u} label={u.display_name} note={NOTES[i % NOTES.length]} />
      ))}
    </ScrollView>
  );
}

function Note({ user, label, note, muted }: { user: User; label: string; note: string; muted?: boolean }) {
  return (
    <View style={styles.item}>
      <View style={styles.avatarWrap}>
        <Avatar uri={user.avatar_url} size={78} />
      </View>
      <View style={styles.bubbleWrap} pointerEvents="none">
        <View style={styles.bubble}>
          <Text style={[styles.bubbleText, muted && { color: colors.textSecondary }]} numberOfLines={3}>
            {note}
          </Text>
        </View>
        <View style={styles.dotBig} />
        <View style={styles.dotSmall} />
      </View>
      <Text style={[styles.label, muted && { color: colors.textSecondary }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 12, paddingTop: 6, gap: 6 },
  item: { width: 98, alignItems: 'center', paddingTop: 44 },
  avatarWrap: { marginBottom: 8 },
  bubbleWrap: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center' },
  bubble: {
    backgroundColor: '#363A40',
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: 96,
    minWidth: 60,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  bubbleText: { color: colors.text, fontSize: 12, lineHeight: 14, textAlign: 'center' },
  dotBig: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#363A40', marginTop: -2, marginLeft: -26 },
  dotSmall: { width: 4, height: 4, borderRadius: 2, backgroundColor: '#363A40', marginTop: 1, marginLeft: -34 },
  label: { color: colors.text, fontSize: 13, maxWidth: 94 },
});
