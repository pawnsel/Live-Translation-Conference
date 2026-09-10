/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/** Rough fixed USD→THB rate for display only — not a live exchange rate.
 *  Every cost in this app is computed in USD (see geminiCost.ts); this only
 *  converts the number shown to the user, rounded to whole baht. */
export const USD_TO_THB_RATE = 36;

export function usdToThb(usd: number): number {
  return Math.round(usd * USD_TO_THB_RATE);
}
