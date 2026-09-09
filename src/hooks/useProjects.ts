import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Project, ProjectBill, ProjectSession, TranscriptItem } from '../types';
import { loadSelectedId, saveSelectedId } from '../storage/projectStore';
import { toPersistError, type PersistFailureReason } from '../data/persistError';
import { createProjectsRepo, type ProjectsRepo } from '../data/projectsRepo';
import { supabase } from '../lib/supabase';
import { ceilCents } from '../billing/geminiCost';
import { projectCost, projectTranscripts, type LiveBuffer } from '../billing/projectCost';

export const MAX_ACTIVE_PROJECTS = 3;
export const PROJECT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EXPIRY_SWEEP_INTERVAL_MS = 60 * 1000;

export function projectExpiresAt(project: Project): number {
  return project.createdAt + PROJECT_TTL_MS;
}

export function projectDaysLeft(project: Project): number {
  return Math.max(0, Math.ceil((projectExpiresAt(project) - Date.now()) / (24 * 60 * 60 * 1000)));
}

/** Words are no longer what a project is priced on — Gemini bills audio
 *  minutes and tokens — but the bill still reports a word count, and the
 *  meaning of "word" has to stay the same wherever it is shown. */
export function countWords(transcripts: TranscriptItem[]): number {
  return transcripts.reduce((total, t) => {
    const text = `${t.sourceText} ${t.targetText}`.trim();
    return total + (text ? text.split(/\s+/).length : 0);
  }, 0);
}

/** Closes the books on a project. `live` describes the session still holding
 *  its captions in memory, if any — the caller names it explicitly rather
 *  than letting this read a project record that may not have been written
 *  yet (see finishProject). */
function buildBill(project: Project, live: LiveBuffer) {
  const now = live.now;
  const closedSessions = project.sessions.map((s) => (s.endedAt ? s : { ...s, endedAt: now }));
  const durationMs = closedSessions.reduce((sum, s) => sum + (s.endedAt! - s.startedAt), 0);
  const transcripts = projectTranscripts(project, live);
  const cost = projectCost(project, live);
  const bill: ProjectBill = {
    sessionCount: closedSessions.length,
    durationMs,
    wordCount: countWords(transcripts),
    estimatedCost: ceilCents(cost.total),
    costBreakdown: {
      liveMinutes: cost.liveMinutes,
      liveAudioCost: cost.liveAudioCost,
      liveTextCost: cost.liveTextCost,
      summaryCost: cost.summaryCost,
      summaryRuns: cost.summaryRuns
    }
  };
  return { closedSessions, bill, transcripts };
}

export interface UseProjectsOptions {
  /** Injected in tests. Defaults to the live Supabase-backed repo. */
  repo?: ProjectsRepo;
  /** The signed-in, approved account. Null means "load nothing and hold
   *  nothing" — a signed-out console on a shared machine must not still be
   *  showing the last person's meetings. */
  userId?: string | null;
}

const defaultRepo = () => createProjectsRepo(supabase as never);

export function useProjects({ repo, userId = null }: UseProjectsOptions = {}) {
  const activeRepo = useMemo(() => repo ?? defaultRepo(), [repo]);

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => loadSelectedId());
  const [summarizingIds, setSummarizingIds] = useState<Set<string>>(() => new Set());
  // A write that fails is the operator's problem, not something to hide: with
  // no signal here a refused write looks exactly like a working recording.
  const [persistError, setPersistError] = useState<{
    reason: PersistFailureReason;
    message: string;
    at: number;
  } | null>(null);

  const fail = useCallback((error: unknown) => {
    const persist = toPersistError(error);
    setPersistError({ reason: persist.reason, message: persist.message, at: Date.now() });
  }, []);

  // ── Loading ───────────────────────────────────────────────────────────────
  const loadSeq = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++loadSeq.current;
    if (!userId) {
      setProjects([]);
      setLoading(false);
      return;
    }
    try {
      const loaded = await activeRepo.listProjects();
      if (seq !== loadSeq.current) return; // a newer load superseded this one
      setProjects(loaded);
      setPersistError(null);
    } catch (error) {
      if (seq === loadSeq.current) fail(error);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [activeRepo, userId, fail]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  /** Runs a mutation, and on failure raises the banner and resyncs from the
   *  server rather than leaving an optimistic edit the database never took.
   *
   *  The resync is awaited before the banner is raised, not fired off in the
   *  background: reload()'s own success path clears persistError (a clean
   *  load has nothing to report), so a resync left running after fail() sets
   *  the error would race it and could silently wipe the banner the moment it
   *  completes. Awaiting first means the banner set below is always the last
   *  write. */
  const run = useCallback(
    async (mutate: () => Promise<void>) => {
      try {
        await mutate();
        return true;
      } catch (error) {
        await reload();
        fail(error);
        return false;
      }
    },
    [fail, reload]
  );

  useEffect(() => {
    saveSelectedId(selectedProjectId);
  }, [selectedProjectId]);

  // Tracks which auto-finished projects have already had their finishProject
  // write issued, so a re-render or a StrictMode double-invoke of the pure
  // updater below can never fire the write twice for the same expiry.
  const syncedAutoFinishIds = useRef<Set<string>>(new Set());

  // ── Expiry sweep ──────────────────────────────────────────────────────────
  // A project must be finished within 7 days; past that the system closes it
  // and bills it from whatever it recorded, rather than letting it run forever.
  // Still client-side, so it only runs while someone has the console open —
  // see the follow-ups in the design doc.
  //
  // The updater below is deliberately pure — no repo call inside it. React
  // may invoke a state updater more than once for the same update (notably
  // under StrictMode), so any side effect placed there would risk firing
  // twice. The actual write happens in the effect further down, which is
  // idempotent by construction (guarded by syncedAutoFinishIds).
  const sweepExpired = useCallback(() => {
    const now = Date.now();
    setProjects((prev) => {
      const anyExpired = prev.some((p) => p.status === 'active' && now >= projectExpiresAt(p));
      if (!anyExpired) return prev;
      return prev.map((p) => {
        if (p.status !== 'active' || now < projectExpiresAt(p)) return p;
        // Nothing is holding a live buffer here — a sweep runs on a timer,
        // not off the console — so every session bills from its own record.
        const { closedSessions, bill } = buildBill(p, { transcripts: [], asrSessionId: null, now });
        return { ...p, status: 'ended' as const, sessions: closedSessions, endedAt: now, bill, autoFinished: true };
      });
    });
  }, []);

  useEffect(() => {
    sweepExpired();
    const timer = setInterval(sweepExpired, EXPIRY_SWEEP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [sweepExpired]);

  // Fires the finishProject write for a project the sweep above just closed,
  // exactly once per project id that actually lands — decoupled from the
  // state updater so it can stay pure. The ref survives re-renders, so this
  // is safe even if the effect itself re-runs.
  useEffect(() => {
    for (const p of projects) {
      if (p.status === 'ended' && p.autoFinished && p.bill && !syncedAutoFinishIds.current.has(p.id)) {
        // Marked in-flight immediately, before the write resolves, so a
        // second effect run triggered by an unrelated state change during
        // the same write can't dispatch a concurrent duplicate for this id.
        syncedAutoFinishIds.current.add(p.id);
        const openIds = p.sessions.filter((s) => !s.endedAt).map((s) => s.id);
        void run(() => activeRepo.finishProject(p.id, p.bill!, p.endedAt ?? Date.now(), openIds)).then(
          (ok) => {
            // A failed write leaves the server's project still active — run()
            // resyncs on failure, so the local copy reverts to 'active' too.
            // Un-marking here means the NEXT sweep tick, which will detect
            // the same project as expired all over again, gets a real retry
            // instead of finding the id already in the set and silently
            // skipping it forever. A success leaves the id marked: the
            // server now agrees, and firing again would just be a wasted call.
            if (!ok) syncedAutoFinishIds.current.delete(p.id);
          }
        );
      }
    }
  }, [projects, activeRepo, run]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const activeProjects = projects.filter((p) => p.status === 'active');
  const endedProjects = projects
    .filter((p) => p.status === 'ended')
    .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));

  const currentProject = activeProjects.find((p) => p.id === selectedProjectId);
  const activeSession = currentProject?.sessions.find((s) => !s.endedAt);
  const canCreateProject = activeProjects.length < MAX_ACTIVE_PROJECTS;

  /** Applies `change` to whichever session recorded `asrSessionId`, wherever
   *  it lives. Searched inside the updater rather than gated on
   *  currentProject, so it stays correct if the selection moved on while a
   *  request was in flight. */
  const updateSessionBy = (
    asrSessionId: string,
    change: (session: ProjectSession) => ProjectSession
  ) => {
    setProjects((prev) =>
      prev.map((p) => {
        const idx = p.sessions.findIndex((s) => s.asrSessionId === asrSessionId);
        if (idx === -1) return p;
        const sessions = p.sessions.slice();
        sessions[idx] = change(sessions[idx]);
        return { ...p, sessions };
      })
    );
  };

  const findSession = (asrSessionId: string): ProjectSession | undefined =>
    projects.flatMap((p) => p.sessions).find((s) => s.asrSessionId === asrSessionId);

  // ── Actions ───────────────────────────────────────────────────────────────
  const createProject = async (name: string) => {
    if (!canCreateProject) return;
    await run(async () => {
      const created = await activeRepo.createProject(name);
      setProjects((prev) => [created, ...prev]);
      setSelectedProjectId(created.id);
    });
  };

  /** Selecting a project pulls its transcripts in. The running cost badge
   *  prices every session in the current project, so leaving them lazy would
   *  make that number silently undercount. Ended projects in the history list
   *  stay lazy — they are read one summary at a time. */
  const selectProject = async (id: string) => {
    setSelectedProjectId(id);
    await run(async () => {
      const bySession = await activeRepo.loadProjectTranscripts(id);
      setProjects((prev) =>
        prev.map((p) =>
          p.id === id
            ? { ...p, sessions: p.sessions.map((s) => ({ ...s, transcripts: bySession[s.id] ?? [] })) }
            : p
        )
      );
    });
  };

  const clearSelection = () => setSelectedProjectId(null);

  // A project outlives many capture sessions: a dropped websocket reconnects
  // under a new id. Any session left open by the old id is closed by the same
  // statement that inserts the new one, so this cannot collide with the "one
  // open session" rule and silently drop the new recording.
  const attachAsrSession = async (asrSessionId: string, sourceLang: string, targetLang: string) => {
    if (!currentProject) return;
    const projectId = currentProject.id;
    await run(async () => {
      const created = await activeRepo.attachAsrSession(
        projectId,
        asrSessionId,
        sourceLang,
        targetLang
      );
      const now = Date.now();
      setProjects((prev) =>
        prev.map((p) =>
          p.id === projectId
            ? {
                ...p,
                asrSessionId,
                sessions: [...p.sessions.map((s) => (s.endedAt ? s : { ...s, endedAt: now })), created]
              }
            : p
        )
      );
    });
  };

  const endSession = async () => {
    if (!currentProject || !activeSession) return;
    const sessionId = activeSession.id;
    await run(async () => {
      await activeRepo.endSession(sessionId);
      updateSessionBy(activeSession.asrSessionId, (s) => ({ ...s, endedAt: Date.now() }));
    });
  };

  const detachAsrSession = async () => {
    if (!currentProject) return;
    const projectId = currentProject.id;
    await endSession();
    await run(async () => {
      await activeRepo.detachAsrSession(projectId);
      setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, asrSessionId: null } : p)));
    });
  };

  /** One closed caption, written as it happens. A crashed tab now loses at
   *  most the sentence in flight instead of the whole meeting. */
  const appendCaption = useCallback(
    async (asrSessionId: string, item: TranscriptItem) => {
      const target = findSession(asrSessionId);
      if (!target) return;
      await run(async () => {
        await activeRepo.appendCaption(target.id, item);
        updateSessionBy(asrSessionId, (s) => ({
          ...s,
          transcripts: [...(s.transcripts ?? []).filter((t) => t.seq !== item.seq), item],
          itemCount: Math.max(s.itemCount, item.seq)
        }));
      });
    },
    [activeRepo, run, projects]
  );

  const editCaption = useCallback(
    async (asrSessionId: string, seq: number, targetText: string) => {
      const target = findSession(asrSessionId);
      if (!target) return;
      await run(async () => {
        await activeRepo.editCaption(target.id, seq, targetText);
        updateSessionBy(asrSessionId, (s) => ({
          ...s,
          transcripts: (s.transcripts ?? []).map((t) =>
            t.seq === seq ? { ...t, targetText, isEdited: true } : t
          )
        }));
      });
    },
    [activeRepo, run, projects]
  );

  /** Fetches one ended session's captions on demand, so the history list can
   *  stay cheap until a summary is actually asked for. */
  const loadSessionTranscript = useCallback(
    async (asrSessionId: string): Promise<TranscriptItem[]> => {
      const target = findSession(asrSessionId);
      if (!target) return [];
      if (target.transcripts) return target.transcripts;
      let items: TranscriptItem[] = [];
      await run(async () => {
        items = await activeRepo.loadSessionTranscript(target.id);
        updateSessionBy(asrSessionId, (s) => ({ ...s, transcripts: items }));
      });
      return items;
    },
    [activeRepo, run, projects]
  );

  // Summarising is a request that can take many seconds, so the history view
  // needs to tell "still working on it" apart from "not summarised yet". The
  // spinner is deliberately NOT persisted — a reload kills the in-flight
  // request, and a stored flag would spin forever. The run COUNTER is
  // persisted: every attempt spends tokens whether or not a summary comes
  // back, and the estimate would understate the bill if a retry cost nothing.
  const markSessionSummarizing = useCallback(
    async (asrSessionId: string) => {
      const target = findSession(asrSessionId);
      if (!target) return;
      const runs = (target.summarizeRuns ?? 0) + 1;
      setSummarizingIds((prev) => new Set(prev).add(asrSessionId));
      await run(async () => {
        await activeRepo.markSummarizing(target.id, runs);
        updateSessionBy(asrSessionId, (s) => ({ ...s, summarizeRuns: runs }));
      });
    },
    [activeRepo, run, projects]
  );

  const saveSessionSummary = useCallback(
    async (asrSessionId: string, summary: string, reportItemCount: number) => {
      const target = findSession(asrSessionId);
      setSummarizingIds((prev) => {
        if (!prev.has(asrSessionId)) return prev;
        const next = new Set(prev);
        next.delete(asrSessionId);
        return next;
      });
      if (!target) return;
      await run(async () => {
        // '' is a real value here — it records that the AI call failed, which
        // is different from nobody having asked.
        await activeRepo.saveSummary(target.id, summary, reportItemCount);
        updateSessionBy(asrSessionId, (s) => ({ ...s, summary, reportItemCount }));
      });
    },
    [activeRepo, run, projects]
  );

  /** `liveTranscripts` are the captions of the session that was just stopped,
   *  and `liveAsrSessionId` names which session they belong to. Naming it
   *  matters: the bill is priced per session, and whether that session's own
   *  transcript has reached the record yet is a race this must not depend on. */
  const finishProject = async (
    liveTranscripts: TranscriptItem[],
    liveAsrSessionId: string | null
  ): Promise<Project | undefined> => {
    if (!currentProject) return undefined;

    const now = Date.now();
    const live: LiveBuffer = { transcripts: liveTranscripts, asrSessionId: liveAsrSessionId, now };
    const { closedSessions, bill, transcripts } = buildBill(currentProject, live);
    const openIds = currentProject.sessions.filter((s) => !s.endedAt).map((s) => s.id);
    const projectId = currentProject.id;

    const ok = await run(() => activeRepo.finishProject(projectId, bill, now, openIds));
    if (!ok) return undefined;

    setProjects((prev) =>
      prev.map((p) =>
        p.id === projectId
          ? { ...p, status: 'ended' as const, sessions: closedSessions, transcripts, endedAt: now, bill, asrSessionId: null }
          : p
      )
    );
    setSelectedProjectId(null);

    // What the bill modal shows — the same numbers just written.
    return { ...currentProject, status: 'ended', sessions: closedSessions, transcripts, endedAt: now, bill };
  };

  return {
    loading,
    activeProjects,
    endedProjects,
    currentProject,
    activeSession,
    canCreateProject,
    createProject,
    selectProject,
    clearSelection,
    attachAsrSession,
    detachAsrSession,
    endSession,
    appendCaption,
    editCaption,
    loadSessionTranscript,
    saveSessionSummary,
    markSessionSummarizing,
    summarizingIds,
    persistError,
    reload,
    finishProject
  };
}
