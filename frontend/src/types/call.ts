export interface Participant {
  id: string;
  displayName: string;
  avatarUrl?: string;
  isMuted: boolean;
  isSpeaking: boolean;
  isLocal: boolean;
  videoTileId?: number;
}

export interface TranscriptUtterance {
  id: string;
  speakerId: string;
  speakerName: string;
  text: string;
  startMs: number;
  endMs: number;
  timestamp: Date;
  isPartial?: boolean;
  result?: ChimeResult;
}

export interface ExplainResponse {
  answer: string;
  term?: string;
  confidence: number;
  status?: 'explained' | 'unclear' | 'no_recent_speech';
  source?: string;
  source_result_ids?: string[];
  kind?: 'inside_joke' | 'slang' | 'nickname' | 'event' | 'place' | 'general';
}

export interface SuggestionPrompt {
  id: string;
  text: string;
  context: string;
}

export type CallState = 'connecting' | 'connected' | 'reconnecting' | 'ended';

export interface ChimeResult {
  resultId: string;
  isPartial: boolean;
  startTimeMs: number;
  endTimeMs: number;
  alternatives: { transcript: string; items: { type: 'pronunciation' | 'punctuation'; content: string; startTimeMs: number; endTimeMs: number; attendee: { attendeeId: string; externalUserId: string } }[] }[];
}
export interface CallSession {
  call_id: string;
  call_token: string;
  is_host: boolean;
  meeting: Record<string, unknown>;
  attendee: { AttendeeId: string; ExternalUserId: string; JoinToken: string };
}
