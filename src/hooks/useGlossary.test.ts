// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useGlossary } from './useGlossary';
import { emptyGlossary } from '../glossary';
import type { GlossaryList, GlossaryRepo } from '../data/glossaryRepo';

const sharedList: GlossaryList = {
  id: 'list-shared',
  name: 'ชื่อบุคคล',
  description: null,
  scope: 'shared',
  isDefault: true
};

const ownList: GlossaryList = {
  id: 'list-own',
  name: 'ศัพท์เฉพาะของโปรเจกต์นี้',
  description: null,
  scope: 'project',
  isDefault: false
};

function fakeRepo(overrides: Partial<GlossaryRepo> = {}): GlossaryRepo {
  return {
    listSharedLists: vi.fn().mockResolvedValue([sharedList]),
    loadProjectLists: vi.fn().mockResolvedValue({ own: ownList, subscribed: [sharedList] }),
    loadTerms: vi.fn().mockResolvedValue({
      'list-shared': { ...emptyGlossary(), person_names: { 'สมชาย': 'Somchai' } },
      'list-own': emptyGlossary()
    }),
    subscribeList: vi.fn().mockResolvedValue(undefined),
    unsubscribeList: vi.fn().mockResolvedValue(undefined),
    addTerm: vi.fn().mockResolvedValue(undefined),
    removeTerm: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

async function renderLoaded(repo: GlossaryRepo, projectId: string | null = 'proj-1') {
  const view = renderHook(() => useGlossary({ repo, projectId }));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  return view;
}

describe('useGlossary', () => {
  it('gives null sections and loads nothing when no project is selected', async () => {
    const repo = fakeRepo();
    const { result } = await renderLoaded(repo, null);

    expect(result.current.sections).toBeNull();
    expect(repo.loadProjectLists).not.toHaveBeenCalled();
  });

  it('merges the subscribed shared lists with the project list', async () => {
    const { result } = await renderLoaded(fakeRepo());

    expect(result.current.sections?.person_names).toEqual({ 'สมชาย': 'Somchai' });
    expect(result.current.subscribedIds.has('list-shared')).toBe(true);
    expect(result.current.sharedLists).toEqual([sharedList]);
  });

  // The rule from the design: a project term beats the shared one.
  it("lets the project's own term win over the shared list", async () => {
    const repo = fakeRepo({
      loadTerms: vi.fn().mockResolvedValue({
        'list-shared': { ...emptyGlossary(), person_names: { 'สมชาย': 'Somchai' } },
        'list-own': { ...emptyGlossary(), person_names: { 'สมชาย': 'Dr. Somchai' } }
      })
    });
    const { result } = await renderLoaded(repo);

    expect(result.current.sections?.person_names).toEqual({ 'สมชาย': 'Dr. Somchai' });
  });

  it("writes a new term to the project's own list and shows it immediately", async () => {
    const repo = fakeRepo();
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.addTerm('protected_terms', 'ภาควิชา', 'Department');
    });

    expect(repo.addTerm).toHaveBeenCalledWith('list-own', 'protected_terms', 'ภาควิชา', 'Department');
    expect(result.current.sections?.protected_terms).toEqual({ 'ภาควิชา': 'Department' });
  });

  it('removes a term from the project list', async () => {
    const repo = fakeRepo({
      loadTerms: vi.fn().mockResolvedValue({
        'list-shared': emptyGlossary(),
        'list-own': { ...emptyGlossary(), protected_terms: { 'ภาควิชา': 'Department' } }
      })
    });
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.removeTerm('protected_terms', 'ภาควิชา');
    });

    expect(repo.removeTerm).toHaveBeenCalledWith('list-own', 'protected_terms', 'ภาควิชา');
    expect(result.current.sections?.protected_terms).toEqual({});
  });

  it('unsubscribes a list that is currently on, and drops its terms', async () => {
    const repo = fakeRepo();
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.toggleList('list-shared');
    });

    expect(repo.unsubscribeList).toHaveBeenCalledWith('proj-1', 'list-shared');
    await waitFor(() => expect(result.current.subscribedIds.has('list-shared')).toBe(false));
    expect(result.current.sections?.person_names).toEqual({});
  });

  it('subscribes a list that is currently off', async () => {
    const repo = fakeRepo({
      loadProjectLists: vi.fn().mockResolvedValue({ own: ownList, subscribed: [] })
    });
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.toggleList('list-shared');
    });

    expect(repo.subscribeList).toHaveBeenCalledWith('proj-1', 'list-shared');
    await waitFor(() => expect(result.current.subscribedIds.has('list-shared')).toBe(true));
  });

  it('reports a failed term write instead of silently dropping it', async () => {
    const repo = fakeRepo({ addTerm: vi.fn().mockRejectedValue(new Error('permission denied')) });
    const { result } = await renderLoaded(repo);

    await act(async () => {
      await result.current.addTerm('person_names', 'ก', 'A');
    });

    expect(result.current.error).not.toBeNull();
  });
});
