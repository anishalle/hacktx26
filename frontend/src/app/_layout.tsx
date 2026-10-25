import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { API_URL } from '@/api';
import { AsksProvider } from '@/state/asks';
import { ActiveCallsProvider } from '@/state/calls';
import { InboxProvider } from '@/state/inbox';
import { PlaybackProvider } from '@/state/playback';
import { RealtimeProvider } from '@/state/realtime';
import { SessionProvider, useSession } from '@/state/session';
import { callColors, colors } from '@/theme';

const theme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: colors.bg, card: colors.bg, primary: colors.blue, text: colors.text },
};

const sheet = {
  presentation: 'formSheet' as const,
  sheetGrabberVisible: true,
  headerShown: false,
  contentStyle: { backgroundColor: colors.grouped },
};

function Gate() {
  const { status, error, reload, me } = useSession();
  if (status !== 'ready' || !me) {
    return (
      <View style={styles.center}>
        {status === 'error' ? (
          <>
            <Text style={styles.errTitle}>Can’t reach the API</Text>
            <Text style={styles.errBody}>{API_URL}</Text>
            <Text style={styles.errBody}>{error}</Text>
            <Text style={styles.errHint}>Start the backend, or run with EXPO_PUBLIC_USE_MOCKS=1.</Text>
            <Pressable onPress={reload} style={styles.retry}>
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </>
        ) : (
          <ActivityIndicator color={colors.textSecondary} />
        )}
      </View>
    );
  }
  return (
    <RealtimeProvider userId={me.id}>
      <InboxProvider key={me.id} userId={me.id}>
        <AsksProvider key={me.id} userId={me.id}>
          <ActiveCallsProvider key={me.id}>
            <PlaybackProvider key={me.id}>
              <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="thread/[id]" />
                <Stack.Screen name="lore/[id]" />
                <Stack.Screen
                  name="call/[groupId]"
                  options={{
                    presentation: 'fullScreenModal',
                    contentStyle: { backgroundColor: callColors.bg },
                    statusBarStyle: 'light',
                  }}
                />
                {/* Explain leaves the thread undimmed at its medium detent so the message stays readable. */}
                <Stack.Screen
                  name="explain"
                  options={{ ...sheet, sheetAllowedDetents: [0.55, 1], sheetLargestUndimmedDetentIndex: 0 }}
                />
                <Stack.Screen name="catchup" options={{ ...sheet, sheetAllowedDetents: [0.62, 1] }} />
                <Stack.Screen name="requests" options={{ ...sheet, sheetAllowedDetents: [0.62, 1] }} />
                <Stack.Screen name="switch-user" options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
                <Stack.Screen name="compose" options={{ ...sheet, sheetAllowedDetents: [1] }} />
                <Stack.Screen name="group/[id]" options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
              </Stack>
            </PlaybackProvider>
          </ActiveCallsProvider>
        </AsksProvider>
      </InboxProvider>
    </RealtimeProvider>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider value={theme}>
      <StatusBar style="dark" />
      <SessionProvider>
        <Gate />
      </SessionProvider>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  errTitle: { color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: 4 },
  errBody: { color: colors.textSecondary, fontSize: 14, textAlign: 'center' },
  errHint: { color: colors.textTertiary, fontSize: 13, textAlign: 'center', marginTop: 8 },
  retry: { marginTop: 16, backgroundColor: colors.action, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 },
  retryText: { color: 'white', fontWeight: '600', fontSize: 15 },
});
