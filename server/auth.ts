/** Server-side access control for everything that spends the Gemini key.
 *
 *  The browser's approval gate only decides what gets *rendered*; it cannot
 *  protect the endpoints, because anyone can call them directly. This module
 *  is what actually stops an unapproved person from opening a live session or
 *  running a summary on our API key.
 *
 *  How a caller is checked, in ONE request to Supabase:
 *
 *    GET /rest/v1/access_requests?select=id,email,status
 *        apikey:        <anon key>
 *        Authorization: Bearer <the caller's access token>
 *
 *  PostgREST verifies the JWT's signature and expiry, and row-level security
 *  narrows the result to the caller's own row (supabase/schema.sql). So the
 *  reply answers both questions at once:
 *
 *    401             → the token is forged, expired, or absent
 *    200 []          → valid token, but this person never registered
 *    200 [{status}]  → registered; only 'approved' may proceed
 *
 *  Note what is NOT here: no service-role key. Verification runs entirely on
 *  the caller's own token plus the public anon key, so this server never holds
 *  a credential that can read other people's rows.
 */

// Aliased: the unprefixed `Response` in this file is the fetch one.
import type { NextFunction, Request, Response as ExpressResponse } from 'express';

export interface ApprovedUser {
  id: string;
  email: string;
}

// A string discriminant, not a boolean one: this project compiles without
// `strict`, and TypeScript will not narrow a union on a boolean literal there.
export type AuthResult =
  | { kind: 'allow'; user: ApprovedUser }
  /** `status` is the HTTP status to answer the caller with. 503 means we could
   *  not reach Supabase and are failing closed — never "allow on error". */
  | { kind: 'deny'; status: 401 | 403 | 503; reason: string };

export type Verifier = (token: string | null) => Promise<AuthResult>;

interface AccessRow {
  id: string;
  email: string;
  status: string;
}

const DEFAULT_TIMEOUT_MS = 8000;

/** `Authorization: Bearer <token>` → the token. */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() || null : null;
}

/** Browsers cannot set headers on a WebSocket, so the token rides in the
 *  subprotocol list as `bearer, <token>` — which travels as a real header
 *  rather than in the URL, where it would end up in access logs. */
export function bearerFromWebSocketProtocol(header: string | undefined): string | null {
  if (!header) return null;
  const parts = header
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const marker = parts.indexOf('bearer');
  if (marker === -1) return null;
  return parts[marker + 1] ?? null;
}

export function createSupabaseVerifier(opts: {
  url: string;
  anonKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Verifier {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = `${opts.url.replace(/\/+$/, '')}/rest/v1/access_requests?select=id,email,status`;

  return async (token) => {
    if (!token) return { kind: 'deny', status: 401, reason: 'missing access token' };

    let response: Response;
    try {
      response = await doFetch(endpoint, {
        headers: {
          apikey: opts.anonKey,
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Supabase unreachable. Deny — an outage must not become an open door.
      return { kind: 'deny', status: 503, reason: 'could not reach the authentication service' };
    }

    if (response.status === 401 || response.status === 403) {
      return { kind: 'deny', status: 401, reason: 'invalid or expired session' };
    }
    if (!response.ok) {
      return { kind: 'deny', status: 503, reason: `authentication service returned ${response.status}` };
    }

    let rows: AccessRow[];
    try {
      rows = (await response.json()) as AccessRow[];
    } catch {
      return { kind: 'deny', status: 503, reason: 'malformed reply from the authentication service' };
    }

    // RLS means at most one row can come back, and it is the caller's own.
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) return { kind: 'deny', status: 403, reason: 'this account is not registered' };
    if (row.status !== 'approved') {
      return { kind: 'deny', status: 403, reason: `this account is ${row.status}, not approved` };
    }

    return { kind: 'allow', user: { id: row.id, email: row.email } };
  };
}

/** Verification costs a round trip to Supabase, and the console can summarise
 *  repeatedly in a session, so results are held briefly.
 *
 *  The success TTL is the lag between an admin revoking access and this server
 *  refusing new work — keep it short. Failures are cached far more briefly, so
 *  a just-approved user is not left waiting, while a flood of bad tokens still
 *  cannot be used to hammer Supabase. */
export function withVerifierCache(
  verify: Verifier,
  opts: { successTtlMs?: number; failureTtlMs?: number; maxEntries?: number } = {},
): Verifier {
  const successTtl = opts.successTtlMs ?? 60_000;
  const failureTtl = opts.failureTtlMs ?? 10_000;
  const maxEntries = opts.maxEntries ?? 500;
  const cache = new Map<string, { expiresAt: number; result: AuthResult }>();

  return async (token) => {
    if (!token) return verify(token);

    const now = Date.now();
    const hit = cache.get(token);
    if (hit && hit.expiresAt > now) return hit.result;
    if (hit) cache.delete(token);

    const result = await verify(token);

    // A backend outage is a transient condition, not a verdict worth keeping.
    const transient = result.kind === 'deny' && result.status === 503;
    if (!transient) {
      if (cache.size >= maxEntries) {
        // Oldest first — Map preserves insertion order.
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(token, { expiresAt: now + (result.kind === 'allow' ? successTtl : failureTtl), result });
    }

    return result;
  };
}

/** The approved caller for the request being handled, set by the middleware. */
export function approvedUserOf(res: ExpressResponse): ApprovedUser | undefined {
  return res.locals.approvedUser as ApprovedUser | undefined;
}

export function requireApprovedUser(verify: Verifier) {
  return async (req: Request, res: ExpressResponse, next: NextFunction): Promise<void> => {
    const result = await verify(extractBearerToken(req.headers.authorization));
    if (result.kind === 'deny') {
      res.status(result.status).json({ error: result.reason });
      return;
    }
    res.locals.approvedUser = result.user;
    next();
  };
}
