import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { VideoGrid } from '../../components/call/VideoGrid';
import { QuestionButton } from '../../components/call/QuestionButton';
import { ExplainCard } from '../../components/call/ExplainCard';
import { AskModal } from '../../components/call/AskModal';
import { SilenceSuggestions } from '../../components/call/SilenceSuggestions';
import { CallControls } from '../../components/call/CallControls';

import { useChimeCall } from '../../hooks/useChimeCall';
import { Chime } from '../../services/chime';
import { getCallSession, endCall } from '../../services/api';
import { useCallTranscript } from '../../hooks/useCallTranscript';
import { useSilenceDetection } from '../../hooks/useSilenceDetection';
import { useExplainCall } from '../../hooks/useExplainCall';

import type { SuggestionPrompt } from '../../types/call';

// Hardcoded for demo â€” will come from auth/route params later
const LOCAL_USER_ID = 'user-local';

/**
 * Main video call screen.
 *
 * Features:
 * 1. Video grid (2-4 participant tiles with active speaker highlight)
 * 2. ? button (bottom-right)
 *    - Tap: quick explain of last 10s
 *    - Long press: mute mic + open ask modal
 * 3. Silence suggestions (popups when user hasn't spoken)
 * 4. Explain card (overlay showing AI response)
 * 5. Call controls (mute, video, end call)
 */
export default function CallScreen() {
  const { callId } = useLocalSearchParams<{ callId: string }>();
  return <ConnectedCallScreen key={callId || 'preview'} callId={callId || 'preview'} />;
}

function ConnectedCallScreen({ callId }: { callId: string }) {
  const router = useRouter();
  const resolvedCallId = callId;

  // State
  const session = getCallSession(resolvedCallId);
  const [controlError, setControlError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [askModalVisible, setAskModalVisible] = useState(false);
  const [explainMode, setExplainMode] = useState<'quick' | 'detailed'>('quick');

  const previousMute = useRef(false);

  // Hooks
  const { utterances, storageError, getRecentWindow, addChimeResults, flush } = useCallTranscript(resolvedCallId);
  const { participants, state, error: callError, transcriptionStatus, cameraEnabled } = useChimeCall(session, addChimeResults);
  const activeSpeakerId = participants.find(p => p.isSpeaking)?.id || null;
  const localId = session?.attendee.AttendeeId || LOCAL_USER_ID;
  const { isLoading, response, isVisible, quickExplain, askQuestion, dismiss } =
    useExplainCall(resolvedCallId, localId, flush);
  const {
    suggestions,
    showSuggestions,
    recordUserSpeech,
    dismissSuggestions,
    selectSuggestion,
  } = useSilenceDetection({
    callId: resolvedCallId,
    userId: LOCAL_USER_ID,
    localParticipantId: localId,
    getRecentTranscript: getRecentWindow,
    enabled: utterances.length > 0 && !askModalVisible, // disable while asking
  });

  useEffect(() => {
    if (session && Chime) void Chime.setMuted(isMuted).catch(e => setControlError(String(e)));
  }, [isMuted, session]);
  useEffect(() => {
    if (session && Chime) void Chime.setVideoOff(isVideoOff || !cameraEnabled).catch(e => setControlError(String(e)));
  }, [isVideoOff, cameraEnabled, session]);

  useEffect(() => {
    const latest = utterances[utterances.length - 1];
    if (latest?.speakerId === localId) recordUserSpeech();
  }, [utterances, recordUserSpeech, localId]);

  // --- Handlers ---

  /**
   * Single tap on ? â€” quick explain.
   * Grab last 10 seconds of transcript and get a fast one-liner.
   */
  const handleQuickExplain = useCallback(() => {
    const recent = getRecentWindow(10_000);
    setExplainMode('quick');
    quickExplain(recent);
  }, [getRecentWindow, quickExplain]);

  /**
   * Long press on ? â€” open ask modal.
   * Mutes the mic and lowers call volume so user can type their question.
   */
  const handleLongPressStart = useCallback(() => {
    previousMute.current = isMuted;
    setIsMuted(true);
    setAskModalVisible(true);
    // TODO: Lower call volume via WebRTC/Daily API
  }, [isMuted]);

  /**
   * User submits a question from the ask modal.
   */
  const handleAskSubmit = useCallback(
    (question: string) => {
      const recent = getRecentWindow(120_000); // last 2 minutes for context
      setExplainMode('detailed');
      setAskModalVisible(false);
      setIsMuted(previousMute.current);
      askQuestion(question, recent);
      // Restore the previous mute selection.
    },
    [getRecentWindow, askQuestion],
  );

  /**
   * Cancel the ask modal â€” restore mic state.
   */
  const handleAskCancel = useCallback(() => {
    setAskModalVisible(false);
    setIsMuted(previousMute.current);
    // Only unmute if they were unmuted before
    // For now, keep muted â€” user can unmute manually
  }, []);

  /**
   * User selects a silence suggestion.
   */
  const handleSuggestionSelect = useCallback(
    (suggestion: SuggestionPrompt) => {
      selectSuggestion(suggestion);
      // Could auto-speak or just give them confidence to talk
    },
    [selectSuggestion],
  );

  const handleEndCall = useCallback(async () => {
    try { await flush(); } catch (e) { setControlError(String(e)); }
    try { if (session?.is_host) await endCall(session.call_id); }
    catch (e) { setControlError(String(e)); return; }
    await Chime?.leave();
    router.replace('/');
  }, [router, session, flush]);

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}><Text style={styles.title}>The group call</Text><Text style={styles.badge}>{state.toUpperCase()}</Text></View>
        <Text style={styles.subtitle}>A little context. A closer connection.</Text>
        <Text selectable style={styles.status}>Invite code: {resolvedCallId}</Text>
        {/* Video grid â€” takes up the main area */}
        <View style={styles.videoArea}>
          <VideoGrid
            participants={participants.map(p => p.isLocal ? { ...p, isMuted } : p)}
            activeSpeakerId={activeSpeakerId}
          />
        </View>

        {/* Silence suggestions â€” top overlay */}
        <SilenceSuggestions
          suggestions={suggestions}
          visible={showSuggestions}
          onSelect={handleSuggestionSelect}
          onDismiss={dismissSuggestions}
        />

        {/* Explain card â€” bottom overlay */}
        <ExplainCard
          response={response}
          isLoading={isLoading}
          isVisible={isVisible}
          onDismiss={dismiss}
          mode={explainMode}
        />

        <View style={styles.assistantSpace}>
          <Text style={styles.assistantTitle}>Stay in the loop</Text>
          <Text style={styles.assistantHint}>Tap for context. Hold to ask privately.</Text>
          {utterances.length > 0 && <Text numberOfLines={2} style={styles.status}>{utterances[utterances.length - 1].text}</Text>}
          <Text style={styles.status}>{controlError || callError || storageError || transcriptionStatus}</Text>
        </View>
        {/* ? button â€” always visible bottom-right */}
        <QuestionButton
          onTap={handleQuickExplain}
          onLongPressStart={handleLongPressStart}
          isLoading={isLoading}
          disabled={askModalVisible || !session || state === 'ended'}
        />

        {/* Call controls â€” bottom bar */}
        <CallControls
          isMuted={isMuted}
          isVideoOff={isVideoOff || !cameraEnabled}
          onToggleMute={() => setIsMuted((m) => !m)}
          onToggleVideo={() => setIsVideoOff((v) => !v)}
          onEndCall={handleEndCall}
        />

        {/* Ask modal â€” covers screen when long-pressing ? */}
        <AskModal
          visible={askModalVisible}
          isLoading={isLoading}
          onSubmit={handleAskSubmit}
          onCancel={handleAskCancel}
        />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#101114',
  },
  safeArea: {
    flex: 1,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, paddingTop: 18 },
  title: { color: '#fafafa', fontSize: 23, fontWeight: '600', letterSpacing: -0.7 },
  badge: { color: '#9aabbd', fontSize: 10, letterSpacing: 1.5, borderWidth: 1, borderColor: '#34383e', borderRadius: 12, padding: 7 },
  subtitle: { color: '#8b9099', fontSize: 13, paddingHorizontal: 22, marginTop: 8, marginBottom: 20 },
  assistantSpace: { padding: 22, paddingRight: 112, minHeight: 136, justifyContent: 'center' },
  assistantTitle: { color: '#f5f5f5', fontWeight: '600', fontSize: 16 },
  assistantHint: { color: '#a4a8b0', fontSize: 12, lineHeight: 18, marginTop: 6 },
  status: { color: '#7a838e', fontSize: 11, marginTop: 10 },
  videoArea: {
    flex: 1,
  },
});
