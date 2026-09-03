// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ping } from './commands';
import { useAsrSocket } from './useAsrSocket';
import type { AnyFrame } from './protocol';

function golden(name: string): AnyFrame {
  return JSON.parse(readFileSync(join(process.cwd(), 'src/asr/__fixtures__/protocol', `${name}.json`), 'utf8'));
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string, public protocols?: string[]) {
    FakeWebSocket.instances.push(this);
  }
  send(payload: string) { this.sent.push(payload); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  serverClose(code: number) { this.readyState = 3; this.onclose?.({ code }); }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
});
afterEach(() => vi.unstubAllGlobals());

const base = { backendUrl: 'http://localhost:8765', sessionId: 'sess_ab12', token: 'op-1' };

describe('useAsrSocket', () => {
  it('connects to the session path with the bearer subprotocol', async () => {
    renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe('ws://localhost:8765/ws/sess_ab12');
    // The token travels in Sec-WebSocket-Protocol, never in the URL.
    expect(socket.protocols).toEqual(['bearer', 'op-1']);
    expect(socket.url).not.toContain('op-1');
  });

  it('does not connect without a session id or a token', () => {
    renderHook(() => useAsrSocket({ ...base, sessionId: null, onFrame: () => {} }));
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('stores session.welcome and reports the socket open', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].receive(golden('session_welcome'));
    });

    expect(result.current.status).toBe('open');
    expect(result.current.welcome?.source_lang).toBe('th');
    expect(result.current.welcome?.gate.min_words).toBe(3);
  });

  it('forwards every frame to onFrame', async () => {
    const onFrame = vi.fn();
    renderHook(() => useAsrSocket({ ...base, onFrame }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].receive(golden('caption_final'));
    });

    expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ type: 'caption.final' }));
  });

  it('folds a session.languages broadcast into welcome', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].receive(golden('session_welcome'));
      FakeWebSocket.instances[0].receive(golden('session_languages'));
    });

    // Without folding, the console would send set_languages, get the
    // confirming broadcast, and still render the old pair forever.
    expect(result.current.welcome?.source_lang).toBe(
      (golden('session_languages') as any).data.source_lang,
    );
    expect(result.current.welcome?.target_lang).toBe(
      (golden('session_languages') as any).data.target_lang,
    );
  });

  it('folds a session.paused broadcast into welcome', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].receive(golden('session_welcome'));
      FakeWebSocket.instances[0].receive(golden('session_paused'));
    });

    expect(result.current.welcome?.paused).toBe((golden('session_paused') as any).data.paused);
  });

  it('folds a gate.state broadcast into welcome', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].receive(golden('session_welcome'));
      FakeWebSocket.instances[0].receive(golden('gate_state'));
    });

    expect(result.current.welcome?.gate).toEqual((golden('gate_state') as any).data);
  });

  it('ignores a state broadcast that arrives before welcome', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].receive(golden('session_paused'));
    });

    // There is no partial WelcomePayload to build on, and inventing one would
    // put made-up languages on screen.
    expect(result.current.welcome).toBeNull();
  });

  it('surfaces control.error with a readable message', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].receive(golden('control_error'));
    });

    expect(result.current.error).toMatch(/operator/i);
  });

  it('flags a 4404 close as a gone session', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].serverClose(4404);
    });

    expect(result.current.sessionGone).toBe(true);
    expect(result.current.status).toBe('closed');
  });

  it('never reconnects after a 4404', async () => {
    renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].serverClose(4404);
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('sends a command as JSON on the open socket', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0].open());

    act(() => result.current.send(ping('sess_ab12')));

    const sent = JSON.parse(FakeWebSocket.instances[0].sent[0]);
    expect(sent.type).toBe('control.ping');
    expect(sent.session).toBe('sess_ab12');
  });

  it('ignores a malformed text frame instead of throwing', async () => {
    const onFrame = vi.fn();
    renderHook(() => useAsrSocket({ ...base, onFrame }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].onmessage?.({ data: 'not json' });
    });

    expect(onFrame).not.toHaveBeenCalled();
  });
});
