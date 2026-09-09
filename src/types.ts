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
  /** Color scheme of the live caption box. 'light' (black text on white) is
   *  the default; 'dark' is white text on black, for a darker room/stage. */
  captionTheme?: 'light' | 'dark';
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
  /** Captions recorded during this session. Loaded on demand — undefined
   *  means "not fetched yet", NOT "this session recorded nothing". Use
   *  `itemCount` to tell those apart. */
  transcripts?: TranscriptItem[];
  /** How many transcript rows this session holds. Always known, because it
   *  comes from a denormalised column; `transcripts` is loaded on demand and
   *  stays undefined until something needs the text. Sessions in the ended
   *  history are listed by this number without fetching a single caption. */
  itemCount: number;
  /** Items sent to the summariser, so an empty `summary` (the AI call
   *  failed) can still say "N ข้อความถูกบันทึกไว้" instead of nothing. */
  reportItemCount?: number;
  /** How many times a summary has been ASKED for on this session, counted
   *  when the request starts. A re-summarise and a failed summarise both
   *  spend tokens, so the cost estimate needs the attempt count, not
   *  whether `summary` ended up filled in. Undefined on sessions recorded
   *  before costs were estimated. */
  summarizeRuns?: number;
}

export interface ProjectBill {
  sessionCount: number;
  durationMs: number;
  wordCount: number;
  /** Upper bound on the Gemini spend for this project, in USD, PLUS
   *  `serviceFee` — see src/billing/geminiCost.ts. Real spend lands at or
   *  below it. */
  estimatedCost: number;
  /** Flat service fee charged on top of the Gemini cost estimate, in USD.
   *  Currently 0 (see SERVICE_FEE_USD) — reserved for when this console
   *  bills a margin rather than passing through raw API cost. Absent on
   *  projects billed before the fee existed. */
  serviceFee?: number;
  /** Where that figure came from, so a bill can be read rather than
   *  trusted. Absent on projects billed before the breakdown existed. */
  costBreakdown?: {
    liveMinutes: number;
    liveAudioCost: number;
    liveTextCost: number;
    summaryCost: number;
    summaryRuns: number;
  };
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
