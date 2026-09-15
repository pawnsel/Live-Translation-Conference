/** Whether the desktop settings sidebar is folded — a per-device UI
 *  preference, same spirit as micStore. */

import { readSetting, writeSetting } from './safeStorage';

export const SIDEBAR_COLLAPSED_KEY = 'ai_translate_sidebar_collapsed';

export function loadSidebarCollapsed(): boolean {
  return readSetting(SIDEBAR_COLLAPSED_KEY) === '1';
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  writeSetting(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : null);
}
