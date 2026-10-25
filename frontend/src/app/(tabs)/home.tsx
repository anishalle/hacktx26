import { useDockScroll } from '@/components/navigation/DockMotion';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';


type Memory = { id: string; image: string; title: string; detail: string; tag: string };

const MEMORIES: Memory[] = [
  { id: 'clouds', image: 'https://images.unsplash.com/photo-1534088568595-a066f410bcda?w=900&q=85', title: 'Head in the clouds', detail: 'Clouds collecting in an open sky. A little reminder to look up.', tag: 'Sky' },
  { id: 'hills', image: 'https://images.unsplash.com/photo-1500534623283-312aade485b7?w=900&q=85', title: 'The long way home', detail: 'The sun settling over layers of hills. Where would you go for a weekend away?', tag: 'Outdoors' },
  { id: 'ocean', image: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=900&q=85', title: 'Somewhere by the sea', detail: 'Warm sand and blue water. The kind of place that makes an afternoon feel a little longer.', tag: 'Coast' },
  { id: 'paper', image: 'https://images.unsplash.com/photo-1499750310107-5fef28a66643?w=900&q=85', title: 'A slow morning', detail: 'An open notebook and a quiet corner. What have you been wanting to make time for?', tag: 'Everyday' },
  { id: 'pink', image: 'https://images.unsplash.com/photo-1519608487953-e999c86e7455?w=900&q=85', title: 'After the sun goes down', detail: 'A quiet street lit up in pink and blue. A different side of the city after dark.', tag: 'Evening' },
];
const rail = [...MEMORIES, ...MEMORIES];

export default function HomeScreen() {
  const onDockScroll = useDockScroll();
  const [selected, setSelected] = useState<Memory | null>(null);
  const [paused, setPaused] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(true);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then(value => { if (mounted) setReduceMotion(value); });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { mounted = false; subscription.remove(); };
  }, []);

  return (
    <SafeAreaView style={styles.screen}>
      <LinearGradient colors={['#f3dfe9', '#e5e0ef', '#f4e9ed']} style={StyleSheet.absoluteFill} />
      <ScrollView onScroll={onDockScroll} scrollEventThrottle={32} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View style={styles.nav}><Text style={styles.wordmark}>connect</Text></View>
        <View style={styles.rails}>
          <PhotoString reverse paused={paused || reduceMotion || !!selected} onSelect={setSelected} />
          <PhotoString paused={paused || reduceMotion || !!selected} onSelect={setSelected} />
        </View>
        <View style={styles.galleryFooter}><Pressable accessibilityRole="button" accessibilityLabel={paused ? 'Resume photo animation' : 'Pause photo animation'} onPress={() => setPaused(value => !value)} style={styles.pauseButton}><Text style={styles.pauseText}>{paused || reduceMotion ? 'Still' : 'Pause'}</Text></Pressable></View>
      </ScrollView>
      <Modal visible={!!selected} transparent animationType="fade" onRequestClose={() => setSelected(null)}>
        <View style={styles.modalBackdrop}><Pressable accessibilityLabel="Dismiss photo" accessibilityRole="button" style={StyleSheet.absoluteFill} onPress={() => setSelected(null)} /><View accessibilityViewIsModal style={styles.detailCard}>{selected && <ScrollView bounces={false}><View style={styles.detailTop}><View><Text style={styles.detailTag}>{selected.tag}</Text><Text style={styles.detailSource}>Example moment</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Close photo" onPress={() => setSelected(null)} style={styles.closeIcon}><Text style={styles.closeGlyph}>×</Text></Pressable></View><View style={styles.detailBody}><Text style={styles.detailTitle}>{selected.title}</Text><Text style={styles.detailCopy}>{selected.detail}</Text></View><Image accessibilityLabel={selected.title} source={{ uri: selected.image }} style={styles.detailImage} /><Text style={styles.photoCredit}>Photography via Unsplash</Text></ScrollView>}</View></View>
      </Modal>
    </SafeAreaView>
  );
}

function PhotoString({ reverse = false, paused, onSelect }: { reverse?: boolean; paused: boolean; onSelect: (item: Memory) => void }) {
  const [progress] = useState(() => new Animated.Value(0));
  const position = useRef(0);
  const distance = MEMORIES.length * 162;

  useEffect(() => {
    const listener = progress.addListener(({ value }) => { position.current = value; });
    if (paused) return () => { progress.removeListener(listener); };
    let disposed = false;
    let animation: Animated.CompositeAnimation;
    const run = () => {
      animation = Animated.timing(progress, { toValue: 1, duration: 44000 * (1 - position.current), easing: Easing.linear, useNativeDriver: Platform.OS !== 'web', isInteraction: false });
      animation.start(({ finished }) => {
        if (!finished || disposed) return;
        position.current = 0;
        progress.setValue(0);
        run();
      });
    };
    run();
    return () => { disposed = true; animation?.stop(); progress.removeListener(listener); };
  }, [paused, progress]);

  return <View style={styles.stringRow}>
    <View pointerEvents="none" style={styles.string} />
    <Animated.View style={[styles.rail, { transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: reverse ? [-distance, 0] : [0, -distance] }) }] }]}>
      {(reverse ? [...rail].reverse() : rail).map((item, index) => <View key={`${item.id}-${index}`} style={styles.photoSlot}><MemoryTile item={item} index={index % MEMORIES.length} onPress={() => onSelect(item)} /></View>)}
    </Animated.View>
  </View>;
}

function MemoryTile({ item, index, onPress }: { item: Memory; index: number; onPress: () => void }) {
  const [scale] = useState(() => new Animated.Value(1));
  const animatePress = (pressed: boolean) => {
    Animated.timing(scale, { toValue: pressed ? 0.95 : 1, duration: pressed ? 120 : 220, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }).start();
  };
  return <Animated.View style={{ transform: [{ rotate: `${[-5, 4, -3, 5, -2][index]}deg` }, { scale }] }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${item.title}`} onPress={onPress} onPressIn={() => animatePress(true)} onPressOut={() => animatePress(false)} style={styles.polaroid}>
      <View style={styles.peg} />
      <Image source={{ uri: item.image }} style={styles.polaroidImage} />
      <Text numberOfLines={1} style={styles.polaroidCaption}>{item.title}</Text>
    </Pressable>
  </Animated.View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f1e5eb', overflow: 'hidden', ...Platform.select({ web: { backgroundImage: 'radial-gradient(ellipse at 95% 8%, #eed0e1 0%, transparent 60%), radial-gradient(ellipse at 0% 60%, #dcddee 0%, transparent 65%), linear-gradient(180deg, #f5e8ee, #f1e9eb)' } }) },
  content: { width: '100%', maxWidth: 620, alignSelf: 'center', paddingBottom: 100, flexGrow: 1, justifyContent: 'center' },
  nav: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24, paddingTop: 24, paddingBottom: 50 },
  wordmark: { color: '#332936', fontWeight: '700', fontSize: 36, letterSpacing: -1.8 },
  rails: { overflow: 'hidden', paddingTop: 4 },
  stringRow: { height: 186, paddingTop: 25 },
  string: { position: 'absolute', top: -24, left: -40, right: -40, height: 58, borderBottomWidth: 2, borderBottomColor: '#b7a79b', borderRadius: 180 },
  rail: { flexDirection: 'row', width: 1620 },
  photoSlot: { width: 162, alignItems: 'center' },
  peg: { position: 'absolute', zIndex: 1, top: -13, left: 66, width: 7, height: 23, borderRadius: 2, backgroundColor: '#cbb69e', borderWidth: 1, borderColor: '#b7a18b', transform: [{ rotate: '5deg' }] },
  polaroid: { width: 140, padding: 7, paddingBottom: 13, backgroundColor: '#fffdf8', borderRadius: 2, shadowColor: '#685363', shadowOpacity: 0.16, shadowRadius: 8, shadowOffset: { width: 0, height: 5 }, elevation: 3 },
  polaroidImage: { width: 126, height: 103, backgroundColor: '#d9cbd6' },
  polaroidCaption: { color: '#574b59', fontSize: 10, marginTop: 8, paddingHorizontal: 3 },
  galleryFooter: { marginHorizontal: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  galleryHint: { fontSize: 11, color: '#766575' },
  pauseButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  pauseText: { fontSize: 11, color: '#645162' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(42,31,43,0.38)', justifyContent: 'center', padding: 20 },
  detailCard: { overflow: 'hidden', backgroundColor: '#fffafd', borderRadius: 28, maxWidth: 420, maxHeight: '90%', width: '100%', alignSelf: 'center', shadowColor: '#35243a', shadowOpacity: 0.22, shadowRadius: 24, shadowOffset: { width: 0, height: 12 } },
  detailTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, paddingTop: 16 },
  detailSource: { fontSize: 11, color: '#7c6d78', marginTop: 4 },
  closeIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#f4eaf0', justifyContent: 'center', alignItems: 'center' },
  closeGlyph: { fontSize: 26, color: '#5c4656' },
  detailImage: { height: 240, marginHorizontal: 14, borderRadius: 18, backgroundColor: '#ded2dc' },
  detailBody: { paddingHorizontal: 22, paddingTop: 6, paddingBottom: 20 },
  photoCredit: { color: '#7c6d78', fontSize: 10, textAlign: 'center', paddingVertical: 16 },
  detailTag: { color: '#9a7894', fontSize: 10, letterSpacing: 1.4, fontWeight: '700', textTransform: 'uppercase' },
  detailTitle: { color: '#302331', fontSize: 29, lineHeight: 34, marginTop: 8, fontFamily: Platform.OS === 'ios' ? 'Georgia' : Platform.OS === 'web' ? 'Georgia, serif' : 'serif' },
  detailCopy: { color: '#766976', fontSize: 14, lineHeight: 21, marginTop: 11 },
});
