/**
 * The rolling caption stack — song-lyric captions.
 *
 * One row per utterance: the sentence being spoken sits on the bottom row and
 * finished ones climb, oldest off the top. Getting the SHIFTS right is the
 * whole problem, and it is not obvious from the live state:
 *
 *  - a caption closing is not a shift (the live row simply firms up from
 *    partial text into the final sentence),
 *  - a new utterance starting IS a shift, even when the caption before it
 *    closed in the same breath,
 *  - an utterance that produces no translation at all is not a shift and must
 *    not pull an older line back down.
 *
 * So the stack is derived from ONE number — which utterance owns the bottom
 * row — rather than from "is a partial in flight". Live partials belong to the
 * utterance after the newest committed one: the capture hook hands out one seq
 * per closed caption, in order, and an utterance with no text at all never
 * takes a number, so that seq is knowable before the caption exists.
 */

/** A committed caption, as far as the stack is concerned. */
export interface StackLine {
  seq: number;
  targetText: string;
}

export interface CaptionRow {
  /** Stable per utterance — the live row keeps its key as its text commits. */
  key: string;
  /** The utterance on this row; -1 for a slot with nothing in it yet. */
  seq: number;
  text: string;
}

/** Which utterance owns the bottom row. */
export function activeUtteranceSeq(newestSeq: number, hasPartial: boolean): number {
  return hasPartial ? newestSeq + 1 : newestSeq;
}

/**
 * The rows to render, oldest first. Always exactly `rows` long — empty slots
 * included — so the block is its full height from the very first word.
 */
export function buildCaptionRows(opts: {
  /** Committed captions in seq order. */
  lines: StackLine[];
  activeSeq: number;
  /** Text of the utterance still being spoken, when one is. */
  liveText: string;
  hasPartial: boolean;
  rows?: number;
}): CaptionRow[] {
  const { lines, activeSeq, liveText, hasPartial, rows = 3 } = opts;

  const active = lines.find((line) => line.seq === activeSeq) ?? null;
  const text = hasPartial ? liveText : (active?.targetText ?? '');

  // Anchored to the active utterance, never to the partial: an utterance that
  // closes with nothing to show leaves the rows exactly where they are.
  const history: CaptionRow[] = lines
    .filter((line) => line.seq < activeSeq && line.targetText.trim() !== '')
    .slice(-(rows - 1))
    .map((line) => ({ key: String(line.seq), seq: line.seq, text: line.targetText }));

  while (history.length < rows - 1) {
    history.unshift({ key: `blank${history.length}`, seq: -1, text: '' });
  }

  // Keyed by utterance, exactly like the history rows: the live line and the
  // finished line it becomes are the SAME row, so it keeps its DOM node (and
  // its slide) as it climbs out of the bottom slot.
  return [...history, { key: String(activeSeq), seq: activeSeq, text }];
}

/**
 * How far the stack moved between two paints, in rows — for the rows that were
 * on screen both times. The page itself does not use this (it measures the
 * real positions of the real nodes, which no model can be wrong about); it is
 * here so the row bookkeeping above can be checked directly.
 */
export function rowShiftDistance(before: CaptionRow[], after: CaptionRow[]): number {
  for (const [index, row] of after.entries()) {
    if (row.seq < 0) continue; // an empty slot holds no line, so it cannot have moved
    const was = before.findIndex((previous) => previous.key === row.key);
    if (was >= 0) return was - index;
  }
  return 0;
}
