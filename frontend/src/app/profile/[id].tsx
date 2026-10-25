import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { api, audioUrl, type Profile } from '../../lib/api';
import { Button, styles } from '../../components/ui';
import { PronunciationButton } from '../../components/PronunciationPlayer';
import { PronunciationEditor } from '../../components/PronunciationEditor';

export default function ProfileScreen() {
  const { id, viewer } = useLocalSearchParams<{ id: string; viewer?: string }>();
  const [attempt, setAttempt] = useState(0);
  return <ProfileContent key={`${id}-${attempt}`} id={id} viewer={viewer} onRetry={() => setAttempt(value => value + 1)} />;
}

function ProfileContent({ id, viewer, onRetry }: { id: string; viewer?: string; onRetry: () => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<Profile>(`/users/${encodeURIComponent(id)}`).then(data => { if (active) setProfile(data); })
      .catch(() => { if (active) setError('Could not load this profile. Please try again.'); });
    return () => { active = false; };
  }, [id]);
  return <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
    {error ? <><Text style={styles.error} accessibilityRole="alert">{error}</Text><Button label="Try again" onPress={onRetry} /></> : !profile ? <ActivityIndicator /> : <>
      <Text style={styles.label}>Member profile</Text>
      <Text style={styles.title}>{profile.display_name}</Text>
      <View style={styles.card}>
        <Text style={styles.name}>Name pronunciation</Text>
        {viewer === id ? <PronunciationEditor key={id} profile={profile} onSaved={setProfile} /> : <>
          <Text style={styles.subtitle}>Hear {profile.display_name} say their name.</Text>
          {profile.pronunciation_url ? <PronunciationButton uri={audioUrl(profile.pronunciation_url)} name={profile.display_name} /> :
            <Text style={styles.subtitle}>No pronunciation recorded yet.</Text>}
        </>}
      </View>
    </>}
  </ScrollView>;
}
