/** Which project is open, remembered per device.
 *
 *  Everything else moved to Postgres (src/data/projectsRepo.ts). This one
 *  stays local on purpose: it is UI state, not data. Two screens signed in as
 *  the same person should each keep their own open project rather than fight
 *  over one shared value.
 */

import type { PersistResult } from '../data/persistError';

export const SELECTED_KEY = 'ai_translate_selected_project';

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    // Some browsers throw on the accessor itself when site data is blocked.
    return undefined;
  }
}

export function loadSelectedId(): string | null {
  try {
    return safeStorage()?.getItem(SELECTED_KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveSelectedId(id: string | null): PersistResult {
  const storage = safeStorage();
  if (!storage) {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'localStorage is not available in this browser context'
    };
  }
  try {
    if (id) storage.setItem(SELECTED_KEY, id);
    else storage.removeItem(SELECTED_KEY);
    return { ok: true };
  } catch (error) {
    // Losing which project was open is a cosmetic failure — the project
    // itself is safe in the database — so this does not raise the banner.
    return { ok: false, reason: 'unknown', message: String(error) };
  }
}
