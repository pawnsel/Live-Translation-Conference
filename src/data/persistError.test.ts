import { describe, expect, it } from 'vitest';
import { PersistError, toPersistError } from './persistError';

describe('toPersistError', () => {
  // 42501 is Postgres "insufficient privilege" — what an RLS policy refusal
  // looks like from the client. Telling the operator to sign in again is the
  // only useful advice, so it is 'auth', not 'unknown'.
  it('maps a Postgres permission error to auth', () => {
    const error = toPersistError({ message: 'permission denied', code: '42501' });
    expect(error.reason).toBe('auth');
  });

  it('maps an expired JWT to auth', () => {
    expect(toPersistError({ message: 'JWT expired' }).reason).toBe('auth');
  });

  it('maps a fetch failure to network', () => {
    expect(toPersistError(new TypeError('Failed to fetch')).reason).toBe('network');
  });

  it('falls back to unknown, keeping the original message', () => {
    const error = toPersistError({ message: 'something odd', code: 'XX000' });
    expect(error.reason).toBe('unknown');
    expect(error.message).toBe('something odd');
  });

  it('passes an existing PersistError through unchanged', () => {
    const original = new PersistError('auth', 'already classified');
    expect(toPersistError(original)).toBe(original);
  });

  it('handles a non-object thrown value', () => {
    expect(toPersistError('boom').message).toBe('boom');
  });
});
