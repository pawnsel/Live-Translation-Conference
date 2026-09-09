import { useCallback, useEffect, useState } from 'react';
import { Project, ProjectBill, ProjectSession, TranscriptItem } from '../types';
import {
  localStorageProjectStore,
  type PersistFailureReason,
  type ProjectStore
} from '../storage/projectStore';
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

export function useProjects(store: ProjectStore = localStorageProjectStore) {
  const [projects, setProjects] = useState<Project[]>(() => store.loadProjects());
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => store.loadSelectedId());
  const [summarizingIds, setSummarizingIds] = useState<Set<string>>(() => new Set());
  // A write that fails is the operator's problem, not something to hide: with
  // no signal here a full quota looks exactly like a working recording.
  const [persistError, setPersistError] = useState<{
    reason: PersistFailureReason;
    message: string;
    at: number;
  } | null>(null);

  useEffect(() => {
    const result = store.saveProjects(projects);
    // Narrows on `'reason' in result` rather than `result.ok`: this repo's
    // tsconfig has no strictNullChecks, and without it TS won't narrow a
    // discriminated union across a boolean literal tag, only a property
    // presence check.
    setPersistError('reason' in result ? { reason: result.reason, message: result.message, at: Date.now() } : null);
  }, [projects, store]);

  useEffect(() => {
    const result = store.saveSelectedId(selectedProjectId);
    if ('reason' in result) setPersistError({ reason: result.reason, message: result.message, at: Date.now() });
  }, [selectedProjectId, store]);

  // A project must be finished within 7 days; past that the system closes it
  // and bills it from whatever it recorded, rather than letting it run forever.
  const sweepExpired = useCallback(() => {
    setProjects((prev) => {
      const now = Date.now();
      let changed = false;
      const swept = prev.map((p) => {
        if (p.status !== 'active' || now < projectExpiresAt(p)) return p;
        changed = true;
        // Nothing is holding a live buffer here — a sweep runs on a timer,
        // not off the console — so every session bills from its own record.
        const { closedSessions, bill } = buildBill(p, { transcripts: [], asrSessionId: null, now });
        return { ...p, status: 'ended' as const, sessions: closedSessions, endedAt: now, bill, autoFinished: true };
      });
      return changed ? swept : prev;
    });
  }, []);

  useEffect(() => {
    sweepExpired();
    const timer = setInterval(sweepExpired, EXPIRY_SWEEP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [sweepExpired]);

  const activeProjects = projects.filter((p) => p.status === 'active');
  const endedProjects = projects
    .filter((p) => p.status === 'ended')
    .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));

  const currentProject = activeProjects.find((p) => p.id === selectedProjectId);
  const activeSession = currentProject?.sessions.find((s) => !s.endedAt);
  const canCreateProject = activeProjects.length < MAX_ACTIVE_PROJECTS;

  const createProject = (name: string) => {
    if (!canCreateProject) return;
    const project: Project = {
      id: `proj_${Date.now()}`,
      name: name.trim(),
      status: 'active',
      sessions: [],
      transcripts: [],
      createdAt: Date.now()
    };
    setProjects((prev) => [project, ...prev]);
    setSelectedProjectId(project.id);
  };

  const selectProject = (id: string) => setSelectedProjectId(id);
  const clearSelection = () => setSelectedProjectId(null);

  const startSession = (asrSessionId: string, sourceLang: string, targetLang: string) => {
    if (!currentProject || activeSession) return;
    const session: ProjectSession = {
      id: `sess_${Date.now()}`,
      asrSessionId,
      startedAt: Date.now(),
      sourceLang,
      targetLang
    };
    setProjects((prev) =>
      prev.map((p: Project) => (p.id === currentProject.id ? { ...p, sessions: [...p.sessions, session] } : p))
    );
  };

  const endSession = () => {
    if (!currentProject || !activeSession) return;
    setProjects((prev) =>
      prev.map((p: Project) =>
        p.id === currentProject.id
          ? {
              ...p,
              sessions: p.sessions.map((s) => (s.id === activeSession.id ? { ...s, endedAt: Date.now() } : s))
            }
          : p
      )
    );
  };

  // A project outlives many ASR sessions: the Python registry is in memory,
  // so a backend restart forces a new session id under the same project.
  // Any session left open by the old id (e.g. the backend restarted rather
  // than the console cleanly detaching) is closed in this same update, so
  // this can't collide with startSession's "already have an open session"
  // guard and silently drop the new recording.
  const attachAsrSession = (asrSessionId: string, sourceLang: string, targetLang: string) => {
    if (!currentProject) return;
    const now = Date.now();
    const session: ProjectSession = {
      id: `sess_${now}`,
      asrSessionId,
      startedAt: now,
      sourceLang,
      targetLang
    };
    setProjects((prev) =>
      prev.map((p: Project) =>
        p.id === currentProject.id
          ? {
              ...p,
              asrSessionId,
              sessions: [...p.sessions.map((s) => (s.endedAt ? s : { ...s, endedAt: now })), session]
            }
          : p
      )
    );
  };

  const detachAsrSession = () => {
    if (!currentProject) return;
    endSession();
    setProjects((prev) =>
      prev.map((p: Project) => (p.id === currentProject.id ? { ...p, asrSessionId: null } : p))
    );
  };

  // Mirrors the live server buffer into the selected project, so each project
  // keeps its own transcript and its own bill.
  const saveTranscripts = useCallback((projectId: string, transcripts: TranscriptItem[]) => {
    setProjects((prev) => prev.map((p: Project) => (p.id === projectId ? { ...p, transcripts } : p)));
  }, []);

  // Keeps each session's own captions with the session record, so the
  // operator can ask for its summary minutes or days later — summarising is
  // on demand, not something that fires the moment a session ends.
  const saveSessionTranscript = useCallback((asrSessionId: string, transcripts: TranscriptItem[]) => {
    setProjects((prev) =>
      prev.map((p) => {
        const idx = p.sessions.findIndex((s) => s.asrSessionId === asrSessionId);
        if (idx === -1) return p;
        const sessions = p.sessions.slice();
        sessions[idx] = { ...sessions[idx], transcripts };
        return { ...p, sessions };
      })
    );
  }, []);

  // Attaches a summary to whichever ProjectSession recorded that ASR
  // session, wherever it lives — searched by `asrSessionId` inside the
  // updater rather than gated on `currentProject`, so it stays correct even
  // if the summary resolves after the project selection moved on.
  // No P2 database exists yet, so this is the "mock" persistence: the same
  // localStorage record every other project field already rides on.
  const saveSessionSummary = useCallback((asrSessionId: string, summary: string, reportItemCount: number) => {
    setSummarizingIds((prev) => {
      if (!prev.has(asrSessionId)) return prev;
      const next = new Set(prev);
      next.delete(asrSessionId);
      return next;
    });
    setProjects((prev) =>
      prev.map((p) => {
        const idx = p.sessions.findIndex((s) => s.asrSessionId === asrSessionId);
        if (idx === -1) return p;
        const sessions = p.sessions.slice();
        sessions[idx] = { ...sessions[idx], summary, reportItemCount };
        return { ...p, sessions };
      })
    );
  }, []);

  // Summarising is a request that can take many seconds, so the history view
  // needs to tell "still working on it" apart from "not summarised yet".
  // Deliberately NOT persisted: a reload kills the in-flight request, and a
  // flag stored in localStorage would leave that session showing a spinner
  // forever.
  const markSessionSummarizing = useCallback((asrSessionId: string) => {
    setSummarizingIds((prev) => new Set(prev).add(asrSessionId));
    // The run counter, unlike the spinner, IS persisted: every attempt spends
    // tokens whether or not it comes back with a summary, and the cost
    // estimate would understate the bill if a retry cost nothing.
    setProjects((prev) =>
      prev.map((p) => {
        const idx = p.sessions.findIndex((s) => s.asrSessionId === asrSessionId);
        if (idx === -1) return p;
        const sessions = p.sessions.slice();
        sessions[idx] = { ...sessions[idx], summarizeRuns: (sessions[idx].summarizeRuns ?? 0) + 1 };
        return { ...p, sessions };
      })
    );
  }, []);

  /** `liveTranscripts` are the captions of the session that was just stopped,
   *  and `liveAsrSessionId` names which session they belong to. Naming it
   *  matters: the bill is priced per session now, and whether that session's
   *  own transcript has been written to the record yet is a race this must
   *  not depend on. */
  const finishProject = (
    liveTranscripts: TranscriptItem[],
    liveAsrSessionId: string | null
  ): Project | undefined => {
    if (!currentProject) return undefined;

    const now = Date.now();
    const live: LiveBuffer = { transcripts: liveTranscripts, asrSessionId: liveAsrSessionId, now };

    setProjects((prev) =>
      prev.map((p: Project) => {
        if (p.id !== currentProject.id) return p;
        // Built from the freshest record rather than the render-time copy:
        // finishing a project stops the live session first, and that write
        // (the session's own transcript) must survive this one.
        const { closedSessions, bill, transcripts } = buildBill(p, live);
        return { ...p, status: 'ended' as const, sessions: closedSessions, transcripts, endedAt: now, bill };
      })
    );
    setSelectedProjectId(null);

    // What the bill modal shows. The numbers match the record written above:
    // both price the same sessions from the same live buffer, and the only
    // thing the newer write adds is that buffer, which `live` supplies here.
    const { closedSessions, bill, transcripts } = buildBill(currentProject, live);
    return { ...currentProject, status: 'ended', sessions: closedSessions, transcripts, endedAt: now, bill };
  };

  return {
    activeProjects,
    endedProjects,
    currentProject,
    activeSession,
    canCreateProject,
    createProject,
    selectProject,
    clearSelection,
    startSession,
    attachAsrSession,
    detachAsrSession,
    endSession,
    saveTranscripts,
    saveSessionTranscript,
    saveSessionSummary,
    markSessionSummarizing,
    summarizingIds,
    persistError,
    finishProject
  };
}
