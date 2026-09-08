// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjects } from './useProjects';

const STORAGE_KEY = 'ai_translate_projects';

// Node's own experimental global `localStorage` (present in the Node version
// running this suite) shadows jsdom's and is left unconfigured by it, so
// touching it throws/warns instead of behaving like browser storage. Stub a
// minimal in-memory Storage so the hook's direct `localStorage.*` calls have
// something real — and per-test-isolated — to read and write.
class FakeStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

// The hook stamps session ids and timestamps off Date.now(). Fake timers make
// those deterministic and distinct across actions in the same test, and also
// keep the hook's own TTL-sweep setInterval (EXPIRY_SWEEP_INTERVAL_MS, 60s)
// from ever firing during a test — we only ever advance by small, explicit
// amounts, never far enough to trip a 60s sweep or the 7-day project TTL.
beforeEach(() => {
  vi.stubGlobal('localStorage', new FakeStorage());
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setupWithProject() {
  const { result } = renderHook(() => useProjects());
  act(() => {
    result.current.createProject('Test Project');
  });
  return result;
}

describe('useProjects — attachAsrSession', () => {
  it('attaches with no prior session: one record appended, asrSessionId set', () => {
    const result = setupWithProject();
    expect(result.current.currentProject?.sessions).toHaveLength(0);

    act(() => {
      result.current.attachAsrSession('asr_1', 'th', 'en');
    });

    const project = result.current.currentProject;
    expect(project?.sessions).toHaveLength(1);
    expect(project?.asrSessionId).toBe('asr_1');
    expect(project?.sessions[0].asrSessionId).toBe('asr_1');
    expect(project?.sessions[0].endedAt).toBeUndefined();
  });

  // Regression test for the bug found in review: attachAsrSession used to set
  // the new asrSessionId and then call startSession, whose "already have an
  // open session" guard silently no-oped whenever the previous ProjectSession
  // had never been closed (the backend-restart case — the old session dies
  // without the console detaching first). That left `sessions[]` pointing at
  // a stale record while `asrSessionId` pointed at the new one, and never
  // logged the new recording's start time at all.
  //
  // Asserting only the new id landed in `asrSessionId` would still pass
  // against that broken version, since the broken code DID perform that part
  // unconditionally. What the broken version gets wrong is `sessions[]`, so
  // this test pins down sessions.length, the old record's endedAt, and that
  // its original startedAt/asrSessionId survive untouched.
  it('regression: attaching over a still-open session closes the old record and appends a new one', () => {
    const result = setupWithProject();

    act(() => {
      result.current.attachAsrSession('asr_old', 'th', 'en');
    });
    const oldSession = result.current.currentProject!.sessions[0];
    expect(oldSession.endedAt).toBeUndefined();

    // Advance the clock so the second attach's timestamps are unambiguously
    // later than the first's, then attach again WITHOUT detaching first —
    // simulating the backend having forgotten the old session.
    vi.advanceTimersByTime(5000);

    act(() => {
      result.current.attachAsrSession('asr_new', 'th', 'en');
    });

    const sessions = result.current.currentProject!.sessions;
    // Exactly one record closed in place, one appended: net +1, not a
    // replacement and not a silent no-op.
    expect(sessions).toHaveLength(2);

    const closedOld = sessions.find((s) => s.id === oldSession.id);
    expect(closedOld).toBeDefined();
    expect(closedOld!.endedAt).toBeDefined();
    expect(closedOld!.endedAt).toBeGreaterThan(oldSession.startedAt);
    // The old record's own history must survive — its elapsed time is real
    // and still feeds the bill.
    expect(closedOld!.startedAt).toBe(oldSession.startedAt);
    expect(closedOld!.asrSessionId).toBe('asr_old');

    const newSession = sessions.find((s) => s.id !== oldSession.id);
    expect(newSession).toBeDefined();
    expect(newSession!.asrSessionId).toBe('asr_new');
    expect(newSession!.endedAt).toBeUndefined();

    expect(result.current.currentProject?.asrSessionId).toBe('asr_new');
  });

  it('detaching after an attach closes the session, clears asrSessionId, and adds no spurious record', () => {
    const result = setupWithProject();

    act(() => {
      result.current.attachAsrSession('asr_1', 'th', 'en');
    });
    expect(result.current.currentProject?.sessions).toHaveLength(1);

    vi.advanceTimersByTime(1000);

    act(() => {
      result.current.detachAsrSession();
    });

    const project = result.current.currentProject;
    expect(project?.sessions).toHaveLength(1);
    expect(project?.sessions[0].endedAt).toBeDefined();
    expect(project?.asrSessionId).toBeNull();
  });

  it("startSession's own guard still no-ops for a direct caller while a session is open", () => {
    const result = setupWithProject();

    act(() => {
      result.current.attachAsrSession('asr_1', 'th', 'en');
    });
    expect(result.current.currentProject?.sessions).toHaveLength(1);

    act(() => {
      result.current.startSession('asr_direct', 'th', 'en');
    });

    // The direct call is a no-op: still just the one session from the
    // attach, and it's still the original one.
    const sessions = result.current.currentProject!.sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].asrSessionId).toBe('asr_1');
  });
});

describe('useProjects — per-session transcripts', () => {
  const items = [
    {
      seq: 0,
      sourceText: 'สวัสดีครับ',
      targetText: 'Hello',
      sourceLang: 'th',
      targetLang: 'en',
      ts: 1,
      latencyMs: 120,
      isEdited: false
    }
  ];

  it('files a transcript under the session that recorded it, so it can be summarised later', () => {
    const result = setupWithProject();

    act(() => {
      result.current.attachAsrSession('asr_1', 'th', 'en');
    });
    act(() => {
      result.current.saveSessionTranscript('asr_1', items);
    });

    expect(result.current.currentProject!.sessions[0].transcripts).toEqual(items);
  });

  // Regression: finishing a project used to write a snapshot of the project
  // taken at render time, which silently threw away the session transcript
  // saved moments earlier when the live session was stopped — leaving that
  // session unsummarisable forever. All three calls land in one batch here,
  // which is exactly how "จบโปรเจกต์" runs them.
  it('regression: finishing a project keeps a transcript saved in the same batch', () => {
    const result = setupWithProject();

    act(() => {
      result.current.attachAsrSession('asr_1', 'th', 'en');
    });

    vi.advanceTimersByTime(1000);

    act(() => {
      result.current.saveSessionTranscript('asr_1', items);
      result.current.detachAsrSession();
      result.current.finishProject(items);
    });

    const ended = result.current.endedProjects[0];
    expect(ended).toBeDefined();
    expect(ended.sessions).toHaveLength(1);
    expect(ended.sessions[0].transcripts).toEqual(items);
  });

  it('attaches a summary to the session that owns the ASR id', () => {
    const result = setupWithProject();

    act(() => {
      result.current.attachAsrSession('asr_1', 'th', 'en');
    });
    act(() => {
      result.current.markSessionSummarizing('asr_1');
    });
    expect(result.current.summarizingIds.has('asr_1')).toBe(true);

    act(() => {
      result.current.saveSessionSummary('asr_1', 'สรุปการประชุม', 1);
    });

    expect(result.current.summarizingIds.has('asr_1')).toBe(false);
    expect(result.current.currentProject!.sessions[0].summary).toBe('สรุปการประชุม');
    expect(result.current.currentProject!.sessions[0].reportItemCount).toBe(1);
  });
});

describe('useProjects — localStorage migration', () => {
  it('loads a project saved before transcripts/asrSessionId existed with sane defaults', () => {
    const legacyProject = {
      id: 'proj_legacy',
      name: 'Legacy',
      status: 'active',
      sessions: [],
      createdAt: Date.now()
      // Deliberately no `transcripts`, no `asrSessionId` — the shape a
      // project persisted before those fields existed would have.
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([legacyProject]));

    const { result } = renderHook(() => useProjects());

    const loaded = result.current.activeProjects.find((p) => p.id === 'proj_legacy');
    expect(loaded).toBeDefined();
    expect(loaded!.transcripts).toEqual([]);
    expect(loaded!.asrSessionId).toBeNull();
  });
});

describe('persistence failures', () => {
  function failingStore(fail: { value: boolean }) {
    return {
      loadProjects: () => [],
      saveProjects: () =>
        fail.value ? ({ ok: false, reason: 'quota', message: 'full' } as const) : ({ ok: true } as const),
      loadSelectedId: () => null,
      saveSelectedId: () => ({ ok: true } as const)
    };
  }

  it('exposes a failed write instead of swallowing it', () => {
    const fail = { value: true };
    // Hoisted so the store keeps one identity across re-renders. The store
    // is in the persistence effects' deps (as it must be — it's used inside
    // them); constructing a new store literal inside the renderHook callback
    // would give it a fresh identity every re-render, retriggering the write
    // on every render regardless of whether `projects` changed, which loops
    // forever while the write keeps failing.
    const store = failingStore(fail);
    const { result } = renderHook(() => useProjects(store));

    act(() => {
      result.current.createProject('งานประชุม');
    });

    expect(result.current.persistError).toMatchObject({ reason: 'quota' });
  });

  it('clears the error once a write succeeds again', () => {
    const fail = { value: true };
    const store = failingStore(fail);
    const { result } = renderHook(() => useProjects(store));

    act(() => {
      result.current.createProject('งานประชุม');
    });
    expect(result.current.persistError).not.toBeNull();

    fail.value = false;
    act(() => {
      result.current.createProject('อีกงาน');
    });
    expect(result.current.persistError).toBeNull();
  });
});
