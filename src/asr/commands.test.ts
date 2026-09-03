import { describe, expect, it } from 'vitest';
import { buildCommand, glossaryAdd, setGate, setLanguages, setPaused } from './commands';

describe('buildCommand', () => {
  it('produces a complete v1 envelope with a unique id', () => {
    const { frame, id } = buildCommand('control.ping', 'sess_ab12', {});
    expect(frame.v).toBe(1);
    expect(frame.type).toBe('control.ping');
    expect(frame.session).toBe('sess_ab12');
    expect(typeof frame.ts).toBe('number');
    expect(frame.id).toBe(id);
    expect(id).toMatch(/^c-/);
  });

  it('sends ts in seconds, not milliseconds', () => {
    const { frame } = buildCommand('control.ping', 's', {});
    // The backend parses ts through the same model as every other frame and
    // treats it as epoch SECONDS.
    expect(frame.ts as number).toBeLessThan(1e11);
  });

  it('gives two commands different ids', () => {
    expect(buildCommand('control.ping', 's', {}).id).not.toBe(buildCommand('control.ping', 's', {}).id);
  });
});

describe('command helpers', () => {
  it('setLanguages sends exactly source and target', () => {
    const { frame } = setLanguages('s', 'th', 'en');
    expect(frame.type).toBe('control.set_languages');
    expect(frame.data).toEqual({ source: 'th', target: 'en' });
  });

  it('setPaused sends exactly paused', () => {
    expect(setPaused('s', true).frame.data).toEqual({ paused: true });
  });

  it('setGate sends exactly min_words and min_interval_ms', () => {
    expect(setGate('s', 3, 400).frame.data).toEqual({ min_words: 3, min_interval_ms: 400 });
  });

  it('glossaryAdd sends exactly section, abbr and full', () => {
    const { frame } = glossaryAdd('s', 'protected_terms', 'ความดันโลหิตสูง', 'hypertension');
    expect(frame.data).toEqual({ section: 'protected_terms', abbr: 'ความดันโลหิตสูง', full: 'hypertension' });
  });
});
