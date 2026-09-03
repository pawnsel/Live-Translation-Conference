import { describe, expect, it, vi } from 'vitest';
import { createTokenBroker } from './asrTokenBroker';

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch');
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    } as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('createTokenBroker', () => {
  it('posts the password to /auth/login and returns the token', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { token: 'tok-1', expires_in: 43200 } }]);
    const broker = createTokenBroker({
      backendUrl: 'http://localhost:8765',
      password: 'hunter2',
      fetchImpl: impl,
      now: () => 1_000_000,
    });

    const result = await broker.getToken();

    expect(result.token).toBe('tok-1');
    expect(result.expiresAt).toBe(1_000_000 + 43200 * 1000);
    expect(calls[0].url).toBe('http://localhost:8765/auth/login');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ password: 'hunter2' });
  });

  it('reuses a cached token instead of logging in again', async () => {
    const { impl } = fakeFetch([{ status: 200, body: { token: 'tok-1', expires_in: 43200 } }]);
    const broker = createTokenBroker({
      backendUrl: 'http://localhost:8765',
      password: 'hunter2',
      fetchImpl: impl,
      now: () => 1_000_000,
    });

    await broker.getToken();
    const second = await broker.getToken();

    expect(second.token).toBe('tok-1');
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('logs in again once the cached token passes 80% of its life', async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { token: 'tok-1', expires_in: 100 } },
      { status: 200, body: { token: 'tok-2', expires_in: 100 } },
    ]);
    let clock = 0;
    const broker = createTokenBroker({
      backendUrl: 'http://localhost:8765',
      password: 'hunter2',
      fetchImpl: impl,
      now: () => clock,
    });

    await broker.getToken();
    clock = 81_000; // 81 s into a 100 s token
    const refreshed = await broker.getToken();

    expect(refreshed.token).toBe('tok-2');
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it('throws a message that does not leak the password on 401', async () => {
    const { impl } = fakeFetch([{ status: 401, body: { detail: 'invalid credentials' } }]);
    const broker = createTokenBroker({
      backendUrl: 'http://localhost:8765',
      password: 'wrong',
      fetchImpl: impl,
    });

    await expect(broker.getToken()).rejects.toThrow(/rejected the operator password/i);
    await expect(broker.getToken()).rejects.not.toThrow(/wrong/);
  });

  it('surfaces a connection failure as a distinct message', async () => {
    const impl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const broker = createTokenBroker({ backendUrl: 'http://localhost:8765', password: 'p', fetchImpl: impl });

    await expect(broker.getToken()).rejects.toThrow(/could not reach the ASR backend/i);
  });

  it('does not cache a failure', async () => {
    const { impl } = fakeFetch([
      { status: 401, body: {} },
      { status: 200, body: { token: 'tok-1', expires_in: 43200 } },
    ]);
    const broker = createTokenBroker({ backendUrl: 'http://localhost:8765', password: 'p', fetchImpl: impl });

    await expect(broker.getToken()).rejects.toThrow();
    await expect(broker.getToken()).resolves.toMatchObject({ token: 'tok-1' });
  });
});
