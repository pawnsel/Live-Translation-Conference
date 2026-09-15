/** Where the caption bar sits on the Output stage, how wide it is, and
 *  whether it is locked — per device, same spirit as micStore: the layout is
 *  tuned to one room's projector and one OBS scene. */

import { readSetting, writeSetting } from './safeStorage';

export const OUTPUT_PREFS_KEY = 'ai_translate_output_prefs';
export const MIN_BAR_WIDTH_PCT = 30;
export const MAX_BAR_WIDTH_PCT = 100;

export interface OutputPrefs {
  /** Bar centre, % of stage width. */
  x: number;
  /** Bar bottom edge, % of stage height. */
  y: number;
  widthPct: number;
  /** Dragging disabled — set before going live. */
  locked: boolean;
}

export const DEFAULT_OUTPUT_PREFS: OutputPrefs = { x: 50, y: 96, widthPct: 80, locked: false };

function numberIn(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function loadOutputPrefs(): OutputPrefs {
  const raw = readSetting(OUTPUT_PREFS_KEY);
  if (!raw) return DEFAULT_OUTPUT_PREFS;
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return DEFAULT_OUTPUT_PREFS;
    parsed = value as Record<string, unknown>;
  } catch {
    return DEFAULT_OUTPUT_PREFS;
  }
  return {
    x: numberIn(parsed.x, 0, 100, DEFAULT_OUTPUT_PREFS.x),
    y: numberIn(parsed.y, 0, 100, DEFAULT_OUTPUT_PREFS.y),
    widthPct: numberIn(parsed.widthPct, MIN_BAR_WIDTH_PCT, MAX_BAR_WIDTH_PCT, DEFAULT_OUTPUT_PREFS.widthPct),
    locked: typeof parsed.locked === 'boolean' ? parsed.locked : DEFAULT_OUTPUT_PREFS.locked
  };
}

export function saveOutputPrefs(prefs: OutputPrefs): void {
  writeSetting(OUTPUT_PREFS_KEY, JSON.stringify(prefs));
}
