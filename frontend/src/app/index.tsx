import { Redirect } from 'expo-router';

/** Cold starts in a dev or release build open `/`; the app starts on the inbox. */
export default function Index() {
  return <Redirect href="/inbox" />;
}
