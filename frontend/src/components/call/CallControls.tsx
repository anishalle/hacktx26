import { Pressable, StyleSheet, Text, View } from 'react-native';

interface CallControlsProps {
  isMuted: boolean;
  isVideoOff: boolean;
  onToggleMute: () => void;
  onToggleVideo: () => void;
  onEndCall: () => void;
}

/**
 * Bottom bar with mute, video toggle, and end call buttons.
 * Standard call controls — nothing fancy here.
 */
export function CallControls({
  isMuted,
  isVideoOff,
  onToggleMute,
  onToggleVideo,
  onEndCall,
}: CallControlsProps) {
  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        style={[styles.button, isMuted && styles.buttonActive]}
        onPress={onToggleMute}
      >

        <Text style={[styles.buttonLabel, isMuted && styles.labelActive]}>
          {isMuted ? 'Unmute' : 'Mute'}
        </Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        style={[styles.button, isVideoOff && styles.buttonActive]}
        onPress={onToggleVideo}
      >

        <Text style={[styles.buttonLabel, isVideoOff && styles.labelActive]}>
          {isVideoOff ? 'Start Video' : 'Stop Video'}
        </Text>
      </Pressable>

      <Pressable accessibilityRole="button" accessibilityLabel="Leave call preview" style={[styles.button, styles.endCallButton]} onPress={onEndCall}>

        <Text style={[styles.buttonLabel, styles.endCallLabel]}>End</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
    paddingVertical: 16,
    paddingHorizontal: 24,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 82,
    height: 54,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  buttonActive: {
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  buttonIcon: {
    fontSize: 24,
  },
  buttonLabel: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    marginTop: 2,
    fontWeight: '500',
  },
  labelActive: {
    color: '#fff',
  },
  endCallButton: {
    backgroundColor: '#ef4444',
  },
  endCallLabel: {
    color: '#fff',
  },
});
