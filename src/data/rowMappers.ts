/** Database rows in, domain types out. Pure — no client, no I/O.
 *
 *  Every snake_case/camelCase rename and every unit conversion lives here and
 *  nowhere else, so the repositories stay thin and the two places this is
 *  easy to get wrong — the three-state `summary` and the seconds/milliseconds
 *  split — are covered by fast tests instead of a live database.
 */

import type { Project, ProjectBill, ProjectSession, TranscriptItem } from '../types';

export interface ProjectRow {
  id: string;
  name: string;
  status: 'active' | 'ended';
  created_at: string;
  ended_at: string | null;
  auto_finished: boolean;
  asr_session_id: string | null;
  bill: ProjectBill | null;
}

export interface SessionRow {
  id: string;
  project_id: string;
  asr_session_id: string;
  started_at: string;
  ended_at: string | null;
  source_lang: string;
  target_lang: string;
  summary: string | null;
  report_item_count: number | null;
  summarize_runs: number;
  item_count: number;
}

export interface TranscriptRow {
  seq: number;
  source_text: string;
  target_text: string;
  source_lang: string;
  target_lang: string;
  ts: string;
  latency_ms: number;
  is_edited: boolean;
}

/** Postgres timestamptz → epoch milliseconds. */
export function toMillis(iso: string): number {
  return Date.parse(iso);
}

export function toMillisOrNull(iso: string | null): number | undefined {
  return iso === null ? undefined : Date.parse(iso);
}

export function toSession(row: SessionRow): ProjectSession {
  return {
    id: row.id,
    asrSessionId: row.asr_session_id,
    startedAt: toMillis(row.started_at),
    endedAt: toMillisOrNull(row.ended_at),
    sourceLang: row.source_lang,
    targetLang: row.target_lang,
    // null means nobody asked; '' means the AI call failed. Those must not
    // collapse into one value — ProjectPanel renders them differently.
    summary: row.summary === null ? undefined : row.summary,
    reportItemCount: row.report_item_count === null ? undefined : row.report_item_count,
    summarizeRuns: row.summarize_runs,
    itemCount: row.item_count
    // `transcripts` is deliberately absent: undefined means "not fetched".
  };
}

export function toProject(row: ProjectRow, sessions: SessionRow[]): Project {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: toMillis(row.created_at),
    endedAt: toMillisOrNull(row.ended_at),
    autoFinished: row.auto_finished,
    // Kept as null rather than undefined: useProjects reads null as "nothing
    // attached", which is a different fact from "field not present".
    asrSessionId: row.asr_session_id,
    bill: row.bill === null ? undefined : row.bill,
    sessions: sessions.map(toSession).sort((a, b) => a.startedAt - b.startedAt),
    transcripts: []
  };
}

export function toTranscriptItem(row: TranscriptRow): TranscriptItem {
  return {
    seq: row.seq,
    sourceText: row.source_text,
    targetText: row.target_text,
    sourceLang: row.source_lang,
    targetLang: row.target_lang,
    // Seconds above this line, timestamptz below it.
    ts: Date.parse(row.ts) / 1000,
    latencyMs: row.latency_ms,
    isEdited: row.is_edited
  };
}

export function fromTranscriptItem(
  sessionId: string,
  item: TranscriptItem
): TranscriptRow & { session_id: string } {
  return {
    session_id: sessionId,
    seq: item.seq,
    source_text: item.sourceText,
    target_text: item.targetText,
    source_lang: item.sourceLang,
    target_lang: item.targetLang,
    ts: new Date(item.ts * 1000).toISOString(),
    latency_ms: item.latencyMs,
    is_edited: item.isEdited
  };
}
