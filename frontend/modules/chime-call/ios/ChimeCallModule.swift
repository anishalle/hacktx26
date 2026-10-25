import ExpoModulesCore
import AmazonChimeSDK
import AVFoundation
import UIKit

public class ChimeCallModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChimeCall")
    Events("onTranscript", "onTranscriptionStatus", "onParticipants", "onVideoTile", "onVolume", "onState", "onError")
    OnCreate { [weak self] in
      ChimeController.shared.emit = { [weak self] name, body in self?.sendEvent(name, body) }
    }
    OnDestroy {
      DispatchQueue.main.async { ChimeController.shared.stop() }
    }
    AsyncFunction("join") { (meetingJSON: String, attendeeJSON: String, promise: Promise) in
      AVAudioSession.sharedInstance().requestRecordPermission { audio in
        guard audio else {
          promise.reject("MICROPHONE_DENIED", "Allow microphone access in Settings to join the call.")
          return
        }
        AVCaptureDevice.requestAccess(for: .video) { camera in
          DispatchQueue.main.async {
            do {
              let videoEnabled = try ChimeController.shared.join(meetingJSON, attendeeJSON, camera: camera)
              promise.resolve(["cameraEnabled": videoEnabled])
            } catch {
              ChimeController.shared.stop()
              promise.reject("CHIME_JOIN_FAILED", error.localizedDescription)
            }
          }
        }
      }
    }
    AsyncFunction("leave") { ChimeController.shared.stop() }.runOnQueue(.main)
    AsyncFunction("setMuted") { (muted: Bool) in
      guard let audioVideo = ChimeController.shared.session?.audioVideo else { return }
      let success = muted ? audioVideo.realtimeLocalMute() : audioVideo.realtimeLocalUnmute()
      if !success { throw NSError(domain: "ChimeCall", code: 1, userInfo: [NSLocalizedDescriptionKey: "Microphone could not be updated."]) }
    }.runOnQueue(.main)
    AsyncFunction("setVideoOff") { (off: Bool) in
      guard let audioVideo = ChimeController.shared.session?.audioVideo else { return }
      if off { audioVideo.stopLocalVideo() } else { try audioVideo.startLocalVideo() }
    }.runOnQueue(.main)
    View(ChimeVideoView.self) {
      Prop("tileId") { (view: ChimeVideoView, tileId: Int) in view.setTile(tileId) }
      Prop("mirror") { (view: ChimeVideoView, mirror: Bool) in view.renderView.mirror = mirror }
    }
  }
}

private class ChimeController: NSObject, TranscriptEventObserver, RealtimeObserver, VideoTileObserver, AudioVideoObserver {
  static let shared = ChimeController()
  var session: DefaultMeetingSession?
  var emit: ((String, [String: Any?]) -> Void)?

  func join(_ meetingJSON: String, _ attendeeJSON: String, camera: Bool) throws -> Bool {
    stop()
    guard let meeting = try JSONSerialization.jsonObject(with: Data(meetingJSON.utf8)) as? [String: Any],
          let attendee = try JSONSerialization.jsonObject(with: Data(attendeeJSON.utf8)) as? [String: Any],
          let placement = meeting["MediaPlacement"] as? [String: String],
          let meetingId = meeting["MeetingId"] as? String,
          let mediaRegion = meeting["MediaRegion"] as? String,
          let attendeeId = attendee["AttendeeId"] as? String,
          let externalUserId = attendee["ExternalUserId"] as? String,
          let joinToken = attendee["JoinToken"] as? String,
          let audioFallback = placement["AudioFallbackUrl"],
          let audioHost = placement["AudioHostUrl"],
          let signaling = placement["SignalingUrl"],
          let turn = placement["TurnControlUrl"] else {
      throw NSError(domain: "ChimeCall", code: 2, userInfo: [NSLocalizedDescriptionKey: "The backend returned incomplete Chime meeting details."])
    }
    let config = MeetingSessionConfiguration(
      createMeetingResponse: CreateMeetingResponse(meeting: Meeting(
        externalMeetingId: meeting["ExternalMeetingId"] as? String,
        mediaPlacement: MediaPlacement(audioFallbackUrl: audioFallback, audioHostUrl: audioHost, signalingUrl: signaling, turnControlUrl: turn, eventIngestionUrl: placement["EventIngestionUrl"]),
        mediaRegion: mediaRegion, meetingId: meetingId)),
      createAttendeeResponse: CreateAttendeeResponse(attendee: Attendee(attendeeId: attendeeId, externalUserId: externalUserId, joinToken: joinToken)))
    let audio = AVAudioSession.sharedInstance()
    try audio.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
    try audio.setActive(true)
    let current = DefaultMeetingSession(configuration: config, logger: ConsoleLogger(name: "ChimeCall", level: .ERROR))
    session = current
    current.audioVideo.addAudioVideoObserver(observer: self)
    current.audioVideo.addRealtimeObserver(observer: self)
    current.audioVideo.addVideoTileObserver(observer: self)
    current.audioVideo.addRealtimeTranscriptEventObserver?(observer: self)
    try current.audioVideo.start()
    current.audioVideo.startRemoteVideo()
    if camera {
      do { try current.audioVideo.startLocalVideo(); return true }
      catch { emit?("onError", ["message": "Camera unavailable; joined with audio."]) }
    }
    return false
  }

  func stop() {
    guard let current = session else { return }
    current.audioVideo.removeAudioVideoObserver(observer: self)
    current.audioVideo.removeRealtimeObserver(observer: self)
    current.audioVideo.removeVideoTileObserver(observer: self)
    current.audioVideo.removeRealtimeTranscriptEventObserver?(observer: self)
    current.audioVideo.stopLocalVideo()
    current.audioVideo.stopRemoteVideo()
    current.audioVideo.stop()
    session = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  func transcriptEventDidReceive(transcriptEvent: TranscriptEvent) {
    if let transcript = transcriptEvent as? Transcript {
      let results: [[String: Any]] = transcript.results.map { result in
        ["resultId": result.resultId, "isPartial": result.isPartial,
         "startTimeMs": result.startTimeMs, "endTimeMs": result.endTimeMs,
         "alternatives": result.alternatives.map { alternative in
           ["transcript": alternative.transcript, "items": alternative.items.filter { $0.type != .unknown }.map { item in
             ["type": item.type.description, "content": item.content,
              "startTimeMs": item.startTimeMs, "endTimeMs": item.endTimeMs,
              "attendee": ["attendeeId": item.attendee.attendeeId, "externalUserId": item.attendee.externalUserId]] as [String: Any]
           }] as [String: Any]
         }] as [String: Any]
      }
      emit?("onTranscript", ["results": results])
    } else if let status = transcriptEvent as? TranscriptionStatus {
      emit?("onTranscriptionStatus", ["status": status.type.description, "message": status.message])
    }
  }
  func attendeesDidJoin(attendeeInfo: [AttendeeInfo]) { participants(attendeeInfo, removed: false) }
  func attendeesDidLeave(attendeeInfo: [AttendeeInfo]) { participants(attendeeInfo, removed: true) }
  func attendeesDidDrop(attendeeInfo: [AttendeeInfo]) { participants(attendeeInfo, removed: true) }
  func attendeesDidMute(attendeeInfo: [AttendeeInfo]) { emit?("onParticipants", ["muted": true, "attendeeIds": attendeeInfo.map { $0.attendeeId }]) }
  func attendeesDidUnmute(attendeeInfo: [AttendeeInfo]) { emit?("onParticipants", ["muted": false, "attendeeIds": attendeeInfo.map { $0.attendeeId }]) }
  private func participants(_ attendees: [AttendeeInfo], removed: Bool) {
    emit?("onParticipants", ["removed": removed, "attendees": attendees.map { ["attendeeId": $0.attendeeId, "externalUserId": $0.externalUserId] }])
  }
  func volumeDidChange(volumeUpdates: [VolumeUpdate]) {
    emit?("onVolume", ["updates": volumeUpdates.map { ["attendeeId": $0.attendeeInfo.attendeeId, "speaking": $0.volumeLevel.rawValue > 0] as [String: Any] }])
  }
  func signalStrengthDidChange(signalUpdates: [SignalUpdate]) {}
  func videoTileDidAdd(tileState: VideoTileState) { tile(tileState, removed: false) }
  func videoTileDidRemove(tileState: VideoTileState) { tile(tileState, removed: true) }
  func videoTileDidPause(tileState: VideoTileState) {}
  func videoTileDidResume(tileState: VideoTileState) {}
  func videoTileSizeDidChange(tileState: VideoTileState) {}
  private func tile(_ state: VideoTileState, removed: Bool) {
    emit?("onVideoTile", ["tileId": state.tileId, "attendeeId": state.attendeeId, "isLocal": state.isLocalTile, "removed": removed])
  }
  func audioSessionDidStartConnecting(reconnecting: Bool) { emit?("onState", ["state": reconnecting ? "reconnecting" : "connecting"]) }
  func audioSessionDidStart(reconnecting: Bool) { emit?("onState", ["state": "connected"]) }
  func audioSessionDidDrop() { emit?("onState", ["state": "reconnecting"]) }
  func audioSessionDidStopWithStatus(sessionStatus: MeetingSessionStatus) { emit?("onState", ["state": "ended", "reason": String(describing: sessionStatus.statusCode)]) }
  func audioSessionDidCancelReconnect() { emit?("onState", ["state": "ended"]) }
  func connectionDidRecover() { emit?("onState", ["state": "connected"]) }
  func connectionDidBecomePoor() { emit?("onState", ["state": "reconnecting"]) }
  func videoSessionDidStartConnecting() {}
  func videoSessionDidStartWithStatus(sessionStatus: MeetingSessionStatus) {}
  func videoSessionDidStopWithStatus(sessionStatus: MeetingSessionStatus) {}
  func remoteVideoSourcesDidBecomeAvailable(sources: [RemoteVideoSource]) {}
  func remoteVideoSourcesDidBecomeUnavailable(sources: [RemoteVideoSource]) {}
  func cameraSendAvailabilityDidChange(available: Bool) {}
}

class ChimeVideoView: ExpoView {
  let renderView = DefaultVideoRenderView()
  private var tileId = -1
  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    renderView.contentMode = .scaleAspectFill
    addSubview(renderView)
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    renderView.frame = bounds
  }
  func setTile(_ next: Int) {
    guard next != tileId else { return }
    if tileId >= 0 { ChimeController.shared.session?.audioVideo.unbindVideoView(tileId: tileId) }
    tileId = next
    if tileId >= 0 { ChimeController.shared.session?.audioVideo.bindVideoView(videoView: renderView, tileId: tileId) }
  }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if tileId >= 0 {
      if window == nil { ChimeController.shared.session?.audioVideo.unbindVideoView(tileId: tileId) }
      else { ChimeController.shared.session?.audioVideo.bindVideoView(videoView: renderView, tileId: tileId) }
    }
  }
}
