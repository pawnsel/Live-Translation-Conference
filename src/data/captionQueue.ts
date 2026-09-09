/** A serial, retrying outbox for closed captions.
 *
 *  A caption is written the moment it closes, so a dropped connection during
 *  a meeting would otherwise cost a sentence and raise the banner for a blip
 *  that fixes itself a second later. The write is an upsert keyed by
 *  (session_id, seq), so retrying is safe: a send that timed out but actually
 *  landed does not produce a duplicate.
 *
 *  Serial on purpose. Captions are numbered and read back in order, and
 *  parallel sends would let a later sentence overtake an earlier one.
 */

import type { TranscriptItem } from '../types';

export interface CaptionQueueOptions {
  send: (sessionId: string, item: TranscriptItem) => Promise<void>;
  /** Called once per caption that never landed, after every retry failed. */
  onFailure: (error: unknown) => void;
  /** Waits between attempts. Its length is how many retries there are. */
  delaysMs?: number[];
}

const DEFAULT_DELAYS = [500, 2000, 5000];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createCaptionQueue({ send, onFailure, delaysMs = DEFAULT_DELAYS }: CaptionQueueOptions) {
  const queue: Array<{ sessionId: string; item: TranscriptItem }> = [];
  let draining: Promise<void> | null = null;

  async function deliver(entry: { sessionId: string; item: TranscriptItem }) {
    for (let attempt = 0; ; attempt++) {
      try {
        await send(entry.sessionId, entry.item);
        return;
      } catch (error) {
        if (attempt >= delaysMs.length) {
          // Give up on this one rather than blocking every caption behind it.
          // onFailure raises the banner, so this is a reported loss, never a
          // silent one.
          onFailure(error);
          return;
        }
        await wait(delaysMs[attempt]);
      }
    }
  }

  async function drain() {
    while (queue.length > 0) {
      await deliver(queue[0]);
      queue.shift();
    }
    draining = null;
  }

  return {
    enqueue(sessionId: string, item: TranscriptItem) {
      queue.push({ sessionId, item });
      draining ||= drain();
    },
    /** Waits for everything queued so far. Called when a session ends, so the
     *  last sentences are on the record before the operator moves on. */
    async flush() {
      while (draining) await draining;
    },
    pending() {
      return queue.length;
    }
  };
}
