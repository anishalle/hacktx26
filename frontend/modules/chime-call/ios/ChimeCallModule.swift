import ExpoModulesCore
import AmazonChimeSDK
import AVFoundation
import UIKit

public class ChimeCallModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChimeCall")
    Events("onCaptionStatus", "onParticipants", "onVideoTile", "onVolume", "onState", "onError")
    OnCreate { [weak self] in
      ChimeController.shared.emit = { [weak self] name, body in self?.sendEvent(name, body) }
      CaptionStreamer.shared.emit = { [weak self] name, body in self?.sendEvent(name, body) }
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
    // Captions: this phone's own microphone, streamed to the API (which relays it to Muse).
    AsyncFunction("startCaptions") { (url: String) in
      guard let target = URL(string: url) else {
        throw NSError(domain: "ChimeCall", code: 3, userInfo: [NSLocalizedDescriptionKey: "Invalid captions URL."])
      }
      try CaptionStreamer.shared.start(target)
    }.runOnQueue(.main)
    AsyncFunction("stopCaptions") { CaptionStreamer.shared.stop() }.runOnQueue(.main)
    AsyncFunction("setMuted") { (muted: Bool) in
      CaptionStreamer.shared.muted = muted
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

private class ChimeController: NSObject, RealtimeObserver, VideoTileObserver, AudioVideoObserver {
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
    try current.audioVideo.start()
    current.audioVideo.startRemoteVideo()
    if camera {
      do { try current.audioVideo.startLocalVideo(); return true }
      catch { emit?("onError", ["message": "Camera unavailable; joined with audio."]) }
    }
    return false
  }

  func stop() {
    CaptionStreamer.shared.stop()
    guard let current = session else { return }
    current.audioVideo.removeAudioVideoObserver(observer: self)
    current.audioVideo.removeRealtimeObserver(observer: self)
    current.audioVideo.removeVideoTileObserver(observer: self)
    current.audioVideo.stopLocalVideo()
    current.audioVideo.stopRemoteVideo()
    current.audioVideo.stop()
    session = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
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

/// Streams this phone's microphone as 24 kHz mono PCM16 (80 ms binary frames) to the captions
/// WebSocket while Chime runs the call. The tap shares Chime's playAndRecord/voiceChat audio
/// session; it never reconfigures it. Muted, it sends silence so the stream keeps real-time pace.
private class CaptionStreamer: NSObject {
  static let shared = CaptionStreamer()
  var emit: ((String, [String: Any?]) -> Void)?
  var muted = false

  private static let chunkBytes = 3840  // 80 ms of 24 kHz mono Int16
  private let queue = DispatchQueue(label: "chime-call.captions")
  private let engine = AVAudioEngine()
  private let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true)!
  private var converter: AVAudioConverter?
  private var pending = Data()
  private var url: URL?
  private var socket: URLSessionWebSocketTask?
  private var active = false
  private var retries = 0

  func start(_ target: URL) throws {
    stop()
    url = target
    active = true
    retries = 0
    try startTap()
    queue.async { self.connect() }
  }

  func stop() {
    guard active || engine.isRunning else { return }
    active = false
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    queue.async {
      self.socket?.cancel(with: .normalClosure, reason: nil)
      self.socket = nil
      self.pending.removeAll()
    }
  }

  private func startTap() throws {
    let input = engine.inputNode
    let inFormat = input.outputFormat(forBus: 0)
    guard inFormat.channelCount > 0, inFormat.sampleRate > 0 else {
      throw NSError(domain: "ChimeCall", code: 4, userInfo: [NSLocalizedDescriptionKey: "No microphone input for captions."])
    }
    converter = AVAudioConverter(from: inFormat, to: outFormat)
    input.installTap(onBus: 0, bufferSize: 2048, format: inFormat) { [weak self] buffer, _ in
      self?.convert(buffer)
    }
    engine.prepare()
    try engine.start()
  }

  private func convert(_ buffer: AVAudioPCMBuffer) {
    guard let converter else { return }
    let ratio = outFormat.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
    var fed = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if fed { status.pointee = .noDataNow; return nil }
      fed = true
      status.pointee = .haveData
      return buffer
    }
    guard error == nil, out.frameLength > 0, let samples = out.int16ChannelData else { return }
    var bytes = Data(bytes: samples[0], count: Int(out.frameLength) * 2)
    if muted { bytes = Data(count: bytes.count) }
    queue.async { self.enqueue(bytes) }
  }

  private func enqueue(_ bytes: Data) {
    pending.append(bytes)
    while pending.count >= Self.chunkBytes {
      let chunk = pending.prefix(Self.chunkBytes)
      pending.removeFirst(Self.chunkBytes)
      socket?.send(.data(Data(chunk))) { _ in }  // dropped while reconnecting; captions resume
    }
  }

  private func connect() {
    guard active, let url else { return }
    let task = URLSession.shared.webSocketTask(with: url)
    socket = task
    emit?("onCaptionStatus", ["status": "connecting"])
    task.resume()
    receive(task)
  }

  private func receive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self else { return }
      self.queue.async {
        guard self.socket === task else { return }
        switch result {
        case .success(let message):
          if case .string(let text) = message,
             let json = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
             let type = json["type"] as? String {
            if type == "ready" { self.retries = 0 }
            self.emit?("onCaptionStatus", ["status": type, "message": json["message"] as? String])
          }
          self.receive(task)
        case .failure:
          self.socket = nil
          self.reconnect()
        }
      }
    }
  }

  private func reconnect() {
    guard active else { return }
    retries += 1
    let delay = min(10.0, pow(2.0, Double(min(retries, 4)) - 1))
    emit?("onCaptionStatus", ["status": "reconnecting"])
    queue.asyncAfter(deadline: .now() + delay) { self.connect() }
  }
}
