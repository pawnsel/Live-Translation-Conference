import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnyFrame } from './protocol';
import { captionsReducer, initialCaptionState, selectCaptions } from './captions';

function golden(name: string): AnyFrame {
  const path = join(process.cwd(), 'src/asr/__fixtures__/protocol', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as AnyFrame;
}

function apply(frames: AnyFrame[]) {
  return frames.reduce((s, frame) => captionsReducer(s, { kind: 'frame', frame }), initialCaptionState);
}

describe('captionsReducer', () => {
  it('appends a final caption with an empty translation', () => {
    const out = selectCaptions(apply([golden('caption_final')]));
    expect(out).toHaveLength(1);
    expect(out[0].seq).toBe(41);
    expect(out[0].sourceText).toBe('ยาพาราเซตามอลสองเม็ด');
    expect(out[0].targetText).toBe('');
    expect(out[0].sourceLang).toBe('th');
  });

  it('applies a target update to the caption with the matching seq', () => {
    const out = selectCaptions(apply([golden('caption_final'), golden('caption_target_update')]));
    expect(out[0].targetText).toBe('two paracetamol tablets');
    expect(out[0].latencyMs).toBe(981);
  });

  it('applies a target that arrives before its final', () => {
    const out = selectCaptions(apply([golden('caption_target_update'), golden('caption_final')]));
    expect(out).toHaveLength(1);
    expect(out[0].targetText).toBe('two paracetamol tablets');
  });

  it('ignores a target whose rev is lower than one already applied', () => {
    const high = golden('caption_target_update') as any;
    const stale = { ...high, data: { ...high.data, rev: 1, target_text: 'STALE' } };
    const out = selectCaptions(apply([golden('caption_final'), high, stale]));
    expect(out[0].targetText).toBe('two paracetamol tablets');
  });

  it('ignores a target whose rev equals the one already applied', () => {
    const first = golden('caption_target_update') as any;
    const duplicate = { ...first, data: { ...first.data, target_text: 'DUPLICATE' } };
    const out = selectCaptions(apply([golden('caption_final'), first, duplicate]));
    expect(out[0].targetText).toBe('two paracetamol tablets');
  });

  it('lets a target_partial be superseded by a higher-rev target_update', () => {
    const base = golden('caption_target_update') as any;
    const partial = { ...base, type: 'caption.target_partial', data: { ...base.data, rev: 1, target_text: 'two para' } };
    const out = selectCaptions(apply([golden('caption_final'), partial, base]));
    expect(out[0].targetText).toBe('two paracetamol tablets');
  });

  it('discards a target_partial that arrives after a higher-rev update', () => {
    const base = golden('caption_target_update') as any;
    const late = { ...base, type: 'caption.target_partial', data: { ...base.data, rev: 2, target_text: 'two para' } };
    const out = selectCaptions(apply([golden('caption_final'), base, late]));
    expect(out[0].targetText).toBe('two paracetamol tablets');
  });

  it('orders captions by seq regardless of arrival order', () => {
    const a = golden('caption_final') as any;
    const b = { ...a, seq: 12, data: { ...a.data, source_text: 'earlier' } };
    const out = selectCaptions(apply([a, b]));
    expect(out.map((c) => c.seq)).toEqual([12, 41]);
  });

  it('holds a partial as the interim line without appending it', () => {
    const state = apply([golden('caption_partial')]);
    expect(selectCaptions(state)).toHaveLength(0);
    expect(state.interim?.sourceText).toBe('ยาพาราเซตามอลสองเม็ด');
  });

  it('clears the interim line when its final arrives', () => {
    const state = apply([golden('caption_partial'), golden('caption_final')]);
    expect(state.interim).toBeNull();
    expect(selectCaptions(state)).toHaveLength(1);
  });

  it('ignores unknown frame types', () => {
    const unknown = { v: 1, type: 'caption.hologram', session: 's', ts: 1, seq: 41, data: {} } as unknown as AnyFrame;
    const out = selectCaptions(apply([golden('caption_final'), unknown]));
    expect(out).toHaveLength(1);
  });

  it('ignores non-caption frames it does not own', () => {
    const out = selectCaptions(apply([golden('caption_final'), golden('glossary_state')]));
    expect(out).toHaveLength(1);
  });

  it('applies a client-side edit and marks the caption edited', () => {
    let state = apply([golden('caption_final'), golden('caption_target_update')]);
    state = captionsReducer(state, { kind: 'edit', seq: 41, targetText: 'two paracetamol' });
    const out = selectCaptions(state);
    expect(out[0].targetText).toBe('two paracetamol');
    expect(out[0].isEdited).toBe(true);
  });

  it('keeps a client-side edit when a later server target arrives', () => {
    const base = golden('caption_target_update') as any;
    const later = { ...base, data: { ...base.data, rev: 9, target_text: 'SERVER REWRITE' } };
    let state = apply([golden('caption_final'), base]);
    state = captionsReducer(state, { kind: 'edit', seq: 41, targetText: 'operator wins' });
    state = captionsReducer(state, { kind: 'frame', frame: later });
    expect(selectCaptions(state)[0].targetText).toBe('operator wins');
  });

  it('resets to empty', () => {
    const state = captionsReducer(apply([golden('caption_final')]), { kind: 'reset' });
    expect(selectCaptions(state)).toHaveLength(0);
    expect(state.interim).toBeNull();
  });
});
