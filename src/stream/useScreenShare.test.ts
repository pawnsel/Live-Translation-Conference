// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyDisplayMediaError, useScreenShare } from './useScreenShare';

type FakeTrack = { label: string; stop: ReturnType<typeof vi.fn>; onended: (() => void) | null };

function fakeStream(label = 'Screen 2') {
  const track: FakeTrack = { label, stop: vi.fn(), onended: null };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}

const domError = (name: string, message: string) => Object.assign(new Error(message), { name });

let getDisplayMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getDisplayMedia = vi.fn();
  Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia }, configurable: true });
});

afterEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
});

describe('classifyDisplayMediaError', () => {
  it('reads a plain NotAllowedError as the operator cancelling the picker', () => {
    expect(classifyDisplayMediaError(domError('NotAllowedError', 'Permission denied'))).toBe('cancelled');
  });

  it('reads "denied by system" as the macOS Screen Recording permission', () => {
    expect(classifyDisplayMediaError(domError('NotAllowedError', 'Permission denied by system'))).toBe('system-denied');
  });

  it('reads anything else as a failure', () => {
    expect(classifyDisplayMediaError(domError('NotReadableError', 'Could not start video source'))).toBe('failed');
    expect(classifyDisplayMediaError('boom')).toBe('failed');
  });
});

describe('useScreenShare', () => {
  it('shares a display and reports its label', async () => {
    const { stream } = fakeStream('Screen 2');
    getDisplayMedia.mockResolvedValue(stream);
    const { result } = renderHook(() => useScreenShare());

    await act(() => result.current.start());

    expect(result.current.status).toBe('sharing');
    expect(result.current.stream).toBe(stream);
    expect(result.current.label).toBe('Screen 2');
    expect(result.current.error).toBeNull();
  });

  it('does nothing when the operator cancels the picker', async () => {
    getDisplayMedia.mockRejectedValue(domError('NotAllowedError', 'Permission denied'));
    const { result } = renderHook(() => useScreenShare());

    await act(() => result.current.start());

    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('reports the macOS permission problem', async () => {
    getDisplayMedia.mockRejectedValue(domError('NotAllowedError', 'Permission denied by system'));
    const { result } = renderHook(() => useScreenShare());

    await act(() => result.current.start());

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('system-denied');
  });

  it('reports a browser with no screen sharing', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    const { result } = renderHook(() => useScreenShare());

    await act(() => result.current.start());

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('unsupported');
  });

  it('marks the share ended when the track ends on its own', async () => {
    const { stream, track } = fakeStream();
    getDisplayMedia.mockResolvedValue(stream);
    const { result } = renderHook(() => useScreenShare());
    await act(() => result.current.start());

    act(() => track.onended?.());

    expect(result.current.status).toBe('ended');
    expect(result.current.stream).toBeNull();
  });

  it('stops the tracks when the operator stops sharing', async () => {
    const { stream, track } = fakeStream();
    getDisplayMedia.mockResolvedValue(stream);
    const { result } = renderHook(() => useScreenShare());
    await act(() => result.current.start());

    act(() => result.current.stop());

    expect(track.stop).toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
    expect(result.current.stream).toBeNull();
  });

  it('replaces a running share and stops the old one', async () => {
    const first = fakeStream('Screen 1');
    const second = fakeStream('Screen 2');
    getDisplayMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    const { result } = renderHook(() => useScreenShare());

    await act(() => result.current.start());
    await act(() => result.current.start());

    expect(first.track.stop).toHaveBeenCalled();
    expect(result.current.stream).toBe(second.stream);
    // The old track ending later must not end the new share.
    act(() => first.track.onended?.());
    expect(result.current.status).toBe('sharing');
  });

  it('keeps a running share when a second attempt fails', async () => {
    const { stream } = fakeStream();
    getDisplayMedia.mockResolvedValueOnce(stream).mockRejectedValueOnce(domError('NotReadableError', 'x'));
    const { result } = renderHook(() => useScreenShare());

    await act(() => result.current.start());
    await act(() => result.current.start());

    expect(result.current.status).toBe('sharing');
    expect(result.current.stream).toBe(stream);
    expect(result.current.error).toBe('failed');
  });

  it('clears a stale error and label when the operator stops sharing', async () => {
    // A denied attempt first (sets error, no stream yet)...
    getDisplayMedia.mockRejectedValueOnce(domError('NotAllowedError', 'Permission denied by system'));
    const { result } = renderHook(() => useScreenShare());
    await act(() => result.current.start());
    expect(result.current.error).toBe('system-denied');

    // ...then a successful share and a stop. Neither the earlier error nor
    // the label from this share may survive the stop — StreamPanel renders
    // error banners outside the "sharing" ternary, so a stale one would show
    // as a permanent, misleading banner.
    const { stream } = fakeStream('Screen 2');
    getDisplayMedia.mockResolvedValueOnce(stream);
    await act(() => result.current.start());
    expect(result.current.error).toBeNull();
    expect(result.current.label).toBe('Screen 2');

    act(() => result.current.stop());

    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
    expect(result.current.label).toBe('');
  });

  it('stops the tracks when the console unmounts', async () => {
    const { stream, track } = fakeStream();
    getDisplayMedia.mockResolvedValue(stream);
    const { result, unmount } = renderHook(() => useScreenShare());
    await act(() => result.current.start());

    unmount();

    expect(track.stop).toHaveBeenCalled();
  });
});
