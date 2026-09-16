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
/** Gap kept between the slide and the caption bar, and below the bar, in % of stage height. */
export const LETTERBOX_GAP_PCT = 2;

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

/**
 * Height of the slide region in letterbox, as % of stage height. `slidePct`
 * is what the operator asked for; when the caption bar plus its gaps needs
 * more room than the band below would have, the SLIDE shrinks — the caption
 * must never cover the slide in this layout.
 */
export function letterboxSlideHeightPct(slidePct: number, barHeightPct: number, gapPct: number = LETTERBOX_GAP_PCT): number {
  const requested = clamp(slidePct, 0, 100);
  const needed = barHeightPct + 2 * gapPct;
  return clamp(Math.min(requested, 100 - needed), 0, 100);
}

/**
 * Where the caption bar's bottom edge sits (same anchor as BarPosition.y: %
 * of stage height, bar anchored bottom-centre) when it is centred in the
 * band under a slide of `slideHeightPct`.
 */
export function letterboxBarBottomPct(slideHeightPct: number, barHeightPct: number): number {
  const bandHeightPct = 100 - slideHeightPct;
  const bottom = slideHeightPct + (bandHeightPct + barHeightPct) / 2;
  return clamp(bottom, barHeightPct, 100);
}
