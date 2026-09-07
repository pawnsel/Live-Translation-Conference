const REFRESH_AT = 0.8;

// Neither request here had a timeout: a hung fetch (server unreachable at
// the network level, rather than answering with an HTTP error) never
// settles, and every caller in Admin.tsx guards its own loading flag with a
// `finally` that only runs once the awaited promise settles — so a hang
// wedges a button disabled forever with no console error at all. Confirmed
// live: an operator saw exactly that, a greyed-out button that stayed
// unclickable across a hard refresh's worth of retrying the same flow.
const REQUEST_TIMEOUT_MS = 10000;

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`เซิร์ฟเวอร์ไม่ตอบสนองภายใน ${REQUEST_TIMEOUT_MS / 1000} วินาที (server did not respond in time)`);
    }
    throw err;
  }
}

export function createOperatorTokenSource(opts: { fetchImpl?: typeof fetch; now?: () => number } = {}) {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;

  let cached: { token: string; refreshAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function load(): Promise<string> {
    const response = await fetchWithTimeout(doFetch, '/api/asr/token', { method: 'POST' });
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
  const response = await fetchWithTimeout(fetchImpl, `${base}/sessions/${sessionId}/capture-link`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}` },
  });
  if (response.status === 404) {
    throw new Error(`Session ${sessionId} no longer exists — create a new one`);
  }
  // This endpoint is served by the Python/FastAPI backend (server/main.py's
  // capture_link handler), NOT this app's own Node server — FastAPI's
  // HTTPException always serialises its failure message as `{"detail": ...}`,
  // never `{"error": ...}` (that shape belongs to createOperatorTokenSource's
  // `load()` above, which really does call this app's Node server). Confirmed
  // against server/main.py: `raise HTTPException(status_code=404, detail=...)`.
  const body = (await response.json().catch(() => ({}))) as { token?: string; detail?: string };
  if (!response.ok || !body.token) {
    throw new Error(body.detail || `Could not mint a capture token (HTTP ${response.status})`);
  }
  return body.token;
}
