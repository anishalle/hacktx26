import { type ComponentRef, useEffect, useRef, useState } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

interface AskModalProps {
  visible: boolean;
  isLoading: boolean;
  onSubmit: (question: string) => void;
  onCancel: () => void;
}

/**
 * Full-screen ask modal triggered by long-pressing the ? button.
 *
 * When this opens:
 * - User's mic is muted (handled by parent)
 * - Call volume is lowered (handled by parent)
 * - User types their specific question
 * - Submit sends it to the AI with recent transcript context
 *
 * The call stays visible behind a semi-transparent overlay.
 */
export function AskModal({ visible, isLoading, onSubmit, onCancel }: AskModalProps) {
  const [question, setQuestion] = useState('');
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const [fadeAnim] = useState(() => new Animated.Value(0));
  const [slideAnim] = useState(() => new Animated.Value(50));

  useEffect(() => {
    if (visible) {
      fadeAnim.setValue(0);
      slideAnim.setValue(50);
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.spring(slideAnim, {
          toValue: 0,
          friction: 8,
          useNativeDriver: true,
        }),
      ]).start(() => {
        inputRef.current?.focus();
      });
    }
  }, [visible, fadeAnim, slideAnim]);

  if (!visible) return null;

  const handleSubmit = () => {
    const q = question.trim();
    if (q.length === 0 || isLoading) return;
    onSubmit(q);
    setQuestion('');
  };

  return (
    <Animated.View style={[styles.overlay, { opacity: fadeAnim }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardAvoid}
      >
        <Pressable style={styles.backdrop} onPress={onCancel} />

        <Animated.View
          style={[
            styles.modal,
            { transform: [{ translateY: slideAnim }] },
          ]}
        >
          <View style={styles.header}>
            <View style={styles.micBadge}>
              <Text style={styles.micBadgeText}>Private question</Text>
            </View>
            <Pressable onPress={onCancel} style={styles.cancelButton}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </View>

          <Text style={styles.title}>Ask about the call</Text>
          <Text style={styles.subtitle}>
            Ask about a phrase, a person, or something you missed. Only you see the answer.
          </Text>

          <View style={styles.inputRow}>
            <TextInput
              ref={inputRef}
              style={styles.input}
              placeholder="e.g. What does 'procs' mean?"
              placeholderTextColor="rgba(255,255,255,0.3)"
              accessibilityLabel="Your question about the call"
              maxLength={300}
              value={question}
              onChangeText={setQuestion}
              onSubmitEditing={handleSubmit}
              returnKeyType="send"
              autoFocus
              multiline={false}
              editable={!isLoading}
            />
            <Pressable
              onPress={handleSubmit}
              style={[
                styles.sendButton,
                (!question.trim() || isLoading) && styles.sendButtonDisabled,
              ]}
              disabled={!question.trim() || isLoading}
            >
              <Text accessibilityLabel="Send question" style={styles.sendButtonText}>
                {isLoading ? '···' : '→'}
              </Text>
            </Pressable>
          </View>

          <View style={styles.quickQuestions}>
            <Text style={styles.quickLabel}>Quick questions:</Text>
            {[
              'Who is that?',
              "What did they just say?",
              "What's the joke?",
            ].map((q) => (
              <Pressable
                key={q}
                style={styles.quickChip}
                onPress={() => {
                  setQuestion(q);

                }}
                disabled={isLoading}
              >
                <Text style={styles.quickChipText}>{q}</Text>
              </Pressable>
            ))}
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 300,
  },
  keyboardAvoid: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  modal: {
    backgroundColor: '#202329',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 40,
    borderTopWidth: 1,
    borderColor: 'rgba(116, 181, 250, 0.2)',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  micBadge: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  micBadgeText: {
    color: '#ef4444',
    fontSize: 12,
    fontWeight: '600',
  },
  cancelButton: {
    padding: 8,
  },
  cancelText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 14,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.5)',
    lineHeight: 18,
    marginBottom: 16,
  },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  input: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: '#fff',
    fontSize: 16,
    borderWidth: 1,
    borderColor: 'rgba(116, 181, 250, 0.3)',
  },
  sendButton: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: '#74b5fa',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: '#374151',
  },
  sendButtonText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
  },
  quickQuestions: {
    marginTop: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
  },
  quickLabel: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 12,
    marginRight: 4,
  },
  quickChip: {
    backgroundColor: 'rgba(116, 181, 250, 0.15)',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(116, 181, 250, 0.2)',
  },
  quickChipText: {
    color: '#b4d6ff',
    fontSize: 13,
  },
});
