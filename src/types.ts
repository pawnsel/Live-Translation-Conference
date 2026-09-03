export interface DictionarySet {
  id: string;
  name: string;
  data: Record<string, string>;
  createdAt: number;
}

export interface AppConfig {
  sourceLang: string;
  targetLang: string;
  aiModel?: string; // e.g. "gemini-3.7-flash", "gemini-2.5-flash", "gemini-2.5-pro"
  speechEngine?: string; // e.g. "google-chirp-asr"
  fontSize?: 'small' | 'medium' | 'large' | 'xlarge';
  fontFamily?: string;
  dictionaryJson?: string;
  showOriginal?: boolean;
  showLatency?: boolean;
  chunkSilenceMs?: number; // silence pause in ms to cut chunk (e.g. 600, 900, 1400)
}

export interface TranscriptItem {
  id: string;
  originalText: string;
  translatedText: string;
  timestamp: number;
  latencyMs?: number;
  isEdited?: boolean;
}

export interface ProjectSession {
  id: string;
  startedAt: number;
  endedAt?: number;
  sourceLang: string;
  targetLang: string;
}

export interface ProjectBill {
  sessionCount: number;
  durationMs: number;
  wordCount: number;
  estimatedCost: number;
}

export interface Project {
  id: string;
  name: string;
  status: 'active' | 'ended';
  sessions: ProjectSession[];
  transcripts: TranscriptItem[];
  createdAt: number;
  endedAt?: number;
  bill?: ProjectBill;
  autoFinished?: boolean; // closed by the 7-day deadline rather than by an operator
}
