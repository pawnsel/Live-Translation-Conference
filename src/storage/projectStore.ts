import type { Project } from '../types';

// Every write to project storage goes through here, and every write reports
// whether it worked. The old code swallowed failures in a bare catch, so a
// full disk quota looked exactly like a successful recording.
//
// Nothing in this interface knows about localStorage. The database phase adds
// a second adapter and changes the default below; `PersistResult` gains
// reasons ('network', 'auth') and the banner's copy follows. Everything else
// — the hook, the banner, the backup button — is untouched by that change.

export const STORAGE_KEY = 'ai_translate_projects';
export const SELECTED_KEY = 'ai_translate_selected_project';

export type PersistFailureReason = 'quota' | 'unavailable' | 'unknown';

export type PersistResult = { ok: true } | { ok: false; reason: PersistFailureReason; message: string };

export interface ProjectStore {
  loadProjects(): Project[];
  saveProjects(projects: Project[]): PersistResult;
  loadSelectedId(): string | null;
  saveSelectedId(id: string | null): PersistResult;
}

function isQuotaError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Browsers disagree on the name, and Firefox historically used a code.
  return (
    error.name === 'QuotaExceededError' ||
    error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    (error as { code?: number }).code === 22
  );
}

function toFailure(error: unknown): PersistResult {
  const message = error instanceof Error ? error.message : String(error);
  if (isQuotaError(error)) {
    return { ok: false, reason: 'quota', message };
  }
  return { ok: false, reason: 'unknown', message };
}

export function createLocalStorageProjectStore(storage?: Storage): ProjectStore {
  const unavailable = (): PersistResult => ({
    ok: false,
    reason: 'unavailable',
    message: 'localStorage is not available in this browser context'
  });

  return {
    loadProjects() {
      if (!storage) return [];
      try {
        const stored = storage.getItem(STORAGE_KEY);
        const parsed: Project[] = stored ? JSON.parse(stored) : [];
        // Projects saved before per-project transcripts or ASR sessions
        // existed have neither field yet.
        return parsed.map((p) => ({ ...p, transcripts: p.transcripts || [], asrSessionId: p.asrSessionId ?? null }));
      } catch {
        return [];
      }
    },
    saveProjects(projects) {
      if (!storage) return unavailable();
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(projects));
        return { ok: true };
      } catch (error) {
        return toFailure(error);
      }
    },
    loadSelectedId() {
      if (!storage) return null;
      try {
        return storage.getItem(SELECTED_KEY);
      } catch {
        return null;
      }
    },
    saveSelectedId(id) {
      if (!storage) return unavailable();
      try {
        if (id) storage.setItem(SELECTED_KEY, id);
        else storage.removeItem(SELECTED_KEY);
        return { ok: true };
      } catch (error) {
        return toFailure(error);
      }
    }
  };
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    // Some browsers throw on the accessor itself when site data is blocked.
    return undefined;
  }
}

// Resolved lazily per call rather than captured at module load: the test
// suite replaces window.localStorage after this module is imported.
export const localStorageProjectStore: ProjectStore = {
  loadProjects: () => createLocalStorageProjectStore(safeStorage()).loadProjects(),
  saveProjects: (p) => createLocalStorageProjectStore(safeStorage()).saveProjects(p),
  loadSelectedId: () => createLocalStorageProjectStore(safeStorage()).loadSelectedId(),
  saveSelectedId: (id) => createLocalStorageProjectStore(safeStorage()).saveSelectedId(id)
};
