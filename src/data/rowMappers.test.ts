import { describe, expect, it } from 'vitest';
import {
  fromTranscriptItem,
  toMillis,
  toProject,
  toSession,
  toTranscriptItem,
  type ProjectRow,
  type SessionRow,
  type TranscriptRow
} from './rowMappers';

const sessionRow: SessionRow = {
  id: 'sess-uuid',
  project_id: 'proj-uuid',
  asr_session_id: 'local_1700000000000',
  started_at: '2026-01-01T00:00:00.000Z',
  ended_at: '2026-01-01T00:30:00.000Z',
  source_lang: 'th',
  target_lang: 'en',
  summary: null,
  report_item_count: null,
  summarize_runs: 0,
  last_seen_at: '2026-01-01T00:10:00.000Z',
  item_count: 12
};

describe('toSession', () => {
  it('maps columns to camelCase and timestamps to epoch ms', () => {
    const session = toSession(sessionRow);
    expect(session.id).toBe('sess-uuid');
    expect(session.asrSessionId).toBe('local_1700000000000');
    expect(session.startedAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(session.endedAt).toBe(Date.parse('2026-01-01T00:30:00.000Z'));
    expect(session.itemCount).toBe(12);
  });

  it('leaves endedAt undefined for a session still running', () => {
    expect(toSession({ ...sessionRow, ended_at: null }).endedAt).toBeUndefined();
  });

  // The three-state rule. Collapsing these is the bug that makes a failed
  // summary look like one nobody ever asked for.
  it('maps a null summary to undefined — nobody has asked', () => {
    expect(toSession({ ...sessionRow, summary: null }).summary).toBeUndefined();
  });

  it('keeps an empty summary as "" — the AI call failed', () => {
    expect(toSession({ ...sessionRow, summary: '' }).summary).toBe('');
  });

  it('keeps a real summary verbatim', () => {
    expect(toSession({ ...sessionRow, summary: 'สรุป' }).summary).toBe('สรุป');
  });
});

const projectRow: ProjectRow = {
  id: 'proj-uuid',
  name: 'ประชุมวิชาการ',
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
  ended_at: null,
  auto_finished: false,
  asr_session_id: null,
  bill: null
};

describe('toSession heartbeat', () => {
  it('maps the heartbeat to epoch ms', () => {
    expect(toSession(sessionRow).lastSeenAt).toBe(Date.parse('2026-01-01T00:10:00.000Z'));
  });

  // Rows written before the column existed come back null. Left undefined
  // rather than defaulted, so staleSessions can fall back to started_at.
  it('leaves the heartbeat undefined for a row written before it existed', () => {
    expect(toSession({ ...sessionRow, last_seen_at: null }).lastSeenAt).toBeUndefined();
  });
});

describe('toProject', () => {
  it('maps the row and attaches its sessions oldest first', () => {
    const older = { ...sessionRow, id: 'a', started_at: '2026-01-01T00:00:00.000Z' };
    const newer = { ...sessionRow, id: 'b', started_at: '2026-01-01T01:00:00.000Z' };
    const project = toProject(projectRow, [newer, older]);

    expect(project.name).toBe('ประชุมวิชาการ');
    expect(project.createdAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(project.sessions.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('starts with an empty transcript array and no bill', () => {
    const project = toProject(projectRow, []);
    expect(project.transcripts).toEqual([]);
    expect(project.bill).toBeUndefined();
  });

  it('carries a finished project bill through unchanged', () => {
    const bill = { sessionCount: 2, durationMs: 1000, wordCount: 40, estimatedCost: 0.12 };
    expect(toProject({ ...projectRow, bill }, []).bill).toEqual(bill);
  });

  it('maps a null asr_session_id to null, not undefined', () => {
    // useProjects treats null as "nothing attached"; undefined would read as
    // "this record predates the field".
    expect(toProject(projectRow, []).asrSessionId).toBeNull();
  });
});

const transcriptRow: TranscriptRow = {
  seq: 3,
  source_text: 'สวัสดีครับ',
  target_text: 'Hello',
  source_lang: 'th',
  target_lang: 'en',
  ts: '2026-01-01T00:00:10.000Z',
  latency_ms: 420,
  is_edited: false
};

describe('toTranscriptItem', () => {
  // TranscriptItem.ts is epoch SECONDS everywhere above the repo — captions.ts
  // sets it as Date.now() / 1000 — while Postgres stores timestamptz.
  it('converts the timestamp to epoch seconds, not milliseconds', () => {
    expect(toTranscriptItem(transcriptRow).ts).toBe(
      Date.parse('2026-01-01T00:00:10.000Z') / 1000
    );
  });

  it('maps the remaining columns', () => {
    const item = toTranscriptItem(transcriptRow);
    expect(item).toMatchObject({
      seq: 3,
      sourceText: 'สวัสดีครับ',
      targetText: 'Hello',
      latencyMs: 420,
      isEdited: false
    });
  });
});

describe('fromTranscriptItem', () => {
  it('round-trips an item back to its row', () => {
    const item = toTranscriptItem(transcriptRow);
    expect(fromTranscriptItem('sess-uuid', item)).toEqual({
      ...transcriptRow,
      session_id: 'sess-uuid'
    });
  });
});

describe('toMillis', () => {
  it('parses a Postgres timestamptz', () => {
    expect(toMillis('2026-01-01T00:00:00.000Z')).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });
});
