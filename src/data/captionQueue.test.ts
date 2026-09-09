import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCaptionQueue } from './captionQueue';
import type { TranscriptItem } from '../types';

function item(seq: number): TranscriptItem {
  return {
    seq,
    sourceText: 'ก',
    targetText: 'A',
    sourceLang: 'th',
    targetLang: 'en',
    ts: 1767225600,
    latencyMs: 10,
    isEdited: false
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createCaptionQueue', () => {
  it('sends one caption and empties', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const queue = createCaptionQueue({ send, onFailure: vi.fn() });

    queue.enqueue('sess-1', item(1));
    await queue.flush();

    expect(send).toHaveBeenCalledWith('sess-1', item(1));
    expect(queue.pending()).toBe(0);
  });

  // Order matters: captions are numbered, and a summary built from them out
  // of order reads as nonsense.
  it('sends captions in the order they were enqueued', async () => {
    const seen: number[] = [];
    const send = vi.fn().mockImplementation(async (_id: string, i: TranscriptItem) => {
      seen.push(i.seq);
    });
    const queue = createCaptionQueue({ send, onFailure: vi.fn() });

    queue.enqueue('sess-1', item(1));
    queue.enqueue('sess-1', item(2));
    queue.enqueue('sess-1', item(3));
    await queue.flush();

    expect(seen).toEqual([1, 2, 3]);
  });

  it('retries after a failure and succeeds without reporting anything', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const onFailure = vi.fn();
    const queue = createCaptionQueue({ send, onFailure, delaysMs: [10, 20] });

    queue.enqueue('sess-1', item(1));
    const flushed = queue.flush();
    await vi.advanceTimersByTimeAsync(10);
    await flushed;

    expect(send).toHaveBeenCalledTimes(2);
    // A blip that resolved is not the operator's problem.
    expect(onFailure).not.toHaveBeenCalled();
    expect(queue.pending()).toBe(0);
  });

  it('reports once and drops the caption when every attempt fails', async () => {
    const send = vi.fn().mockRejectedValue(new Error('offline'));
    const onFailure = vi.fn();
    const queue = createCaptionQueue({ send, onFailure, delaysMs: [10, 20] });

    queue.enqueue('sess-1', item(1));
    const flushed = queue.flush();
    await vi.advanceTimersByTimeAsync(30);
    await flushed;

    expect(send).toHaveBeenCalledTimes(3); // initial + two retries
    expect(onFailure).toHaveBeenCalledTimes(1);
    // Dropped rather than retried forever, so the captions behind it still
    // get through. onFailure has already told the operator.
    expect(queue.pending()).toBe(0);
  });

  it('keeps delivering later captions after one is given up on', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('a'))
      .mockResolvedValue(undefined);
    const onFailure = vi.fn();
    const queue = createCaptionQueue({ send, onFailure, delaysMs: [10, 20] });

    queue.enqueue('sess-1', item(1));
    queue.enqueue('sess-1', item(2));
    const flushed = queue.flush();
    await vi.advanceTimersByTimeAsync(30);
    await flushed;

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith('sess-1', item(2));
    expect(queue.pending()).toBe(0);
  });

  it('flush resolves immediately when there is nothing queued', async () => {
    const queue = createCaptionQueue({ send: vi.fn(), onFailure: vi.fn() });
    await expect(queue.flush()).resolves.toBeUndefined();
  });
});
