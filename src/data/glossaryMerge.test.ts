import { describe, expect, it } from 'vitest';
import { emptyGlossary, type GlossarySections } from '../glossary';
import { mergeGlossary } from './glossaryMerge';

function sections(overrides: Partial<GlossarySections>): GlossarySections {
  return { ...emptyGlossary(), ...overrides };
}

describe('mergeGlossary', () => {
  it('returns an empty glossary when there is nothing to merge', () => {
    expect(mergeGlossary([], emptyGlossary())).toEqual(emptyGlossary());
  });

  it('combines terms from several shared lists', () => {
    const names = sections({ person_names: { 'สมชาย': 'Somchai' } });
    const terms = sections({ protected_terms: { 'ภาควิชา': 'Department' } });

    const merged = mergeGlossary([names, terms], emptyGlossary());

    expect(merged.person_names).toEqual({ 'สมชาย': 'Somchai' });
    expect(merged.protected_terms).toEqual({ 'ภาควิชา': 'Department' });
  });

  it('merges sections independently — a term in one never leaks into another', () => {
    const shared = sections({ person_names: { 'ก': 'A' } });
    const own = sections({ protected_terms: { 'ข': 'B' } });

    const merged = mergeGlossary([shared], own);

    expect(merged.person_names).toEqual({ 'ก': 'A' });
    expect(merged.protected_terms).toEqual({ 'ข': 'B' });
    expect(merged.thai_corrections).toEqual({});
    expect(merged.en_th_corrections).toEqual({});
  });

  it('applies shared lists in order — a later list wins over an earlier one', () => {
    const first = sections({ person_names: { 'สมชาย': 'Somchai' } });
    const second = sections({ person_names: { 'สมชาย': 'Somchai Jaidee' } });

    expect(mergeGlossary([first, second], emptyGlossary()).person_names).toEqual({
      'สมชาย': 'Somchai Jaidee'
    });
  });

  // The rule that matters: an operator correcting a wrong shared term during a
  // live meeting must win, or the correction is useless.
  it("lets the project's own term override a shared one", () => {
    const shared = sections({ person_names: { 'สมชาย': 'Somchai' } });
    const own = sections({ person_names: { 'สมชาย': 'Dr. Somchai' } });

    expect(mergeGlossary([shared], own).person_names).toEqual({ 'สมชาย': 'Dr. Somchai' });
  });

  it('does not mutate its inputs', () => {
    const shared = sections({ person_names: { 'ก': 'A' } });
    const own = sections({ person_names: { 'ก': 'B' } });

    mergeGlossary([shared], own);

    expect(shared.person_names).toEqual({ 'ก': 'A' });
    expect(own.person_names).toEqual({ 'ก': 'B' });
  });
});
