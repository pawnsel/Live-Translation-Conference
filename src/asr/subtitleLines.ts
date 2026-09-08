/**
 * YouTube-style subtitle paging.
 *
 * A live caption grows one fragment at a time and would otherwise stack up
 * into a wall of text. Real subtitles never do that: they fill at most two
 * lines and, the moment a word no longer fits, the block is wiped and the
 * overflowing word starts a fresh block.
 *
 * The geometry lives in the DOM, so the rule is expressed against a
 * `measure` callback (how many lines does this string occupy?) — that keeps
 * the paging decision itself pure and unit-testable.
 */

/** How many lines the given text occupies at the subtitle's width. */
export type MeasureLines = (text: string) => number;

// A cut is snapped back to a word boundary only when that boundary is late
// enough in the chunk. Snapping a nearly-empty line back to its first space
// would page far too often; Thai has no spaces at all, so it always cuts by
// character.
const MIN_SNAP_RATIO = 0.4;

/**
 * Longest prefix of `text` from `start` that still fits in `maxLines`,
 * as a character count. Returns 0 when nothing fits.
 */
export function longestFittingLength(text: string, start: number, maxLines: number, measure: MeasureLines): number {
  let lo = 1;
  let hi = text.length - start;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (measure(text.slice(start, start + mid)) <= maxLines) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best <= 0) return 0;

  const chunk = text.slice(start, start + best);
  const space = chunk.lastIndexOf(' ');
  if (space >= Math.floor(best * MIN_SNAP_RATIO)) return space + 1;
  return best;
}

/**
 * Where the currently visible subtitle block should start, given the full
 * accumulated text and where the block started before. Advances a whole
 * block at a time (never scrolls line by line) so the reader gets a clean
 * new page instead of drifting text.
 */
export function fitSubtitlePage(text: string, start: number, maxLines: number, measure: MeasureLines): number {
  let s = Math.min(Math.max(start, 0), text.length);
  // Bounded: each pass consumes at least one character, and a long caption
  // is capped upstream — the guard only protects against a measure() that
  // never reports a fit.
  for (let guard = 0; guard < 64; guard++) {
    if (measure(text.slice(s)) <= maxLines) return s;
    const fit = longestFittingLength(text, s, maxLines, measure);
    // Not even one character fits (a container with no width yet) — leaving
    // the block where it is beats looping.
    if (fit <= 0) return s;
    s += fit;
  }
  return s;
}

/**
 * Whether `next` is the same caption still being spoken (fragments only ever
 * get appended), or a brand new one that must reset the block.
 */
export function isContinuation(previous: string, next: string): boolean {
  return next.length >= previous.length && next.startsWith(previous);
}
