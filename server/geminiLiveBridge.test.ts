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
