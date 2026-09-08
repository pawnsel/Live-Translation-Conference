import { describe, expect, it } from 'vitest';
import { groupCaptionsIntoParagraphs, PARAGRAPH_GAP_SECONDS } from './historyParagraphs';
import type { TranscriptItem } from '../types';

function caption(seq: number, ts: number, extra: Partial<TranscriptItem> = {}): TranscriptItem {
  return {
    seq,
    sourceText: `source ${seq}`,
    targetText: `target ${seq}`,
    sourceLang: 'th',
    targetLang: 'en',
    ts,
    latencyMs: 0,
    isEdited: false,
    ...extra
  };
}

describe('groupCaptionsIntoParagraphs', () => {
  it('returns no paragraphs for no captions', () => {
    expect(groupCaptionsIntoParagraphs([])).toEqual([]);
  });

  it('keeps captions spoken close together in one paragraph', () => {
    const items = [caption(0, 1000), caption(1, 1002), caption(2, 1005)];
    const paragraphs = groupCaptionsIntoParagraphs(items);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].items.map((i) => i.seq)).toEqual([0, 1, 2]);
  });

  it('starts a new paragraph after a long pause', () => {
    const items = [caption(0, 1000), caption(1, 1000 + PARAGRAPH_GAP_SECONDS + 1), caption(2, 1000 + PARAGRAPH_GAP_SECONDS + 3)];
    const paragraphs = groupCaptionsIntoParagraphs(items);
    expect(paragraphs.map((p) => p.items.map((i) => i.seq))).toEqual([[0], [1, 2]]);
  });

  it('keeps a pause exactly at the threshold in the same paragraph', () => {
    const items = [caption(0, 1000), caption(1, 1000 + PARAGRAPH_GAP_SECONDS)];
    expect(groupCaptionsIntoParagraphs(items)).toHaveLength(1);
  });

  it('stamps each paragraph with the time of its first caption', () => {
    const items = [caption(0, 1000), caption(1, 1001), caption(2, 1000 + PARAGRAPH_GAP_SECONDS + 5)];
    const paragraphs = groupCaptionsIntoParagraphs(items);
    expect(paragraphs.map((p) => p.startTs)).toEqual([1000, 1000 + PARAGRAPH_GAP_SECONDS + 5]);
  });

  it('keys each paragraph by its first caption seq so React can track it', () => {
    const items = [caption(7, 1000), caption(8, 1000 + PARAGRAPH_GAP_SECONDS + 1)];
    expect(groupCaptionsIntoParagraphs(items).map((p) => p.key)).toEqual([7, 8]);
  });

  it('breaks a paragraph that has run long enough to be hard to read', () => {
    // Twenty captions one second apart: no pause ever breaks them, so only
    // the length cap can.
    const items = Array.from({ length: 20 }, (_, i) => caption(i, 1000 + i));
    const paragraphs = groupCaptionsIntoParagraphs(items);
    expect(paragraphs.length).toBeGreaterThan(1);
    expect(paragraphs.flatMap((p) => p.items.map((i) => i.seq))).toEqual(items.map((i) => i.seq));
  });
});
