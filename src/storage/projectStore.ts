/** Which project is open, remembered per device.
 *
 *  Everything else moved to Postgres (src/data/projectsRepo.ts). This one
 *  stays local on purpose: it is UI state, not data. Two screens signed in as
 *  the same person should each keep their own open project rather than fight
 *  over one shared value.
 */

import type { PersistResult } from '../data/persistError';
import { readSetting, safeStorage, writeSetting } from './safeStorage';

export const SELECTED_KEY = 'ai_translate_selected_project';

export function loadSelectedId(): string | null {
  return readSetting(SELECTED_KEY);
}

export function saveSelectedId(id: string | null): PersistResult {
  if (!safeStorage()) {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'localStorage is not available in this browser context'
    };
  }
  // Losing which project was open is a cosmetic failure — the project itself
  // is safe in the database — so this does not raise the banner.
  return writeSetting(SELECTED_KEY, id)
    ? { ok: true }
    : { ok: false, reason: 'unknown', message: 'could not write to localStorage' };
}
