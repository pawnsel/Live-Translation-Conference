// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OUTPUT_WINDOW_SIZE, prepareOutputDocument, requestOutputWindow, useOutputWindow } from './useOutputWindow';

function fakeWindow() {
  const listeners = new Map<string, () => void>();
  const doc = document.implementation.createHTMLDocument('output');
  // jsdom implements none of the Fullscreen API, so the Output document gets
  // the part of it the hook uses: a fullscreenElement that the request/exit
  // calls move, and the fullscreenchange event the browser fires with it —
  // including when the viewer leaves fullscreen with Esc.
  let fullscreenElement: Element | null = null;
  Object.defineProperty(doc, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  const setFullscreen = (element: Element | null) => {
    fullscreenElement = element;
    doc.dispatchEvent(new Event('fullscreenchange'));
  };
  Object.assign(doc, { exitFullscreen: vi.fn(async () => setFullscreen(null)) });
  Object.assign(doc.documentElement, {
    requestFullscreen: vi.fn(async () => setFullscreen(doc.documentElement))
  });
  const win = {
    document: doc,
    closed: false,
    close: vi.fn(() => {
      win.closed = true;
    }),
    focus: vi.fn(),
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    fire: (type: string) => listeners.get(type)?.(),
    /** Fullscreen changed by something other than the app — Esc, the OS. */
    setFullscreen
  };
  return win;
}

/** requestFullscreen as the test installed it above. */
function fullscreenCalls(win: ReturnType<typeof fakeWindow>) {
  return (win.document.documentElement.requestFullscreen as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.head.replaceChildren();
});

// The console's document is the real jsdom document: it has an http:// URL,
// so relative stylesheet links resolve the way they do in the browser.
function addConsoleStyles() {
  document.head.innerHTML = '<style>.a{color:red}</style><link rel="stylesheet" href="/assets/index.css">';
}

describe('prepareOutputDocument', () => {
  it('copies the app stylesheets with absolute URLs and returns a mount point', () => {
    addConsoleStyles();
    const target = document.implementation.createHTMLDocument('output');

    const root = prepareOutputDocument(document, target);

    expect(target.head.querySelectorAll('style').length).toBe(1);
    const link = target.head.querySelector('link[rel="stylesheet"]')!;
    expect(link.getAttribute('href')).toMatch(/^https?:\/\/.+\/assets\/index\.css$/);
    expect(root.ownerDocument).toBe(target);
    expect(target.body.contains(root)).toBe(true);
  });

  it('does not pile up copies when a window is prepared twice', () => {
    addConsoleStyles();
    const target = document.implementation.createHTMLDocument('output');

    prepareOutputDocument(document, target);
    prepareOutputDocument(document, target);

    expect(target.head.querySelectorAll('style').length).toBe(1);
    expect(target.head.querySelectorAll('link').length).toBe(1);
    expect(target.body.children.length).toBe(1);
  });
});

describe('requestOutputWindow', () => {
  it('opens a named popup big enough to read before it is moved to the projector', () => {
    const popup = fakeWindow();
    const host = { open: vi.fn().mockReturnValue(popup) };

    expect(requestOutputWindow(host as unknown as Window)).toBe(popup);
    const [, name, features] = host.open.mock.calls[0] as [string, string, string];
    expect(name).toBe('live-translation-output');
    expect(features).toContain(`width=${OUTPUT_WINDOW_SIZE.width}`);
    expect(features).toContain(`height=${OUTPUT_WINDOW_SIZE.height}`);
  });

  // Document PiP would be the obvious window to reach for, and it is the
  // wrong one: Chrome blocks the Fullscreen API inside it.
  it('never asks for a Document Picture-in-Picture window', () => {
    const popup = fakeWindow();
    const host = { documentPictureInPicture: { requestWindow: vi.fn() }, open: vi.fn().mockReturnValue(popup) };

    requestOutputWindow(host as unknown as Window);

    expect(host.documentPictureInPicture.requestWindow).not.toHaveBeenCalled();
  });

  it('returns null when the popup is blocked', () => {
    const host = { open: vi.fn().mockReturnValue(null) };
    expect(requestOutputWindow(host as unknown as Window)).toBeNull();
  });
});

describe('useOutputWindow', () => {
  it('opens a window and exposes a container inside it', async () => {
    const popup = fakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const { result } = renderHook(() => useOutputWindow());

    await act(() => result.current.open());

    expect(result.current.isOpen).toBe(true);
    expect(result.current.container?.ownerDocument).toBe(popup.document);
  });

  it('reports a blocked popup', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderHook(() => useOutputWindow());

    await act(() => result.current.open());

    expect(result.current.isOpen).toBe(false);
    expect(result.current.error).toBe('blocked');
  });

  it('notices when the viewer closes the window', async () => {
    const popup = fakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const { result } = renderHook(() => useOutputWindow());
    await act(() => result.current.open());

    act(() => popup.fire('pagehide'));

    expect(result.current.isOpen).toBe(false);
    expect(result.current.container).toBeNull();
  });

  it('closes the window on request and on unmount', async () => {
    const popup = fakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const { result, unmount } = renderHook(() => useOutputWindow());
    await act(() => result.current.open());

    act(() => result.current.close());
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(result.current.isOpen).toBe(false);

    const again = fakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(again as unknown as Window);
    await act(() => result.current.open());
    unmount();
    expect(again.close).toHaveBeenCalledTimes(1);
  });

  it('focuses an already-open window instead of opening another', async () => {
    const popup = fakeWindow();
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const { result } = renderHook(() => useOutputWindow());

    await act(() => result.current.open());
    await act(() => result.current.open());

    expect(open).toHaveBeenCalledTimes(1);
    expect(popup.focus).toHaveBeenCalled();
  });

  it('ignores a second open() fired in the same tick as the first', async () => {
    // Two clicks in a row must not both go through: they would return the
    // same named window, and a second prepareOutputDocument call would
    // detach the node React is portalled into out from under it.
    const popup = fakeWindow();
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const { result } = renderHook(() => useOutputWindow());

    await act(async () => {
      const first = result.current.open();
      const second = result.current.open();
      await Promise.all([first, second]);
    });

    expect(open).toHaveBeenCalledTimes(1);
    expect(result.current.isOpen).toBe(true);
  });
});

describe('useOutputWindow fullscreen', () => {
  async function openWindow() {
    const popup = fakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const hook = renderHook(() => useOutputWindow());
    await act(() => hook.result.current.open());
    return { popup, ...hook };
  }

  it('starts with the Output window windowed', async () => {
    const { result } = await openWindow();
    expect(result.current.isFullscreen).toBe(false);
  });

  it('puts the Output document itself into fullscreen — the whole broadcast image, not the stage box', async () => {
    const { popup, result } = await openWindow();

    await act(async () => result.current.toggleFullscreen());

    expect(fullscreenCalls(popup)).toBe(1);
    expect(popup.document.fullscreenElement).toBe(popup.document.documentElement);
    expect(result.current.isFullscreen).toBe(true);
  });

  it('leaves fullscreen when toggled again', async () => {
    const { popup, result } = await openWindow();
    await act(async () => result.current.toggleFullscreen());

    await act(async () => result.current.toggleFullscreen());

    expect(popup.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(result.current.isFullscreen).toBe(false);
  });

  it('follows fullscreen left from outside the app, as Esc does', async () => {
    const { popup, result } = await openWindow();
    await act(async () => result.current.toggleFullscreen());

    act(() => popup.setFullscreen(null));

    expect(result.current.isFullscreen).toBe(false);
  });

  it('is no longer fullscreen once the window is gone', async () => {
    const { popup, result } = await openWindow();
    await act(async () => result.current.toggleFullscreen());

    act(() => popup.fire('pagehide'));

    expect(result.current.isFullscreen).toBe(false);
  });

  it('ignores a toggle with no Output window open', async () => {
    const { result } = renderHook(() => useOutputWindow());

    await act(async () => result.current.toggleFullscreen());

    expect(result.current.isFullscreen).toBe(false);
  });
});
