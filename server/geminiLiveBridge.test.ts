import { describe, expect, it } from 'vitest';
import { createLiveBridge, CONNECTING, OPEN, type SocketLike } from './geminiLiveBridge';

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
export function makeBridge(overrides: { targetLanguageCode?: string } = {}) {
  const client = new FakeSocket();
  const upstreams: FakeSocket[] = [];
  createLiveBridge(client, {
    model: 'test-model',
    targetLanguageCode: overrides.targetLanguageCode ?? 'en',
    sourceLanguageCodes: ['th-TH'],
    openUpstream: () => {
      const up = new FakeSocket();
      up.readyState = CONNECTING;
      upstreams.push(up);
      return up;
    }
  });
  return { client, upstreams };
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
