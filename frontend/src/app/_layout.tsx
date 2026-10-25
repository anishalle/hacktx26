import { Stack } from 'expo-router';

export default function RootLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: 'fade',
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen
        name="call/[callId]"
        options={{
          gestureEnabled: false, // don't accidentally leave a call
          animation: 'slide_from_bottom',
        }}
      />
    </Stack>
  );
}
