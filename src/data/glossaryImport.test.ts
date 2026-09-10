import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_TERM_LENGTH, parseGlossaryFile, toGlossaryFile } from './glossaryImport';

const json = (value: unknown) => JSON.stringify(value);

describe('parseGlossaryFile — flat form', () => {
  // The shape the operator asked for: a bare map of term to translation,
  // which says nothing about which section it belongs to. The section comes
  // from whichever tab is open, exactly like the paste-from-Excel box.
  it('reads a flat file into the section that is open', () => {
    const result = parseGlossaryFile(json({ Kawin: 'กวิน', Somchai: 'สมชาย' }), 'en_th_corrections');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.form).toBe('flat');
    expect(result.sections.en_th_corrections).toEqual({ Kawin: 'กวิน', Somchai: 'สมชาย' });
    expect(result.sections.person_names).toEqual({});
    expect(result.total).toBe(2);
  });

  it('trims whitespace around both sides', () => {
    const result = parseGlossaryFile(json({ '  Kawin  ': '  กวิน  ' }), 'person_names');
    expect(result.status === 'ok' && result.sections.person_names).toEqual({ Kawin: 'กวิน' });
  });

  // A blank key or value cannot be acted on: the recogniser has nothing to
  // listen for, or the model has nothing to substitute.
  it('skips entries with a blank side and counts them as rejected', () => {
    const result = parseGlossaryFile(json({ Kawin: 'กวิน', '': 'x', Empty: '   ' }), 'person_names');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.total).toBe(1);
    expect(result.skipped).toBe(2);
  });
});

describe('parseGlossaryFile — sectioned form', () => {
  it('reads every section from one file', () => {
    const result = parseGlossaryFile(
      json({
        en_th_corrections: { Kawin: 'กวิน' },
        protected_terms: { ความดันโลหิตสูง: 'hypertension' }
      }),
      'person_names'
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.form).toBe('sectioned');
    expect(result.sections.en_th_corrections).toEqual({ Kawin: 'กวิน' });
    expect(result.sections.protected_terms).toEqual({ ความดันโลหิตสูง: 'hypertension' });
    // The open tab is ignored entirely — the file said where things go.
    expect(result.sections.person_names).toEqual({});
    expect(result.total).toBe(2);
  });

  it('accepts a file naming only some of the sections', () => {
    const result = parseGlossaryFile(json({ person_names: { 'นพ. สมชาย': 'Dr. Somchai' } }), 'protected_terms');
    expect(result.status === 'ok' && result.form).toBe('sectioned');
    expect(result.status === 'ok' && result.total).toBe(1);
  });

  // A key that looks like a section but is not one would silently drop every
  // term under it if it were treated as sectioned.
  it('treats an unknown object key as an error, not as a flat entry', () => {
    const result = parseGlossaryFile(json({ persons: { Kawin: 'กวิน' } }), 'person_names');
    expect(result.status).toBe('error');
    if (result.status === 'ok') return;
    expect(result.error).toContain('persons');
  });

  it('rejects a file mixing a section object with a loose term', () => {
    const result = parseGlossaryFile(json({ person_names: { a: 'b' }, Kawin: 'กวิน' }), 'person_names');
    expect(result.status).toBe('error');
  });
});

describe('parseGlossaryFile — rejections', () => {
  it('rejects text that is not JSON', () => {
    expect(parseGlossaryFile('Kawin, กวิน', 'person_names').status).toBe('error');
  });

  it('rejects a JSON array', () => {
    expect(parseGlossaryFile(json([{ term: 'Kawin' }]), 'person_names').status).toBe('error');
  });

  it('rejects a file with nothing usable in it', () => {
    const result = parseGlossaryFile(json({}), 'person_names');
    expect(result.status).toBe('error');
    if (result.status === 'ok') return;
    expect(result.error).toBeTruthy();
  });

  it('rejects a non-string value in the flat form', () => {
    expect(parseGlossaryFile(json({ Kawin: 42 }), 'person_names').status).toBe('error');
  });
});

describe('parseGlossaryFile — oversized terms', () => {
  // server/geminiLiveBridge.ts truncates at MAX_TERM_LENGTH before anything
  // reaches Gemini, so a longer term would be stored here and then silently
  // become a different term on the wire. Import keeps it but says so.
  it('flags a term longer than the model will accept', () => {
    const long = 'ก'.repeat(MAX_IMPORT_TERM_LENGTH + 1);
    const result = parseGlossaryFile(json({ [long]: 'x', Kawin: 'กวิน' }), 'person_names');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.tooLong).toEqual([long]);
    // Still imported — the operator decides, and a truncated term is not
    // worse than no term at all.
    expect(result.total).toBe(2);
  });
});

describe('toGlossaryFile', () => {
  it('writes the sectioned form so a file round-trips', () => {
    const sections = {
      protected_terms: {},
      person_names: { 'นพ. สมชาย': 'Dr. Somchai' },
      thai_corrections: {},
      en_th_corrections: { Kawin: 'กวิน' }
    };
    const round = parseGlossaryFile(toGlossaryFile(sections), 'protected_terms');
    expect(round.status).toBe('ok');
    if (round.status !== 'ok') return;
    expect(round.form).toBe('sectioned');
    expect(round.sections).toEqual(sections);
  });

  it('leaves out sections that hold nothing, so the file stays readable', () => {
    const text = toGlossaryFile({
      protected_terms: {},
      person_names: {},
      thai_corrections: {},
      en_th_corrections: { Kawin: 'กวิน' }
    });
    expect(Object.keys(JSON.parse(text))).toEqual(['en_th_corrections']);
  });
});
