import { describe, expect, it } from 'vitest';
import {
  IDLE_STOP_MS,
  SESSION_MAX_MS,
  autoStopReason,
  type SessionClock
} from './sessionLimits';

const START = Date.UTC(2026, 8, 10, 9, 0, 0);

function clock(over: Partial<SessionClock> = {}): SessionClock {
  return { startedAt: START, lastSpeechAt: START, now: START, ...over };
}

describe('autoStopReason', () => {
  it('lets a session that is being spoken into run', () => {
    expect(autoStopReason(clock({ now: START + 60_000, lastSpeechAt: START + 59_000 }))).toBeNull();
  });

  // The runaway-cost case: a tab left streaming an empty room bills roughly
  // $2.20 an hour whether or not anybody is in it.
  it('stops a session nobody has spoken into for the idle limit', () => {
    expect(autoStopReason(clock({ now: START + IDLE_STOP_MS - 1 }))).toBeNull();
    expect(autoStopReason(clock({ now: START + IDLE_STOP_MS }))).toBe('idle');
  });

  // Silence is measured from the last speech, not from the start: a meeting
  // that has been running for hours is not idle if somebody just spoke.
  it('measures silence from the last thing said, not from the session start', () => {
    const twoHours = START + 2 * 60 * 60_000;
    expect(autoStopReason(clock({ now: twoHours, lastSpeechAt: twoHours - 1000 }))).toBeNull();
  });

  it('stops a session that has run past the maximum length', () => {
    const busy = { now: START + SESSION_MAX_MS, lastSpeechAt: START + SESSION_MAX_MS - 1000 };
    expect(autoStopReason(clock(busy))).toBe('max-duration');
  });

  it('leaves a session just under the maximum alone', () => {
    const busy = { now: START + SESSION_MAX_MS - 1, lastSpeechAt: START + SESSION_MAX_MS - 1000 };
    expect(autoStopReason(clock(busy))).toBeNull();
  });

  // Both limits can be past at once — a session left open overnight is both
  // idle and over-length. Naming the ceiling is the more useful of the two,
  // because it is the one the operator cannot avoid by speaking.
  it('reports the length ceiling when both limits are past', () => {
    expect(autoStopReason(clock({ now: START + SESSION_MAX_MS + IDLE_STOP_MS }))).toBe(
      'max-duration'
    );
  });

  // A session whose clock has not started yet (a caption arriving before
  // attach completes) must not be read as infinitely idle.
  it('treats a future timestamp as no elapsed time rather than as idle', () => {
    expect(autoStopReason(clock({ now: START - 5000 }))).toBeNull();
  });
});
