import { describe, expect, it } from 'vitest';
import { captionsReducer, initialCaptionState, selectCaptions } from './captions';

describe('captionsReducer + selectCaptions', () => {
  it('adds a caption and returns it sorted by seq', () => {
    let state = captionsReducer(initialCaptionState, {
      kind: 'add',
      seq: 1,
      sourceText: 'b',
      targetText: 'B',
      sourceLang: 'th',
      targetLang: 'en',
      latencyMs: 100
    });
    state = captionsReducer(state, {
      kind: 'add',
      seq: 0,
      sourceText: 'a',
      targetText: 'A',
      sourceLang: 'th',
      targetLang: 'en',
      latencyMs: 50
    });

    const captions = selectCaptions(state);
    expect(captions.map((c) => c.seq)).toEqual([0, 1]);
    expect(captions[0]).toMatchObject({ sourceText: 'a', targetText: 'A', latencyMs: 50, isEdited: false });
  });

  it('lets an edit override the target text without touching the source', () => {
    let state = captionsReducer(initialCaptionState, {
      kind: 'add',
      seq: 0,
      sourceText: 'a',
      targetText: 'A',
      sourceLang: 'th',
      targetLang: 'en',
      latencyMs: 50
    });
    state = captionsReducer(state, { kind: 'edit', seq: 0, targetText: 'A (corrected)' });

    const [caption] = selectCaptions(state);
    expect(caption.sourceText).toBe('a');
    expect(caption.targetText).toBe('A (corrected)');
    expect(caption.isEdited).toBe(true);
  });

  it('reset clears everything back to the initial state', () => {
    let state = captionsReducer(initialCaptionState, {
      kind: 'add',
      seq: 0,
      sourceText: 'a',
      targetText: 'A',
      sourceLang: 'th',
      targetLang: 'en',
      latencyMs: 50
    });
    state = captionsReducer(state, { kind: 'reset' });
    expect(state).toEqual(initialCaptionState);
    expect(selectCaptions(state)).toEqual([]);
  });
});
