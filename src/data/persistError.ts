/** One classification for every way a write can fail, so the banner can say
 *  something useful instead of "an error occurred".
 *
 *  'quota' and 'unavailable' survive from the localStorage era — the selected
 *  project id still lives there. 'network' and 'auth' are the database ones.
 */

export type PersistFailureReason = 'quota' | 'unavailable' | 'network' | 'auth' | 'unknown';

export type PersistResult =
  | { ok: true }
  | { ok: false; reason: PersistFailureReason; message: string };

export class PersistError extends Error {
  reason: PersistFailureReason;

  constructor(reason: PersistFailureReason, message: string) {
    super(message);
    this.name = 'PersistError';
    this.reason = reason;
  }
}

/** RLS refusals arrive as Postgres 42501, and an expired session as a JWT
 *  message. Both mean the same thing to the operator: sign in again. */
function isAuthFailure(code: string | undefined, message: string): boolean {
  if (code === '42501' || code === 'PGRST301') return true;
  return /jwt|token|not authenticated|permission denied/i.test(message);
}

export function toPersistError(error: unknown): PersistError {
  if (error instanceof PersistError) return error;

  // supabase-js surfaces a dead connection as a TypeError from fetch.
  if (error instanceof TypeError) {
    return new PersistError('network', error.message);
  }

  const asRecord = (error ?? {}) as { message?: unknown; code?: unknown };
  const message =
    typeof asRecord.message === 'string' ? asRecord.message : String(error ?? 'unknown error');
  const code = typeof asRecord.code === 'string' ? asRecord.code : undefined;

  if (/failed to fetch|network/i.test(message)) return new PersistError('network', message);
  if (isAuthFailure(code, message)) return new PersistError('auth', message);
  return new PersistError('unknown', message);
}
