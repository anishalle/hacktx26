import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

export default function HomeScreen() {
  const router = useRouter();
  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.top}><Text style={styles.wordmark}>in the loop</Text><View style={styles.profile}><Text style={styles.initial}>Y</Text></View></View>
        <Text style={styles.eyebrow}>A SPACE TO BELONG</Text>
        <Text style={styles.title}>Same call.{'\n'}More connection.</Text>
        <Text style={styles.description}>The jokes, the names, the things you missed. Get a little context without breaking the conversation.</Text>
        <View style={styles.room}>
          <View style={styles.roomTop}><Text style={styles.roomLabel}>YOUR CALL SPACE</Text><Text style={styles.preview}>Preview</Text></View>
          <View style={styles.portraits}>{['Y', 'S', 'M'].map((letter, i) => <View key={letter} style={[styles.avatar, { backgroundColor: ['#d7e7fa', '#eee1d7', '#dcdfee'][i], marginLeft: i ? -12 : 0 }]}><Text style={styles.avatarText}>{letter}</Text></View>)}</View>
          <Text style={styles.roomTitle}>Catch up with your people</Text>
          <Text style={styles.roomDescription}>Explore the call experience. Live video and transcription are not connected yet.</Text>
          <Pressable accessibilityRole="button" style={({ pressed }) => [styles.join, pressed && { opacity: 0.8 }]} onPress={() => router.push('/call/preview')}><Text style={styles.joinText}>Open call preview</Text><Text style={styles.joinArrow}>↗</Text></Pressable>
        </View>
        <Text style={styles.section}>A little help, on your terms</Text>
        {[['01', 'Tap for context', 'One sentence about the last 10 seconds.'], ['02', 'Hold to ask', 'A private question, a concise answer.'], ['03', 'Find your way in', 'Conversation suggestions once live speech is connected.']].map(([number, title, detail]) => <View key={number} style={styles.feature}><Text style={styles.number}>{number}</Text><View style={styles.featureBody}><Text style={styles.featureTitle}>{title}</Text><Text style={styles.featureDetail}>{detail}</Text></View></View>)}
        <Text style={styles.footer}>Your questions stay on your screen.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#faf9f7' },
  content: { width: '100%', maxWidth: 560, alignSelf: 'center', padding: 24, paddingBottom: 36 },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 45 },
  wordmark: { color: '#171a20', fontWeight: '700', fontSize: 24, letterSpacing: -1 },
  profile: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#e9edf3', alignItems: 'center', justifyContent: 'center' },
  initial: { color: '#536478', fontWeight: '600' },
  eyebrow: { color: '#6f8095', fontSize: 10, letterSpacing: 2, fontWeight: '600', marginBottom: 15 },
  title: { color: '#15191f', fontSize: 39, lineHeight: 44, letterSpacing: -1.8, fontWeight: '600' },
  description: { color: '#73777e', fontSize: 15, lineHeight: 23, marginTop: 17, marginBottom: 30 },
  room: { backgroundColor: '#fff', padding: 22, borderRadius: 26, borderWidth: 1, borderColor: '#e8e9eb' },
  roomTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  roomLabel: { color: '#888f99', letterSpacing: 1.3, fontSize: 9, fontWeight: '600' },
  preview: { color: '#526e8e', fontSize: 11, backgroundColor: '#edf4fc', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10 },
  portraits: { flexDirection: 'row', marginVertical: 22 },
  avatar: { width: 50, height: 50, borderRadius: 25, borderWidth: 3, borderColor: '#fff', justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#576171', fontSize: 16, fontWeight: '500' },
  roomTitle: { fontSize: 20, color: '#20242a', fontWeight: '600', letterSpacing: -0.5 },
  roomDescription: { color: '#878b93', fontSize: 12, lineHeight: 19, marginTop: 9, marginBottom: 22 },
  join: { backgroundColor: '#202a36', padding: 16, borderRadius: 15, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  joinText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  joinArrow: { color: '#9bc9ff', fontSize: 21 },
  section: { color: '#242a32', fontSize: 16, fontWeight: '600', marginTop: 32, marginBottom: 8 },
  feature: { flexDirection: 'row', gap: 18, paddingVertical: 17, borderBottomWidth: 1, borderColor: '#e9e9e7' },
  number: { color: '#94a4b6', fontSize: 12, paddingTop: 3 },
  featureBody: { flex: 1 },
  featureTitle: { color: '#373d46', fontSize: 14, fontWeight: '500' },
  featureDetail: { color: '#848990', fontSize: 12, lineHeight: 18, marginTop: 5 },
  footer: { textAlign: 'center', color: '#969ba2', fontSize: 11, marginTop: 28 },
});
