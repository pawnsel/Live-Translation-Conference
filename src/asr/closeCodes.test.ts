import { describe, expect, it } from 'vitest';
import { describeCloseCode, describeErrorCode } from './closeCodes';

describe('describeCloseCode', () => {
  it('marks 4404 as a gone session that must not be retried', () => {
    const r = describeCloseCode(4404);
    expect(r.sessionGone).toBe(true);
    expect(r.retryable).toBe(false);
    expect(r.message).toMatch(/session/i);
  });

  it('marks 4401 as retryable after a fresh token', () => {
    const r = describeCloseCode(4401);
    expect(r.retryable).toBe(true);
    expect(r.sessionGone).toBe(false);
  });

  it('describes 4408 as another device already sending audio', () => {
    expect(describeCloseCode(4408).message).toMatch(/audio/i);
    expect(describeCloseCode(4408).retryable).toBe(false);
  });

  it('describes 4403, 4409 and 4429', () => {
    expect(describeCloseCode(4403).message).toBeTruthy();
    expect(describeCloseCode(4409).message).toBeTruthy();
    expect(describeCloseCode(4429).retryable).toBe(true);
  });

  it('treats a normal 1000 close as non-retryable and not an error', () => {
    expect(describeCloseCode(1000).retryable).toBe(false);
  });

  it('falls back for an unrecognised code without throwing', () => {
    expect(describeCloseCode(4999).message).toContain('4999');
  });
});

describe('describeErrorCode', () => {
  it('maps forbidden to an operator-role message', () => {
    expect(describeErrorCode('forbidden', 'raw')).toMatch(/operator/i);
  });

  it('uses the server message for an unmapped code', () => {
    expect(describeErrorCode('internal', 'boom')).toContain('boom');
  });
});
