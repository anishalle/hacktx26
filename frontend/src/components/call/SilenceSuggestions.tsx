import { useEffect, useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { SuggestionPrompt } from '../../types/call';

interface SilenceSuggestionsProps {
  suggestions: SuggestionPrompt[];
  visible: boolean;
  onSelect: (suggestion: SuggestionPrompt) => void;
  onDismiss: () => void;
}

/**
 * Floating suggestion pills that appear when the user has been quiet for a while.
 * Positioned at the top of the screen so they don't interfere with the ? button.
 *
 * Shows 2-3 things the user could say to join the conversation.
 * Gently slides down, can be dismissed with an X or by tapping a suggestion.
 */
export function SilenceSuggestions({
  suggestions,
  visible,
  onSelect,
  onDismiss,
}: SilenceSuggestionsProps) {
  const [slideAnim] = useState(() => new Animated.Value(-100));
  const [fadeAnim] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (visible && suggestions.length > 0) {
      Animated.parallel([
        Animated.spring(slideAnim, {
          toValue: 0,
          friction: 8,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: -100,
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
  }, [visible, suggestions.length, slideAnim, fadeAnim]);

  if (!visible || suggestions.length === 0) return null;

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
      <View style={styles.header}>
        <Text style={styles.headerText}> Jump in?</Text>
        <Pressable onPress={onDismiss} style={styles.dismissButton}>
          <Text style={styles.dismissText}>✕</Text>
        </Pressable>
      </View>

      {suggestions.map((s) => (
        <Pressable
          key={s.id}
          style={styles.suggestionPill}
          onPress={() => onSelect(s)}
        >
          <Text style={styles.suggestionText}>{s.text}</Text>
          <Text style={styles.suggestionContext}>{s.context}</Text>
        </Pressable>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 60,
    left: 16,
    right: 16,
    zIndex: 150,
    backgroundColor: 'rgba(27, 30, 36, 0.92)',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.2)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  headerText: {
    color: '#fbbf24',
    fontSize: 14,
    fontWeight: '700',
  },
  dismissButton: {
    padding: 4,
  },
  dismissText: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 16,
  },
  suggestionPill: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 12,
    padding: 12,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  suggestionText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    fontStyle: 'italic',
  },
  suggestionContext: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 11,
    marginTop: 4,
  },
});
