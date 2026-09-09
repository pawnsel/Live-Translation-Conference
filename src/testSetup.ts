/** Works around a Node/jsdom conflict over the `localStorage` global.
 *
 *  Node (from v22, stabilizing in later versions) defines its own global
 *  `localStorage` accessor backed by `--localstorage-file`. When that flag
 *  is absent the accessor exists but returns `undefined`. Vitest's jsdom
 *  environment normally copies `window.localStorage` onto the Node global,
 *  but its copy step skips any key Node already owns — so with a newer
 *  Node, `localStorage` (and `sessionStorage`) end up pointing at Node's
 *  disabled accessor instead of jsdom's working implementation, and any
 *  test or app code that reads the bare `localStorage` global (rather than
 *  `window.localStorage`) sees `undefined`.
 *
 *  jsdom's own storage still works fine — vitest exposes the live JSDOM
 *  instance as `globalThis.jsdom` — so this just repoints the global
 *  accessor at it, once jsdom's environment setup has run.
 */

const g = globalThis as typeof globalThis & { jsdom?: { window: Window } };

if (g.jsdom) {
  Object.defineProperty(globalThis, 'localStorage', {
    get: () => g.jsdom!.window.localStorage,
    configurable: true
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    get: () => g.jsdom!.window.sessionStorage,
    configurable: true
  });
}
