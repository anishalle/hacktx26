import { useEffect, useState } from 'react';
import { Chime } from '../services/chime';
import { getMembers, startTranscription } from '../services/api';
import type { CallSession, CallState, ChimeResult, Participant } from '../types/call';

export function useChimeCall(session: CallSession | undefined, onTranscript: (results: ChimeResult[], names: Record<string, string>) => void) {
  const [participants, setParticipants] = useState<Participant[]>(() => session ? [{ id: session.attendee.AttendeeId, displayName: 'You', isLocal: true, isMuted: false, isSpeaking: false }] : []);
  const [state, setState] = useState<CallState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [transcriptionStatus, setTranscriptionStatus] = useState('Waiting for speech');
  const [cameraEnabled, setCameraEnabled] = useState(true);

  useEffect(() => {
    if (!session || !Chime) {
      return;
    }
    const native = Chime;
    let active = true;
    let transcriptionRequested = false;
    const names: Record<string, string> = {};
    const updateNames = async () => {
      try {
        const response = await getMembers(session.call_id);
        if (!active) return;
        for (const member of response.members) names[member.attendee_id] = member.user_id;
        setParticipants(current => current.map(p => ({ ...p, displayName: names[p.id] || p.displayName })));
      } catch (e) { if (active) setError(e instanceof Error ? e.message : 'Could not load participants.'); }
    };
    const subscriptions = [
      native.addListener('onTranscript', event => {
        if (active) onTranscript(event.results, names);
      }),
      native.addListener('onTranscriptionStatus', event => {
        if (!active) return;
        setTranscriptionStatus(event.status === 'started' || event.status === 'resumed' ? 'Live transcription' : `Transcription ${event.status}`);
        if (event.status === 'failed') setError(event.message || 'Live transcription could not start.');
      }),
      native.addListener('onState', event => {
        if (!active) return;
        setState(event.state);
        if (event.state === 'connected' && session.is_host && !transcriptionRequested) {
          transcriptionRequested = true;
          void startTranscription(session.call_id).then(() => {
            if (active) setTranscriptionStatus(current => current === 'Live transcription' ? current : 'Transcription requested');
          }).catch(e => { if (active) setError(e instanceof Error ? e.message : 'Could not start transcription.'); });
        }
      }),
      native.addListener('onParticipants', event => {
        if (!active) return;
        setParticipants(current => {
          let next = [...current];
          for (const attendee of event.attendees || []) {
            if (event.removed) next = next.filter(p => p.id !== attendee.attendeeId);
            else if (!next.some(p => p.id === attendee.attendeeId)) next.push({ id: attendee.attendeeId, displayName: names[attendee.attendeeId] || 'Participant', isMuted: false, isSpeaking: false, isLocal: attendee.attendeeId === session.attendee.AttendeeId });
          }
          if (event.attendeeIds) next = next.map(p => event.attendeeIds!.includes(p.id) ? { ...p, isMuted: !!event.muted } : p);
          return next;
        });
        void updateNames();
      }),
      native.addListener('onVideoTile', event => {
        if (!active) return;
        setParticipants(current => {
          const next = current.some(p => p.id === event.attendeeId) ? current : [...current, { id: event.attendeeId, displayName: names[event.attendeeId] || 'Participant', isLocal: event.isLocal, isMuted: false, isSpeaking: false }];
          return next.map(p => p.id === event.attendeeId ? { ...p, videoTileId: event.removed ? undefined : event.tileId } : p);
        });
      }),
      native.addListener('onVolume', event => {
        if (active) setParticipants(current => current.map(p => {
          const update = event.updates.find(item => item.attendeeId === p.id);
          return update ? { ...p, isSpeaking: update.speaking } : p;
        }));
      }),
      native.addListener('onError', event => { if (active) setError(event.message); }),
    ];
    void updateNames();
    void native.join(JSON.stringify(session.meeting), JSON.stringify(session.attendee)).then(result => {
      if (active) setCameraEnabled(result.cameraEnabled);
      else void native.leave();
    }).catch(e => { if (active) { setError(e instanceof Error ? e.message : 'Could not join the call.'); setState('ended'); } });
    return () => { active = false; subscriptions.forEach(subscription => subscription.remove()); void native.leave(); };
  }, [session, onTranscript]);
  return { participants, state, error: !session || !Chime ? 'Open a call in the iPhone development build.' : error, transcriptionStatus, cameraEnabled };
}
