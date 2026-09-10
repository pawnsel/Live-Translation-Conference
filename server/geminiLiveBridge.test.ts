import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveBridge,
  CONNECTING,
  OPEN,
  REVERIFY_INTERVAL_MS,
  EXPIRED_TOKEN_GRACE_MS,
  SESSION_MAX_MS,
  CLOSE_REVOKED,
  CLOSE_MAX_DURATION,
  type SocketLike
} from './geminiLiveBridge';
import type { AuthResult, Verifier } from './auth';

/** Minimal SocketLike double: records what was sent, lets a test fire events. */
export class FakeSocket implements SocketLike {
  readyState = OPEN;
  sent: Array<string | Buffer> = [];
  closed: { code?: number; reason?: string } | null = null;
  private handlers = new Map<string, Array<(...args: any[]) => void>>();

  send(data: string | Buffer) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  on(event: string, cb: (...args: any[]) => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }
  emit(event: string, ...args: any[]) {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
  /** Frames sent as JSON, parsed. */
  jsonSent(): any[] {
    return this.sent.map((s) => JSON.parse(s.toString()));
  }
}

/** Drives a bridge with a fake client and a queue of fake upstreams. */
export function makeBridge(
  overrides: { targetLanguageCode?: string; verify?: Verifier; accessToken?: string } = {}
) {
  const client = new FakeSocket();
  const upstreams: FakeSocket[] = [];
  createLiveBridge(client, {
    model: 'test-model',
    targetLanguageCode: overrides.targetLanguageCode ?? 'en',
    sourceLanguageCodes: ['th-TH'],
    accessToken: overrides.accessToken ?? 'token-1',
    verify:
      overrides.verify ??
      (async () => ({ kind: 'allow', user: { id: 'u1', email: 'a@chula.ac.th' } })),
    openUpstream: () => {
      const up = new FakeSocket();
      up.readyState = CONNECTING;
      upstreams.push(up);
      return up;
    }
  });
  return { client, upstreams };
}

/** A verifier that answers with whatever the test currently wants, and counts
 *  the tokens it was asked about. */
export function scriptedVerifier(initial: AuthResult) {
  const seen: (string | null)[] = [];
  let answer = initial;
  const verify: Verifier = async (token) => {
    seen.push(token);
    return answer;
  };
  return {
    verify,
    seen,
    set(next: AuthResult) {
      answer = next;
    }
  };
}

const ALLOW: AuthResult = { kind: 'allow', user: { id: 'u1', email: 'a@chula.ac.th' } };

/** Lets the bridge's awaited verify() calls settle between timer advances. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Opens the newest upstream and completes its setup handshake. */
export function completeSetup(up: FakeSocket) {
  up.readyState = OPEN;
  up.emit('open');
  up.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })), false);
}

describe('createLiveBridge', () => {
  it('sends setup carrying the language pair once the client config arrives', () => {
    const { client, upstreams } = makeBridge();
    const up = upstreams[0];
    up.readyState = OPEN;
    up.emit('open');

    client.emit(
      'message',
      Buffer.from(JSON.stringify({ targetLanguageCode: 'th', sourceLanguageCodes: ['en-US'] })),
      false
    );

    const setup = up.jsonSent().find((f) => f.setup)?.setup;
    expect(setup.model).toBe('models/test-model');
    expect(setup.generationConfig.translationConfig.targetLanguageCode).toBe('th');
    expect(setup.inputAudioTranscription.languageCodes).toEqual(['en-US']);
  });

  it('queues audio that arrives before setupComplete and flushes it after', () => {
    const { client, upstreams } = makeBridge();
    const up = upstreams[0];
    up.readyState = OPEN;
    up.emit('open');
    client.emit('message', Buffer.from(JSON.stringify({ targetLanguageCode: 'en' })), false);

    const audio = Buffer.from('audio-frame-1');
    client.emit('message', audio, true);
    expect(up.sent.filter((s) => s.toString() === 'audio-frame-1')).toHaveLength(0);

    up.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })), false);
    expect(up.sent.filter((s) => s.toString() === 'audio-frame-1')).toHaveLength(1);
  });

  it('relays upstream transcription frames to the client', () => {
    const { client, upstreams } = makeBridge();
    const up = upstreams[0];
    completeSetup(up);
    const frame = JSON.stringify({ serverContent: { outputTranscription: { text: 'hello' } } });
    up.emit('message', Buffer.from(frame), false);
    expect(client.sent.map((s) => s.toString())).toContain(frame);
  });

  it('drops audio-only model frames instead of relaying them', () => {
    const { client, upstreams } = makeBridge();
    const up = upstreams[0];
    completeSetup(up);
    const before = client.sent.length;
    up.emit(
      'message',
      Buffer.from(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'x' } }] } } })),
      false
    );
    expect(client.sent.length).toBe(before);
  });
});

describe('session resumption', () => {
  it('asks for resumption and context compression in the first setup', () => {
    const { client, upstreams } = makeBridge();
    const up = upstreams[0];
    up.readyState = OPEN;
    up.emit('open');
    client.emit('message', Buffer.from(JSON.stringify({ targetLanguageCode: 'en' })), false);

    const setup = up.jsonSent().find((f) => f.setup)?.setup;
    // No handle on a first connection — an empty object still opts into the
    // sessionResumptionUpdate frames a later swap needs.
    expect(setup.sessionResumption).toEqual({});
    expect(setup.contextWindowCompression).toEqual({ slidingWindow: {} });
  });

  it('does not relay sessionResumptionUpdate or goAway to the client', () => {
    const { client, upstreams } = makeBridge();
    const up = upstreams[0];
    completeSetup(up);
    const before = client.sent.length;
    up.emit('message', Buffer.from(JSON.stringify({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } })), false);
    up.emit('message', Buffer.from(JSON.stringify({ goAway: { timeLeft: '60s' } })), false);
    expect(client.sent.length).toBe(before);
  });
});

describe('upstream swap', () => {
  it('opens a replacement on goAway and keeps the client socket open', () => {
    const { client, upstreams } = makeBridge();
    completeSetup(upstreams[0]);
    upstreams[0].emit('message', Buffer.from(JSON.stringify({ goAway: { timeLeft: '60s' } })), false);

    expect(upstreams).toHaveLength(2);
    expect(upstreams[0].closed).not.toBeNull();
    expect(client.closed).toBeNull();
  });

  it('resumes the replacement with the latest handle', () => {
    const { upstreams } = makeBridge();
    completeSetup(upstreams[0]);
    upstreams[0].emit('message', Buffer.from(JSON.stringify({ sessionResumptionUpdate: { newHandle: 'h9', resumable: true } })), false);
    upstreams[0].emit('message', Buffer.from(JSON.stringify({ goAway: {} })), false);

    completeSetup(upstreams[1]);
    const setup = upstreams[1].jsonSent().find((f) => f.setup)?.setup;
    expect(setup.sessionResumption).toEqual({ handle: 'h9' });
  });

  it('opens a fresh session when the server said the handle is not resumable', () => {
    const { upstreams } = makeBridge();
    completeSetup(upstreams[0]);
    upstreams[0].emit('message', Buffer.from(JSON.stringify({ sessionResumptionUpdate: { newHandle: 'h9', resumable: true } })), false);
    upstreams[0].emit('message', Buffer.from(JSON.stringify({ sessionResumptionUpdate: { resumable: false } })), false);
    upstreams[0].emit('message', Buffer.from(JSON.stringify({ goAway: {} })), false);

    completeSetup(upstreams[1]);
    const setup = upstreams[1].jsonSent().find((f) => f.setup)?.setup;
    expect(setup.sessionResumption).toEqual({});
  });

  it('queues audio during the swap and flushes it into the replacement', () => {
    const { client, upstreams } = makeBridge();
    completeSetup(upstreams[0]);
    upstreams[0].emit('message', Buffer.from(JSON.stringify({ goAway: {} })), false);

    client.emit('message', Buffer.from('mid-swap-audio'), true);
    completeSetup(upstreams[1]);

    expect(upstreams[1].sent.map((s) => s.toString())).toContain('mid-swap-audio');
  });

  it('swaps on an unexpected close with no goAway', () => {
    const { client, upstreams } = makeBridge();
    completeSetup(upstreams[0]);
    upstreams[0].emit('close', 1006, Buffer.from(''));

    expect(upstreams).toHaveLength(2);
    expect(client.closed).toBeNull();
  });

  it('opens at most three replacements before giving up to the client', () => {
    const { client, upstreams } = makeBridge();
    completeSetup(upstreams[0]);

    // Three closes buy three replacements; the fourth is refused.
    upstreams[0].emit('close', 1006, Buffer.from(''));
    upstreams[1].emit('close', 1006, Buffer.from(''));
    upstreams[2].emit('close', 1006, Buffer.from(''));
    expect(upstreams).toHaveLength(4);
    expect(client.closed).toBeNull();

    upstreams[3].emit('close', 1006, Buffer.from(''));
    expect(upstreams).toHaveLength(4);
    expect(client.closed).not.toBeNull();
  });

  it('relays setupComplete to the client only once across a goAway-driven swap', () => {
    // The browser has no notion of an upstream swap (§3.2 of the design):
    // relaying a second setupComplete would tell it to rebuild its whole
    // mic/AudioContext pipeline while the first one is still running.
    const { client, upstreams } = makeBridge();
    completeSetup(upstreams[0]);
    const setupCompleteFramesAfterFirst = client
      .jsonSent()
      .filter((f) => f.setupComplete !== undefined).length;
    expect(setupCompleteFramesAfterFirst).toBe(1);

    upstreams[0].emit('message', Buffer.from(JSON.stringify({ goAway: { timeLeft: '60s' } })), false);
    completeSetup(upstreams[1]);

    const setupCompleteFramesTotal = client.jsonSent().filter((f) => f.setupComplete !== undefined).length;
    expect(setupCompleteFramesTotal).toBe(1);
  });

  it('resets the swap budget after a replacement completes setup', () => {
    const { client, upstreams } = makeBridge();
    completeSetup(upstreams[0]);
    upstreams[0].emit('close', 1006, Buffer.from('')); // replacement 1 → [1]
    upstreams[1].emit('close', 1006, Buffer.from('')); // replacement 2 → [2]

    // A healthy handshake buys a full budget again, so the next three closes
    // each get a replacement rather than hitting the cap two short.
    completeSetup(upstreams[2]);
    upstreams[2].emit('close', 1006, Buffer.from('')); // → [3]
    upstreams[3].emit('close', 1006, Buffer.from('')); // → [4]
    upstreams[4].emit('close', 1006, Buffer.from('')); // → [5]
    expect(upstreams).toHaveLength(6);
    expect(client.closed).toBeNull();

    upstreams[5].emit('close', 1006, Buffer.from(''));
    expect(client.closed).not.toBeNull();
  });
});

// A live session is what actually spends money on the Gemini key, and until
// now it was checked exactly once, at the handshake. The bridge swaps its own
// upstream every ten minutes to keep a long meeting going, so a session left
// open — or one belonging to an account revoked mid-meeting — could stream
// indefinitely.
describe('createLiveBridge session guards', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('re-checks the caller periodically rather than only at the handshake', async () => {
    const scripted = scriptedVerifier(ALLOW);
    const { client } = makeBridge({ verify: scripted.verify });

    await vi.advanceTimersByTimeAsync(REVERIFY_INTERVAL_MS);
    await settle();
    expect(scripted.seen.length).toBe(1);

    await vi.advanceTimersByTimeAsync(REVERIFY_INTERVAL_MS);
    await settle();
    expect(scripted.seen.length).toBe(2);
    expect(client.closed).toBeNull();
  });

  it('cuts a session whose account was revoked', async () => {
    const scripted = scriptedVerifier(ALLOW);
    const { client } = makeBridge({ verify: scripted.verify });

    scripted.set({ kind: 'deny', status: 403, reason: 'this account is revoked, not approved' });
    await vi.advanceTimersByTimeAsync(REVERIFY_INTERVAL_MS);
    await settle();

    expect(client.closed?.code).toBe(CLOSE_REVOKED);
  });

  // The trap this guard exists for: Supabase access tokens expire after an
  // hour, and the verifier reports an expired token with the same 401 it uses
  // for a forged one. Closing on the first 401 would end EVERY meeting at the
  // sixty-minute mark — the exact three-hour meetings this system is for.
  it('does not cut a session the moment its token expires', async () => {
    const scripted = scriptedVerifier(ALLOW);
    const { client } = makeBridge({ verify: scripted.verify });

    scripted.set({ kind: 'deny', status: 401, reason: 'invalid or expired session' });
    await vi.advanceTimersByTimeAsync(REVERIFY_INTERVAL_MS);
    await settle();

    expect(client.closed).toBeNull();
  });

  it('cuts a session whose token stays unusable past the grace window', async () => {
    const scripted = scriptedVerifier(ALLOW);
    const { client } = makeBridge({ verify: scripted.verify });

    scripted.set({ kind: 'deny', status: 401, reason: 'invalid or expired session' });
    await vi.advanceTimersByTimeAsync(EXPIRED_TOKEN_GRACE_MS + REVERIFY_INTERVAL_MS);
    await settle();

    expect(client.closed?.code).toBe(CLOSE_REVOKED);
  });

  it('forgives the expiry once the client sends a token that works', async () => {
    const scripted = scriptedVerifier(ALLOW);
    const { client } = makeBridge({ verify: scripted.verify });

    scripted.set({ kind: 'deny', status: 401, reason: 'invalid or expired session' });
    await vi.advanceTimersByTimeAsync(REVERIFY_INTERVAL_MS);
    await settle();

    // supabase-js refreshed in the browser and the client pushed the new one
    // down the socket it already has open.
    client.emit('message', Buffer.from(JSON.stringify({ authRefresh: { accessToken: 'token-2' } })), false);
    scripted.set(ALLOW);
    await vi.advanceTimersByTimeAsync(REVERIFY_INTERVAL_MS);
    await settle();

    expect(scripted.seen.at(-1)).toBe('token-2');

    // The grace clock must have been reset, not merely paused: a later expiry
    // gets its own full window.
    scripted.set({ kind: 'deny', status: 401, reason: 'invalid or expired session' });
    await vi.advanceTimersByTimeAsync(REVERIFY_INTERVAL_MS);
    await settle();
    expect(client.closed).toBeNull();
  });

  // Failing closed is right at the handshake, where no meeting exists yet.
  // Mid-meeting it would mean a Supabase blip ends a real conference.
  it('never cuts a live session because Supabase is unreachable', async () => {
    const scripted = scriptedVerifier(ALLOW);
    const { client } = makeBridge({ verify: scripted.verify });

    scripted.set({ kind: 'deny', status: 503, reason: 'could not reach the authentication service' });
    await vi.advanceTimersByTimeAsync(EXPIRED_TOKEN_GRACE_MS * 3);
    await settle();

    expect(client.closed).toBeNull();
  });

  it('does not relay the auth refresh frame upstream', async () => {
    const { client, upstreams } = makeBridge();
    completeSetup(upstreams[0]);
    const before = upstreams[0].sent.length;

    client.emit('message', Buffer.from(JSON.stringify({ authRefresh: { accessToken: 'token-2' } })), false);

    expect(upstreams[0].sent.length).toBe(before);
  });

  // Otherwise a client whose access was pulled could hold its billed session
  // open indefinitely by sending a fresh piece of garbage every few minutes.
  it('does not let a stream of refreshes extend the grace window', async () => {
    const scripted = scriptedVerifier(ALLOW);
    const { client } = makeBridge({ verify: scripted.verify });

    scripted.set({ kind: 'deny', status: 401, reason: 'invalid or expired session' });
    for (let tick = 0; tick < 4; tick++) {
      client.emit(
        'message',
        Buffer.from(JSON.stringify({ authRefresh: { accessToken: `junk-${tick}` } })),
        false
      );
      await vi.advanceTimersByTimeAsync(REVERIFY_INTERVAL_MS);
      await settle();
    }

    expect(client.closed?.code).toBe(CLOSE_REVOKED);
  });

  it('ignores an auth refresh carrying no usable token', async () => {
    const scripted = scriptedVerifier(ALLOW);
    const { client } = makeBridge({ verify: scripted.verify, accessToken: 'token-1' });

    client.emit('message', Buffer.from(JSON.stringify({ authRefresh: { accessToken: 42 } })), false);
    await vi.advanceTimersByTimeAsync(REVERIFY_INTERVAL_MS);
    await settle();

    expect(scripted.seen.at(-1)).toBe('token-1');
  });

  // The runaway-cost guard: a tab left streaming overnight bills about $2.20
  // an hour whether or not anybody is in the room.
  it('closes a session that has run past the maximum duration', async () => {
    const { client } = makeBridge();

    await vi.advanceTimersByTimeAsync(SESSION_MAX_MS - 1000);
    await settle();
    expect(client.closed).toBeNull();

    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(client.closed?.code).toBe(CLOSE_MAX_DURATION);
  });

  it('stops re-checking once the client has gone', async () => {
    const scripted = scriptedVerifier(ALLOW);
    const { client } = makeBridge({ verify: scripted.verify });

    client.emit('close');
    await vi.advanceTimersByTimeAsync(REVERIFY_INTERVAL_MS * 3);
    await settle();

    expect(scripted.seen.length).toBe(0);
  });
});
