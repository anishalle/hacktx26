import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { PronunciationPlayback } from '../components/PronunciationPlayer';

export default function Layout() {
  return <PronunciationPlayback>
    <StatusBar style="dark" />
    <Stack screenOptions={{ headerStyle: { backgroundColor: '#f5f6f0' }, headerTintColor: '#19392f' }}>
      <Stack.Screen name="index" options={{ title: 'Your group' }} />
      <Stack.Screen name="profile/[id]" options={{ title: 'Profile' }} />
    </Stack>
  </PronunciationPlayback>;
}
