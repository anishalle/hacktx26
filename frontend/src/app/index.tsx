import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { api, audioUrl, type Profile } from '../lib/api';
import { Button, styles } from '../components/ui';
import { PronunciationButton, usePronunciationPlayback } from '../components/PronunciationPlayer';

export default function Members() {
  const [attempt, setAttempt] = useState(0);
  return <MemberList key={attempt} onRetry={() => setAttempt(value => value + 1)} />;
}

function MemberList({ onRetry }: { onRetry: () => void }) {
  const [users, setUsers] = useState<Profile[]>([]);
  const [viewer, setViewer] = useState('priya');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const { stop } = usePronunciationPlayback();
  useFocusEffect(useCallback(() => {
    let active = true;
    setLoading(true);
    api<Profile[]>('/users').then(data => { if (active) { setUsers(data); setError(''); } })
      .catch(() => { if (active) setError('Could not load profiles. Check your API connection and try again.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []));
  return <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
    <Text style={styles.label}>Longhorns · Members</Text>
    <Text style={styles.title}>Every name deserves to be heard.</Text>
    <Text style={styles.subtitle}>Learn how your friends say their names, in their own voices.</Text>
    <View style={styles.card}>
      <Text style={styles.label}>Demo: using the app as</Text>
      <View style={styles.row}>{['priya', 'swayam', 'alex'].map(id => <Button key={id}
        secondary={id !== viewer} label={id[0].toUpperCase() + id.slice(1)} onPress={() => { stop(); setViewer(id); }} />)}</View>
    </View>
    {loading && <ActivityIndicator accessibilityLabel="Loading profiles" />}
    {error ? <><Text accessibilityRole="alert" style={styles.error}>{error}</Text><Button label="Try again" onPress={onRetry} /></> :
      users.map(user => <View key={user.id} style={styles.card}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Open ${user.display_name}'s profile`}
          onPress={() => { stop(); router.push({ pathname: '/profile/[id]', params: { id: user.id, viewer } }); }}>
          <Text style={styles.name}>{user.display_name}{viewer === user.id ? ' (you)' : ''} →</Text>
        </Pressable>
        {user.pronunciation_url ? <PronunciationButton uri={audioUrl(user.pronunciation_url)} name={user.display_name} /> :
          <Text style={styles.subtitle}>No pronunciation recorded yet</Text>}
      </View>)}
  </ScrollView>;
}
