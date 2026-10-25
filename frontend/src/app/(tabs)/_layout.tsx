import { BlurView } from 'expo-blur';
import { Tabs, usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, PanResponder, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { DockMotion } from '@/components/navigation/DockMotion';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useInbox } from '@/state/inbox';
import { colors } from '@/theme';

const pages = ['/calls', '/home', '/inbox'] as const;
const native = Platform.OS !== 'web';
export const unstable_settings = { anchor: 'home' };

export default function TabsLayout() {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const { unreadThreads } = useInbox();
  const current = pages.findIndex(path => pathname === path);
  const [width, setWidth] = useState(342);
  const cell = (width - 12) / 3;
  const [position] = useState(() => new Animated.Value(Math.max(current, 0)));
  const [ripple] = useState(() => new Animated.Value(1));
  const [scrolling] = useState(() => new Animated.Value(0));
  const [swipe] = useState(() => new Animated.Value(0));
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moving = useRef(false);

  useEffect(() => {
    const toValue = Math.max(current, 0);
    if (reduced) { position.setValue(toValue); return; }
    const spring = Animated.spring(position, { toValue, stiffness: 240, damping: 25, mass: 0.8, useNativeDriver: native });
    ripple.setValue(0);
    const wave = Animated.timing(ripple, { toValue: 1, duration: 620, easing: Easing.out(Easing.cubic), useNativeDriver: native });
    spring.start(); wave.start();
    return () => { spring.stop(); wave.stop(); };
  }, [current, position, reduced, ripple]);

  useEffect(() => () => { if (settle.current) clearTimeout(settle.current); }, []);
  const onScroll = useCallback(() => {
    if (reduced) return;
    if (settle.current) clearTimeout(settle.current);
    if (!moving.current) {
      moving.current = true;
      Animated.spring(scrolling, { toValue: 1, stiffness: 230, damping: 25, useNativeDriver: native }).start();
    }
    settle.current = setTimeout(() => {
      moving.current = false;
      Animated.spring(scrolling, { toValue: 0, stiffness: 200, damping: 20, useNativeDriver: native }).start();
    }, 180);
  }, [reduced, scrolling]);

  const gestures = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => current >= 0 && Math.abs(g.dx) > 22 && Math.abs(g.dx) > Math.abs(g.dy) * 1.7,
    onPanResponderMove: (_, g) => { if (!reduced) swipe.setValue(Math.max(-60, Math.min(60, -g.dx * 0.2))); },
    onPanResponderRelease: (_, g) => {
      const next = current + (g.dx < 0 ? 1 : -1);
      if (Math.abs(g.dx) > 60 && next >= 0 && next < pages.length) router.navigate(pages[next]);
      Animated.spring(swipe, { toValue: 0, stiffness: 250, damping: 26, useNativeDriver: native }).start();
    },
    onPanResponderTerminate: () => Animated.spring(swipe, { toValue: 0, useNativeDriver: native }).start(),
  }), [current, reduced, router, swipe]);

  return <DockMotion value={onScroll}><View style={styles.screen} {...gestures.panHandlers}>
    <Tabs backBehavior="initialRoute" screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg }, animation: reduced ? 'none' : 'fade', transitionSpec: { animation: 'timing', config: { duration: reduced ? 0 : 240, easing: Easing.out(Easing.cubic) } } }}
      tabBar={() => <View pointerEvents="box-none" style={[styles.dockWrap, { bottom: Math.max(insets.bottom, 14) }]}>
        <Animated.View testID="floating-dock" style={[styles.dockShadow, { transform: [{ scaleX: scrolling.interpolate({ inputRange: [0, 1], outputRange: [1, 0.9] }) }, { scaleY: scrolling.interpolate({ inputRange: [0, 1], outputRange: [1, 0.94] }) }, { translateY: scrolling.interpolate({ inputRange: [0, 1], outputRange: [0, 5] }) }] }]}>
          <BlurView tint="light" intensity={85} style={styles.dock} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
            <Animated.View pointerEvents="none" style={[styles.selection, { width: cell, transform: [{ translateX: Animated.add(Animated.multiply(position, cell), swipe) }, { scaleX: ripple.interpolate({ inputRange: [0, 0.3, 1], outputRange: [1.04, 1.1, 1] }) }] }]}>
              <Animated.View style={[styles.ripple, { opacity: reduced ? 0 : ripple.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0.4, 0.25, 0] }), transform: [{ scale: ripple.interpolate({ inputRange: [0, 1], outputRange: [0.1, 3.5] }) }] }]} />
            </Animated.View>
            {pages.map((path, index) => <Pressable key={path} accessibilityRole="tab" accessibilityLabel={['Calls', 'Connect', 'Messages'][index]} accessibilityState={{ selected: pathname === path }} onPress={() => router.navigate(path)} style={({ pressed }) => [styles.tab, pressed && { opacity: 0.65 }]}>
              <Animated.View style={{ transform: [{ translateY: scrolling.interpolate({ inputRange: [0, 1], outputRange: [0, 4] }) }] }}><Icon name={(['video', 'square.grid.2x2', 'bubble.left.and.bubble.right'] as const)[index]} size={21} /></Animated.View>
              <Animated.Text style={[styles.label, pathname === path && styles.activeLabel, { opacity: scrolling.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]}>{['Calls', 'Connect', 'Messages'][index]}</Animated.Text>
              {index === 2 && unreadThreads > 0 && <View style={styles.badge}><Text style={styles.badgeText}>{unreadThreads}</Text></View>}
            </Pressable>)}
          </BlurView>
        </Animated.View>
      </View>}>
      <Tabs.Screen name="calls" /><Tabs.Screen name="home" /><Tabs.Screen name="inbox" />
      <Tabs.Screen name="reels" options={{ href: null }} /><Tabs.Screen name="search" options={{ href: null }} /><Tabs.Screen name="profile" options={{ href: null }} />
    </Tabs>
  </View></DockMotion>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, overflow: 'hidden' },
  dockWrap: { position: 'absolute', left: 24, right: 24, alignItems: 'center' },
  dockShadow: { width: '100%', maxWidth: 410, borderRadius: 36, shadowColor: '#745c78', shadowOpacity: 0.12, shadowRadius: 20, shadowOffset: { width: 0, height: 7 } },
  dock: { flexDirection: 'row', padding: 6, borderRadius: 36, overflow: 'hidden', backgroundColor: '#ffffff88', borderWidth: 1, borderColor: '#ffffffdd' },
  selection: { position: 'absolute', left: 5, top: 5, bottom: 5, borderRadius: 29, backgroundColor: '#ead9e9aa', borderWidth: 1, borderColor: '#ffffff99', overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  ripple: { position: 'absolute', width: 55, height: 55, borderRadius: 28, backgroundColor: '#ffffff' },
  tab: { flex: 1, minHeight: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', gap: 4 },
  label: { fontSize: 10, color: colors.textSecondary },
  activeLabel: { color: colors.text, fontWeight: '600' },
  badge: { position: 'absolute', top: 4, right: 16, minWidth: 16, height: 16, paddingHorizontal: 4, borderRadius: 8, backgroundColor: colors.blue, justifyContent: 'center', alignItems: 'center' },
  badgeText: { fontSize: 9, color: 'white' },
});
