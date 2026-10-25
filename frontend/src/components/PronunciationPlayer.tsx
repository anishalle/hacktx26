import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { usePathname } from 'expo-router';
import { Button, styles } from './ui';

const Playback = createContext({
  play: (_uri: string) => {}, stop: () => {}, playingUri: null as string | null,
});

export function PronunciationPlayback({ children }: { children: ReactNode }) {
  const player = useAudioPlayer();
  const status = useAudioPlayerStatus(player);
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState('');
  const pathname = usePathname();
  useEffect(() => { player.pause(); }, [pathname, player]);
  async function play(nextUri: string) {
    try {
      setError('');
      player.pause();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      player.replace(nextUri);
      setUri(nextUri);
      player.play();
    } catch {
      setError('Could not play this recording. Please try again.');
    }
  }
  return <Playback.Provider value={{ play, stop: () => player.pause(), playingUri: status.playing ? uri : null }}>
    {children}
    {(error || status.error) ? <View style={{ padding: 16 }}><Text accessibilityRole="alert" style={styles.error}>
      {error || 'Could not load this recording. Please try again.'}
    </Text></View> : null}
  </Playback.Provider>;
}

export const usePronunciationPlayback = () => useContext(Playback);

export function PronunciationButton({ uri, name, disabled = false }: { uri: string; name: string; disabled?: boolean }) {
  const playback = usePronunciationPlayback();
  const playing = playback.playingUri === uri;
  return <Button secondary disabled={disabled} label={playing ? '■ Stop' : `🔊 Hear ${name}`}
    onPress={() => playing ? playback.stop() : playback.play(uri)} />;
}
