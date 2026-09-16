import { describe, expect, it } from 'vitest';
import { clampBar, dragBar, fitScale, letterboxBarBottomPct, letterboxSlideHeightPct } from './outputLayout';

describe('fitScale', () => {
  it('fits the 1920×1080 stage into the window', () => {
    expect(fitScale(960, 540)).toBe(0.5);
    expect(fitScale(1920, 1080)).toBe(1);
  });

  it('letterboxes by the tighter side', () => {
    expect(fitScale(1200, 540)).toBe(0.5);
    expect(fitScale(960, 900)).toBe(0.5);
  });

  it('is zero for a window with no size yet', () => {
    expect(fitScale(0, 540)).toBe(0);
    expect(fitScale(960, 0)).toBe(0);
  });
});

describe('clampBar', () => {
  const bar = { widthPct: 80, heightPct: 20 };

  it('leaves a position that fits alone', () => {
    expect(clampBar({ x: 50, y: 96 }, bar)).toEqual({ x: 50, y: 96 });
  });

  it('keeps the whole bar inside horizontally', () => {
    expect(clampBar({ x: 10, y: 96 }, bar).x).toBe(40);
    expect(clampBar({ x: 95, y: 96 }, bar).x).toBe(60);
  });

  it('keeps the whole bar inside vertically (y is the bottom edge)', () => {
    expect(clampBar({ x: 50, y: 5 }, bar).y).toBe(20);
    expect(clampBar({ x: 50, y: 130 }, bar).y).toBe(100);
  });

  it('pins a full-width bar to the centre', () => {
    expect(clampBar({ x: 30, y: 96 }, { widthPct: 100, heightPct: 20 }).x).toBe(50);
  });
});

describe('dragBar', () => {
  const bar = { widthPct: 60, heightPct: 20 };
  const screen = { width: 960, height: 540 };

  it('converts on-screen pixels to stage percent', () => {
    // 96px of a 960px-wide on-screen stage is 10%; 54px of 540px is 10%.
    expect(dragBar({ x: 50, y: 80 }, { dx: 96, dy: -54 }, screen, bar)).toEqual({ x: 60, y: 70 });
  });

  it('snaps to the horizontal centre when close', () => {
    expect(dragBar({ x: 40, y: 80 }, { dx: 105.6, dy: 0 }, screen, bar).x).toBe(50); // 51%
    expect(dragBar({ x: 40, y: 80 }, { dx: 124.8, dy: 0 }, screen, bar).x).toBeCloseTo(53); // 53%
  });

  it('clamps the result', () => {
    expect(dragBar({ x: 50, y: 80 }, { dx: -2000, dy: 2000 }, screen, bar)).toEqual({ x: 30, y: 100 });
  });

  it('does not move on a stage with no on-screen size', () => {
    expect(dragBar({ x: 50, y: 80 }, { dx: 100, dy: 100 }, { width: 0, height: 0 }, bar)).toEqual({ x: 50, y: 80 });
  });
});

describe('letterboxSlideHeightPct', () => {
  it('gives the operator their requested slide height when the bar comfortably fits below', () => {
    expect(letterboxSlideHeightPct(80, 15)).toBe(80);
  });

  it('shrinks the slide when the bar plus its gaps would not fit in the remaining band', () => {
    // needed = 15 + 2*2 = 19, so the band can only spare 100 - 19 = 81.
    expect(letterboxSlideHeightPct(95, 15)).toBe(81);
  });

  it('collapses the slide to nothing when the bar alone is bigger than the stage', () => {
    expect(letterboxSlideHeightPct(80, 100)).toBe(0);
  });

  it('clamps an out-of-range requested slide percentage first', () => {
    expect(letterboxSlideHeightPct(150, 15)).toBe(81);
    expect(letterboxSlideHeightPct(-10, 15)).toBe(0);
  });

  it('accepts a custom gap', () => {
    // needed = 15 + 2*5 = 25, band spares 75.
    expect(letterboxSlideHeightPct(95, 15, 5)).toBe(75);
  });
});

describe('letterboxBarBottomPct', () => {
  it('centres the bar in the band below the slide', () => {
    expect(letterboxBarBottomPct(80, 10)).toBe(95);
  });

  it('puts the bar flush with the stage bottom when it fills the whole band', () => {
    expect(letterboxBarBottomPct(80, 20)).toBe(100);
  });

  it('clamps to the stage bottom when the band would push the bar past it', () => {
    expect(letterboxBarBottomPct(90, 30)).toBe(100);
  });

  it('clamps to the bar height at the low end', () => {
    // An artificial slideHeightPct far below the normal 0..100 range pushes
    // the unclamped centring result below barHeightPct.
    expect(letterboxBarBottomPct(-300, 10)).toBe(10);
  });
});
