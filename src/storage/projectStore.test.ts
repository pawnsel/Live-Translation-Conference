import { describe, expect, it } from 'vitest';
import { createLocalStorageProjectStore, STORAGE_KEY } from './projectStore';
import type { Project } from '../types';

class MemoryStorage implements Storage {
  store = new Map<string, string>();
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
    this.store.set(key, value);
  }
}

// asrSessionId: null (not omitted) because loadProjects() unconditionally
// normalizes it on every load, including a project saved this way; omitting
// it here would make the round-trip assertion below fail on that
// normalization alone, not on an actual persistence bug.
const project = (): Project => ({
  id: 'p1',
  name: 'Test',
  status: 'active',
  sessions: [],
  transcripts: [],
  createdAt: 1,
  asrSessionId: null
});

describe('localStorage project store', () => {
  it('round-trips projects', () => {
    const store = createLocalStorageProjectStore(new MemoryStorage());
    expect(store.saveProjects([project()])).toEqual({ ok: true });
    expect(store.loadProjects()).toEqual([project()]);
  });

  it('reports a quota failure instead of swallowing it', () => {
    const storage = new MemoryStorage();
    storage.setItem = () => {
      const err = new Error('exceeded');
      err.name = 'QuotaExceededError';
      throw err;
    };
    const result = createLocalStorageProjectStore(storage).saveProjects([project()]);
    expect(result).toMatchObject({ ok: false, reason: 'quota' });
  });

  it('reports storage that is switched off entirely', () => {
    const storage = new MemoryStorage();
    storage.setItem = () => {
      throw new Error('access denied');
    };
    const result = createLocalStorageProjectStore(storage).saveProjects([project()]);
    expect(result).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('falls back to an empty list on corrupt stored JSON', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, '{not json');
    expect(createLocalStorageProjectStore(storage).loadProjects()).toEqual([]);
  });

  it('backfills fields that predate per-project transcripts', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify([{ id: 'p1', name: 'Old', status: 'active', sessions: [], createdAt: 1 }]));
    const [loaded] = createLocalStorageProjectStore(storage).loadProjects();
    expect(loaded.transcripts).toEqual([]);
    expect(loaded.asrSessionId).toBeNull();
  });

  it('reports unavailable when there is no storage at all', () => {
    const store = createLocalStorageProjectStore(undefined);
    expect(store.loadProjects()).toEqual([]);
    expect(store.saveProjects([project()])).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});
