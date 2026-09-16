import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The slide window, shared into the console.
 *
 * Deliberately independent of the translation session: an operator sets the
 * share up before the meeting starts, and ending a session leaves it running.
 */

export type ShareStatus = 'idle' | 'sharing' | 'ended' | 'error';
export type ShareError = 'system-denied' | 'unsupported' | 'failed';

export interface ScreenShare {
  stream: MediaStream | null;
  status: ShareStatus;
  error: ShareError | null;
  /** The browser's name for what is shared, e.g. "Screen 2". */
  label: string;
  start: () => Promise<void>;
  stop: () => void;
}

// Chrome-only hints are passed through as-is; other browsers ignore them.
// Every surface this setup must not share is kept out of the picker, so the
// wrong choice is not one click away during an event:
//   selfBrowserSurface — the console's own tab, inside its own broadcast.
//   monitorTypeSurfaces — a whole display. The second one is showing the
//     Output window (the slide inside the slide, forever) and the first is
//     showing the console. Only a window or a tab is ever the answer.
//   surfaceSwitching — this one is not about the picker: it is the "Share
//     this tab instead" button Chrome puts in its sharing bar, which sits on
//     screen for the whole event and leads somewhere the operator must not
//     go. Excluding it also makes that bar shorter.
const DISPLAY_MEDIA_OPTIONS = {
  video: { frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  audio: false,
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'exclude',
  monitorTypeSurfaces: 'exclude'
} as DisplayMediaStreamOptions;

/**
 * Chrome rejects with NotAllowedError both when the operator closes the
 * picker and when macOS has not granted Screen Recording; only the message
 * tells them apart ("Permission denied" vs "Permission denied by system").
 */
export function classifyDisplayMediaError(err: unknown): 'cancelled' | 'system-denied' | 'failed' {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  const message = typeof err === 'object' && err !== null ? String((err as { message?: unknown }).message ?? '') : '';
  if (name === 'NotAllowedError') return /system/i.test(message) ? 'system-denied' : 'cancelled';
  return 'failed';
}

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => {
    track.onended = null;
    track.stop();
  });
}

export function useScreenShare(): ScreenShare {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<ShareStatus>('idle');
  const [error, setError] = useState<ShareError | null>(null);
  const [label, setLabel] = useState('');
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(true);

  const release = useCallback((next: ShareStatus) => {
    stopTracks(streamRef.current);
    streamRef.current = null;
    setStream(null);
    setStatus(next);
    // A banner from a previous failure (e.g. macOS system-denied) must not
    // survive a stop — StreamPanel renders error banners outside the sharing
    // ternary, so a stale error/label here would show forever.
    setError(null);
    setLabel('');
  }, []);

  const start = useCallback(async () => {
    const mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    if (!mediaDevices?.getDisplayMedia) {
      setError('unsupported');
      setStatus('error');
      return;
    }

    let next: MediaStream;
    try {
      next = await mediaDevices.getDisplayMedia(DISPLAY_MEDIA_OPTIONS);
    } catch (err) {
      const kind = classifyDisplayMediaError(err);
      if (kind === 'cancelled') return;
      setError(kind);
      // A share that is already running keeps running; only say "error"
      // when there is nothing on screen.
      if (!streamRef.current) setStatus('error');
      return;
    }

    if (!mountedRef.current) {
      stopTracks(next);
      return;
    }

    stopTracks(streamRef.current);
    streamRef.current = next;
    const [track] = next.getVideoTracks();
    if (track) {
      // Chrome's own "Stop sharing" button, or the display being unplugged.
      track.onended = () => {
        if (streamRef.current === next) release('ended');
      };
    }
    setStream(next);
    setLabel(track?.label ?? '');
    setError(null);
    setStatus('sharing');
  }, [release]);

  const stop = useCallback(() => release('idle'), [release]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopTracks(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  return { stream, status, error, label, start, stop };
}
