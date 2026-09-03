import { describe, expect, it, vi } from 'vitest';
import { chooseSession, createSession, deleteSession, getSession, listSessions, type SessionSnapshot } from './sessions';

function snapshot(id: string, extra: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id,
    source_lang: 'th',
    target_lang: 'en',
    clients: 0,
    report_active: false,
    recognizer_alive: true,
    helper_alive: null,
    ingest: 'remote',
    audio_alive: null,
    ...extra,
  };
}

function jsonFetch(responses: Array<{ ok?: boolean; status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch');
    return { ok: next.ok ?? true, status: next.status ?? 200, json: async () => next.body } as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('chooseSession', () => {
  it('creates when none are live', () => {
    expect(chooseSession([])).toEqual({ action: 'create' });
  });

  it('adopts silently when exactly one is live', () => {
    expect(chooseSession([snapshot('sess_a')])).toEqual({ action: 'adopt', id: 'sess_a' });
  });

  it('asks when several are live', () => {
    const many = [snapshot('sess_a'), snapshot('sess_b')];
    expect(chooseSession(many)).toEqual({ action: 'ask', sessions: many });
  });
});

describe('createSession', () => {
  it('requests remote ingest so the browser owns the microphone', async () => {
    const { impl, calls } = jsonFetch([{ body: snapshot('sess_new') }]);

    const created = await createSession('http://localhost:8765', 'op-1', impl);

    expect(created.id).toBe('sess_new');
    expect(calls[0].url).toBe('http://localhost:8765/sessions');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ ingest: 'remote' });
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer op-1');
  });

  it('reports the MAX_SESSIONS cap specifically', async () => {
    const { impl } = jsonFetch([{ ok: false, status: 409, body: { detail: 'session cap reached' } }]);

    await expect(createSession('http://localhost:8765', 'op-1', impl)).rejects.toThrow(/already running the maximum/i);
  });
});

describe('getSession', () => {
  it('returns null for a session the backend has forgotten', async () => {
    const { impl } = jsonFetch([{ ok: false, status: 404, body: {} }]);
    expect(await getSession('http://localhost:8765', 'op-1', 'gone', impl)).toBeNull();
  });

  it('returns the snapshot when it exists', async () => {
    const { impl } = jsonFetch([{ body: snapshot('sess_a', { recognizer_alive: false }) }]);
    const result = await getSession('http://localhost:8765', 'op-1', 'sess_a', impl);
    expect(result?.recognizer_alive).toBe(false);
  });
});

describe('listSessions', () => {
  it('returns the array the backend sends', async () => {
    const { impl } = jsonFetch([{ body: [snapshot('sess_a')] }]);
    expect(await listSessions('http://localhost:8765', 'op-1', impl)).toHaveLength(1);
  });
});

describe('deleteSession', () => {
  it('sends DELETE with the correct URL and Authorization header', async () => {
    const { impl, calls } = jsonFetch([{ body: {} }]);

    await deleteSession('http://localhost:8765', 'op-1', 'sess_end', impl);

    expect(calls[0].url).toBe('http://localhost:8765/sessions/sess_end');
    expect(calls[0].init?.method).toBe('DELETE');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer op-1');
  });

  it('resolves without throwing when the session is already forgotten', async () => {
    const { impl } = jsonFetch([{ ok: false, status: 404, body: {} }]);

    await expect(deleteSession('http://localhost:8765', 'op-1', 'gone', impl)).resolves.toBeUndefined();
  });

  it('throws with the intended message on a 500 error', async () => {
    const { impl } = jsonFetch([{ ok: false, status: 500, body: {} }]);

    await expect(deleteSession('http://localhost:8765', 'op-1', 'sess_x', impl)).rejects.toThrow(/Could not end session.*HTTP 500/);
  });
});
