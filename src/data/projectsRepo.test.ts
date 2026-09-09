import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from './testing/fakeSupabase';
import { createProjectsRepo, PROJECT_SELECT } from './projectsRepo';

const projectRow = {
  id: 'proj-1',
  name: 'ประชุมวิชาการ',
  status: 'active' as const,
  created_at: '2026-01-01T00:00:00.000Z',
  ended_at: null,
  auto_finished: false,
  asr_session_id: null,
  bill: null,
  project_sessions: [
    {
      id: 'sess-1',
      project_id: 'proj-1',
      asr_session_id: 'local_1',
      started_at: '2026-01-01T00:05:00.000Z',
      ended_at: null,
      source_lang: 'th',
      target_lang: 'en',
      summary: null,
      report_item_count: null,
      summarize_runs: 0,
      item_count: 2
    }
  ]
};

describe('projectsRepo.listProjects', () => {
  it('reads projects with their sessions in one statement, newest first', async () => {
    const fake = createFakeSupabase([{ data: [projectRow] }]);
    const repo = createProjectsRepo(fake.client);

    const projects = await repo.listProjects();

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      table: 'projects',
      op: 'select',
      columns: PROJECT_SELECT,
      filters: [{ kind: 'order', column: 'created_at', value: { ascending: false } }]
    });
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('ประชุมวิชาการ');
    expect(projects[0].sessions[0].itemCount).toBe(2);
  });

  // No owner_id filter is issued on purpose: the SELECT policy already scopes
  // this to the caller. A client-side filter here would imply the client is
  // what enforces privacy, which is exactly the wrong idea to encode.
  it('does not filter by owner — RLS does that', async () => {
    const fake = createFakeSupabase([{ data: [projectRow] }]);
    await createProjectsRepo(fake.client).listProjects();
    expect(fake.calls[0].filters.some((f) => f.column === 'owner_id')).toBe(false);
  });

  it('returns an empty list when the account has no projects', async () => {
    const fake = createFakeSupabase([{ data: [] }]);
    expect(await createProjectsRepo(fake.client).listProjects()).toEqual([]);
  });

  it('throws a classified PersistError when the query fails', async () => {
    const fake = createFakeSupabase([{ error: { message: 'JWT expired' } }]);
    await expect(createProjectsRepo(fake.client).listProjects()).rejects.toMatchObject({
      reason: 'auth'
    });
  });
});

const transcriptRow = {
  session_id: 'sess-1',
  seq: 1,
  source_text: 'สวัสดี',
  target_text: 'Hello',
  source_lang: 'th',
  target_lang: 'en',
  ts: '2026-01-01T00:06:00.000Z',
  latency_ms: 300,
  is_edited: false
};

describe('projectsRepo.loadSessionTranscript', () => {
  it('reads one session ordered by seq', async () => {
    const fake = createFakeSupabase([{ data: [transcriptRow] }]);

    const items = await createProjectsRepo(fake.client).loadSessionTranscript('sess-1');

    expect(fake.calls[0]).toMatchObject({
      table: 'transcript_items',
      op: 'select',
      filters: [
        { kind: 'eq', column: 'session_id', value: 'sess-1' },
        { kind: 'order', column: 'seq', value: { ascending: true } }
      ]
    });
    expect(items).toHaveLength(1);
    expect(items[0].targetText).toBe('Hello');
    expect(items[0].ts).toBe(Date.parse('2026-01-01T00:06:00.000Z') / 1000);
  });
});

describe('projectsRepo.loadProjectTranscripts', () => {
  it('reads every session of a project in one statement, grouped by session', async () => {
    const second = { ...transcriptRow, session_id: 'sess-2', seq: 1, target_text: 'World' };
    const fake = createFakeSupabase([{ data: [transcriptRow, second] }]);

    const grouped = await createProjectsRepo(fake.client).loadProjectTranscripts('proj-1');

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ table: 'transcript_items', op: 'select' });
    expect(Object.keys(grouped).sort()).toEqual(['sess-1', 'sess-2']);
    expect(grouped['sess-2'][0].targetText).toBe('World');
  });

  it('returns an empty map when the project has recorded nothing', async () => {
    const fake = createFakeSupabase([{ data: [] }]);
    expect(await createProjectsRepo(fake.client).loadProjectTranscripts('proj-1')).toEqual({});
  });
});

describe('projectsRepo.createProject', () => {
  it('inserts the project and returns the created record', async () => {
    const fake = createFakeSupabase([
      { data: { ...projectRow, id: 'proj-new', name: 'สัมมนา', project_sessions: [] } }
    ]);

    const project = await createProjectsRepo(fake.client).createProject('  สัมมนา  ');

    expect(fake.calls[0]).toMatchObject({
      table: 'projects',
      op: 'insert',
      payload: { name: 'สัมมนา', status: 'active' },
      single: true
    });
    expect(project.id).toBe('proj-new');
    expect(project.sessions).toEqual([]);
  });

  // owner_id is omitted on purpose: the column defaults to auth.uid(), so the
  // database stamps it and the client cannot claim to be someone else.
  it('does not send owner_id — the column default stamps it', async () => {
    const fake = createFakeSupabase([{ data: { ...projectRow, project_sessions: [] } }]);
    await createProjectsRepo(fake.client).createProject('x');
    expect(fake.calls[0].payload).not.toHaveProperty('owner_id');
  });

  it('throws a classified error when the insert is refused', async () => {
    const fake = createFakeSupabase([{ error: { message: 'permission denied', code: '42501' } }]);
    await expect(createProjectsRepo(fake.client).createProject('x')).rejects.toMatchObject({
      reason: 'auth'
    });
  });
});

const newSessionRow = {
  id: 'sess-new',
  project_id: 'proj-1',
  asr_session_id: 'local_2',
  started_at: '2026-01-01T01:00:00.000Z',
  ended_at: null,
  source_lang: 'th',
  target_lang: 'en',
  summary: null,
  report_item_count: null,
  summarize_runs: 0,
  item_count: 0
};

describe('projectsRepo.attachAsrSession', () => {
  it('closes any session still open, inserts the new one, and points the project at it', async () => {
    const fake = createFakeSupabase([
      { data: null },            // close open sessions
      { data: newSessionRow },   // insert the new session
      { data: null }             // point the project at it
    ]);

    const session = await createProjectsRepo(fake.client).attachAsrSession(
      'proj-1',
      'local_2',
      'th',
      'en'
    );

    // A session left open by a reconnect must be closed in the same action, or
    // startSession's "already have an open session" guard silently drops the
    // new recording.
    expect(fake.calls[0]).toMatchObject({
      table: 'project_sessions',
      op: 'update',
      filters: [
        { kind: 'eq', column: 'project_id', value: 'proj-1' },
        { kind: 'is', column: 'ended_at', value: null }
      ]
    });
    expect(fake.calls[1]).toMatchObject({
      table: 'project_sessions',
      op: 'insert',
      payload: {
        project_id: 'proj-1',
        asr_session_id: 'local_2',
        source_lang: 'th',
        target_lang: 'en'
      },
      single: true
    });
    expect(fake.calls[2]).toMatchObject({
      table: 'projects',
      op: 'update',
      payload: { asr_session_id: 'local_2' },
      filters: [{ kind: 'eq', column: 'id', value: 'proj-1' }]
    });
    expect(session.id).toBe('sess-new');
    expect(session.itemCount).toBe(0);
  });
});

describe('projectsRepo.endSession', () => {
  it('stamps ended_at on that session only', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await createProjectsRepo(fake.client).endSession('sess-1');

    expect(fake.calls[0]).toMatchObject({
      table: 'project_sessions',
      op: 'update',
      filters: [{ kind: 'eq', column: 'id', value: 'sess-1' }]
    });
    expect((fake.calls[0].payload as { ended_at: string }).ended_at).toEqual(expect.any(String));
  });
});

describe('projectsRepo.detachAsrSession', () => {
  it('clears the project pointer', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await createProjectsRepo(fake.client).detachAsrSession('proj-1');
    expect(fake.calls[0]).toMatchObject({
      table: 'projects',
      op: 'update',
      payload: { asr_session_id: null },
      filters: [{ kind: 'eq', column: 'id', value: 'proj-1' }]
    });
  });
});

describe('projectsRepo.finishProject', () => {
  const bill = { sessionCount: 1, durationMs: 60000, wordCount: 10, estimatedCost: 0.01 };

  it('closes the named open sessions first, then marks the project ended', async () => {
    const fake = createFakeSupabase([{ data: null }, { data: null }]);

    await createProjectsRepo(fake.client).finishProject('proj-1', bill, 1767225600000, ['sess-1']);

    // Sessions first: if the second statement fails the project stays active
    // with its sessions closed, which is recoverable. The reverse order would
    // leave an ended project holding a session that never stops billing.
    expect(fake.calls[0]).toMatchObject({
      table: 'project_sessions',
      op: 'update',
      filters: [{ kind: 'in', column: 'id', value: ['sess-1'] }]
    });
    expect(fake.calls[1]).toMatchObject({
      table: 'projects',
      op: 'update',
      payload: {
        status: 'ended',
        bill,
        asr_session_id: null,
        ended_at: new Date(1767225600000).toISOString()
      },
      filters: [{ kind: 'eq', column: 'id', value: 'proj-1' }]
    });
  });

  it('skips the session statement when nothing is open', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await createProjectsRepo(fake.client).finishProject('proj-1', bill, 1767225600000, []);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].table).toBe('projects');
  });
});

const caption = {
  seq: 7,
  sourceText: 'สวัสดีครับ',
  targetText: 'Hello',
  sourceLang: 'th',
  targetLang: 'en',
  ts: Date.parse('2026-01-01T00:10:00.000Z') / 1000,
  latencyMs: 250,
  isEdited: false
};

describe('projectsRepo.appendCaption', () => {
  it('upserts one row keyed by (session_id, seq)', async () => {
    const fake = createFakeSupabase([{ data: null }]);

    await createProjectsRepo(fake.client).appendCaption('sess-1', caption);

    // Upsert, not insert: a retry after a timeout that actually succeeded
    // must not fail on the primary key and strand the retry queue.
    expect(fake.calls[0]).toMatchObject({
      table: 'transcript_items',
      op: 'upsert',
      payload: {
        session_id: 'sess-1',
        seq: 7,
        source_text: 'สวัสดีครับ',
        target_text: 'Hello',
        ts: '2026-01-01T00:10:00.000Z',
        latency_ms: 250,
        is_edited: false
      }
    });
  });

  it('throws a classified error when the write is refused', async () => {
    const fake = createFakeSupabase([{ error: new TypeError('Failed to fetch') }]);
    await expect(
      createProjectsRepo(fake.client).appendCaption('sess-1', caption)
    ).rejects.toMatchObject({ reason: 'network' });
  });
});

describe('projectsRepo.editCaption', () => {
  it('updates one row and marks it edited', async () => {
    const fake = createFakeSupabase([{ data: null }]);

    await createProjectsRepo(fake.client).editCaption('sess-1', 7, 'Good morning');

    expect(fake.calls[0]).toMatchObject({
      table: 'transcript_items',
      op: 'update',
      payload: { target_text: 'Good morning', is_edited: true },
      filters: [
        { kind: 'eq', column: 'session_id', value: 'sess-1' },
        { kind: 'eq', column: 'seq', value: 7 }
      ]
    });
  });
});

describe('projectsRepo.markSummarizing', () => {
  // The run counter is persisted even though the spinner is not: every
  // attempt spends tokens, so a retry that fails must still be billed.
  it('writes the caller-computed run count', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await createProjectsRepo(fake.client).markSummarizing('sess-1', 3);
    expect(fake.calls[0]).toMatchObject({
      table: 'project_sessions',
      op: 'update',
      payload: { summarize_runs: 3 },
      filters: [{ kind: 'eq', column: 'id', value: 'sess-1' }]
    });
  });
});

describe('projectsRepo.saveSummary', () => {
  it('stores a real summary with the item count sent to the summariser', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await createProjectsRepo(fake.client).saveSummary('sess-1', 'สรุปการประชุม', 42);
    expect(fake.calls[0]).toMatchObject({
      table: 'project_sessions',
      op: 'update',
      payload: { summary: 'สรุปการประชุม', report_item_count: 42 }
    });
  });

  // '' must reach the column as '', never as null: null would read back as
  // "nobody asked for a summary" and hide the failure from the operator.
  it('stores a failed summary as an empty string, not null', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await createProjectsRepo(fake.client).saveSummary('sess-1', '', 42);
    expect((fake.calls[0].payload as { summary: unknown }).summary).toBe('');
  });
});
