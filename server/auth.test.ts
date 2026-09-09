import { describe, it, expect, vi } from 'vitest';
import {
  bearerFromWebSocketProtocol,
  createSupabaseVerifier,
  extractBearerToken,
  requireApprovedUser,
  withVerifierCache,
  type AuthResult,
  type Verifier,
} from './auth';

const APPROVED = [{ id: 'u1', email: 'somchai.j@chula.ac.th', status: 'approved' }];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function verifierWith(fetchImpl: typeof fetch) {
  return createSupabaseVerifier({ url: 'https://proj.supabase.co', anonKey: 'anon', fetchImpl });
}

describe('extractBearerToken', () => {
  it('reads the token out of an Authorization header', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('bearer abc')).toBe('abc');
  });

  it('returns null for anything else', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken('Bearer ')).toBeNull();
  });
});

describe('bearerFromWebSocketProtocol', () => {
  it('reads the token that follows the bearer marker', () => {
    expect(bearerFromWebSocketProtocol('bearer, abc.def')).toBe('abc.def');
    expect(bearerFromWebSocketProtocol('bearer,abc.def')).toBe('abc.def');
  });

  it('returns null when the marker or the token is missing', () => {
    expect(bearerFromWebSocketProtocol(undefined)).toBeNull();
    expect(bearerFromWebSocketProtocol('bearer')).toBeNull();
    expect(bearerFromWebSocketProtocol('graphql-ws')).toBeNull();
  });
});

describe('createSupabaseVerifier', () => {
  it('allows an approved account and reports who it is', async () => {
    const verify = verifierWith(vi.fn(async () => jsonResponse(200, APPROVED)) as unknown as typeof fetch);
    const result = await verify('good-token');
    expect(result).toEqual({ kind: 'allow', user: { id: 'u1', email: 'somchai.j@chula.ac.th' } });
  });

  it('sends the caller token and the anon key to the approval table', async () => {
    const spy = vi.fn(async () => jsonResponse(200, APPROVED));
    await verifierWith(spy as unknown as typeof fetch)('good-token');

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://proj.supabase.co/rest/v1/access_requests?select=id,email,status');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer good-token');
    expect(headers.apikey).toBe('anon');
  });

  it('denies a request with no token without calling out at all', async () => {
    const spy = vi.fn(async () => jsonResponse(200, APPROVED));
    const result = await verifierWith(spy as unknown as typeof fetch)(null);
    expect(result).toMatchObject({ kind: 'deny', status: 401 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('denies a forged or expired token — PostgREST rejects the JWT', async () => {
    const verify = verifierWith(vi.fn(async () => jsonResponse(401, {})) as unknown as typeof fetch);
    expect(await verify('bad')).toMatchObject({ kind: 'deny', status: 401 });
  });

  it('denies a valid token whose account never registered (no row)', async () => {
    const verify = verifierWith(vi.fn(async () => jsonResponse(200, [])) as unknown as typeof fetch);
    expect(await verify('good')).toMatchObject({ kind: 'deny', status: 403 });
  });

  it.each(['pending', 'rejected'])('denies an account that is %s', async (status) => {
    const verify = verifierWith(
      vi.fn(async () => jsonResponse(200, [{ id: 'u1', email: 'a@chula.ac.th', status }])) as unknown as typeof fetch,
    );
    const result = await verify('good');
    expect(result).toMatchObject({ kind: 'deny', status: 403 });
    expect((result as { reason: string }).reason).toContain(status);
  });

  it('fails closed when Supabase is unreachable', async () => {
    const verify = verifierWith(
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    );
    expect(await verify('good')).toMatchObject({ kind: 'deny', status: 503 });
  });

  it('fails closed on a malformed reply', async () => {
    const verify = verifierWith(
      vi.fn(async () => new Response('not json', { status: 200 })) as unknown as typeof fetch,
    );
    expect(await verify('good')).toMatchObject({ kind: 'deny', status: 503 });
  });
});

describe('withVerifierCache', () => {
  const allow: AuthResult = { kind: 'allow', user: { id: 'u1', email: 'a@chula.ac.th' } };

  it('reuses a decision instead of asking Supabase every time', async () => {
    const inner = vi.fn(async () => allow);
    const verify = withVerifierCache(inner);
    await verify('t');
    await verify('t');
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('asks again once the entry expires — this is the revocation lag', async () => {
    vi.useFakeTimers();
    try {
      const inner = vi.fn(async () => allow);
      const verify = withVerifierCache(inner, { successTtlMs: 1000 });
      await verify('t');
      vi.advanceTimersByTime(1001);
      await verify('t');
      expect(inner).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps separate decisions per token', async () => {
    const inner = vi.fn(async (token: string | null) =>
      token === 'good' ? allow : ({ kind: 'deny', status: 403, reason: 'no' } as AuthResult),
    );
    const verify = withVerifierCache(inner);
    expect((await verify('good')).kind).toBe('allow');
    expect((await verify('bad')).kind).toBe('deny');
  });

  it('never caches a backend outage, so recovery is immediate', async () => {
    const results: AuthResult[] = [{ kind: 'deny', status: 503, reason: 'down' }, allow];
    const inner = vi.fn(async () => results.shift()!);
    const verify = withVerifierCache(inner);
    expect((await verify('t')).kind).toBe('deny');
    expect((await verify('t')).kind).toBe('allow');
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('bounds how many entries it holds', async () => {
    const inner = vi.fn(async () => allow);
    const verify = withVerifierCache(inner, { maxEntries: 2 });
    await verify('a');
    await verify('b');
    await verify('c'); // evicts 'a'
    await verify('a');
    expect(inner).toHaveBeenCalledTimes(4);
  });
});

describe('requireApprovedUser', () => {
  function fakeRes() {
    const res = {
      locals: {} as Record<string, unknown>,
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(payload: unknown) {
        res.body = payload;
        return res;
      },
    };
    return res;
  }

  it('passes an approved caller through and records who they are', async () => {
    const verify: Verifier = async () => ({ kind: 'allow', user: { id: 'u1', email: 'a@chula.ac.th' } });
    const res = fakeRes();
    const next = vi.fn();

    await requireApprovedUser(verify)(
      { headers: { authorization: 'Bearer t' } } as never,
      res as never,
      next as never,
    );

    expect(next).toHaveBeenCalledOnce();
    expect(res.locals.approvedUser).toEqual({ id: 'u1', email: 'a@chula.ac.th' });
  });

  it('answers with the refusal and never calls the route', async () => {
    const verify: Verifier = async () => ({ kind: 'deny', status: 403, reason: 'this account is pending' });
    const res = fakeRes();
    const next = vi.fn();

    await requireApprovedUser(verify)({ headers: {} } as never, res as never, next as never);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'this account is pending' });
  });
});
