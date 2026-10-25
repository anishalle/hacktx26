import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createRoom } from '../services/rooms';

export default function HomeScreen() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function startCall() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const invitation = await createRoom();
      router.push({ pathname: '/call/[callId]', params: {
        callId: invitation.room_id, invite: invitation.invite_token, name: name.trim(),
      } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the call.');
    } finally { setBusy(false); }
  }
  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.wordmark}>in the loop</Text>
        <View style={styles.hero}>
          <Text style={styles.title}>Your people.{'\n'}One link away.</Text>
          <Text style={styles.description}>Start a call and invite someone in.</Text>
        </View>
        <View style={styles.room}>
          <Text style={styles.label}>Your name</Text>
          <TextInput accessibilityLabel="Your name" placeholder="How should we call you?" placeholderTextColor="#9299a3" value={name} onChangeText={setName} maxLength={60} autoComplete="name" returnKeyType="go" onSubmitEditing={startCall} style={styles.input} editable={!busy} />
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <Pressable accessibilityRole="button" disabled={busy || !name.trim()} onPress={startCall} style={({ pressed }) => [styles.join, (busy || !name.trim() || pressed) && { opacity: 0.6 }]}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.joinText}>Start a call</Text>}
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#faf9f7' },
  content: { width: '100%', maxWidth: 520, alignSelf: 'center', padding: 24, paddingBottom: 40 },
  wordmark: { color: '#171a20', fontWeight: '700', fontSize: 24, letterSpacing: -1, marginTop: 14 },
  hero: { paddingTop: 80, paddingBottom: 38 },
  title: { color: '#15191f', fontSize: 40, lineHeight: 46, letterSpacing: -1.8, fontWeight: '600' },
  description: { color: '#73777e', fontSize: 15, lineHeight: 23, marginTop: 18 },
  room: { backgroundColor: '#fff', padding: 22, borderRadius: 26, borderWidth: 1, borderColor: '#e8e9eb' },
  label: { color: '#555e6b', fontSize: 13, marginBottom: 10 },
  input: { backgroundColor: '#f5f6f8', borderWidth: 1, borderColor: '#e4e7ec', borderRadius: 14, padding: 15, fontSize: 16, color: '#202a36', marginBottom: 18 },
  error: { color: '#a13b40', fontSize: 13, lineHeight: 19, marginBottom: 16 },
  join: { backgroundColor: '#202a36', padding: 17, borderRadius: 15, alignItems: 'center', minHeight: 54 },
  joinText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
