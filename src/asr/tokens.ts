const REFRESH_AT = 0.8;

export function createOperatorTokenSource(opts: { fetchImpl?: typeof fetch; now?: () => number } = {}) {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;

  let cached: { token: string; refreshAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function load(): Promise<string> {
    const response = await doFetch('/api/asr/token', { method: 'POST' });
    const body = (await response.json().catch(() => ({}))) as { token?: string; expiresAt?: number; error?: string };
    if (!response.ok || !body.token || typeof body.expiresAt !== 'number') {
      throw new Error(body.error || `Could not obtain an ASR token (HTTP ${response.status})`);
    }
    const issuedAt = now();
    // Refresh before the token dies, not after a 4401 kills a live caption
    // stream. An event day can outlast the 12 h TTL.
    cached = { token: body.token, refreshAt: issuedAt + (body.expiresAt - issuedAt) * REFRESH_AT };
    return body.token;
  }

  return {
    async get(): Promise<string> {
      if (cached && now() < cached.refreshAt) return cached.token;
      if (!inFlight) {
        inFlight = load().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
  };
}

export async function mintSourceToken(
  backendUrl: string,
  sessionId: string,
  operatorToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const base = backendUrl.replace(/\/+$/, '');
  const response = await fetchImpl(`${base}/sessions/${sessionId}/capture-link`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}` },
  });
  if (response.status === 404) {
    throw new Error(`Session ${sessionId} no longer exists — create a new one`);
  }
  const body = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!response.ok || !body.token) {
    throw new Error(body.error || `Could not mint a capture token (HTTP ${response.status})`);
  }
  return body.token;
}
