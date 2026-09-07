import { describe, expect, it } from 'vitest';
import { createReorderQueue } from './reorderQueue';

describe('createReorderQueue', () => {
  it('emits items immediately when they arrive in order', () => {
    const emitted: string[] = [];
    const queue = createReorderQueue<string>((item) => emitted.push(item));
    queue.push(0, 'a');
    queue.push(1, 'b');
    expect(emitted).toEqual(['a', 'b']);
  });

  it('holds an out-of-order item until its predecessor arrives', () => {
    const emitted: string[] = [];
    const queue = createReorderQueue<string>((item) => emitted.push(item));
    queue.push(1, 'b');
    expect(emitted).toEqual([]);
    queue.push(0, 'a');
    expect(emitted).toEqual(['a', 'b']);
  });

  it('drains multiple buffered items once the gap is filled', () => {
    const emitted: number[] = [];
    const queue = createReorderQueue<number>((item) => emitted.push(item));
    queue.push(2, 20);
    queue.push(1, 10);
    queue.push(3, 30);
    expect(emitted).toEqual([]);
    queue.push(0, 0);
    expect(emitted).toEqual([0, 10, 20, 30]);
  });

  it('ignores a stale duplicate seq', () => {
    const emitted: number[] = [];
    const queue = createReorderQueue<number>((item) => emitted.push(item));
    queue.push(0, 1);
    queue.push(0, 999); // duplicate of an already-emitted seq
    expect(emitted).toEqual([1]);
  });
});
