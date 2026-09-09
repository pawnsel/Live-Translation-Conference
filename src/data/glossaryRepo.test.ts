import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from './testing/fakeSupabase';
import { createGlossaryRepo } from './glossaryRepo';

const sharedListRow = {
  id: 'list-shared',
  name: 'ชื่อบุคคล (อังกฤษ → ไทย)',
  description: 'รายชื่อผู้บริหาร',
  scope: 'shared' as const,
  is_default: true
};

const ownListRow = {
  id: 'list-own',
  name: 'ศัพท์เฉพาะของโปรเจกต์นี้',
  description: null,
  scope: 'project' as const,
  is_default: false
};

describe('glossaryRepo.listSharedLists', () => {
  it('reads every shared list, newest name order stable by created_at', async () => {
    const fake = createFakeSupabase([{ data: [sharedListRow] }]);

    const lists = await createGlossaryRepo(fake.client).listSharedLists();

    expect(fake.calls[0]).toMatchObject({
      table: 'glossary_lists',
      op: 'select',
      filters: [
        { kind: 'eq', column: 'scope', value: 'shared' },
        { kind: 'order', column: 'created_at', value: { ascending: true } }
      ]
    });
    expect(lists).toEqual([
      {
        id: 'list-shared',
        name: 'ชื่อบุคคล (อังกฤษ → ไทย)',
        description: 'รายชื่อผู้บริหาร',
        scope: 'shared',
        isDefault: true
      }
    ]);
  });
});

describe('glossaryRepo.loadProjectLists', () => {
  it("separates the project's own list from the shared lists it subscribes to", async () => {
    const fake = createFakeSupabase([
      { data: [ownListRow] },                                   // the own list
      { data: [{ list_id: 'list-shared', glossary_lists: sharedListRow }] } // subscriptions
    ]);

    const result = await createGlossaryRepo(fake.client).loadProjectLists('proj-1');

    expect(fake.calls[0]).toMatchObject({
      table: 'glossary_lists',
      filters: [
        { kind: 'eq', column: 'project_id', value: 'proj-1' },
        { kind: 'eq', column: 'scope', value: 'project' }
      ]
    });
    expect(fake.calls[1]).toMatchObject({
      table: 'project_glossary_lists',
      filters: [{ kind: 'eq', column: 'project_id', value: 'proj-1' }]
    });
    expect(result.own?.id).toBe('list-own');
    expect(result.subscribed.map((l) => l.id)).toEqual(['list-shared']);
  });

  // The trigger creates the own list, so this should never happen — but a
  // null return is far better than a crash if it somehow does.
  it('returns a null own list rather than throwing when none exists', async () => {
    const fake = createFakeSupabase([{ data: [] }, { data: [] }]);
    const result = await createGlossaryRepo(fake.client).loadProjectLists('proj-1');
    expect(result.own).toBeNull();
    expect(result.subscribed).toEqual([]);
  });
});

describe('glossaryRepo.loadTerms', () => {
  it('reads every requested list in one statement, grouped into sections', async () => {
    const fake = createFakeSupabase([
      {
        data: [
          { list_id: 'list-shared', section: 'person_names', term: 'สมชาย', translation: 'Somchai' },
          { list_id: 'list-own', section: 'protected_terms', term: 'ภาควิชา', translation: 'Dept' }
        ]
      }
    ]);

    const byList = await createGlossaryRepo(fake.client).loadTerms(['list-shared', 'list-own']);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      table: 'glossary_terms',
      op: 'select',
      filters: [{ kind: 'in', column: 'list_id', value: ['list-shared', 'list-own'] }]
    });
    expect(byList['list-shared'].person_names).toEqual({ 'สมชาย': 'Somchai' });
    expect(byList['list-own'].protected_terms).toEqual({ 'ภาควิชา': 'Dept' });
    // Every requested list gets an entry, even an empty one, so callers can
    // index without guarding.
    expect(byList['list-shared'].protected_terms).toEqual({});
  });

  it('issues no statement at all for an empty list of ids', async () => {
    const fake = createFakeSupabase();
    expect(await createGlossaryRepo(fake.client).loadTerms([])).toEqual({});
    expect(fake.calls).toHaveLength(0);
  });
});

describe('glossaryRepo subscriptions', () => {
  it('subscribes a project to a shared list', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await createGlossaryRepo(fake.client).subscribeList('proj-1', 'list-shared');
    expect(fake.calls[0]).toMatchObject({
      table: 'project_glossary_lists',
      op: 'upsert',
      payload: { project_id: 'proj-1', list_id: 'list-shared' }
    });
  });

  it('unsubscribes a project from a shared list', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await createGlossaryRepo(fake.client).unsubscribeList('proj-1', 'list-shared');
    expect(fake.calls[0]).toMatchObject({
      table: 'project_glossary_lists',
      op: 'delete',
      filters: [
        { kind: 'eq', column: 'project_id', value: 'proj-1' },
        { kind: 'eq', column: 'list_id', value: 'list-shared' }
      ]
    });
  });
});

describe('glossaryRepo terms', () => {
  it('upserts a term into the given list', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await createGlossaryRepo(fake.client).addTerm('list-own', 'person_names', ' สมชาย ', ' Somchai ');
    expect(fake.calls[0]).toMatchObject({
      table: 'glossary_terms',
      op: 'upsert',
      // Trimmed: a stray space would create a second, invisible entry that
      // never matches anything the recogniser hears.
      payload: {
        list_id: 'list-own',
        section: 'person_names',
        term: 'สมชาย',
        translation: 'Somchai'
      }
    });
  });

  it('removes a term from the given list', async () => {
    const fake = createFakeSupabase([{ data: null }]);
    await createGlossaryRepo(fake.client).removeTerm('list-own', 'person_names', 'สมชาย');
    expect(fake.calls[0]).toMatchObject({
      table: 'glossary_terms',
      op: 'delete',
      filters: [
        { kind: 'eq', column: 'list_id', value: 'list-own' },
        { kind: 'eq', column: 'section', value: 'person_names' },
        { kind: 'eq', column: 'term', value: 'สมชาย' }
      ]
    });
  });

  it('throws a classified error when a term write is refused', async () => {
    const fake = createFakeSupabase([{ error: { message: 'permission denied', code: '42501' } }]);
    await expect(
      createGlossaryRepo(fake.client).addTerm('list-shared', 'person_names', 'a', 'b')
    ).rejects.toMatchObject({ reason: 'auth' });
  });
});
