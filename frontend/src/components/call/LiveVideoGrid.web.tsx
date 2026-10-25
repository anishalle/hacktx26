import { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Participant, RemoteAudioTrack, Track } from 'livekit-client';

function VideoTile({ participant, local }: { participant: Participant; local: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const publication = participant.getTrackPublication(Track.Source.Camera);
  const track = publication?.track;
  useEffect(() => {
    const element = video.current;
    if (!track || !element) return;
    track.attach(element);
    return () => { track.detach(element); };
  }, [track]);
  const visible = !!track && !publication?.isMuted;
  return (
    <View testID={`participant-${participant.identity}`} style={[styles.tile, participant.isSpeaking && styles.speaking]}>
      <video ref={video} autoPlay playsInline muted style={{ position: 'absolute', width: '100%', height: '100%', objectFit: 'cover', opacity: visible ? 1 : 0, transform: local ? 'scaleX(-1)' : undefined }} />
      {!visible && <View style={styles.avatar}><Text style={styles.initial}>{(participant.name || 'Guest').slice(0, 1).toUpperCase()}</Text></View>}
      <View style={styles.tag}><Text style={styles.name} numberOfLines={1}>{local ? 'You' : participant.name || 'Guest'}</Text>{!participant.isMicrophoneEnabled && <Text style={styles.muted}>Muted</Text>}</View>
      {participant.isSpeaking && <View accessibilityLabel={`${participant.name || 'Participant'} is speaking`} style={styles.speakingDot} />}
    </View>
  );
}

function AudioTrack({ track }: { track: RemoteAudioTrack }) {
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    track.attach(element);
    return () => { track.detach(element); };
  }, [track]);
  return <audio ref={audio} autoPlay />;
}

export function LiveVideoGrid({ participants, localId }: { participants: Participant[]; localId: string }) {
  return (
    <>
      <View style={styles.grid}>{participants.map(participant => <VideoTile key={participant.identity} participant={participant} local={participant.identity === localId} />)}</View>
      {participants.filter(p => p.identity !== localId).flatMap(p => Array.from(p.audioTrackPublications.values())).map(publication => publication.track instanceof RemoteAudioTrack ? <AudioTrack key={publication.trackSid} track={publication.track} /> : null)}
    </>
  );
}
const styles = StyleSheet.create({
  grid: { flex: 1, minHeight: 180, flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 14, paddingBottom: 8 },
  tile: { flexGrow: 1, flexBasis: '46%', minHeight: 180, borderRadius: 24, overflow: 'hidden', backgroundColor: '#252c35', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  speaking: { borderColor: '#84bbf7' },
  avatar: { width: 72, height: 72, borderRadius: 36, backgroundColor: '#354354', alignItems: 'center', justifyContent: 'center' },
  initial: { fontSize: 28, color: '#c9ddf5', fontWeight: '500' },
  tag: { position: 'absolute', bottom: 12, left: 12, right: 12, flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start' },
  name: { color: '#fff', fontSize: 13, fontWeight: '600', backgroundColor: 'rgba(0,0,0,0.45)', padding: 6, borderRadius: 8, maxWidth: '70%' },
  muted: { color: '#e6e8ed', fontSize: 10, backgroundColor: 'rgba(0,0,0,0.45)', padding: 5, borderRadius: 6 },
  speakingDot: { position: 'absolute', top: 12, right: 12, width: 8, height: 8, borderRadius: 4, backgroundColor: '#8ec6ff' },
});
