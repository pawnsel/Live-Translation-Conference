import { describe, expect, it } from 'vitest';
import { captionSizing, captionThemeClasses } from './captionStyle';

describe('captionThemeClasses', () => {
  it('keeps the light theme exactly as the console drew it', () => {
    expect(captionThemeClasses('light')).toEqual({
      box: 'bg-white border-slate-200',
      finalText: 'text-black',
      pendingText: 'text-slate-300',
      sourceSettled: 'text-slate-400',
      sourcePartial: 'text-slate-300',
      latencyBadge: 'bg-slate-100 text-slate-500 border-slate-200',
      idleOverlay: 'bg-white text-slate-400',
      idleTitle: 'text-slate-700'
    });
  });

  it('keeps the dark theme exactly as the console drew it', () => {
    expect(captionThemeClasses('dark')).toEqual({
      box: 'bg-black border-slate-700',
      finalText: 'text-white',
      pendingText: 'text-slate-600',
      sourceSettled: 'text-slate-400',
      sourcePartial: 'text-slate-600',
      latencyBadge: 'bg-white/5 text-slate-400 border-slate-700',
      idleOverlay: 'bg-black text-slate-500',
      idleTitle: 'text-slate-300'
    });
  });

  it('draws translucent as 70% black with the dark theme text colours', () => {
    const dark = captionThemeClasses('dark');
    const translucent = captionThemeClasses('translucent');
    expect(translucent.box).toBe('bg-black/70 border-white/10');
    expect(translucent.finalText).toBe(dark.finalText);
    expect(translucent.pendingText).toBe(dark.pendingText);
    expect(translucent.sourceSettled).toBe(dark.sourceSettled);
    expect(translucent.sourcePartial).toBe(dark.sourcePartial);
    expect(translucent.latencyBadge).toBe(dark.latencyBadge);
  });

  it('treats an unset theme as light, as the console always has', () => {
    expect(captionThemeClasses(undefined)).toEqual(captionThemeClasses('light'));
  });
});

describe('captionSizing', () => {
  it('keeps the console sizes exactly as boxTextSizeClass had them', () => {
    expect(captionSizing('console', 'small').text).toBe('text-xl sm:text-2xl');
    expect(captionSizing('console', 'medium').text).toBe('text-2xl sm:text-3xl');
    expect(captionSizing('console', 'large').text).toBe('text-3xl sm:text-4xl');
    expect(captionSizing('console', 'xlarge').text).toBe('text-4xl sm:text-5xl');
    expect(captionSizing('console', undefined).text).toBe('text-3xl sm:text-4xl');
    expect(captionSizing('console', 'medium')).toMatchObject({
      source: 'text-base sm:text-lg',
      sourceGap: 'mb-2',
      padding: 'px-6 py-6 sm:px-10 sm:py-[28.8px]',
      radius: 'rounded-2xl'
    });
  });

  it('sizes the stage in fixed stage pixels, growing with the tier', () => {
    const px = (cls: string) => Number(/text-\[(\d+)px\]/.exec(cls)?.[1]);
    const tiers = (['small', 'medium', 'large', 'xlarge'] as const).map((t) => px(captionSizing('stage', t).text));
    expect(tiers.every((n) => Number.isFinite(n))).toBe(true);
    expect([...tiers].sort((a, b) => a - b)).toEqual(tiers);
    // No responsive prefixes: the stage is a fixed 1920×1080 box whose
    // window width says nothing about how big its text should be.
    expect(Object.values(captionSizing('stage', 'large')).join(' ')).not.toMatch(/\bsm:/);
  });
});
