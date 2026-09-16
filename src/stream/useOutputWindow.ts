import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The window the audience sees, dragged onto the second display and put
 * full screen there.
 *
 * Opened by the console and rendered into with a React portal, so it shares
 * the console's state instead of syncing a copy of it. A plain popup, not
 * Document Picture-in-Picture: Chrome blocks the Fullscreen API inside a PiP
 * window, and filling the projector is the whole point of this window.
 */

/** Big enough to read while it is still on the console's display. */
export const OUTPUT_WINDOW_SIZE = { width: 1280, height: 720 };

export type OutputWindowError = 'blocked' | 'failed';

export interface OutputWindow {
  /** Where to portal the stage; null while no window is open. */
  container: HTMLElement | null;
  isOpen: boolean;
  error: OutputWindowError | null;
  /** Must be called from a click handler — opening a window needs a user gesture. */
  open: () => Promise<void>;
  close: () => void;
  /** The Output window fills the display it sits on. */
  isFullscreen: boolean;
  /**
   * Must be called from a click handler INSIDE the Output window: the
   * Fullscreen API wants a user gesture in that window, and a click in the
   * console does not count.
   */
  toggleFullscreen: () => void;
}

/** null when the browser blocked the popup. */
export function requestOutputWindow(host: Window): Window | null {
  return host.open(
    '',
    'live-translation-output',
    `popup,width=${OUTPUT_WINDOW_SIZE.width},height=${OUTPUT_WINDOW_SIZE.height}`
  );
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

export function useOutputWindow(): OutputWindow {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<OutputWindowError | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const winRef = useRef<Window | null>(null);

  const forget = useCallback(() => {
    winRef.current = null;
    setContainer(null);
    setIsFullscreen(false);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const win = winRef.current;
    if (!win || win.closed) return;
    const doc = win.document;
    // Fullscreen can be refused (no user gesture left, a permissions policy)
    // and the rejection is nothing to act on: `isFullscreen` follows the
    // document's own fullscreenchange event, so a refusal simply leaves the
    // window as it was and the button still reads "full screen".
    const done = doc.fullscreenElement ? doc.exitFullscreen?.() : doc.documentElement.requestFullscreen?.();
    done?.catch(() => undefined);
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

    let opened: Window | null;
    try {
      opened = requestOutputWindow(window);
    } catch {
      setError('failed');
      return;
    }
    if (!opened) {
      setError('blocked');
      return;
    }
    const win = opened;

    const root = prepareOutputDocument(document, win.document);
    winRef.current = win;
    win.addEventListener('pagehide', () => {
      if (winRef.current === win) forget();
    });
    // Listened for rather than assumed from toggleFullscreen: the viewer can
    // also leave fullscreen with Esc, and the button must not go on claiming
    // the window is still filling the display.
    win.document.addEventListener('fullscreenchange', () => {
      if (winRef.current === win) setIsFullscreen(Boolean(win.document.fullscreenElement));
    });
    setError(null);
    setContainer(root);
  }, [forget]);

  useEffect(
    () => () => {
      const win = winRef.current;
      winRef.current = null;
      if (win && !win.closed) win.close();
    },
    []
  );

  return { container, isOpen: container !== null, error, open, close, isFullscreen, toggleFullscreen };
}
