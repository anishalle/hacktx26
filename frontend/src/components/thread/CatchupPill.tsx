import { Button, Host } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize } from '@expo/ui/swift-ui/modifiers';
import { useEffect, useState } from 'react';
import { Animated, StyleSheet } from 'react-native';

import { formatCount } from '@/lib/format';

/** Floating "Catch Me Up · 1,204" glass button at the top of a busy thread. */
export function CatchupPill({ count, top, onPress }: { count: number; top: number; onPress: () => void }) {
  const [anim] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.spring(anim, { toValue: 1, useNativeDriver: true, damping: 16, stiffness: 180, delay: 250 }).start();
  }, [anim]);
  const label = `Catch Me Up · ${formatCount(count)}`;
  return (
    <Animated.View
      style={[
        styles.wrap,
        {
          top,
          opacity: anim,
          transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }],
        },
      ]}
      pointerEvents="box-none"
    >
      {/* matchContents measures once, so remount when the label changes. */}
      <Host matchContents colorScheme="light" key={label}>
        <Button
          label={label}
          systemImage="sparkles"
          onPress={onPress}
          modifiers={[buttonStyle('glass'), controlSize('large')]}
        />
      </Host>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 9 },
});
