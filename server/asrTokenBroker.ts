export interface BrokerOptions {
  backendUrl: string;
  password: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface OperatorToken {
  token: string;
  /** Epoch ms at which the backend stops accepting this token. */
  expiresAt: number;
}

/** Refresh once 80% of the token's life is gone, rather than after a 4401. */
const REFRESH_AT = 0.8;

export function createTokenBroker(opts: BrokerOptions) {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const base = opts.backendUrl.replace(/\/+$/, '');

  let cached: { token: OperatorToken; refreshAt: number } | null = null;
  let inFlight: Promise<OperatorToken> | null = null;

  async function login(): Promise<OperatorToken> {
    let response: Response;
    try {
      response = await doFetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: opts.password }),
      });
    } catch (cause) {
      // Distinct from a rejected password: one is a config error the operator
      // fixes in .env, the other means the Python process is not running.
      throw new Error(`Could not reach the ASR backend at ${base}`, { cause });
    }

    if (!response.ok) {
      // Never echo the attempted password into a log or an HTTP response.
      throw new Error(`The ASR backend rejected the operator password (HTTP ${response.status})`);
    }

    const body = (await response.json()) as { token?: string; expires_in?: number };
    if (!body.token || typeof body.expires_in !== 'number') {
      throw new Error('The ASR backend returned a malformed token response');
    }

    const issuedAt = now();
    const token: OperatorToken = {
      token: body.token,
      expiresAt: issuedAt + body.expires_in * 1000,
    };
    cached = { token, refreshAt: issuedAt + body.expires_in * 1000 * REFRESH_AT };
    return token;
  }

  return {
    async getToken(): Promise<OperatorToken> {
      if (cached && now() < cached.refreshAt) return cached.token;
      // Collapse concurrent callers onto one login; the endpoint is rate
      // limited per IP at LOGIN_RATE_PER_MIN (5).
      if (!inFlight) {
        inFlight = login().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
  };
}
