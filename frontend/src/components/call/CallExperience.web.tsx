import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ConnectionState, Room, RoomEvent, type Participant, type TranscriptionSegment } from 'livekit-client';
import { LiveVideoGrid } from './LiveVideoGrid.web';
import { QuestionButton } from './QuestionButton';
import { ExplainCard } from './ExplainCard';
import { AskModal } from './AskModal';
import { CallControls } from './CallControls';
import { SilenceSuggestions } from './SilenceSuggestions';
import { joinRoom } from '../../services/rooms';
import { PrivateAudioSession } from '../../services/call/PrivateAudioSession';
import { useCallTranscript } from '../../hooks/useCallTranscript';
import { useExplainCall } from '../../hooks/useExplainCall';
import { useVoiceQuestion } from '../../hooks/useVoiceQuestion.web';
import { useSilenceDetection } from '../../hooks/useSilenceDetection';

const ROOM_EVENTS = [RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected,
  RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed, RoomEvent.TrackMuted,
  RoomEvent.TrackUnmuted, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished,
  RoomEvent.ActiveSpeakersChanged, RoomEvent.ParticipantNameChanged,
  RoomEvent.ConnectionStateChanged, RoomEvent.AudioPlaybackStatusChanged];

export default function CallExperience() {
  const params = useLocalSearchParams<{ callId: string; invite?: string; name?: string }>();
  const router = useRouter();
  const [room] = useState(() => new Room({ adaptiveStream: true, dynacast: true, webAudioMix: true,
    videoCaptureDefaults: { resolution: { width: 640, height: 480, frameRate: 24 } },
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true },
  }));
  const [audio, setAudio] = useState<PrivateAudioSession | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [connection, setConnection] = useState(ConnectionState.Disconnected);
  const [name, setName] = useState(params.name || '');
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shareNotice, setShareNotice] = useState('');
  const [needsAudio, setNeedsAudio] = useState(false);
  const [explainMode, setExplainMode] = useState<'quick' | 'detailed'>('quick');
  const [identity, setIdentity] = useState('');
  const joining = useRef(false);
  const alive = useRef(true);
  const receivedSegments = useRef(new Set<string>());
  const { addUtterance, getRecentWindow, storageError, utterances } = useCallTranscript(params.callId);
  const explain = useExplainCall(params.callId, identity);
  const submitQuestion = useCallback((question: string) => {
    setExplainMode('detailed');
    void explain.askQuestion(question, getRecentWindow(120_000));
  }, [explain.askQuestion, getRecentWindow]);
  const voice = useVoiceQuestion(audio, submitQuestion);
  const silence = useSilenceDetection({ callId: params.callId, userId: identity,
    localParticipantId: identity, getRecentTranscript: getRecentWindow,
    enabled: connection === ConnectionState.Connected && utterances.length > 0 && !voice.active });

  const sync = useCallback(() => {
    setParticipants([room.localParticipant, ...room.remoteParticipants.values()]);
    setConnection(room.state);
    setNeedsAudio(!room.canPlaybackAudio);
  }, [room]);

  useEffect(() => {
    alive.current = true;
    const privateAudio = new PrivateAudioSession(room);
    setAudio(privateAudio);
    ROOM_EVENTS.forEach(event => room.on(event, sync));
    return () => {
      alive.current = false;
      ROOM_EVENTS.forEach(event => room.off(event, sync));
      privateAudio.dispose();
      void room.disconnect();
    };
  }, [room, sync]);

  useEffect(() => {
    // The teammate's STT integration can publish standard LiveKit transcription events.
    const receive = (segments: TranscriptionSegment[], participant?: Participant) => {
      if (!participant) return;
      for (const segment of segments) {
        const key = `${participant.identity}:${segment.id}`;
        if (!segment.final || !segment.text.trim() || receivedSegments.current.has(key)) continue;
        receivedSegments.current.add(key);
        if (receivedSegments.current.size > 1000) receivedSegments.current.delete(receivedSegments.current.values().next().value!);
        const now = Date.now();
        addUtterance({ speakerId: participant.identity, speakerName: participant.name || 'Guest',
          text: segment.text, startMs: now, endMs: now });
      }
    };
    room.on(RoomEvent.TranscriptionReceived, receive);
    return () => { room.off(RoomEvent.TranscriptionReceived, receive); };
  }, [room, addUtterance]);

  useEffect(() => {
    const latest = utterances[utterances.length - 1];
    if (latest?.speakerId === identity) silence.recordUserSpeech();
  }, [utterances, identity, silence.recordUserSpeech]);

  useEffect(() => {
    if (voice.active && connection !== ConnectionState.Connected) void voice.close();
  }, [connection, voice.active, voice.close]);

  async function connect() {
    if (joining.current || !name.trim()) return;
    if (!params.invite) { setError('This call link is missing its invitation. Ask for a new link.'); return; }
    if (!window.isSecureContext) { setError('Open this call over HTTPS to use your camera and microphone.'); return; }
    joining.current = true; setBusy(true); setError('');
    void room.startAudio().catch(() => setNeedsAudio(true));
    try {
      const access = await joinRoom(params.callId, params.invite, name.trim());
      if (!alive.current) return;
      setIdentity(access.participant_identity);
      await room.connect(access.server_url, access.participant_token);
      if (!alive.current) { await room.disconnect(); return; }
      setJoined(true);
      try { await room.localParticipant.setMicrophoneEnabled(true); }
      catch { setError('Microphone unavailable. Allow access, then tap Unmute.'); }
      if (!alive.current) return;
      try { await room.localParticipant.setCameraEnabled(true); }
      catch { setError('Camera unavailable. You can still stay in the call.'); }
      sync();
    } catch {
      await room.disconnect();
      if (alive.current) { setJoined(false); setError('Could not connect to the call. Check your invitation and try again.'); }
    } finally { joining.current = false; if (alive.current) setBusy(false); }
  }

  async function control(kind: 'mic' | 'camera') {
    if (busy || voice.active) return;
    setBusy(true); setError('');
    try {
      if (kind === 'mic') await room.localParticipant.setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled);
      else await room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled);
      sync();
    } catch { setError(`Could not change your ${kind === 'mic' ? 'microphone' : 'camera'}. Check browser permissions.`); }
    finally { setBusy(false); }
  }

  async function leave() {
    await room.disconnect();
    await voice.close();
    router.replace('/');
  }

  async function share() {
    const url = new URL(`/call/${encodeURIComponent(params.callId)}`, window.location.origin);
    url.searchParams.set('invite', params.invite || '');
    try {
      if (navigator.share) await navigator.share({ title: 'Join my call', url: url.toString() });
      else { await navigator.clipboard.writeText(url.toString()); setShareNotice('Link copied'); }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) setShareNotice('Could not copy the link. Copy it from the address bar.');
    }
  }

  if (!joined) return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.joinPage} keyboardShouldPersistTaps="handled">
        <Pressable accessibilityRole="button" onPress={() => router.replace('/')} style={styles.back}><Text style={styles.secondary}>Back</Text></Pressable>
        <Text style={styles.joinTitle}>You’re invited.</Text>
        <Text style={styles.joinHint}>Join with your camera and microphone.</Text>
        <TextInput accessibilityLabel="Your name" value={name} onChangeText={setName} maxLength={60} placeholder="Your name" placeholderTextColor="#828c99" style={styles.input} editable={!busy} onSubmitEditing={connect} />
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Join call" onPress={connect} disabled={busy || !name.trim()} style={[styles.joinButton, (busy || !name.trim()) && { opacity: 0.5 }]}>{busy ? <ActivityIndicator color="#162536" /> : <Text style={styles.joinButtonText}>Join call</Text>}</Pressable>
      </ScrollView>
    </SafeAreaView>
  );

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <View><Text style={styles.title}>in the loop</Text><Text style={styles.connection}>{connection === ConnectionState.Connected ? `${participants.length} in call` : connection === ConnectionState.Reconnecting ? 'Reconnecting…' : 'Disconnected'}</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel="Invite someone" onPress={share} style={styles.invite}><Text style={styles.inviteText}>Invite</Text></Pressable>
        </View>
        {shareNotice ? <Pressable onPress={() => setShareNotice('')}><Text style={styles.notice}>{shareNotice}</Text></Pressable> : null}
        {error || storageError ? <Text accessibilityRole="alert" style={styles.error}>{error || storageError}</Text> : null}
        {needsAudio && <Pressable accessibilityRole="button" onPress={() => void room.startAudio().catch(() => setError('Tap again to enable call audio.'))} style={styles.sound}><Text style={styles.inviteText}>Enable sound</Text></Pressable>}
        {connection === ConnectionState.Disconnected && <Pressable accessibilityRole="button" onPress={connect} style={styles.sound}><Text style={styles.inviteText}>Rejoin call</Text></Pressable>}
        <LiveVideoGrid participants={participants} localId={identity} />
        <View style={styles.assistantRow}><Text style={styles.assistantHint}>Tap for context. Hold to ask by voice.</Text></View>
        <QuestionButton onTap={() => { setExplainMode('quick'); void explain.quickExplain(getRecentWindow(10_000)); }} onLongPressStart={() => { explain.dismiss(); void voice.start(); }} isLoading={explain.isLoading} disabled={voice.active || busy || connection !== ConnectionState.Connected} />
        <CallControls isMuted={!room.localParticipant.isMicrophoneEnabled} isVideoOff={!room.localParticipant.isCameraEnabled} onToggleMute={() => void control('mic')} onToggleVideo={() => void control('camera')} onEndCall={() => void leave()} disabled={busy || voice.active || connection !== ConnectionState.Connected} />
        <SilenceSuggestions suggestions={silence.suggestions} visible={silence.showSuggestions && !voice.active} onSelect={silence.selectSuggestion} onDismiss={silence.dismissSuggestions} />
        <ExplainCard response={explain.response} isLoading={explain.isLoading} isVisible={explain.isVisible && !voice.active} onDismiss={explain.dismiss} mode={explainMode} />
        <AskModal status={voice.status} transcript={voice.transcript} error={voice.error} onSend={voice.send} onCancel={() => void voice.close()} />
      </SafeAreaView>
    </View>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101114' },
  safe: { flex: 1, width: '100%', maxWidth: 900, alignSelf: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 22, paddingVertical: 18 },
  title: { color: '#fafafa', fontSize: 22, fontWeight: '600', letterSpacing: -0.7 },
  connection: { color: '#909ba9', fontSize: 12, marginTop: 4 },
  invite: { minHeight: 44, paddingHorizontal: 18, borderRadius: 22, backgroundColor: '#283342', justifyContent: 'center' },
  inviteText: { color: '#b7d9ff', fontSize: 13, fontWeight: '600' },
  notice: { color: '#a0c8f6', paddingHorizontal: 24, paddingBottom: 10, fontSize: 12 },
  assistantRow: { minHeight: 116, justifyContent: 'center', paddingLeft: 24, paddingRight: 120 },
  assistantHint: { color: '#9aa6b6', fontSize: 12, lineHeight: 19, maxWidth: 200 },
  error: { color: '#f8b2b5', fontSize: 13, lineHeight: 19, paddingHorizontal: 22, marginBottom: 14 },
  sound: { alignSelf: 'center', padding: 14, marginBottom: 10, borderRadius: 14, backgroundColor: '#283342' },
  joinPage: { width: '100%', maxWidth: 500, alignSelf: 'center', padding: 26 },
  back: { minHeight: 44, justifyContent: 'center', marginBottom: 70 },
  secondary: { color: '#a7b4c4', fontSize: 14 },
  joinTitle: { color: '#fafafa', fontSize: 35, fontWeight: '600', letterSpacing: -1 },
  joinHint: { color: '#9ca6b5', fontSize: 14, marginTop: 12, marginBottom: 30 },
  input: { color: '#fff', backgroundColor: '#242a33', borderRadius: 15, padding: 17, fontSize: 16, marginBottom: 16 },
  joinButton: { minHeight: 54, borderRadius: 15, backgroundColor: '#8ac3ff', alignItems: 'center', justifyContent: 'center' },
  joinButtonText: { color: '#162536', fontWeight: '600', fontSize: 16 },
});
