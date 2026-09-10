// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_TTL_MS, STALE_SWEEP_INTERVAL_MS, useProjects } from './useProjects';
import { SESSION_STALE_MS } from '../data/staleSessions';
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
    // A live session by default: its tab reported in a moment ago. Without
    // this the orphan sweep in reload() would (correctly) close it, since an
    // open session with no heartbeat is exactly what an abandoned tab leaves
    // behind.
    lastSeenAt: Date.now(),
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
    touchSession: vi.fn().mockResolvedValue(undefined),
    closeStaleSession: vi.fn().mockResolvedValue(undefined),
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

  // A tab reload seeds selectedProjectId straight from localStorage, which
  // never goes through selectProject — without a catch-up effect, the
  // restored project's sessions keep transcripts === undefined and the cost
  // badge (via projectCost.ts's `transcripts ?? []`) silently treats it as
  // empty.
  it('eagerly loads transcripts for a selection restored from localStorage', async () => {
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
    localStorage.setItem('ai_translate_selected_project', 'proj-1');
    const repo = fakeRepo({
      listProjects: vi.fn().mockResolvedValue([project({ sessions: [session({ itemCount: 1 })] })]),
      loadProjectTranscripts: vi.fn().mockResolvedValue({ 'sess-1': [item] })
    });
    const { result } = await renderLoaded(repo);

    expect(result.current.currentProject?.id).toBe('proj-1');
    await waitFor(() => expect(repo.loadProjectTranscripts).toHaveBeenCalledWith('proj-1'));
    await waitFor(() =>
      expect(result.current.currentProject?.sessions[0].transcripts).toEqual([item])
    );
  });

  // A session with itemCount 0 has nothing recorded yet, so the restore
  // effect must not spend a round trip fetching it.
  it('does not fetch transcripts for a restored project with no recorded items', async () => {
    localStorage.setItem('ai_translate_selected_project', 'proj-1');
    const repo = fakeRepo({
      listProjects: vi.fn().mockResolvedValue([project({ sessions: [session({ itemCount: 0 })] })])
    });
    const { result } = await renderLoaded(repo);

    expect(result.current.currentProject?.id).toBe('proj-1');
    expect(repo.loadProjectTranscripts).not.toHaveBeenCalled();
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

  it('reports a caption that never lands, after the retries are exhausted', async () => {
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
      await result.current.flushCaptions();
    });

    await waitFor(() => expect(result.current.persistError).toMatchObject({ reason: 'network' }));
  }, 20000);

  it('reports, rather than silently drops, a caption whose session is not on the record', async () => {
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
    expect(result.current.persistError).not.toBeNull();
  });

  it('counts itemCount from the actual transcript length, not the (0-based, cross-session) seq', async () => {
    const repo = fakeRepo({
      listProjects: vi.fn().mockResolvedValue([project({ sessions: [session()] })])
    });
    const { result } = await renderLoaded(repo);
    await act(async () => {
      await result.current.selectProject('proj-1');
    });

    // seqRef in useGeminiLiveCapture is 0-based and never resets per session,
    // so a session's very first caption can easily arrive with seq === 0.
    await act(async () => {
      await result.current.appendCaption('local_1', {
        seq: 0,
        sourceText: 'ก',
        targetText: 'A',
        sourceLang: 'th',
        targetLang: 'en',
        ts: 1,
        latencyMs: 1,
        isEdited: false
      });
    });

    expect(result.current.currentProject?.sessions[0].itemCount).toBe(1);
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

describe('useProjects — auto-finish retry', () => {
  // EXPIRY_SWEEP_INTERVAL_MS is internal to the hook, not exported — the
  // sweep timer's period is a private implementation detail. 60s, matching
  // the hook's own constant.
  const SWEEP_INTERVAL_MS = 60 * 1000;

  // Regression for a bug the reviewer found in the auto-finish sync effect: it
  // used to mark a project's id "synced" in the same tick it *started* the
  // finishProject write, not once the write actually landed. A write that
  // failed (server never recorded the finish) triggers run()'s resync, which
  // reverts the project back to 'active' from the server's still-active copy
  // — and the next sweep tick re-detects it as expired and flips it to
  // 'ended' locally again, but the sync effect silently skipped it forever
  // because the id was already marked. The project could sit ended in the UI
  // with the server still holding it open, with no retry, ever.
  it('retries a failed auto-finish write on the next sweep instead of skipping it forever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const expired = project({ createdAt: Date.now() - PROJECT_TTL_MS - 1000 });
      const repo = fakeRepo({
        listProjects: vi.fn().mockResolvedValue([expired]),
        finishProject: vi
          .fn()
          .mockRejectedValueOnce(new PersistError('network', 'offline'))
          .mockResolvedValueOnce(undefined)
      });

      const { result } = await renderLoaded(repo);
      expect(repo.finishProject).not.toHaveBeenCalled();

      // First sweep tick: detects the already-expired project, auto-finishes
      // it locally, and fires the write — which fails. run() resyncs from
      // the (unchanged) server copy, reverting the project back to 'active'.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
      });
      expect(repo.finishProject).toHaveBeenCalledTimes(1);
      expect(result.current.activeProjects.map((p) => p.id)).toEqual(['proj-1']);
      expect(result.current.endedProjects).toHaveLength(0);

      // Second sweep tick: the project (still expired by createdAt) is
      // auto-finished again. This is the retry — it must actually happen,
      // not be skipped because the first attempt already marked it synced.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
      });
      expect(repo.finishProject).toHaveBeenCalledTimes(2);
      expect(result.current.activeProjects).toHaveLength(0);
      expect(result.current.endedProjects.map((p) => p.id)).toEqual(['proj-1']);
    } finally {
      vi.useRealTimers();
    }
  });
});

// A tab that vanishes cannot close its own session. Left open, it is billed
// up to `now` — a refresh mid-meeting quietly added to the project's estimate
// for as long as nobody noticed — and it shows as live, which blocks both its
// own summary and any project switch.
describe('useProjects — orphaned sessions', () => {
  const STALE_ENOUGH = 10 * 60_000;

  it('closes a session whose tab stopped reporting, at its last heartbeat', async () => {
    const lastSeenAt = Date.now() - STALE_ENOUGH;
    const repo = fakeRepo({
      listProjects: vi
        .fn()
        .mockResolvedValue([project({ sessions: [session({ lastSeenAt, endedAt: undefined })] })])
    });
    const { result } = await renderLoaded(repo);

    expect(repo.closeStaleSession).toHaveBeenCalledWith('sess-1', lastSeenAt);
    // Applied in memory too, so the console stops showing a dead session as
    // live without waiting for another round trip.
    expect(result.current.activeProjects[0].sessions[0].endedAt).toBe(lastSeenAt);
  });

  it('leaves a session alone while its tab is still reporting', async () => {
    const repo = fakeRepo({
      listProjects: vi.fn().mockResolvedValue([project({ sessions: [session()] })])
    });
    const { result } = await renderLoaded(repo);

    expect(repo.closeStaleSession).not.toHaveBeenCalled();
    expect(result.current.activeProjects[0].sessions[0].endedAt).toBeUndefined();
  });

  // The console runs in more than one tab, and a tab loading the console
  // must never end the meeting another tab — or itself — is recording.
  it('never closes the session this tab owns, however stale it looks', async () => {
    const repo = fakeRepo({
      listProjects: vi.fn().mockResolvedValue([
        project({ sessions: [session({ lastSeenAt: Date.now() - STALE_ENOUGH, endedAt: undefined })] })
      ])
    });
    const view = renderHook(() => useProjects({ repo, userId: USER, ownAsrSessionId: 'local_1' }));
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    expect(repo.closeStaleSession).not.toHaveBeenCalled();
  });

  // Bookkeeping must not hold up a console that already has what it needs to
  // render, and a refused write must not raise the persistence banner.
  it('shows the list even when closing the orphan fails', async () => {
    const repo = fakeRepo({
      listProjects: vi.fn().mockResolvedValue([
        project({ sessions: [session({ lastSeenAt: Date.now() - STALE_ENOUGH, endedAt: undefined })] })
      ]),
      closeStaleSession: vi.fn().mockRejectedValue(new Error('refused'))
    });
    const { result } = await renderLoaded(repo);

    expect(result.current.activeProjects).toHaveLength(1);
    expect(result.current.persistError).toBeNull();
  });
});

describe('useProjects — heartbeat', () => {
  it('stamps the session row for the session it is given', async () => {
    const repo = fakeRepo({
      listProjects: vi.fn().mockResolvedValue([project({ sessions: [session()] })])
    });
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.touchSession('local_1');
    });

    expect(repo.touchSession).toHaveBeenCalledWith('sess-1');
  });

  it('writes nothing for a session it does not know', async () => {
    const repo = fakeRepo();
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.touchSession('local_unknown');
    });

    expect(repo.touchSession).not.toHaveBeenCalled();
  });

  // A missed beat is harmless — the next is thirty seconds away and the
  // staleness window is four beats wide — so it must not raise the banner and
  // trigger a resync in the middle of a meeting.
  it('stays quiet when a beat is refused', async () => {
    const repo = fakeRepo({
      listProjects: vi.fn().mockResolvedValue([project({ sessions: [session()] })]),
      touchSession: vi.fn().mockRejectedValue(new Error('offline'))
    });
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.touchSession('local_1');
    });

    expect(result.current.persistError).toBeNull();
  });
});

// The bug this covers: the sweep used to run ONLY at load, but the staleness
// window guarantees a just-refreshed session is NOT stale at that moment. So
// the one case heartbeats were built for — refresh mid-meeting — could never
// be caught, and the session sat marked "recording" forever.
describe('useProjects — the sweep keeps running', () => {
  it('closes a session that goes stale while the console is already open', async () => {
    vi.useFakeTimers();
    try {
      const lastSeenAt = Date.now();
      const repo = fakeRepo({
        listProjects: vi.fn().mockResolvedValue([
          // A fresh createdAt: the fixture's default is months old, and the
          // 7-day expiry sweep would auto-finish the project part way through
          // the window this test advances.
          project({ createdAt: Date.now(), sessions: [session({ lastSeenAt, endedAt: undefined })] })
        ])
      });
      const view = renderHook(() => useProjects({ repo, userId: USER }));
      await vi.waitFor(() => expect(view.result.current.loading).toBe(false));

      // Fresh at load, so the load-time sweep correctly leaves it alone.
      expect(repo.closeStaleSession).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(SESSION_STALE_MS + STALE_SWEEP_INTERVAL_MS);
      });

      expect(repo.closeStaleSession).toHaveBeenCalledWith('sess-1', lastSeenAt);
      expect(view.result.current.activeProjects[0].sessions[0].endedAt).toBe(lastSeenAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes the closure once, not on every tick', async () => {
    vi.useFakeTimers();
    try {
      const repo = fakeRepo({
        listProjects: vi.fn().mockResolvedValue([
          project({
            createdAt: Date.now(),
            sessions: [session({ lastSeenAt: Date.now() - SESSION_STALE_MS * 2, endedAt: undefined })]
          })
        ])
      });
      const view = renderHook(() => useProjects({ repo, userId: USER }));
      await vi.waitFor(() => expect(view.result.current.loading).toBe(false));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(STALE_SWEEP_INTERVAL_MS * 5);
      });

      expect(repo.closeStaleSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// A tab that refreshes knows its own session is dead, and says so through
// sessionStorage. Without it the console would have to wait out the whole
// staleness window before that session stopped looking live.
describe('useProjects — reclaiming this tab’s own session after a reload', () => {
  it('closes the reclaimed session at once, however fresh its heartbeat', async () => {
    const lastSeenAt = Date.now() - 1_000;
    const repo = fakeRepo({
      listProjects: vi
        .fn()
        .mockResolvedValue([project({ sessions: [session({ lastSeenAt, endedAt: undefined })] })])
    });
    const view = renderHook(() =>
      useProjects({ repo, userId: USER, reclaimAsrSessionId: 'local_1' })
    );
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    expect(repo.closeStaleSession).toHaveBeenCalledWith('sess-1', lastSeenAt);
  });

  it('leaves a session another tab is recording alone', async () => {
    const repo = fakeRepo({
      listProjects: vi.fn().mockResolvedValue([project({ sessions: [session()] })])
    });
    const view = renderHook(() =>
      useProjects({ repo, userId: USER, reclaimAsrSessionId: 'someone_elses' })
    );
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    expect(repo.closeStaleSession).not.toHaveBeenCalled();
  });
});
