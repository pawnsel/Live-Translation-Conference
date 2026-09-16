// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareOutputDocument, requestOutputWindow, useOutputWindow } from './useOutputWindow';

function fakeWindow() {
  const listeners = new Map<string, () => void>();
  const win = {
    document: document.implementation.createHTMLDocument('output'),
    closed: false,
    close: vi.fn(() => {
      win.closed = true;
    }),
    focus: vi.fn(),
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    fire: (type: string) => listeners.get(type)?.()
  };
  return win;
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
  it('uses Document PiP when preferred and available', async () => {
    const pipWin = fakeWindow();
    const host = { documentPictureInPicture: { requestWindow: vi.fn().mockResolvedValue(pipWin) }, open: vi.fn() };
    const result = await requestOutputWindow(host as unknown as Window, true);
    expect(result).toEqual({ win: pipWin, kind: 'pip' });
    expect(host.open).not.toHaveBeenCalled();
  });

  it('falls back to a popup without Document PiP', async () => {
    const popup = fakeWindow();
    const host = { open: vi.fn().mockReturnValue(popup) };
    const result = await requestOutputWindow(host as unknown as Window, true);
    expect(result).toEqual({ win: popup, kind: 'popup' });
  });

  it('uses a popup when PiP is not preferred', async () => {
    const popup = fakeWindow();
    const host = { documentPictureInPicture: { requestWindow: vi.fn() }, open: vi.fn().mockReturnValue(popup) };
    const result = await requestOutputWindow(host as unknown as Window, false);
    expect(result?.kind).toBe('popup');
    expect(host.documentPictureInPicture.requestWindow).not.toHaveBeenCalled();
  });

  it('returns null when the popup is blocked', async () => {
    const host = { open: vi.fn().mockReturnValue(null) };
    expect(await requestOutputWindow(host as unknown as Window, false)).toBeNull();
  });
});

describe('useOutputWindow', () => {
  it('opens a window and exposes a container inside it', async () => {
    const popup = fakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const { result } = renderHook(() => useOutputWindow(false));

    await act(() => result.current.open());

    expect(result.current.isOpen).toBe(true);
    expect(result.current.kind).toBe('popup');
    expect(result.current.container?.ownerDocument).toBe(popup.document);
  });

  it('reports a blocked popup', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderHook(() => useOutputWindow(false));

    await act(() => result.current.open());

    expect(result.current.isOpen).toBe(false);
    expect(result.current.error).toBe('blocked');
  });

  it('notices when the viewer closes the window', async () => {
    const popup = fakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const { result } = renderHook(() => useOutputWindow(false));
    await act(() => result.current.open());

    act(() => popup.fire('pagehide'));

    expect(result.current.isOpen).toBe(false);
    expect(result.current.container).toBeNull();
  });

  it('closes the window on request and on unmount', async () => {
    const popup = fakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const { result, unmount } = renderHook(() => useOutputWindow(false));
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
    const { result } = renderHook(() => useOutputWindow(false));

    await act(() => result.current.open());
    await act(() => result.current.open());

    expect(open).toHaveBeenCalledTimes(1);
    expect(popup.focus).toHaveBeenCalled();
  });

  it('ignores a second open() fired before the first settles', async () => {
    // Two clicks before the first `await` inside open() resolves must not
    // both go through: on the popup path they would return the same named
    // window, and a second prepareOutputDocument call would detach the node
    // React is portalled into out from under it.
    const popup = fakeWindow();
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const { result } = renderHook(() => useOutputWindow(false));

    await act(async () => {
      const first = result.current.open();
      const second = result.current.open();
      await Promise.all([first, second]);
    });

    expect(open).toHaveBeenCalledTimes(1);
    expect(result.current.isOpen).toBe(true);
  });

  it('retries as a popup when the Document PiP request rejects', async () => {
    const requestWindow = vi.fn().mockRejectedValue(new Error('InvalidStateError'));
    Object.defineProperty(window, 'documentPictureInPicture', { value: { requestWindow }, configurable: true });
    const popup = fakeWindow();
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const { result } = renderHook(() => useOutputWindow(true));

    try {
      await act(() => result.current.open());

      expect(requestWindow).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledTimes(1);
      expect(result.current.isOpen).toBe(true);
      expect(result.current.kind).toBe('popup');
      expect(result.current.error).toBeNull();
    } finally {
      delete (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture;
    }
  });

  it('reports a blocked popup — not an unrecoverable failure — when the PiP retry is also blocked', async () => {
    const requestWindow = vi.fn().mockRejectedValue(new Error('permissions policy'));
    Object.defineProperty(window, 'documentPictureInPicture', { value: { requestWindow }, configurable: true });
    vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderHook(() => useOutputWindow(true));

    try {
      await act(() => result.current.open());

      expect(result.current.error).toBe('blocked');
      expect(result.current.isOpen).toBe(false);
    } finally {
      delete (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture;
    }
  });
});
