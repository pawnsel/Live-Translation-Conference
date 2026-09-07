export interface ReorderQueue<T> {
  push(seq: number, item: T): void;
}

// Applies items in strictly increasing seq order (starting at 0), holding
// anything that arrives ahead of its turn until the gap is filled. Each
// chunk sent by useGeminiCapture gets one seq; its Gemini response can come
// back out of order (a later, shorter chunk finishing first), and this is
// what keeps captions appearing in the order they were spoken.
export function createReorderQueue<T>(onInOrder: (item: T) => void): ReorderQueue<T> {
  let nextSeq = 0;
  const pending = new Map<number, T>();

  return {
    push(seq: number, item: T): void {
      if (seq < nextSeq) return; // stale/duplicate — already emitted
      if (seq > nextSeq) {
        pending.set(seq, item);
        return;
      }
      onInOrder(item);
      nextSeq++;
      while (pending.has(nextSeq)) {
        const next = pending.get(nextSeq)!;
        pending.delete(nextSeq);
        onInOrder(next);
        nextSeq++;
      }
    }
  };
}
