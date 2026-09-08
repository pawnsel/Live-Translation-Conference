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
  /** A locally-generated session identifier (`local_${Date.now()}`), not
   *  tied to any server-side session — there is no backend to die with. */
  asrSessionId: string;
  startedAt: number;
  endedAt?: number;
  sourceLang: string;
  targetLang: string;
  /** The AI summary for this session, once the operator asks for one.
   *  Summarising is never automatic — it costs a model call, so it happens
   *  only on request from the session history. No P2 database exists yet,
   *  so this rides on the same localStorage record everything else in
   *  `Project` already uses — undefined means "never summarised", never
   *  "the summary failed": a failed AI summary is stored as "". */
  summary?: string;
  /** Captions recorded during this session, kept so a summary can be asked
   *  for long after the session ended. Undefined for sessions recorded
   *  before summaries became on-demand. */
  transcripts?: TranscriptItem[];
  /** Items sent to the summariser, so an empty `summary` (the AI call
   *  failed) can still say "N ข้อความถูกบันทึกไว้" instead of nothing. */
  reportItemCount?: number;
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
  /** The locally-generated session identifier of the currently attached
   *  session, if any (see `ProjectSession.asrSessionId`). Null when no
   *  session is attached — there is no backend, so nothing else can
   *  invalidate it. */
  asrSessionId?: string | null;
}
