import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, Text, View } from 'react-native';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { api, audioUrl, saveRecording, type Profile } from '../lib/api';
import { PronunciationButton, usePronunciationPlayback } from './PronunciationPlayer';
import { Button, styles } from './ui';

export function PronunciationEditor({ profile, onSaved }: { profile: Profile; onSaved: (profile: Profile) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const locked = useRef(false);
  const mounted = useRef(true);
  const playback = usePronunciationPlayback();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY, status => {
    if (!mounted.current) return;
    if (status.hasError) {
      setRecording(false);
      setError('Recording was interrupted. Please record your name again.');
    } else if (status.isFinished) {
      setRecording(false);
      setDraft(status.url);
      if (!status.url) setError('No audio was captured. Please try again.');
    }
    if (status.isFinished || status.hasError) {
      void setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    }
  });
  const state = useAudioRecorderState(recorder, 100);
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', next => {
      if (next !== 'active' && recorder.isRecording) void recorder.stop().catch(() => {});
    });
    return () => {
      mounted.current = false;
      subscription.remove();
      if (recorder.isRecording) void recorder.stop().catch(() => {});
    };
  }, [recorder]);
  useEffect(() => () => {
    if (Platform.OS === 'web' && draft?.startsWith('blob:')) URL.revokeObjectURL(draft);
  }, [draft]);

  async function act(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try { await action(); }
    catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : 'Something went wrong. Please try again.');
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function record() {
    playback.stop();
    const permission = await AudioModule.requestRecordingPermissionsAsync();
    if (!permission.granted) {
      throw new Error('Microphone access is needed to record your name. Allow it in your device or browser settings and try again.');
    }
    if (!mounted.current) return;
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      if (!mounted.current) return;
      setDraft(null);
      recorder.record({ forDuration: 3 });
      setRecording(true);
    } catch {
      await setAudioModeAsync({ allowsRecording: false });
      throw new Error('Could not start the microphone. Check your microphone settings and try again.');
    }
  }

  async function save() {
    if (!draft) return;
    playback.stop();
    const updated = await saveRecording(profile.id, draft);
    if (!mounted.current) return;
    onSaved(updated);
    setDraft(null);
    setNotice('Pronunciation saved. Your group can now hear your name.');
  }

  async function remove() {
    playback.stop();
    await api(`/users/${profile.id}/pronunciation`, { method: 'DELETE', headers: { 'X-Demo-User': profile.id } });
    if (!mounted.current) return;
    onSaved({ ...profile, pronunciation_url: null });
    setNotice('Pronunciation removed.');
  }

  return <View style={{ gap: 16 }}>
    <Text style={styles.subtitle}>Say your name the way you want it to be heard. Record up to 3 seconds, then listen before saving.</Text>
    {profile.pronunciation_url && !draft && <PronunciationButton
      uri={audioUrl(profile.pronunciation_url)} name={profile.display_name} disabled={recording || busy} />}
    <Button disabled={busy} label={busy ? 'Please wait…' : recording ? `■ Stop recording (${Math.min(3, state.durationMillis / 1000).toFixed(1)}s / 3s)` : draft ? '● Record again' : '● Record my name'}
      onPress={() => void act(recording ? () => recorder.isRecording ? recorder.stop() : Promise.resolve() : record)} />
    {recording && <Text accessibilityLiveRegion="polite" style={styles.subtitle}>Recording… stops automatically at 3 seconds.</Text>}
    {draft && !recording && <>
      <Text style={styles.label}>Preview · not saved yet</Text>
      <PronunciationButton uri={draft} name="your recording" disabled={busy} />
      <Button disabled={busy} label="Save pronunciation" onPress={() => void act(save)} />
      <Button secondary disabled={busy} label="Discard recording" onPress={() => { playback.stop(); setDraft(null); setError(''); }} />
    </>}
    {profile.pronunciation_url && !draft && !recording && <Button secondary disabled={busy}
      label="Remove pronunciation" onPress={() => void act(remove)} />}
    {notice ? <Text accessibilityLiveRegion="polite" style={styles.subtitle}>{notice}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {Platform.OS === 'web' && <Text style={styles.subtitle}>Microphone recording requires localhost or HTTPS.</Text>}
  </View>;
}
