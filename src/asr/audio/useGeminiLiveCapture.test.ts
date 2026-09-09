// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGeminiLiveCapture } from './useGeminiLiveCapture';
import { emptyGlossary } from '../../glossary';
import { reconnectDelayMs } from './reconnectPolicy';

// jsdom has no WebSocket, no AudioContext and no getUserMedia, so the whole
// browser side is faked here. Each fake records the instances it created so a
// test can assert that a dozen reconnects leave nothing running.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  /** Simulates Gemini finishing its handshake, via the proxy. */
  setupComplete() {
    this.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
  }
  /** Simulates the socket dropping for a reason the proxy could not absorb. */
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const tracks: Array<{ stopped: boolean }> = [];
const contexts: Array<{ closed: boolean }> = [];

class FakeAudioContext {
  sampleRate = 16000;
  destination = {};
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  private record = { closed: false };
  constructor(_opts: unknown) {
    contexts.push(this.record);
  }
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockImplementation(async () => {
    this.record.closed = true;
  });
  createMediaStreamSource = () => ({ connect: () => {} });
  createGain = () => ({ gain: { value: 0 }, connect: () => ({ connect: () => {} }) });
}

class FakeAudioWorkletNode {
  port = { onmessage: null, close: () => {} };
  connect = () => ({ connect: () => {} });
  disconnect = () => {};
  constructor(_ctx: unknown, _name: string, _opts: unknown) {}
}

function makeStream() {
  const track = { stopped: false, addEventListener: () => {}, stop() { this.stopped = true; } };
  tracks.push(track as unknown as { stopped: boolean });
  return { getTracks: () => [track], getAudioTracks: () => [track] };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  tracks.length = 0;
  contexts.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  vi.stubGlobal('isSecureContext', true);
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn().mockImplementation(async () => makeStream()) },
    configurable: true
  });
  URL.createObjectURL = vi.fn().mockReturnValue('blob:fake');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderCapture() {
  return renderHook(() =>
    useGeminiLiveCapture({
      active: true,
      paused: false,
      sourceLang: 'th',
      targetLang: 'en',
      glossary: emptyGlossary(),
      onResult: () => {},
      accessToken: 'test-token'
    })
  );
}

/** Lets the hook's queued microtasks and awaited startAudio steps settle. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useGeminiLiveCapture reconnect loop', () => {
  it('keeps reconnecting far past the old five-attempt budget', async () => {
    renderCapture();
    await settle();

    // Ten consecutive failures with no successful setup in between: the old
    // MAX_RECONNECTS of 5 would have stopped opening sockets at six.
    for (let failure = 1; failure <= 10; failure++) {
      const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      await act(async () => {
        socket.drop();
      });
      await act(async () => {
        vi.advanceTimersByTime(reconnectDelayMs(failure));
      });
      await settle();
    }

    expect(FakeWebSocket.instances.length).toBe(11);
  });

  it('returns to the base delay once a session completes setup again', async () => {
    renderCapture();
    await settle();

    const first = FakeWebSocket.instances[0];
    await act(async () => {
      first.drop();
    });
    await act(async () => {
      vi.advanceTimersByTime(reconnectDelayMs(1));
    });
    await settle();

    // A healthy handshake resets the failure count, so the next drop waits
    // the base delay again rather than 1600 ms.
    const second = FakeWebSocket.instances[1];
    await act(async () => {
      second.setupComplete();
    });
    await settle();
    await act(async () => {
      second.drop();
    });
    await act(async () => {
      vi.advanceTimersByTime(reconnectDelayMs(1));
    });
    await settle();

    expect(FakeWebSocket.instances.length).toBe(3);
  });

  it('leaves no microphone track or AudioContext running after a meeting of cycles', async () => {
    renderCapture();
    await settle();

    for (let cycle = 0; cycle < 12; cycle++) {
      const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      await act(async () => {
        socket.setupComplete();
      });
      await settle();
      await act(async () => {
        socket.drop();
      });
      await act(async () => {
        vi.advanceTimersByTime(reconnectDelayMs(1));
      });
      await settle();
    }

    // The loop's final iteration also drops, so a correct hook leaves nothing
    // running — not "at most one".
    expect(tracks.filter((t) => !t.stopped).length).toBe(0);
    expect(contexts.filter((c) => !c.closed).length).toBe(0);
  });

  it('does not build a second pipeline for a repeat setupComplete on the same socket', async () => {
    // The proxy swaps its own Gemini upstream in place (server/geminiLiveBridge.ts)
    // without dropping the browser socket — no drop() here, unlike every other
    // test in this file — so this is the one case that actually exercises the
    // browser receiving setupComplete twice on a socket that never closed.
    renderCapture();
    await settle();

    const socket = FakeWebSocket.instances[0];
    await act(async () => {
      socket.setupComplete();
    });
    await settle();

    expect(tracks.length).toBe(1);
    expect(contexts.length).toBe(1);

    await act(async () => {
      socket.setupComplete();
    });
    await settle();

    expect(tracks.length).toBe(1);
    expect(contexts.length).toBe(1);
    expect(tracks.filter((t) => !t.stopped).length).toBe(1);
    expect(contexts.filter((c) => !c.closed).length).toBe(1);
  });
});
