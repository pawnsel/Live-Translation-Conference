import { describe, expect, it } from 'vitest';
import { createChunker } from './chunker';

function makeFrame(value: number, length = 100): Int16Array {
  return new Int16Array(length).fill(value);
}

const LOUD = 3000; // above the default silence RMS threshold
const SILENT = 0;

describe('createChunker', () => {
  it('cuts once trailing silence follows enough buffered speech', () => {
    const chunker = createChunker({ sampleRate: 1000, minSpeechMs: 200, silenceMs: 200, minChunkMs: 100, maxChunkMs: 10000 });

    expect(chunker.pushFrame(makeFrame(LOUD))).toBeNull(); // 100ms speech
    expect(chunker.pushFrame(makeFrame(LOUD))).toBeNull(); // 200ms speech total
    expect(chunker.pushFrame(makeFrame(SILENT))).toBeNull(); // 100ms silence
    const result = chunker.pushFrame(makeFrame(SILENT)); // 200ms silence total -> cut

    expect(result).not.toBeNull();
    expect(result!.length).toBe(400); // the 4 frames buffered before the cut
  });

  it('does not cut before the minimum speech duration, even with immediate silence', () => {
    const chunker = createChunker({ sampleRate: 1000, minSpeechMs: 300, silenceMs: 100, minChunkMs: 500, maxChunkMs: 10000 });

    expect(chunker.pushFrame(makeFrame(SILENT))).toBeNull();
    expect(chunker.pushFrame(makeFrame(SILENT))).toBeNull();
    // Only 200ms buffered, below both minSpeechMs and minChunkMs — flush
    // discards it rather than sending near-silence.
    expect(chunker.flush()).toBeNull();
  });

  it('hard-caps a continuous, pause-free chunk at maxChunkMs', () => {
    const chunker = createChunker({ sampleRate: 1000, minSpeechMs: 100000, silenceMs: 100000, minChunkMs: 100, maxChunkMs: 300 });

    expect(chunker.pushFrame(makeFrame(LOUD))).toBeNull(); // 100ms
    expect(chunker.pushFrame(makeFrame(LOUD))).toBeNull(); // 200ms
    const result = chunker.pushFrame(makeFrame(LOUD)); // 300ms -> hits the cap

    expect(result).not.toBeNull();
    expect(result!.length).toBe(300);
  });

  it('flush returns whatever is buffered above the minimum, as the end of speech', () => {
    const chunker = createChunker({ sampleRate: 1000, minSpeechMs: 500, silenceMs: 500, minChunkMs: 150, maxChunkMs: 10000 });

    chunker.pushFrame(makeFrame(LOUD)); // 100ms
    chunker.pushFrame(makeFrame(LOUD)); // 200ms — below minSpeechMs, so pushFrame itself never cut

    const flushed = chunker.flush();
    expect(flushed).not.toBeNull();
    expect(flushed!.length).toBe(200);
  });

  it('resets its buffer after a cut, so the next chunk starts empty', () => {
    const chunker = createChunker({ sampleRate: 1000, minSpeechMs: 100, silenceMs: 100, minChunkMs: 50, maxChunkMs: 10000 });

    chunker.pushFrame(makeFrame(LOUD));
    chunker.pushFrame(makeFrame(SILENT)); // cuts here (100ms speech, 100ms silence)

    // Immediately after the cut, a single 100ms silent frame is below both
    // minSpeechMs and minChunkMs, so nothing should be pending.
    expect(chunker.flush()).toBeNull();
  });
});
