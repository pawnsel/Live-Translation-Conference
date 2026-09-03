import { describe, expect, it, vi } from 'vitest';
import { createOperatorTokenSource, mintSourceToken } from './tokens';

function jsonFetch(responses: Array<{ ok?: boolean; status?: number; body?: unknown; jsonThrows?: boolean }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch');
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: next.jsonThrows
        ? async () => {
            throw new SyntaxError("Unexpected token '<', \"<html>...\" is not valid JSON");
          }
        : async () => next.body,
    } as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('createOperatorTokenSource', () => {
  it('fetches a token from the Node broker', async () => {
    const { impl, calls } = jsonFetch([{ body: { token: 'op-1', expiresAt: 100_000 } }]);
    const source = createOperatorTokenSource({ fetchImpl: impl, now: () => 0 });

    expect(await source.get()).toBe('op-1');
    expect(calls[0].url).toBe('/api/asr/token');
    expect(calls[0].init?.method).toBe('POST');
  });

  it('caches until 80% of the remaining life has elapsed', async () => {
    const { impl } = jsonFetch([
      { body: { token: 'op-1', expiresAt: 100_000 } },
      { body: { token: 'op-2', expiresAt: 200_000 } },
    ]);
    let clock = 0;
    const source = createOperatorTokenSource({ fetchImpl: impl, now: () => clock });

    expect(await source.get()).toBe('op-1');
    clock = 79_000;
    expect(await source.get()).toBe('op-1');
    clock = 81_000;
    expect(await source.get()).toBe('op-2');
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it('reports the broker error message when the endpoint is unconfigured', async () => {
    const { impl } = jsonFetch([{ ok: false, status: 503, body: { error: 'ASR_OPERATOR_PASSWORD is not configured on the server' } }]);
    const source = createOperatorTokenSource({ fetchImpl: impl });

    await expect(source.get()).rejects.toThrow(/not configured/);
  });

  it('handles unparseable responses without a SyntaxError', async () => {
    const { impl } = jsonFetch([{ ok: false, status: 502, jsonThrows: true }]);
    const source = createOperatorTokenSource({ fetchImpl: impl });

    await expect(source.get()).rejects.toThrow(/Could not obtain an ASR token.*HTTP 502/);
  });
});

describe('mintSourceToken', () => {
  it('calls capture-link with the operator token and returns the source token', async () => {
    const { impl, calls } = jsonFetch([{ body: { token: 'src-1', url: 'capture.html?token=src-1', expires_in: 43200 } }]);

    const token = await mintSourceToken('http://localhost:8765', 'sess_ab12', 'op-1', impl);

    expect(token).toBe('src-1');
    expect(calls[0].url).toBe('http://localhost:8765/sessions/sess_ab12/capture-link');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer op-1');
  });

  it('reports a 404 as a missing session rather than a generic failure', async () => {
    const { impl } = jsonFetch([{ ok: false, status: 404, body: { detail: 'not found' } }]);

    await expect(mintSourceToken('http://localhost:8765', 'gone', 'op-1', impl)).rejects.toThrow(/session/i);
  });

  it('handles unparseable responses without a SyntaxError', async () => {
    const { impl } = jsonFetch([{ ok: false, status: 500, jsonThrows: true }]);

    await expect(mintSourceToken('http://localhost:8765', 'sess_x', 'op-1', impl)).rejects.toThrow(/Could not mint a capture token.*HTTP 500/);
  });
});
