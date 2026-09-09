// Turns a project record into money, session by session, using the rates in
// geminiCost.ts. One function so the running badge in the header and the
// final bill can never disagree — they call this with the same inputs.

import type { Project, ProjectSession, TranscriptItem } from '../types';
import { ZERO_COST, addCost, liveSessionCost, summaryCost, type CostBreakdown } from './geminiCost';

export interface LiveBuffer {
  /** Captions for the session recording right now, still in memory. */
  transcripts: TranscriptItem[];
  /** Which session owns that buffer, null when nothing is recording. */
  asrSessionId: string | null;
  now: number;
}

/** Summarise runs charged for this session. Runs are counted as they are
 *  started, so a failed run is still charged — it still spent tokens. A
 *  session recorded before the counter existed falls back to "one run if it
 *  was ever summarised", which is the best that record supports. */
function summaryRuns(session: ProjectSession): number {
  if (typeof session.summarizeRuns === 'number') return session.summarizeRuns;
  return session.summary !== undefined ? 1 : 0;
}

/** The captions this session should be billed for. While a session owns the
 *  live buffer its captions have not been filed on the record yet, so the
 *  buffer is the only copy; reading both would bill the same words twice. */
export function sessionTranscripts(session: ProjectSession, live: LiveBuffer): TranscriptItem[] {
  const isLive = live.asrSessionId !== null && session.asrSessionId === live.asrSessionId;
  return isLive ? live.transcripts : session.transcripts ?? [];
}

export function projectTranscripts(project: Project | undefined, live: LiveBuffer): TranscriptItem[] {
  if (!project) return [];
  return project.sessions.flatMap((session) => sessionTranscripts(session, live));
}

export function sessionCost(session: ProjectSession, live: LiveBuffer): CostBreakdown {
  // An open session is charged up to now, so the number climbs while it
  // records rather than jumping when it stops.
  const endedAt = session.endedAt ?? live.now;
  const transcripts = sessionTranscripts(session, live);

  return addCost(
    liveSessionCost(endedAt - session.startedAt, transcripts),
    summaryCost(transcripts, summaryRuns(session), live.now)
  );
}

export function projectCost(project: Project | undefined, live: LiveBuffer): CostBreakdown {
  if (!project) return ZERO_COST;
  return project.sessions.reduce((total, session) => addCost(total, sessionCost(session, live)), ZERO_COST);
}
