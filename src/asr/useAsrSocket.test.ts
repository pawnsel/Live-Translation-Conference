// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ping } from './commands';
import { useAsrSocket } from './useAsrSocket';
import type { AnyFrame } from './protocol';

// Must match the implementation's RECONNECT_DELAY_MS (src/asr/useAsrSocket.ts).
// Not exported, so pinned here; if the implementation's delay changes, update
// this constant to match.
const RECONNECT_DELAY_MS = 2000;

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

  // The five fold tests below deliberately override the golden fixture's
  // data with values that differ from what session_welcome.json already
  // seeds. If a fixture's broadcast value happens to equal the welcome seed
  // (as session_languages.json, gate_state.json and session_mode.json all
  // do out of the box), a test asserting against that value alone would
  // still pass even if the corresponding switch case were deleted entirely
  // and fell through to `default: break`. Overriding to a value that can
  // only be present via the fold makes each test actually discriminate.
  // This mirrors the override technique already used in captions.test.ts
  // (spread the parsed fixture, override `data`) and operates on an
  // in-memory copy — it never touches the fixture JSON files themselves.

  it('folds a session.languages broadcast into welcome', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    const languages = golden('session_languages') as any;
    const override = {
      ...languages,
      data: { ...languages.data, source_lang: 'en', target_lang: 'th', asr_switchable: false },
    };

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].receive(golden('session_welcome'));
      FakeWebSocket.instances[0].receive(override);
    });

    // Without folding, the console would send set_languages, get the
    // confirming broadcast, and still render the old pair forever.
    expect(result.current.welcome?.source_lang).toBe('en');
    expect(result.current.welcome?.target_lang).toBe('th');
    expect(result.current.welcome?.asr_switchable).toBe(false);
  });

  it('folds a session.paused broadcast into welcome', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].receive(golden('session_welcome'));
      FakeWebSocket.instances[0].receive(golden('session_paused'));
    });

    // session_paused.json is `true`; the welcome seed is `false` — this
    // fixture already discriminates without an override.
    expect(result.current.welcome?.paused).toBe((golden('session_paused') as any).data.paused);
  });

  it('folds a session.mode broadcast into welcome', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    const mode = golden('session_mode') as any;
    const override = { ...mode, data: { ...mode.data, mode: 'chunk' } };

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].receive(golden('session_welcome'));
      FakeWebSocket.instances[0].receive(override);
    });

    expect(result.current.welcome?.mode).toBe('chunk');
  });

  it('folds a gate.state broadcast into welcome', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    const gate = golden('gate_state') as any;
    const override = { ...gate, data: { min_words: 7, min_interval_ms: 950 } };

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].receive(golden('session_welcome'));
      FakeWebSocket.instances[0].receive(override);
    });

    expect(result.current.welcome?.gate).toEqual({ min_words: 7, min_interval_ms: 950 });
  });

  it('folds a report.state broadcast into welcome', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    const report = golden('report_state') as any;
    const override = { ...report, data: { active: false, count: 99 } };

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].receive(golden('session_welcome'));
      FakeWebSocket.instances[0].receive(override);
    });

    expect(result.current.welcome?.report).toEqual({ active: false, count: 99 });
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

  it('reconnects after a retryable close code (4401)', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
      expect(FakeWebSocket.instances).toHaveLength(1);

      act(() => {
        FakeWebSocket.instances[0].open();
        FakeWebSocket.instances[0].serverClose(4401);
      });

      // No reconnect before the delay elapses.
      expect(FakeWebSocket.instances).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
      });

      expect(FakeWebSocket.instances).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
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

  it('closes the socket on unmount', async () => {
    const { unmount } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());

    act(() => unmount());

    expect(socket.readyState).toBe(3);
  });

  it('does not reconnect after unmount even with a pending retry timer', async () => {
    vi.useFakeTimers();
    try {
      const { unmount } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
      expect(FakeWebSocket.instances).toHaveLength(1);

      act(() => {
        FakeWebSocket.instances[0].open();
        // Retryable close — schedules a reconnect timer.
        FakeWebSocket.instances[0].serverClose(4401);
      });

      act(() => unmount());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS + 1000);
      });

      // The pending timer must have been cleared by cleanup; a 12-hour
      // console cannot leak a reconnect against an unmounted component.
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
