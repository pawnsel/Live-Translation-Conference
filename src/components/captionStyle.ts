/**
 * How the live caption box looks, as data.
 *
 * The console box and the Output stage draw the same box, so its colours and
 * sizes live here once instead of as ternaries inside JSX. Every class is a
 * whole literal on purpose: Tailwind v4 only generates classes it can find
 * spelled out in source.
 */

import type { DisplayConfig } from '../types';

export type CaptionTheme = NonNullable<DisplayConfig['captionTheme']>;
/** 'console' is the operator's box (responsive rem sizes); 'stage' is the
 *  1920×1080 Output stage (fixed stage pixels). */
export type CaptionVariant = 'console' | 'stage';

export interface CaptionThemeClasses {
  /** Background and border of the box. */
  box: string;
  /** Translation text once there is some. */
  finalText: string;
  /** Placeholder / empty live row. */
  pendingText: string;
  /** Source line for a closed sentence. */
  sourceSettled: string;
  /** Source line while the sentence is still being spoken. */
  sourcePartial: string;
  latencyBadge: string;
  /** The "ready for the microphone" hint laid over an idle box. */
  idleOverlay: string;
  idleTitle: string;
}

const LIGHT: CaptionThemeClasses = {
  box: 'bg-white border-slate-200',
  finalText: 'text-black',
  pendingText: 'text-slate-300',
  sourceSettled: 'text-slate-400',
  sourcePartial: 'text-slate-300',
  latencyBadge: 'bg-slate-100 text-slate-500 border-slate-200',
  idleOverlay: 'bg-white text-slate-400',
  idleTitle: 'text-slate-700'
};

const DARK: CaptionThemeClasses = {
  box: 'bg-black border-slate-700',
  finalText: 'text-white',
  pendingText: 'text-slate-600',
  sourceSettled: 'text-slate-400',
  sourcePartial: 'text-slate-600',
  latencyBadge: 'bg-white/5 text-slate-400 border-slate-700',
  idleOverlay: 'bg-black text-slate-500',
  idleTitle: 'text-slate-300'
};

// Over a slide the bar shows what is behind it. In the console there is no
// slide, only the page, so the idle hint gets a solid grey close to what 70%
// black over the page looks like rather than stacking a second translucent
// layer on top of the box.
const TRANSLUCENT: CaptionThemeClasses = {
  ...DARK,
  box: 'bg-black/70 border-white/10',
  idleOverlay: 'bg-neutral-700 text-slate-400'
};

export function captionThemeClasses(theme: DisplayConfig['captionTheme']): CaptionThemeClasses {
  switch (theme) {
    case 'dark':
      return DARK;
    case 'translucent':
      return TRANSLUCENT;
    case 'light':
    default:
      return LIGHT;
  }
}

export interface CaptionSizing {
  /** The translation line(s). */
  text: string;
  /** The source line. */
  source: string;
  /** Space under the source line. */
  sourceGap: string;
  padding: string;
  radius: string;
}

function consoleText(size: DisplayConfig['fontSize']): string {
  switch (size) {
    case 'small':
      return 'text-xl sm:text-2xl';
    case 'medium':
      return 'text-2xl sm:text-3xl';
    case 'xlarge':
      return 'text-4xl sm:text-5xl';
    case 'large':
    default:
      return 'text-3xl sm:text-4xl';
  }
}

// Starting values: the console box is roughly 1000px wide at a typical
// desktop width and the stage bar is 80% of 1920 = 1536px, so these are the
// console's desktop sizes scaled by ~1.5. Task 9 tunes them against
// screenshots of both.
function stageText(size: DisplayConfig['fontSize']): string {
  switch (size) {
    case 'small':
      return 'text-[36px]';
    case 'medium':
      return 'text-[46px]';
    case 'xlarge':
      return 'text-[72px]';
    case 'large':
    default:
      return 'text-[56px]';
  }
}

export function captionSizing(variant: CaptionVariant, fontSize: DisplayConfig['fontSize']): CaptionSizing {
  if (variant === 'stage') {
    return {
      text: stageText(fontSize),
      source: 'text-[28px]',
      sourceGap: 'mb-[12px]',
      padding: 'px-[60px] py-[44px]',
      radius: 'rounded-[24px]'
    };
  }
  return {
    text: consoleText(fontSize),
    source: 'text-base sm:text-lg',
    sourceGap: 'mb-2',
    padding: 'px-6 py-6 sm:px-10 sm:py-[28.8px]',
    radius: 'rounded-2xl'
  };
}
