export interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
export interface BrowserRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => BrowserRecognition;
    webkitSpeechRecognition?: new () => BrowserRecognition;
  }
}

export function createSpeechRecognition(): BrowserRecognition {
  const Constructor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Constructor) throw new Error('Voice questions need a browser with speech recognition, such as Chrome or Edge.');
  const recognition = new Constructor();
  recognition.lang = navigator.language || 'en-US';
  recognition.continuous = true;
  recognition.interimResults = true;
  return recognition;
}
