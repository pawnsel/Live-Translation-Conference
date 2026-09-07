export interface SessionSnapshot {
  id: string;
  source_lang: string;
  target_lang: string;
  clients: number;
  report_active: boolean;
  /** Read from the engine's worker thread at call time. A reading, not a verdict. */
  recognizer_alive: boolean;
  /** null when DUAL_ASR is off — not a fault. */
  helper_alive: boolean | null;
  ingest: string;
  /** null for a local session, where the question does not apply. */
  audio_alive: boolean | null;
}

export type SessionChoice =
  | { action: 'create' }
  | { action: 'adopt'; id: string }
  | { action: 'ask'; sessions: SessionSnapshot[] };

/**
 * The console's documented rule: create if none is live, adopt if exactly one
 * is, ask when several are. Adopting "the first" of several would silently
 * attach one venue's operator to another venue's event.
 */
export function chooseSession(sessions: SessionSnapshot[]): SessionChoice {
  if (sessions.length === 0) return { action: 'create' };
  if (sessions.length === 1) return { action: 'adopt', id: sessions[0].id };
  return { action: 'ask', sessions };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// None of these calls had a timeout: `fetch()` can hang far longer than an
// operator will wait — TCP-level failures against a server that just
// vanished are not always an immediate rejection — and every caller in
// Admin.tsx guards its own loading flag (`starting`, `endingSession`) with a
// `finally` that only ever runs once the awaited promise SETTLES. A fetch
// that never settles therefore wedges a button disabled forever with no
// console error and no visible explanation — confirmed live: the operator
// saw exactly that, a greyed-out "เริ่ม Session" that stayed unclickable
// across a hard refresh's worth of retrying the same stuck flow.
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

export async function listSessions(
  backendUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SessionSnapshot[]> {
  const response = await fetchWithTimeout(fetchImpl, `${backendUrl.replace(/\/+$/, '')}/sessions`, {
    headers: authHeaders(token),
  });
  if (!response.ok) throw new Error(`Could not list sessions (HTTP ${response.status})`);
  return (await response.json()) as SessionSnapshot[];
}

export async function createSession(
  backendUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SessionSnapshot> {
  const response = await fetchWithTimeout(fetchImpl, `${backendUrl.replace(/\/+$/, '')}/sessions`, {
    method: 'POST',
    headers: authHeaders(token),
    // "remote" is required: a local session opens the SERVER's microphone,
    // and every local session shares that one physical device.
    body: JSON.stringify({ ingest: 'remote' }),
  });
  if (response.status === 409) {
    throw new Error('เซิร์ฟเวอร์กำลังรันเซสชันครบจำนวนสูงสุดแล้ว (the backend is already running the maximum number of sessions)');
  }
  if (!response.ok) throw new Error(`Could not create a session (HTTP ${response.status})`);
  return (await response.json()) as SessionSnapshot;
}

export async function getSession(
  backendUrl: string,
  token: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SessionSnapshot | null> {
  const response = await fetchWithTimeout(fetchImpl, `${backendUrl.replace(/\/+$/, '')}/sessions/${id}`, {
    headers: authHeaders(token),
  });
  // A forgotten session is the normal consequence of a backend restart, not
  // an error worth throwing over.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not read session ${id} (HTTP ${response.status})`);
  return (await response.json()) as SessionSnapshot;
}

export async function deleteSession(
  backendUrl: string,
  token: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchWithTimeout(fetchImpl, `${backendUrl.replace(/\/+$/, '')}/sessions/${id}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Could not end session ${id} (HTTP ${response.status})`);
  }
}
