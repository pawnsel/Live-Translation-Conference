// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  emptyGlossary,
  GLOSSARY_STORAGE_KEY,
  glossaryToVocabulary,
  loadGlossary,
  saveGlossary
} from './glossary';

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

  it('falls back to an empty section when a section deserializes to a non-object shape', () => {
    localStorage.setItem(
      GLOSSARY_STORAGE_KEY,
      JSON.stringify({
        protected_terms: 'not an object',
        person_names: ['also', 'not', 'an', 'object'],
        thai_corrections: { ok: 'fine' }
      })
    );
    expect(loadGlossary()).toEqual({
      protected_terms: {},
      person_names: {},
      thai_corrections: { ok: 'fine' }
    });
  });

  it('falls back to an empty section when a section has non-string values', () => {
    localStorage.setItem(
      GLOSSARY_STORAGE_KEY,
      JSON.stringify({
        protected_terms: { term: 123 },
        person_names: {},
        thai_corrections: {}
      })
    );
    expect(loadGlossary()).toEqual(emptyGlossary());
  });
});

describe('glossaryToVocabulary', () => {
  it('takes the source-language side of every section', () => {
    const vocab = glossaryToVocabulary({
      protected_terms: { 'ธรรมาภิบาล': 'governance' },
      person_names: { 'สมชาย': 'Somchai' },
      // The key is the mis-hearing to avoid; the value is the correct Thai
      // form the recogniser should be biased toward.
      thai_corrections: { 'ครับผม': 'ครับ' }
    });
    expect(vocab).toEqual(['ธรรมาภิบาล', 'สมชาย', 'ครับ']);
  });

  it('drops blanks and duplicates', () => {
    const vocab = glossaryToVocabulary({
      protected_terms: { 'ประชุม': 'meeting', '   ': 'blank' },
      person_names: { ' ประชุม ': 'dupe after trim' },
      thai_corrections: {}
    });
    expect(vocab).toEqual(['ประชุม']);
  });

  it('returns nothing for an empty glossary', () => {
    expect(glossaryToVocabulary(emptyGlossary())).toEqual([]);
  });
});
