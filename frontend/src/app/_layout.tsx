import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { API_URL } from '@/api';
import { InboxProvider } from '@/state/inbox';
import { RealtimeProvider } from '@/state/realtime';
import { SessionProvider, useSession } from '@/state/session';
import { colors } from '@/theme';

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: colors.bg, card: colors.bg, primary: colors.blue, text: colors.text },
};

const sheet = {
  presentation: 'formSheet' as const,
  sheetGrabberVisible: true,
  headerShown: false,
  contentStyle: { backgroundColor: colors.sheetBg },
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
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="thread/[id]" />
        <Stack.Screen name="catchup" options={{ ...sheet, sheetAllowedDetents: [0.62, 1], sheetCornerRadius: 28 }} />
        <Stack.Screen name="explain" options={{ ...sheet, sheetAllowedDetents: [0.38] }} />
        <Stack.Screen name="switch-user" options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
      </Stack>
      </InboxProvider>
    </RealtimeProvider>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider value={theme}>
      <StatusBar style="light" />
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
  retry: { marginTop: 16, backgroundColor: colors.blue, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 },
  retryText: { color: 'white', fontWeight: '600', fontSize: 15 },
});
