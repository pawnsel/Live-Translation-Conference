/** localStorage that cannot throw.
 *
 *  Some browsers throw on the `localStorage` accessor itself when site data
 *  is blocked, so even reaching for it needs a try/catch. Everything stored
 *  through here is per-device UI preference — which project is open, which
 *  microphone to use — never data. Losing it is cosmetic.
 */

export function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readSetting(key: string): string | null {
  try {
    return safeStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Writes, or clears the key when `value` is null. Returns whether it stuck,
 *  for the one caller (projectStore) that reports storage failures. */
export function writeSetting(key: string, value: string | null): boolean {
  const storage = safeStorage();
  if (!storage) return false;
  try {
    if (value) storage.setItem(key, value);
    else storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
