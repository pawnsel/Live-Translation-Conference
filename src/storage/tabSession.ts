/** Which recording session THIS TAB owns, remembered across a reload.
 *
 *  `sessionStorage`, not `localStorage`, and the distinction is the whole
 *  point: it survives a refresh but dies with the tab, and is not shared with
 *  any other tab. That is exactly the fact needed here — "the page you are
 *  looking at is the same tab that started session X, and it is not recording
 *  it any more" — which no heartbeat can express, because a tab that
 *  refreshes leaves a heartbeat only seconds old.
 *
 *  Without this a refreshed session sits marked "recording" for the whole
 *  staleness window: it cannot be summarised, and it blocks switching
 *  projects. See data/staleSessions.ts.
 */

const TAB_SESSION_KEY = 'ai_translate_tab_session';

function safeSessionStorage(): Storage | undefined {
  try {
    // The accessor itself throws in some browsers when site data is blocked,
    // so even reaching for it needs the guard.
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

/** Called when recording starts. */
export function rememberTabSession(asrSessionId: string): void {
  try {
    safeSessionStorage()?.setItem(TAB_SESSION_KEY, asrSessionId);
  } catch {
    // Losing this only costs the fast path — the heartbeat still closes the
    // session, just a couple of minutes later.
  }
}

/** Called when recording stops normally, so nothing is left to reclaim. */
export function forgetTabSession(): void {
  try {
    safeSessionStorage()?.removeItem(TAB_SESSION_KEY);
  } catch {
    // As above.
  }
}

/** The session this tab was recording before the page reloaded, if any. */
export function loadTabSession(): string | null {
  try {
    return safeSessionStorage()?.getItem(TAB_SESSION_KEY) ?? null;
  } catch {
    return null;
  }
}
