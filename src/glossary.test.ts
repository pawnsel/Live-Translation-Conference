// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyGlossary, GLOSSARY_STORAGE_KEY, loadGlossary, saveGlossary } from './glossary';

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

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { value: new FakeStorage(), configurable: true });
});

describe('loadGlossary', () => {
  it('returns an empty glossary when nothing is stored', () => {
    expect(loadGlossary()).toEqual(emptyGlossary());
  });

  it('round-trips a saved glossary', () => {
    const sections = {
      protected_terms: { ความดันโลหิตสูง: 'hypertension' },
      person_names: {},
      thai_corrections: {}
    };
    saveGlossary(sections);
    expect(loadGlossary()).toEqual(sections);
  });

  it('falls back to empty on corrupt stored JSON', () => {
    localStorage.setItem(GLOSSARY_STORAGE_KEY, '{not json');
    expect(loadGlossary()).toEqual(emptyGlossary());
  });
});
