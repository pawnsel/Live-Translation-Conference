// How long to wait before the next attempt to reopen the capture socket.
//
// There is deliberately no attempt limit: a conference outlives any fixed
// budget, and the old flat 800 ms × 5 cap meant about five seconds of Gemini
// trouble ended a two-hour session for good. The operator decides when a
// session is over; until then this keeps trying, backing off so a dead
// server is not hammered.
export const RECONNECT_BASE_DELAY_MS = 800;
export const RECONNECT_MAX_DELAY_MS = 10000;

export function reconnectDelayMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** exponent, RECONNECT_MAX_DELAY_MS);
}
