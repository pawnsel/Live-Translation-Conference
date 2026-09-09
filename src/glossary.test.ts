// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyEnThCorrections, emptyGlossary, glossaryToPairs, glossaryToVocabulary } from './glossary';

describe('glossaryToVocabulary', () => {
  it('takes the source-language side of every section', () => {
    const vocab = glossaryToVocabulary({
      protected_terms: { 'ธรรมาภิบาล': 'governance' },
      person_names: { 'สมชาย': 'Somchai' },
      // The key is the mis-hearing to avoid; the value is the correct Thai
      // form the recogniser should be biased toward.
      thai_corrections: { 'ครับผม': 'ครับ' },
      // English source, so here the key is what the recogniser must hear.
      en_th_corrections: { Kawin: 'กวิน' }
    });
    expect(vocab).toEqual(['ธรรมาภิบาล', 'สมชาย', 'ครับ', 'Kawin']);
  });

  it('drops blanks and duplicates', () => {
    const vocab = glossaryToVocabulary({
      protected_terms: { 'ประชุม': 'meeting', '   ': 'blank' },
      person_names: { ' ประชุม ': 'dupe after trim' },
      thai_corrections: {},
      en_th_corrections: {}
    });
    expect(vocab).toEqual(['ประชุม']);
  });

  it('returns nothing for an empty glossary', () => {
    expect(glossaryToVocabulary(emptyGlossary())).toEqual([]);
  });
});

describe('glossaryToPairs', () => {
  it('pairs terms with the translation they must keep', () => {
    expect(
      glossaryToPairs({
        protected_terms: { 'ธรรมาภิบาล': 'good governance' },
        person_names: { 'สมชาย': 'Somchai' },
        // Thai→Thai corrections steer the recogniser, not the translation.
        thai_corrections: { 'ครับผม': 'ครับ' },
        en_th_corrections: { Kawin: 'กวิน' }
      })
    ).toEqual([
      { term: 'ธรรมาภิบาล', translation: 'good governance' },
      { term: 'สมชาย', translation: 'Somchai' },
      { term: 'Kawin', translation: 'กวิน' }
    ]);
  });

  it('skips entries missing either side', () => {
    expect(
      glossaryToPairs({
        protected_terms: { 'ก': '', '  ': 'blank term' },
        person_names: {},
        thai_corrections: {},
        en_th_corrections: {}
      })
    ).toEqual([]);
  });
});

describe('applyEnThCorrections', () => {
  const withEnTh = (en_th_corrections: Record<string, string>) => ({
    ...emptyGlossary(),
    en_th_corrections
  });

  it('replaces a mapped English term with its Thai form', () => {
    expect(applyEnThCorrections('Kawin is presenting now', withEnTh({ Kawin: 'กวิน' }))).toBe(
      'กวิน is presenting now'
    );
  });

  it('matches regardless of the casing the model produced', () => {
    expect(applyEnThCorrections('kawin and KAWIN', withEnTh({ Kawin: 'กวิน' }))).toBe('กวิน and กวิน');
  });

  it('leaves a longer word that merely starts with the term alone', () => {
    expect(applyEnThCorrections('Kawinsky spoke', withEnTh({ Kawin: 'กวิน' }))).toBe('Kawinsky spoke');
  });

  it('prefers the longest matching term when one term prefixes another', () => {
    expect(
      applyEnThCorrections('Kawin Chai arrived', withEnTh({ Kawin: 'กวิน', 'Kawin Chai': 'กวินชัย' }))
    ).toBe('กวินชัย arrived');
  });

  it('treats regex metacharacters in a term as literal text', () => {
    expect(applyEnThCorrections('dose a.b now', withEnTh({ 'a.b': 'เอบี' }))).toBe('dose เอบี now');
    expect(applyEnThCorrections('dose axb now', withEnTh({ 'a.b': 'เอบี' }))).toBe('dose axb now');
  });

  it('does not re-replace text produced by an earlier replacement', () => {
    expect(applyEnThCorrections('Kawin', withEnTh({ Kawin: 'Somchai', Somchai: 'สมชาย' }))).toBe('Somchai');
  });

  it('ignores entries missing either side', () => {
    expect(applyEnThCorrections('Kawin here', withEnTh({ Kawin: '   ', '  ': 'กวิน' }))).toBe('Kawin here');
  });

  it('returns the text unchanged when nothing is mapped', () => {
    expect(applyEnThCorrections('Kawin is presenting now', emptyGlossary())).toBe('Kawin is presenting now');
  });
});
