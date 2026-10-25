import { Redirect } from 'expo-router';

/** Cold starts open Connect, between the calls and messages tabs. */
export default function Index() {
  return <Redirect href="/home" />;
}
