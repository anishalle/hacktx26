export interface Participant {
  id: string;
  displayName: string;
  avatarUrl?: string;
  isMuted: boolean;
  isSpeaking: boolean;
  isLocal: boolean;
}

export interface TranscriptUtterance {
  id: string;
  speakerId: string;
  speakerName: string;
  text: string;
  startMs: number;
  endMs: number;
  timestamp: Date;
}

export interface ExplainResponse {
  answer: string;
  term?: string;
  confidence: number;
  kind?: 'inside_joke' | 'slang' | 'nickname' | 'event' | 'place' | 'general';
}

export interface SuggestionPrompt {
  id: string;
  text: string;
  context: string;
}

export type CallState = 'connecting' | 'connected' | 'reconnecting' | 'ended';
