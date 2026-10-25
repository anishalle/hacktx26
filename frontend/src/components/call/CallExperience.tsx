import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { WebView } from 'react-native-webview';

const FRONTEND_HOST = process.env.EXPO_PUBLIC_FRONTEND_HOST || 'http://localhost:8081';

/**
 * Native call screen: loads the full web call experience in a WebView.
 * LiveKit needs WebRTC which requires a browser engine, so the WebView
 * gives us full functionality inside Expo Go with no native modules.
 */
export default function CallExperience() {
  const params = useLocalSearchParams<{ callId: string; invite?: string; name?: string }>();
  const router = useRouter();
  const [name, setName] = useState(params.name || '');
  const [joined, setJoined] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const callUrl = `${FRONTEND_HOST}/call/${encodeURIComponent(params.callId)}?invite=${encodeURIComponent(params.invite || '')}&name=${encodeURIComponent(name)}`;

  if (!joined) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.joinPage}>
          <Pressable accessibilityRole="button" onPress={() => router.replace('/')} style={styles.back}>
            <Text style={styles.secondary}>Back</Text>
          </Pressable>
          <Text style={styles.joinTitle}>You're invited.</Text>
          <Text style={styles.joinHint}>Join with your camera and microphone.</Text>
          <TextInput
            accessibilityLabel="Your name"
            value={name}
            onChangeText={setName}
            maxLength={60}
            placeholder="Your name"
            placeholderTextColor="#828c99"
            style={styles.input}
            onSubmitEditing={() => name.trim() && setJoined(true)}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              if (!name.trim()) return;
              if (!params.invite) { setError('This call link is missing its invitation.'); return; }
              setJoined(true);
            }}
            disabled={!name.trim()}
            style={[styles.joinButton, !name.trim() && { opacity: 0.5 }]}
          >
            <Text style={styles.joinButtonText}>Join call</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.screen}>
      {loading && (
        <View style={styles.loader}>
          <ActivityIndicator size="large" color="#8ac3ff" />
          <Text style={styles.loaderText}>Loading call...</Text>
        </View>
      )}
      <WebView
        source={{ uri: callUrl }}
        style={styles.webview}
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        javaScriptEnabled
        domStorageEnabled
        onLoadEnd={() => setLoading(false)}
        onError={() => {
          setLoading(false);
          setError('Could not load the call. Make sure the web server is running.');
          setJoined(false);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101114' },
  joinPage: { flex: 1, justifyContent: 'center', padding: 26, maxWidth: 500, width: '100%', alignSelf: 'center' },
  back: { position: 'absolute', top: 20, left: 26, minHeight: 44, justifyContent: 'center' },
  secondary: { color: '#a7b4c4', fontSize: 14 },
  joinTitle: { color: '#fafafa', fontSize: 35, fontWeight: '600', letterSpacing: -1 },
  joinHint: { color: '#9ca6b5', fontSize: 14, marginTop: 12, marginBottom: 30 },
  input: { color: '#fff', backgroundColor: '#242a33', borderRadius: 15, padding: 17, fontSize: 16, marginBottom: 16 },
  error: { color: '#f8b2b5', fontSize: 13, lineHeight: 19, marginBottom: 14 },
  joinButton: { minHeight: 54, borderRadius: 15, backgroundColor: '#8ac3ff', alignItems: 'center', justifyContent: 'center' },
  joinButtonText: { color: '#162536', fontWeight: '600', fontSize: 16 },
  webview: { flex: 1 },
  loader: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#101114' },
  loaderText: { color: '#909ba9', fontSize: 14, marginTop: 12 },
});
