import { useEffect, type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { GestureDetector, GestureHandlerRootView, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import type { Lore, Message } from '@/api';
import type { PlaybackItem } from '@/state/playback';

import { MomentCard, type LoreActions } from './MomentCard';

/** How much of each back card shows above the one in front of it. */
export const PEEK = 40;
/** Back cards behind the front one. */
const BACK = 2;
/** Cards kept mounted on either side of the window, so swipes in both directions animate. */
const BEHIND = 1;
const SWIPE = 90;
const FLICK = 700;
const SPRING = { damping: 20, stiffness: 220, mass: 0.9 };

type Props = {
  items: Lore[];
  /** The front card; `items.length` means the deck is done. */
  index: number;
  onIndexChange: (index: number) => void;
  actions: LoreActions;
  queue?: PlaybackItem[];
  onOpenPhoto?: (m: Message) => void;
  /** The front card's height. */
  height: number;
  /** Shown in the front slot once every card has been swiped. */
  done?: ReactNode;
};

/**
 * The Lore deck: the front card with the next two peeking above it. Swipe left for the next card,
 * right to bring the last one back, or tap a peek to jump to it. Each card owns its own drag, so a
 * card that flew off stays where it went and flies back from there.
 */
export function MomentDeck({ items, index, onIndexChange, actions, queue, onOpenPhoto, height, done }: Props) {
  const { width } = useWindowDimensions();
  const off = width * 1.3;
  const window = items
    .map((lore, i) => ({ lore, depth: i - index }))
    .filter(({ depth }) => depth >= -BEHIND && depth <= BACK + 1);
  return (
    <GestureHandlerRootView style={[styles.deck, { height: height + PEEK * BACK }]}>
      {index >= items.length && done ? <View style={[styles.slot, { height }]}>{done}</View> : null}
      {window.map(({ lore, depth }) => (
        <DeckSlot
          key={lore.id}
          depth={depth}
          height={height}
          off={off}
          canBack={index > 0}
          onForward={() => onIndexChange(index + 1)}
          onBack={() => onIndexChange(index - 1)}
        >
          {depth > BACK ? null : (
            <MomentCard
              lore={lore}
              actions={actions}
              // A card leaving to the left keeps its full face while it flies off.
              peek={depth > 0}
              onPeekPress={() => onIndexChange(index + depth)}
              queue={queue}
              onOpenPhoto={onOpenPhoto}
            />
          )}
        </DeckSlot>
      ))}
    </GestureHandlerRootView>
  );
}

type SlotProps = {
  depth: number;
  height: number;
  off: number;
  canBack: boolean;
  onForward: () => void;
  onBack: () => void;
  children: ReactNode;
};

function DeckSlot({ depth, height, off, canBack, onForward, onBack, children }: SlotProps) {
  // A card arriving at the back of the window fades in from one step further back.
  const d = useSharedValue(depth > 0 ? depth + 1 : 0);
  const tx = useSharedValue(depth < 0 ? -off : 0);
  const ty = useSharedValue(0);
  const front = depth === 0;

  useEffect(() => {
    d.set(withSpring(Math.max(depth, 0), SPRING));
    if (depth < 0) {
      // Passed over without a swipe (a peek was tapped): send it off to the left.
      if (Math.abs(tx.get()) < 1) tx.set(withTiming(-off, { duration: 260 }));
    } else if (tx.get() !== 0 || ty.get() !== 0) {
      tx.set(withSpring(0, SPRING));
      ty.set(withSpring(0, SPRING));
    }
  }, [depth, d, tx, ty, off]);

  const pan = usePanGesture({
    enabled: front,
    activeOffsetX: [-12, 12],
    // Vertical drags belong to the Lore tab's scroll view.
    failOffsetY: [-14, 14],
    onUpdate: (e) => {
      'worklet';
      tx.set(e.translationX);
      ty.set(e.translationY * 0.15);
    },
    onDeactivate: (e) => {
      'worklet';
      const forward = e.translationX < -SWIPE || e.velocityX < -FLICK;
      const back = e.translationX > SWIPE || e.velocityX > FLICK;
      if (forward) {
        tx.set(withTiming(-off, { duration: 240 }));
        ty.set(withTiming(e.translationY * 0.4, { duration: 240 }));
        scheduleOnRN(onForward);
      } else if (back && canBack) {
        tx.set(withSpring(0, SPRING));
        ty.set(withSpring(0, SPRING));
        scheduleOnRN(onBack);
      } else {
        tx.set(withSpring(0, SPRING));
        ty.set(withSpring(0, SPRING));
      }
    },
  });

  const style = useAnimatedStyle(() => {
    const k = d.get();
    return {
      opacity: interpolate(k, [0, 1, 2, 3], [1, 0.85, 0.7, 0], Extrapolation.CLAMP),
      transform: [
        { translateX: tx.get() },
        { translateY: ty.get() - PEEK * k },
        { scale: 1 - 0.05 * k },
        { rotate: `${Math.max(-12, Math.min(12, tx.get() / 22))}deg` },
      ],
    };
  });

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[styles.slot, { height, zIndex: 10 - depth }, style]}
        pointerEvents={depth < 0 || depth > BACK ? 'none' : 'auto'}
      >
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  deck: { marginHorizontal: 16 },
  slot: { position: 'absolute', left: 0, right: 0, bottom: 0, transformOrigin: 'top' },
});
