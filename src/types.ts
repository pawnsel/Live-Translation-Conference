/** One caption as the operator sees it. Shaped to protocol v1 so that P2's
 *  `transcript_items` table is a direct mapping rather than a migration. */
export interface TranscriptItem {
  seq: number;
  sourceText: string;
  targetText: string;
  sourceLang: string;
  targetLang: string;
  ts: number;
  latencyMs: number;
  isEdited: boolean;
}

/** Purely local presentation. Everything the BACKEND owns — languages,
 *  paused, mode, gate, glossary — is read from its broadcasts instead. */
export interface DisplayConfig {
  fontSize?: 'small' | 'medium' | 'large' | 'xlarge';
  fontFamily?: string;
  showOriginal?: boolean;
  showLatency?: boolean;
}

export interface ProjectSession {
  id: string;
  /** The Python session this recording ran against. Dies with the backend. */
  asrSessionId: string;
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
  autoFinished?: boolean;
  /** The live Python session, if one is currently attached. Null after a
   *  backend restart, which invalidates every session id it ever issued. */
  asrSessionId?: string | null;
}
