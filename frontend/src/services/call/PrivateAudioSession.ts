import { ConnectionState, RemoteAudioTrack, Room, RoomEvent, Track } from 'livekit-client';

/** Owns audio isolation independently of the assistant UI. */
export class PrivateAudioSession {
  private active = false;
  private previousMic = false;
  private volumes = new Map<RemoteAudioTrack, number>();
  private restoreTask: Promise<void> | null = null;

  private room: Room;

  constructor(room: Room) {
    this.room = room;
    room.on(RoomEvent.TrackSubscribed, this.onTrackSubscribed);
    room.on(RoomEvent.LocalTrackPublished, this.onLocalPublished);
  }

  private duck(track: RemoteAudioTrack) {
    if (!this.volumes.has(track)) this.volumes.set(track, track.attachedElements.length ? track.getVolume() : 1);
    track.setVolume(0.15);
  }

  private onTrackSubscribed = (track: unknown) => {
    if (this.active && track instanceof RemoteAudioTrack) this.duck(track);
  };

  private onLocalPublished = () => {
    if (this.active) this.blockOutgoingAudio();
  };

  private blockOutgoingAudio() {
    for (const publication of this.room.localParticipant.audioTrackPublications.values()) {
      if (publication.source === Track.Source.Microphone && publication.track) {
        // Disable the actual WebRTC source before any asynchronous signalling.
        publication.track.mediaStreamTrack.enabled = false;
      }
    }
  }

  async enter(): Promise<() => Promise<void>> {
    if (this.active) throw new Error('A private question is already open.');
    if (this.room.state !== ConnectionState.Connected) throw new Error('Reconnect to the call before asking.');
    this.active = true;
    this.restoreTask = null;
    this.previousMic = this.room.localParticipant.isMicrophoneEnabled;
    this.blockOutgoingAudio();
    try {
      await this.room.localParticipant.setMicrophoneEnabled(false);
      for (const participant of this.room.remoteParticipants.values()) {
        for (const publication of participant.audioTrackPublications.values()) {
          if (publication.track instanceof RemoteAudioTrack) this.duck(publication.track);
        }
      }
    } catch {
      await this.restore();
      throw new Error('Could not isolate your microphone. Voice capture did not start.');
    }
    return () => this.restore();
  }

  restore(): Promise<void> {
    if (this.restoreTask) return this.restoreTask;
    if (!this.active) return Promise.resolve();
    this.active = false;
    for (const [track, volume] of this.volumes) track.setVolume(volume);
    this.volumes.clear();
    this.restoreTask = (async () => {
      if (this.room.state === ConnectionState.Connected) {
        await this.room.localParticipant.setMicrophoneEnabled(this.previousMic);
      }
    })();
    return this.restoreTask;
  }

  dispose() {
    this.room.off(RoomEvent.TrackSubscribed, this.onTrackSubscribed);
    this.room.off(RoomEvent.LocalTrackPublished, this.onLocalPublished);
    this.active = false;
    this.volumes.clear();
  }
}
