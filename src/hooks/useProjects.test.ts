// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjects } from './useProjects';
import { PersistError } from '../data/persistError';
import type { ProjectsRepo } from '../data/projectsRepo';
import type { Project, ProjectSession, TranscriptItem } from '../types';

const USER = 'user-1';

function session(overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    id: 'sess-1',
    asrSessionId: 'local_1',
    startedAt: Date.parse('2026-01-01T00:00:00.000Z'),
    sourceLang: 'th',
    targetLang: 'en',
    summarizeRuns: 0,
    itemCount: 0,
    ...overrides
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'ประชุม',
    status: 'active',
    sessions: [],
    transcripts: [],
    createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
    asrSessionId: null,
    ...overrides
  };
}

/** A repo whose every method is a spy, seeded with one active project. */
function fakeRepo(overrides: Partial<ProjectsRepo> = {}): ProjectsRepo {
  return {
    listProjects: vi.fn().mockResolvedValue([project()]),
    loadSessionTranscript: vi.fn().mockResolvedValue([]),
    loadProjectTranscripts: vi.fn().mockResolvedValue({}),
    createProject: vi.fn().mockResolvedValue(project({ id: 'proj-new', name: 'ใหม่' })),
    attachAsrSession: vi.fn().mockResolvedValue(session({ id: 'sess-new', asrSessionId: 'local_2' })),
    endSession: vi.fn().mockResolvedValue(undefined),
    detachAsrSession: vi.fn().mockResolvedValue(undefined),
    appendCaption: vi.fn().mockResolvedValue(undefined),
    editCaption: vi.fn().mockResolvedValue(undefined),
    markSummarizing: vi.fn().mockResolvedValue(undefined),
    saveSummary: vi.fn().mockResolvedValue(undefined),
    finishProject: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

async function renderLoaded(repo: ProjectsRepo) {
  const view = renderHook(() => useProjects({ repo, userId: USER }));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  return view;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useProjects — loading', () => {
  it('starts loading and fills in from the repo', async () => {
    const repo = fakeRepo();
    const { result } = renderHook(() => useProjects({ repo, userId: USER }));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.activeProjects).toHaveLength(1);
  });

  // A signed-out or unapproved caller must not see the previous account's
  // projects on a shared machine.
  it('loads nothing and stays empty when there is no user', async () => {
    const repo = fakeRepo();
    const { result } = renderHook(() => useProjects({ repo, userId: null }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(repo.listProjects).not.toHaveBeenCalled();
    expect(result.current.activeProjects).toEqual([]);
  });

  it('clears the cache when the user signs out', async () => {
    const repo = fakeRepo();
    const { result, rerender } = renderHook(
      ({ userId }) => useProjects({ repo, userId }),
      { initialProps: { userId: USER as string | null } }
    );
    await waitFor(() => expect(result.current.activeProjects).toHaveLength(1));

    rerender({ userId: null });

    await waitFor(() => expect(result.current.activeProjects).toEqual([]));
  });

  it('reports a failed load through persistError', async () => {
    const repo = fakeRepo({
      listProjects: vi.fn().mockRejectedValue(new PersistError('network', 'offline'))
    });
    const { result } = await renderLoaded(repo);
    expect(result.current.persistError).toMatchObject({ reason: 'network', message: 'offline' });
  });
});

describe('useProjects — createProject', () => {
  it('adds the created project and selects it', async () => {
    const repo = fakeRepo();
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.createProject('ใหม่');
    });

    expect(repo.createProject).toHaveBeenCalledWith('ใหม่');
    expect(result.current.currentProject?.id).toBe('proj-new');
    expect(localStorage.getItem('ai_translate_selected_project')).toBe('proj-new');
  });

  it('refuses past the active-project limit without calling the repo', async () => {
    const repo = fakeRepo({
      listProjects: vi
        .fn()
        .mockResolvedValue([project({ id: 'a' }), project({ id: 'b' }), project({ id: 'c' })])
    });
    const { result } = await renderLoaded(repo);

    expect(result.current.canCreateProject).toBe(false);
    await act(async () => {
      await result.current.createProject('เกินโควตา');
    });
    expect(repo.createProject).not.toHaveBeenCalled();
  });

  it('surfaces a refused create and leaves the list unchanged', async () => {
    const repo = fakeRepo({
      createProject: vi.fn().mockRejectedValue(new PersistError('auth', 'permission denied'))
    });
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.createProject('ใหม่');
    });

    expect(result.current.persistError).toMatchObject({ reason: 'auth' });
    expect(result.current.activeProjects.map((p) => p.id)).toEqual(['proj-1']);
  });
});

describe('useProjects — selecting a project', () => {
  // The running cost badge prices every session in the current project, so
  // its captions have to be in memory or the number silently undercounts.
  it('loads the selected project transcripts', async () => {
    const item: TranscriptItem = {
      seq: 1,
      sourceText: 'ก',
      targetText: 'A',
      sourceLang: 'th',
      targetLang: 'en',
      ts: 1767225600,
      latencyMs: 10,
      isEdited: false
    };
    const repo = fakeRepo({
      listProjects: vi.fn().mockResolvedValue([project({ sessions: [session()] })]),
      loadProjectTranscripts: vi.fn().mockResolvedValue({ 'sess-1': [item] })
    });
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.selectProject('proj-1');
    });

    expect(repo.loadProjectTranscripts).toHaveBeenCalledWith('proj-1');
    await waitFor(() =>
      expect(result.current.currentProject?.sessions[0].transcripts).toEqual([item])
    );
  });
});

describe('useProjects — attachAsrSession', () => {
  it('appends the session the repo created and points the project at it', async () => {
    const repo = fakeRepo();
    const { result } = await renderLoaded(repo);
    await act(async () => {
      await result.current.selectProject('proj-1');
    });

    await act(async () => {
      await result.current.attachAsrSession('local_2', 'th', 'en');
    });

    expect(repo.attachAsrSession).toHaveBeenCalledWith('proj-1', 'local_2', 'th', 'en');
    expect(result.current.currentProject?.sessions).toHaveLength(1);
    expect(result.current.currentProject?.asrSessionId).toBe('local_2');
    expect(result.current.activeSession?.id).toBe('sess-new');
  });
});

describe('useProjects — captions', () => {
  it('writes one caption and folds it into the session in memory', async () => {
    const repo = fakeRepo({
      listProjects: vi.fn().mockResolvedValue([project({ sessions: [session()] })])
    });
    const { result } = await renderLoaded(repo);
    const item: TranscriptItem = {
      seq: 1,
      sourceText: 'ก',
      targetText: 'A',
      sourceLang: 'th',
      targetLang: 'en',
      ts: 1767225600,
      latencyMs: 10,
      isEdited: false
    };

    await act(async () => {
      await result.current.appendCaption('local_1', item);
    });

    expect(repo.appendCaption).toHaveBeenCalledWith('sess-1', item);
  });

  it('reports a caption that never lands', async () => {
    const repo = fakeRepo({
      listProjects: vi.fn().mockResolvedValue([project({ sessions: [session()] })]),
      appendCaption: vi.fn().mockRejectedValue(new PersistError('network', 'offline'))
    });
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.appendCaption('local_1', {
        seq: 1,
        sourceText: 'ก',
        targetText: 'A',
        sourceLang: 'th',
        targetLang: 'en',
        ts: 1,
        latencyMs: 1,
        isEdited: false
      });
    });

    expect(result.current.persistError).toMatchObject({ reason: 'network' });
  });

  it('does nothing for a caption whose session is not on the record', async () => {
    const repo = fakeRepo();
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.appendCaption('local_missing', {
        seq: 1,
        sourceText: 'ก',
        targetText: 'A',
        sourceLang: 'th',
        targetLang: 'en',
        ts: 1,
        latencyMs: 1,
        isEdited: false
      });
    });

    expect(repo.appendCaption).not.toHaveBeenCalled();
  });
});

describe('useProjects — summaries', () => {
  it('counts every attempt, including one that fails', async () => {
    const repo = fakeRepo({
      listProjects: vi
        .fn()
        .mockResolvedValue([project({ sessions: [session({ summarizeRuns: 2 })] })])
    });
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.markSessionSummarizing('local_1');
    });

    expect(repo.markSummarizing).toHaveBeenCalledWith('sess-1', 3);
    expect(result.current.summarizingIds.has('local_1')).toBe(true);
  });

  it('stores a failed summary as an empty string and clears the spinner', async () => {
    const repo = fakeRepo({
      listProjects: vi.fn().mockResolvedValue([project({ sessions: [session()] })])
    });
    const { result } = await renderLoaded(repo);
    await act(async () => {
      await result.current.markSessionSummarizing('local_1');
    });

    await act(async () => {
      await result.current.saveSessionSummary('local_1', '', 12);
    });

    expect(repo.saveSummary).toHaveBeenCalledWith('sess-1', '', 12);
    expect(result.current.summarizingIds.has('local_1')).toBe(false);
    const stored = result.current.activeProjects[0].sessions[0];
    expect(stored.summary).toBe('');
    expect(stored.reportItemCount).toBe(12);
  });
});

describe('useProjects — finishProject', () => {
  it('closes open sessions, bills the project and clears the selection', async () => {
    const repo = fakeRepo({
      listProjects: vi.fn().mockResolvedValue([project({ sessions: [session()] })])
    });
    const { result } = await renderLoaded(repo);
    await act(async () => {
      await result.current.selectProject('proj-1');
    });

    let finished: Project | undefined;
    await act(async () => {
      finished = await result.current.finishProject([], 'local_1');
    });

    expect(repo.finishProject).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ sessionCount: 1 }),
      expect.any(Number),
      ['sess-1']
    );
    expect(finished?.status).toBe('ended');
    expect(finished?.bill?.sessionCount).toBe(1);
    expect(result.current.currentProject).toBeUndefined();
  });

  it('returns undefined and writes nothing when no project is selected', async () => {
    const repo = fakeRepo();
    const { result } = await renderLoaded(repo);

    let finished: Project | undefined = project();
    await act(async () => {
      finished = await result.current.finishProject([], null);
    });

    expect(finished).toBeUndefined();
    expect(repo.finishProject).not.toHaveBeenCalled();
  });
});
