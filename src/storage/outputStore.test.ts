// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_OUTPUT_PREFS, OUTPUT_PREFS_KEY, loadOutputPrefs, saveOutputPrefs } from './outputStore';

describe('outputStore', () => {
  beforeEach(() => localStorage.clear());

  it('starts from the defaults: bottom-centre, 4% up, 80% wide, unlocked', () => {
    expect(loadOutputPrefs()).toEqual({ x: 50, y: 96, widthPct: 80, locked: false });
    expect(DEFAULT_OUTPUT_PREFS).toEqual({ x: 50, y: 96, widthPct: 80, locked: false });
  });

  it('round-trips what was saved', () => {
    saveOutputPrefs({ x: 42.5, y: 70, widthPct: 65, locked: true });
    expect(loadOutputPrefs()).toEqual({ x: 42.5, y: 70, widthPct: 65, locked: true });
  });

  it('falls back to defaults for unreadable storage', () => {
    localStorage.setItem(OUTPUT_PREFS_KEY, '{not json');
    expect(loadOutputPrefs()).toEqual(DEFAULT_OUTPUT_PREFS);
  });

  it('repairs each bad field on its own', () => {
    localStorage.setItem(OUTPUT_PREFS_KEY, JSON.stringify({ x: 'left', y: 250, widthPct: 5, locked: 'yes' }));
    expect(loadOutputPrefs()).toEqual({ x: 50, y: 96, widthPct: 80, locked: false });
  });
});
