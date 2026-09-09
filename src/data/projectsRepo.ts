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
import { PersistError, toPersistError } from './persistError';
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

    // Implemented in Task 5.
    async createProject() {
      throw new PersistError('unknown', 'not implemented');
    },
    async attachAsrSession() {
      throw new PersistError('unknown', 'not implemented');
    },
    async endSession() {
      throw new PersistError('unknown', 'not implemented');
    },
    async detachAsrSession() {
      throw new PersistError('unknown', 'not implemented');
    },
    async finishProject() {
      throw new PersistError('unknown', 'not implemented');
    },

    // Implemented in Task 6.
    async appendCaption() {
      throw new PersistError('unknown', 'not implemented');
    },
    async editCaption() {
      throw new PersistError('unknown', 'not implemented');
    },
    async markSummarizing() {
      throw new PersistError('unknown', 'not implemented');
    },
    async saveSummary() {
      throw new PersistError('unknown', 'not implemented');
    }
  };
}
