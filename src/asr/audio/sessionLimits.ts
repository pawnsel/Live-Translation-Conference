/** When a recording session should stop itself.
 *
 *  Pure, so the two rules that decide whether a meeting keeps billing can be
 *  read and tested in one place rather than inferred from timer wiring in
 *  Admin.tsx.
 *
 *  Why this exists at all: a live session is what spends money on the Gemini
 *  key — roughly $2.20 an hour of wall clock, whether or not anybody is in the
 *  room — and nothing used to stop one. A tab left open on a Friday evening
 *  billed all weekend.
 *
 *  The server enforces its own ceiling too (SESSION_MAX_MS in
 *  server/geminiLiveBridge.ts) for the tab whose JavaScript has stalled. This
 *  is the friendly half: it stops the session properly, so the last sentence
 *  is flushed and the session record is closed, instead of the socket simply
 *  dying.
 */

/** No speech for this long and the session stops itself. Measured from the
 *  last thing anybody said, not from the start — a three-hour meeting is not
 *  idle. */
export const IDLE_STOP_MS = 15 * 60_000;

/** Hard ceiling on one session, matching SESSION_MAX_MS on the server. */
export const SESSION_MAX_MS = 6 * 60 * 60_000;

export interface SessionClock {
  /** When this recording session started. */
  startedAt: number;
  /** When speech was last seen — a closed caption or a streaming partial.
   *  NOT the last audio frame: frames flow continuously from an open
   *  microphone in a silent room, so they say nothing about whether anybody
   *  is speaking. */
  lastSpeechAt: number;
  now: number;
}

export type AutoStopReason = 'idle' | 'max-duration';

export function autoStopReason(clock: SessionClock): AutoStopReason | null {
  // Clamped at zero: a caption can be timestamped a moment ahead of the
  // session record on a machine whose clock ticked between the two, and a
  // negative elapsed time must never read as "past the limit".
  const elapsed = Math.max(0, clock.now - clock.startedAt);
  const silent = Math.max(0, clock.now - clock.lastSpeechAt);

  // Checked first when both apply: the ceiling is the one the operator cannot
  // talk their way out of, so it is the more useful thing to be told.
  if (elapsed >= SESSION_MAX_MS) return 'max-duration';
  if (silent >= IDLE_STOP_MS) return 'idle';
  return null;
}
