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

// Whether OBS Window Capture reliably captures a Document PiP window on
// macOS and Windows — see docs/stream-output-checklist.md for the answer and
// how it was verified.
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
  // Guards the gap between a click and the first await below. Without it, two
  // clicks before `requestOutputWindow` resolves both go through: on the
  // popup path they return the same named window, and the second
  // `prepareOutputDocument` call detaches the node React is portalled into
  // out from under it.
  const openingRef = useRef(false);

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
    // A second click before the first `await` below resolves must not start
    // a second request — see the comment on openingRef above.
    if (openingRef.current) return;
    openingRef.current = true;

    try {
      let result: Awaited<ReturnType<typeof requestOutputWindow>>;
      try {
        result = await requestOutputWindow(window, preferPip);
      } catch {
        // Document PiP can reject for reasons a redeploy can't fix on event
        // day — permissions policy, an enterprise policy, a consumed user
        // gesture, InvalidStateError. Retrying once as a plain popup turns
        // most of those into the actionable 'blocked' ("allow popups")
        // message instead of a dead end.
        if (!preferPip) {
          setError('failed');
          return;
        }
        try {
          result = await requestOutputWindow(window, false);
        } catch {
          setError('failed');
          return;
        }
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
    } finally {
      openingRef.current = false;
    }
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
