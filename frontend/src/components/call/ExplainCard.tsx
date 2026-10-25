import { useEffect, useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { ExplainResponse } from '../../types/call';

interface ExplainCardProps {
  response: ExplainResponse | null;
  isLoading: boolean;
  isVisible: boolean;
  onDismiss: () => void;
  mode: 'quick' | 'detailed';
}

const KIND_LABELS: Record<string, string> = {
  inside_joke: ' Inside joke',
  slang: ' Slang',
  nickname: ' Nickname',
  event: ' Event',
  place: ' Place',
  general: ' Context',
};

/**
 * The overlay card that appears when the ? button is tapped.
 * Slides up from the bottom-right, overlays the call without covering video tiles.
 *
 * - Shows a loading state ("Figuring out what that means...")
 * - Then the one-line explanation
 * - Auto-dismisses after 15s for quick mode, manual dismiss for detailed
 * - Tap anywhere on the card to dismiss
 */
export function ExplainCard({
  response,
  isLoading,
  isVisible,
  onDismiss,
  mode,
}: ExplainCardProps) {
  const [slideAnim] = useState(() => new Animated.Value(100));
  const [fadeAnim] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (isVisible) {
      Animated.parallel([
        Animated.spring(slideAnim, {
          toValue: 0,
          friction: 8,
          tension: 65,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: 100,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [isVisible, slideAnim, fadeAnim]);

  if (!isVisible) return null;

  return (
    <Animated.View
      style={[
        styles.container,
        {
          transform: [{ translateY: slideAnim }],
          opacity: fadeAnim,
        },
      ]}
    >
      <Pressable onPress={onDismiss} style={styles.card}>
        {isLoading ? (
          <View style={styles.loadingContainer}>
            <Text style={styles.loadingDots}>· · ·</Text>
            <Text style={styles.loadingText}>
              Figuring out what that means...
            </Text>
          </View>
        ) : response ? (
          <View>
            {response.kind && (
              <Text style={styles.kindLabel}>
                {KIND_LABELS[response.kind] || ' Context'}
              </Text>
            )}
            <Text style={styles.answerText}>{response.answer}</Text>
            {response.confidence > 0 && response.confidence < 0.5 && (
              <Text style={styles.lowConfidence}>
                 Not totally sure about this one
              </Text>
            )}
            <Text style={styles.dismissHint}>
              {mode === 'quick' ? 'auto-dismisses in 15s · tap to close' : 'tap to close'}
            </Text>
          </View>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 236,
    left: 16,
    right: 16,
    zIndex: 200,
  },
  card: {
    backgroundColor: 'rgba(27, 30, 36, 0.95)',
    borderRadius: 23,
    padding: 22,
    borderWidth: 1,
    borderColor: 'rgba(116, 181, 250, 0.3)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 12,
  },
  loadingContainer: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  loadingDots: {
    fontSize: 24,
    color: '#9bcaff',
    fontWeight: '700',
    letterSpacing: 4,
    marginBottom: 4,
  },
  loadingText: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.6)',
    fontStyle: 'italic',
  },
  kindLabel: {
    fontSize: 12,
    color: '#9bcaff',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 6,
  },
  answerText: {
    fontSize: 16,
    color: '#fff',
    lineHeight: 22,
    fontWeight: '500',
  },
  lowConfidence: {
    fontSize: 12,
    color: '#fbbf24',
    marginTop: 8,
  },
  dismissHint: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.3)',
    marginTop: 10,
    textAlign: 'right',
  },
});
