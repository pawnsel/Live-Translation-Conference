/** Every statement the app issues against projects, sessions and transcripts.
 *
 *  One method, roughly one statement. No filtering by owner anywhere: the RLS
 *  policies in supabase/schema-projects.sql are what scope these to the
 *  caller, and duplicating that here would suggest the client is what keeps
 *  data private. It is not.
 *
 *  Every method throws PersistError on failure. Callers turn that into the
 *  banner; nothing swallows a failed write.
 */

import type { Project, ProjectBill, ProjectSession, TranscriptItem } from '../types';
import type { QueryClient } from './queryClient';
import { toPersistError } from './persistError';
import {
  fromTranscriptItem,
  toProject,
  toSession,
  toTranscriptItem,
  type ProjectRow,
  type SessionRow,
  type TranscriptRow
} from './rowMappers';

/** Projects and their sessions in one round trip. PostgREST resolves the
 *  embedded name from the foreign key on project_sessions.project_id. */
export const PROJECT_SELECT = '*, project_sessions(*)';

const SESSION_COLUMNS =
  'id, project_id, asr_session_id, started_at, ended_at, source_lang, target_lang, summary, report_item_count, summarize_runs, item_count';

const TRANSCRIPT_COLUMNS =
  'session_id, seq, source_text, target_text, source_lang, target_lang, ts, latency_ms, is_edited';

export interface ProjectsRepo {
  listProjects(): Promise<Project[]>;
  loadSessionTranscript(sessionId: string): Promise<TranscriptItem[]>;
  loadProjectTranscripts(projectId: string): Promise<Record<string, TranscriptItem[]>>;
  createProject(name: string): Promise<Project>;
  attachAsrSession(
    projectId: string,
    asrSessionId: string,
    sourceLang: string,
    targetLang: string
  ): Promise<ProjectSession>;
  endSession(sessionId: string): Promise<void>;
  detachAsrSession(projectId: string): Promise<void>;
  appendCaption(sessionId: string, item: TranscriptItem): Promise<void>;
  editCaption(sessionId: string, seq: number, targetText: string): Promise<void>;
  markSummarizing(sessionId: string, runs: number): Promise<void>;
  saveSummary(sessionId: string, summary: string, reportItemCount: number): Promise<void>;
  finishProject(
    projectId: string,
    bill: ProjectBill,
    endedAt: number,
    openSessionIds: string[]
  ): Promise<void>;
}

/** Unwraps a supabase-js result, turning its error into a PersistError. */
function unwrap<T>(result: { data: unknown; error: unknown }): T {
  if (result.error) throw toPersistError(result.error);
  return result.data as T;
}

export function createProjectsRepo(client: QueryClient): ProjectsRepo {
  return {
    async listProjects() {
      const rows = unwrap<(ProjectRow & { project_sessions: SessionRow[] })[]>(
        await client.from('projects').select(PROJECT_SELECT).order('created_at', { ascending: false })
      );
      return (rows ?? []).map((row) => toProject(row, row.project_sessions ?? []));
    },

    async loadSessionTranscript(sessionId) {
      const rows = unwrap<TranscriptRow[]>(
        await client
          .from('transcript_items')
          .select(TRANSCRIPT_COLUMNS)
          .eq('session_id', sessionId)
          .order('seq', { ascending: true })
      );
      return (rows ?? []).map(toTranscriptItem);
    },

    async loadProjectTranscripts(projectId) {
      // One statement for the whole project: the running cost badge needs
      // every session's captions, and a query per session would be N round
      // trips on every project switch.
      const rows = unwrap<(TranscriptRow & { session_id: string })[]>(
        await client
          .from('transcript_items')
          .select(`${TRANSCRIPT_COLUMNS}, project_sessions!inner(project_id)`)
          .eq('project_sessions.project_id', projectId)
          .order('seq', { ascending: true })
      );

      const grouped: Record<string, TranscriptItem[]> = {};
      for (const row of rows ?? []) {
        (grouped[row.session_id] ||= []).push(toTranscriptItem(row));
      }
      return grouped;
    },

    async createProject(name) {
      // owner_id is omitted deliberately: the column defaults to auth.uid(),
      // so the database decides who owns this and the client cannot lie.
      const row = unwrap<ProjectRow & { project_sessions?: SessionRow[] }>(
        await client
          .from('projects')
          .insert({ name: name.trim(), status: 'active' })
          .select(PROJECT_SELECT)
          .single()
      );
      return toProject(row, row.project_sessions ?? []);
    },

    async attachAsrSession(projectId, asrSessionId, sourceLang, targetLang) {
      const now = new Date().toISOString();

      // Close anything left open first. A dropped websocket that reconnected
      // under a new id leaves the old session running; if it is still open
      // when the new one is inserted, the "one open session" guard upstream
      // discards the new recording.
      unwrap(
        await client
          .from('project_sessions')
          .update({ ended_at: now })
          .eq('project_id', projectId)
          .is('ended_at', null)
      );

      const row = unwrap<SessionRow>(
        await client
          .from('project_sessions')
          .insert({
            project_id: projectId,
            asr_session_id: asrSessionId,
            source_lang: sourceLang,
            target_lang: targetLang,
            started_at: now
          })
          .select(SESSION_COLUMNS)
          .single()
      );

      unwrap(
        await client.from('projects').update({ asr_session_id: asrSessionId }).eq('id', projectId)
      );

      return toSession(row);
    },

    async endSession(sessionId) {
      unwrap(
        await client
          .from('project_sessions')
          .update({ ended_at: new Date().toISOString() })
          .eq('id', sessionId)
      );
    },

    async detachAsrSession(projectId) {
      unwrap(await client.from('projects').update({ asr_session_id: null }).eq('id', projectId));
    },

    async finishProject(projectId, bill, endedAt, openSessionIds) {
      const stamp = new Date(endedAt).toISOString();

      // Sessions first. PostgREST has no transaction across statements, so
      // order is the only control available: a failure after this point
      // leaves an active project whose sessions are closed, which the next
      // finish attempt fixes. The reverse order would leave an ended project
      // holding an open session that keeps accruing time.
      if (openSessionIds.length > 0) {
        unwrap(
          await client
            .from('project_sessions')
            .update({ ended_at: stamp })
            .in('id', openSessionIds)
        );
      }

      unwrap(
        await client
          .from('projects')
          .update({ status: 'ended', ended_at: stamp, bill, asr_session_id: null })
          .eq('id', projectId)
      );
    },

    async appendCaption(sessionId, item) {
      // Upsert rather than insert: a caption whose write timed out may have
      // landed anyway, and the retry queue must not deadlock on a duplicate
      // key. (session_id, seq) is the primary key, so this is idempotent.
      unwrap(
        await client
          .from('transcript_items')
          .upsert(fromTranscriptItem(sessionId, item), { onConflict: 'session_id,seq' })
      );
    },

    async editCaption(sessionId, seq, targetText) {
      unwrap(
        await client
          .from('transcript_items')
          .update({ target_text: targetText, is_edited: true })
          .eq('session_id', sessionId)
          .eq('seq', seq)
      );
    },

    async markSummarizing(sessionId, runs) {
      // Counted by the caller, which knows the previous value. Postgres has no
      // "increment" through PostgREST without an RPC, and the count only has
      // to be right, not race-proof: one operator, one console.
      unwrap(
        await client.from('project_sessions').update({ summarize_runs: runs }).eq('id', sessionId)
      );
    },

    async saveSummary(sessionId, summary, reportItemCount) {
      // `summary` may legitimately be '' — that is how a failed AI call is
      // recorded. It must not become null on the way to the column.
      unwrap(
        await client
          .from('project_sessions')
          .update({ summary, report_item_count: reportItemCount })
          .eq('id', sessionId)
      );
    }
  };
}
