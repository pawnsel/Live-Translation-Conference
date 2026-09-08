import { describe, expect, it } from 'vitest';
import { chunkTranscript, SUMMARY_CHUNK_CHARS } from './summaryChunks';
import type { TranscriptLine } from './gemini';

const line = (n: number, chars = 10): TranscriptLine => ({
  sourceText: 'a'.repeat(chars),
  targetText: `t${n}`
});

describe('chunkTranscript', () => {
  it('returns no chunks for an empty transcript', () => {
    expect(chunkTranscript([])).toEqual([]);
  });

  it('keeps a short transcript in a single chunk', () => {
    const lines = [line(1), line(2), line(3)];
    expect(chunkTranscript(lines)).toEqual([lines]);
  });

  it('splits once the character budget is exceeded', () => {
    const lines = [line(1, 40), line(2, 40), line(3, 40)];
    const chunks = chunkTranscript(lines, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(lines);
  });

  it('never splits a single line across two chunks', () => {
    const chunks = chunkTranscript([line(1, 500), line(2, 10)], 100);
    expect(chunks[0]).toEqual([line(1, 500)]);
    expect(chunks[1]).toEqual([line(2, 10)]);
  });

  it('preserves order and loses nothing', () => {
    const lines = Array.from({ length: 50 }, (_, i) => line(i, 300));
    expect(chunkTranscript(lines, 1000).flat()).toEqual(lines);
  });

  it('defaults to the shared chunk budget', () => {
    const lines = Array.from({ length: 200 }, (_, i) => line(i, 200));
    const chunks = chunkTranscript(lines);
    for (const chunk of chunks) {
      const chars = chunk.reduce((n, l) => n + l.sourceText.length + l.targetText.length, 0);
      // A chunk may exceed the budget only when it holds a single oversized line.
      expect(chars <= SUMMARY_CHUNK_CHARS || chunk.length === 1).toBe(true);
    }
  });
});
