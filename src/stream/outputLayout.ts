/**
 * Geometry of the Output stage — pure, so the drag rules can be checked
 * without a browser.
 *
 * The stage is a fixed 1920×1080 box scaled to fit its window. The caption
 * bar is positioned in PERCENT of the stage, anchored at its bottom-centre:
 * a bar that grows (show original switched on) grows upwards, away from the
 * bottom edge, and a resized window leaves the bar where it was.
 */

export const STAGE_WIDTH = 1920;
export const STAGE_HEIGHT = 1080;
/** How close (in % of stage width) to the centre a drag snaps onto it. */
export const CENTRE_SNAP_PCT = 2;

export interface BarPosition {
  /** Bar centre, % of stage width. */
  x: number;
  /** Bar bottom edge, % of stage height. */
  y: number;
}

export interface BarSize {
  widthPct: number;
  heightPct: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function fitScale(viewportWidth: number, viewportHeight: number): number {
  if (viewportWidth <= 0 || viewportHeight <= 0) return 0;
  return Math.min(viewportWidth / STAGE_WIDTH, viewportHeight / STAGE_HEIGHT);
}

/** The nearest position at which the whole bar is on the stage. */
export function clampBar(pos: BarPosition, bar: BarSize): BarPosition {
  const halfWidth = clamp(bar.widthPct, 0, 100) / 2;
  return {
    x: clamp(pos.x, halfWidth, 100 - halfWidth),
    y: clamp(pos.y, clamp(bar.heightPct, 0, 100), 100)
  };
}

/**
 * Where a drag puts the bar. `delta` is the pointer movement in screen
 * pixels; `stageOnScreen` is the stage's on-screen size (after scaling), so
 * the conversion holds at any window size.
 */
export function dragBar(
  origin: BarPosition,
  delta: { dx: number; dy: number },
  stageOnScreen: { width: number; height: number },
  bar: BarSize
): BarPosition {
  if (stageOnScreen.width <= 0 || stageOnScreen.height <= 0) return clampBar(origin, bar);
  const moved = {
    x: origin.x + (delta.dx / stageOnScreen.width) * 100,
    y: origin.y + (delta.dy / stageOnScreen.height) * 100
  };
  if (Math.abs(moved.x - 50) <= CENTRE_SNAP_PCT) moved.x = 50;
  return clampBar(moved, bar);
}
