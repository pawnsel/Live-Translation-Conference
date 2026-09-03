import { useCallback, useEffect, useState } from 'react';
import { Project, ProjectBill, ProjectSession, TranscriptItem } from '../types';

const STORAGE_KEY = 'ai_translate_projects';
const SELECTED_KEY = 'ai_translate_selected_project';

// Placeholder rate until real usage-based billing lands (see SYSTEM_OVERVIEW.md §4).
const ESTIMATED_COST_PER_WORD = 0.002;

export const MAX_ACTIVE_PROJECTS = 3;
export const PROJECT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EXPIRY_SWEEP_INTERVAL_MS = 60 * 1000;

export function projectExpiresAt(project: Project): number {
  return project.createdAt + PROJECT_TTL_MS;
}

export function projectDaysLeft(project: Project): number {
  return Math.max(0, Math.ceil((projectExpiresAt(project) - Date.now()) / (24 * 60 * 60 * 1000)));
}

function loadProjects(): Project[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const parsed: Project[] = stored ? JSON.parse(stored) : [];
    // Projects saved before per-project transcripts existed have no array yet.
    return parsed.map((p) => ({ ...p, transcripts: p.transcripts || [] }));
  } catch {
    return [];
  }
}

function loadSelectedId(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

function countWords(transcripts: TranscriptItem[]): number {
  return transcripts.reduce((total, t) => {
    const text = `${t.originalText} ${t.translatedText}`.trim();
    return total + (text ? text.split(/\s+/).length : 0);
  }, 0);
}

function buildBill(project: Project, transcripts: TranscriptItem[], now: number) {
  const closedSessions = project.sessions.map((s) => (s.endedAt ? s : { ...s, endedAt: now }));
  const durationMs = closedSessions.reduce((sum, s) => sum + (s.endedAt! - s.startedAt), 0);
  const wordCount = countWords(transcripts);
  const bill: ProjectBill = {
    sessionCount: closedSessions.length,
    durationMs,
    wordCount,
    estimatedCost: Math.round(wordCount * ESTIMATED_COST_PER_WORD * 100) / 100
  };
  return { closedSessions, bill };
}

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>(() => loadProjects());
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => loadSelectedId());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
    } catch {
      // ignore quota errors
    }
  }, [projects]);

  useEffect(() => {
    try {
      if (selectedProjectId) localStorage.setItem(SELECTED_KEY, selectedProjectId);
      else localStorage.removeItem(SELECTED_KEY);
    } catch {
      // ignore quota errors
    }
  }, [selectedProjectId]);

  // A project must be finished within 7 days; past that the system closes it
  // and bills it from whatever it recorded, rather than letting it run forever.
  const sweepExpired = useCallback(() => {
    setProjects((prev) => {
      const now = Date.now();
      let changed = false;
      const swept = prev.map((p) => {
        if (p.status !== 'active' || now < projectExpiresAt(p)) return p;
        changed = true;
        const { closedSessions, bill } = buildBill(p, p.transcripts, now);
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

  const startSession = (sourceLang: string, targetLang: string) => {
    if (!currentProject || activeSession) return;
    const session: ProjectSession = {
      id: `sess_${Date.now()}`,
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

  // Mirrors the live server buffer into the selected project, so each project
  // keeps its own transcript and its own bill.
  const saveTranscripts = useCallback((projectId: string, transcripts: TranscriptItem[]) => {
    setProjects((prev) => prev.map((p: Project) => (p.id === projectId ? { ...p, transcripts } : p)));
  }, []);

  const finishProject = (transcripts: TranscriptItem[]): Project | undefined => {
    if (!currentProject) return undefined;

    const now = Date.now();
    const { closedSessions, bill } = buildBill(currentProject, transcripts, now);
    const finished: Project = {
      ...currentProject,
      status: 'ended',
      sessions: closedSessions,
      transcripts,
      endedAt: now,
      bill
    };

    setProjects((prev) => prev.map((p: Project) => (p.id === currentProject.id ? finished : p)));
    setSelectedProjectId(null);

    return finished;
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
    endSession,
    saveTranscripts,
    finishProject
  };
}
