import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The window OBS captures.
 *
 * Opened by the console and rendered into with a React portal, so it shares
 * the console's state instead of syncing a copy of it. Document
 * Picture-in-Picture is preferred because it stays on top and cannot be
 * minimised — and a minimised Chrome window stops painting, which OBS
 * captures as a frozen frame. A popup is the fallback.
 */

// Decided by the spike (spikes/stream-output-spike.html): whether OBS Window
// Capture reliably captures a Document PiP window on macOS and Windows.
export const PREFER_DOCUMENT_PIP = true;
export const OUTPUT_WINDOW_SIZE = { width: 960, height: 540 };

export type OutputWindowKind = 'pip' | 'popup';
export type OutputWindowError = 'blocked' | 'failed';

export interface OutputWindow {
  /** Where to portal the stage; null while no window is open. */
  container: HTMLElement | null;
  kind: OutputWindowKind | null;
  isOpen: boolean;
  error: OutputWindowError | null;
  /** Must be called from a click handler — both window kinds need a user gesture. */
  open: () => Promise<void>;
  close: () => void;
}

interface DocumentPictureInPictureApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

export async function requestOutputWindow(
  host: Window,
  preferPip: boolean
): Promise<{ win: Window; kind: OutputWindowKind } | null> {
  const pip = (host as Window & { documentPictureInPicture?: DocumentPictureInPictureApi }).documentPictureInPicture;
  if (preferPip && pip) {
    return { win: await pip.requestWindow(OUTPUT_WINDOW_SIZE), kind: 'pip' };
  }
  const win = host.open(
    '',
    'live-translation-output',
    `popup,width=${OUTPUT_WINDOW_SIZE.width},height=${OUTPUT_WINDOW_SIZE.height}`
  );
  return win ? { win, kind: 'popup' } : null;
}

/**
 * Gives the Output document the console's styles and a bare black body, and
 * returns the element to portal into. Links are rewritten to absolute URLs:
 * the new document's base URL is not guaranteed to be the console's.
 */
export function prepareOutputDocument(source: Document, target: Document): HTMLElement {
  target.title = 'Live Translation — Output';
  target.head.querySelectorAll('[data-output-style]').forEach((node) => node.remove());
  source.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
    const copy = node.cloneNode(true) as Element;
    if (node.tagName === 'LINK') copy.setAttribute('href', (node as HTMLLinkElement).href);
    copy.setAttribute('data-output-style', '');
    target.head.appendChild(target.importNode(copy, true));
  });
  target.body.replaceChildren();
  target.body.style.cssText = 'margin:0;background:#000;overflow:hidden;';
  const root = target.createElement('div');
  root.id = 'output-root';
  target.body.appendChild(root);
  return root;
}

export function useOutputWindow(preferPip: boolean = PREFER_DOCUMENT_PIP): OutputWindow {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [kind, setKind] = useState<OutputWindowKind | null>(null);
  const [error, setError] = useState<OutputWindowError | null>(null);
  const winRef = useRef<Window | null>(null);

  const forget = useCallback(() => {
    winRef.current = null;
    setContainer(null);
    setKind(null);
  }, []);

  const close = useCallback(() => {
    const win = winRef.current;
    forget();
    if (win && !win.closed) win.close();
  }, [forget]);

  const open = useCallback(async () => {
    const existing = winRef.current;
    if (existing && !existing.closed) {
      existing.focus();
      return;
    }

    let result: Awaited<ReturnType<typeof requestOutputWindow>>;
    try {
      result = await requestOutputWindow(window, preferPip);
    } catch {
      setError('failed');
      return;
    }
    if (!result) {
      setError('blocked');
      return;
    }

    const { win } = result;
    const root = prepareOutputDocument(document, win.document);
    winRef.current = win;
    win.addEventListener('pagehide', () => {
      if (winRef.current === win) forget();
    });
    setError(null);
    setKind(result.kind);
    setContainer(root);
  }, [preferPip, forget]);

  useEffect(
    () => () => {
      const win = winRef.current;
      winRef.current = null;
      if (win && !win.closed) win.close();
    },
    []
  );

  return { container, kind, isOpen: container !== null, error, open, close };
}
