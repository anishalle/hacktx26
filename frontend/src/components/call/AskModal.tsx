import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
export type VoiceStatus = 'idle' | 'preparing' | 'listening' | 'ready' | 'stopping' | 'error';

interface AskModalProps {
  status: VoiceStatus;
  transcript: string;
  error: string;
  onSend: () => void;
  onCancel: () => void;
  onChangeText?: (text: string) => void;
}

export function AskModal({ status, transcript, error, onSend, onCancel, onChangeText }: AskModalProps) {
  const waiting = status === 'preparing' || status === 'stopping';
  const isNative = Platform.OS !== 'web';
  return (
    <Modal visible={status !== 'idle'} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={styles.overlay}>
        <Pressable accessibilityLabel="Close voice question" style={StyleSheet.absoluteFill} onPress={onCancel} />
        <View style={styles.sheet} accessibilityViewIsModal>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.eyebrow}>PRIVATE QUESTION</Text>
            <Pressable accessibilityRole="button" onPress={onCancel} style={styles.close}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
          <Text accessibilityRole="header" style={styles.title}>
            {status === 'preparing'
              ? 'Muting your call mic...'
              : status === 'listening'
                ? 'Go ahead, listening...'
                : status === 'error'
                  ? 'Something went wrong'
                  : isNative
                    ? 'Type your question'
                    : 'Ready to ask?'}
          </Text>
          <Text style={styles.subtitle}>
            {status === 'listening' || status === 'ready'
              ? 'Call mic muted - call audio lowered'
              : isNative
                ? 'Your mic is muted from the call'
                : 'Ask by voice'}
          </Text>
          {isNative && onChangeText ? (
            <TextInput
              style={styles.textInput}
              value={transcript}
              onChangeText={onChangeText}
              placeholder="What do you want to know?"
              placeholderTextColor="#828c99"
              multiline
              autoFocus
              onSubmitEditing={onSend}
            />
          ) : (
            <>
              <View style={styles.wave} accessibilityLabel={status === 'listening' ? 'Listening for your question' : 'Voice question'}>
                {[12, 26, 38, 22, 45, 30, 16].map((height, i) => (
                  <View key={i} style={[styles.bar, { height, opacity: status === 'listening' ? 1 : 0.35 }]} />
                ))}
              </View>
              <ScrollView style={styles.words} contentContainerStyle={{ paddingBottom: 8 }}>
                <Text accessibilityLiveRegion="polite" style={styles.transcript}>
                  {transcript || 'Say your question out loud.'}
                </Text>
              </ScrollView>
            </>
          )}
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send voice question"
            onPress={onSend}
            disabled={waiting || !transcript.trim() || status === 'error'}
            style={[styles.send, (waiting || !transcript.trim() || status === 'error') && { opacity: 0.4 }]}
          >
            <Text style={styles.sendText}>{status === 'stopping' ? 'Finishing...' : 'Ask'}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: { width: '100%', maxWidth: 560, maxHeight: '85%', alignSelf: 'center', backgroundColor: '#202329', borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 36 },
  handle: { width: 34, height: 4, borderRadius: 3, backgroundColor: '#535963', alignSelf: 'center', marginBottom: 14 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { color: '#91bce9', fontSize: 10, letterSpacing: 1.5, fontWeight: '600' },
  close: { minHeight: 44, minWidth: 44, alignItems: 'flex-end', justifyContent: 'center' },
  closeText: { color: '#b5bbc5', fontSize: 13 },
  title: { color: '#fafafa', fontSize: 24, lineHeight: 30, fontWeight: '600', marginTop: 10, letterSpacing: -0.6 },
  subtitle: { color: '#a0a7b2', fontSize: 12, marginTop: 10 },
  textInput: { color: '#fff', backgroundColor: '#2a3040', borderRadius: 14, padding: 16, fontSize: 16, lineHeight: 22, minHeight: 80, marginVertical: 16, textAlignVertical: 'top' },
  wave: { flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', height: 92 },
  bar: { width: 5, borderRadius: 3, backgroundColor: '#86bfff' },
  words: { maxHeight: 150, marginBottom: 20 },
  transcript: { color: '#e7ebf1', fontSize: 17, lineHeight: 25, textAlign: 'center' },
  error: { color: '#ffb8b8', fontSize: 13, lineHeight: 20, marginTop: 14 },
  send: { minHeight: 52, borderRadius: 15, backgroundColor: '#85bfff', justifyContent: 'center', alignItems: 'center' },
  sendText: { color: '#142336', fontSize: 15, fontWeight: '700' },
});
