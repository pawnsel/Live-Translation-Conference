# Stream Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator share the projector display from the console and get one composed 16:9 Output window (slides + draggable live caption bar) that OBS captures as a single source.

**Architecture:** The console opens the Output window (Document Picture-in-Picture, falling back to a `window.open` popup) and renders into it with a React portal, so the Output reads the same React state as the console — same `MediaStream`, same captions, same display config. The live caption box is extracted from `Admin.tsx` into `LiveCaptionBox`, used by both the console and the 1920×1080 `OutputStage`. No server change.

**Tech Stack:** React 19, TypeScript 5.8, Tailwind v4 (Vite plugin), Vitest 3 + Testing Library + jsdom, Playwright 1.63 (visual checks only, not a project dependency).

**Spec:** `docs/superpowers/specs/2026-09-15-stream-output-design.md`

## Global Constraints

- Chrome/Edge on macOS **and** Windows; no OS-specific workaround in code.
- OBS stays responsible for encoding, RTMP and audio. The browser never streams.
- One layout only: caption bar overlaid on the slide. No other layouts.
- Stage is exactly 1920×1080; every Output size/position is in stage units.
- The Output caption bar uses the console's display settings (font size tier, theme, show original, `showPrevious`). The only Output-only prefs are position, bar width, lock.
- Output-only prefs defaults: bar bottom-centre, bottom edge at 96% of stage height (4% above the bottom), bar width 80%.
- `captionTheme` is `'light' | 'dark' | 'translucent'`; translucent = black at 70% opacity with the dark theme's text colours.
- Not shown on the stream: latency badge, the `กำลังแปล…` placeholder, the idle hint.
- Screen share and Output window are independent of the translation session; ending a session closes neither.
- The Output window is never closed automatically when a share ends (OBS would lose its source).
- Anything that measures or observes DOM inside the Output window uses the element's own window (`node.ownerDocument.defaultView`), never the console's globals.
- Per-device prefs go through `src/storage/safeStorage.ts` (same pattern as `micStore.ts`).
- UI copy is Thai, matching the existing console.
- UI changes are not done until rendered and looked at (repo feedback: tsc + tests cannot catch CSS bugs). The console is behind Google OAuth, so visual checks use an **uncommitted** harness page (`harness.html` + `src/harness/` + `harness/`), deleted in Task 12.
- Commit only the files each task lists — never `git add -A` (the harness must not be committed).

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `spikes/stream-output-spike.html` | create (Task 0), delete (Task 12) | Throwaway: which Output window kind OBS captures reliably |
| `src/types.ts` | modify | `captionTheme` gains `'translucent'` |
| `src/components/captionStyle.ts` | create | Pure: theme → class strings, (variant, font tier) → sizing classes |
| `src/asr/subtitleLines.ts` | modify | Add pure `unscaledHeight` |
| `src/components/SubtitleText.tsx` | modify | Own-window `ResizeObserver`; transform-safe line height |
| `src/components/useCaptionStackAnimation.ts` | create | Rolling-stack slide animation, moved from `Admin.tsx` |
| `src/components/LiveCaptionBox.tsx` | create | The live caption box, moved from `Admin.tsx`; `console` / `stage` variants |
| `src/pages/Admin.tsx` | modify | Use `LiveCaptionBox`; translucent button; สตรีม tab; portal; status chip; `beforeunload` |
| `src/stream/outputLayout.ts` | create | Pure: stage fit scale, bar clamping, drag → position, centre snap |
| `src/storage/outputStore.ts` | create | Per-device Output prefs |
| `src/stream/useScreenShare.ts` | create | Display `MediaStream` + status + error classification |
| `src/stream/useOutputWindow.ts` | create | Open/close Output window, copy styles, portal container |
| `src/stream/OutputStage.tsx` | create | 1920×1080 stage: video + draggable caption bar |
| `src/stream/StreamPanel.tsx` | create | สตรีม tab content, status chip, OBS guide |
| `SYSTEM_OVERVIEW.md` | modify | Document the feature |
| `docs/stream-output-checklist.md` | create | Real-hardware checklist for the user |

---

### Task 0: Spike — which Output window kind can OBS capture? (throwaway, user-gated)

The rest of the plan works either way; this only decides the value of `PREFER_DOCUMENT_PIP` in Task 8. **Stop after Step 3 and wait for the user's results.** Tasks 1–7 do not depend on the answer and may proceed while waiting.

**Files:**
- Create: `spikes/stream-output-spike.html`

- [ ] **Step 1: Write the spike page**

```html
<!doctype html>
<html lang="th">
<head>
<meta charset="UTF-8" />
<title>Stream output spike (throwaway)</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; max-width: 900px; }
  button { font-size: 16px; padding: 8px 14px; margin: 4px; }
  #log { white-space: pre-wrap; background: #f4f4f5; padding: 12px; border-radius: 8px; font-size: 13px; }
  .stage { position: fixed; inset: 0; background: #000; color: #fff; overflow: hidden; font-family: system-ui, sans-serif; }
  .stage video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .stage .bar { position: absolute; left: 10%; right: 10%; bottom: 4%; background: rgba(0,0,0,.7); padding: 16px 24px; border-radius: 16px; font-size: 28px; }
  .stage .css-anim { position: absolute; top: 12px; left: 12px; width: 40px; height: 40px; background: #de5c8e; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<h1>Stream output spike — ทดสอบก่อนทำจริง (ทิ้งได้)</h1>
<p>
  1) กด <b>แชร์หน้าจอ</b> เลือกจอ projector &nbsp; 2) กด <b>เปิด PiP</b> หรือ <b>เปิด Popup</b>
  &nbsp; 3) ใน OBS เพิ่ม Window Capture เลือกหน้าต่างนั้น แล้วทำตาม checklist ด้านล่าง
</p>
<button id="share">แชร์หน้าจอ</button>
<button id="pip">เปิด PiP (Document Picture-in-Picture)</button>
<button id="popup">เปิด Popup (window.open)</button>
<h3>Checklist (ทำทั้ง PiP และ Popup, บน Mac และ Windows)</h3>
<ol>
  <li>OBS เห็นหน้าต่างนี้ในรายการ Window Capture ไหม? (Windows: ใช้ capture method "Windows 10 (1903 and up)")</li>
  <li>สี่เหลี่ยมชมพูหมุน, ตัวเลขวิ่ง และภาพจอขยับใน OBS ไหม?</li>
  <li><b>minimise หน้านี้ (console)</b> — ภาพใน OBS ยังขยับไหม? ตัวเลขยังวิ่งไหม (ช้าลงได้)?</li>
  <li>เอาหน้าต่างอื่นมาบังหน้าต่าง Output มิด — OBS ยังขยับไหม? (PiP ควรบังไม่ได้)</li>
  <li>ย่อ/ขยายหน้าต่าง Output — ตัวนับ "RO (Output window)" เพิ่มไหม? "RO (console)" เพิ่มไหม? ลองตอน console ถูก minimise ด้วย</li>
  <li>แถบ "Chrome กำลังแชร์หน้าจอ" ไปโผล่จอไหน?</li>
</ol>
<div id="log"></div>
<script>
  const log = (m) => { document.getElementById('log').textContent += new Date().toLocaleTimeString() + '  ' + m + '\n'; };
  let stream = null;
  let ticks = 0;

  document.getElementById('share').onclick = async () => {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
      log('sharing: ' + stream.getVideoTracks()[0].label);
      stream.getVideoTracks()[0].onended = () => log('share ended');
    } catch (e) { log('share error: ' + e.name + ' — ' + e.message); }
  };

  function fill(win, kind) {
    const doc = win.document;
    doc.head.appendChild(document.querySelector('style').cloneNode(true));
    doc.body.style.margin = '0';
    const stage = doc.createElement('div');
    stage.className = 'stage';
    stage.innerHTML = '<video autoplay muted playsinline></video><div class="css-anim"></div><div class="bar">tick: <span class="n">0</span> · RO (Output window): <span class="ro-out">0</span> · RO (console): <span class="ro-in">0</span></div>';
    doc.body.appendChild(stage);
    const video = stage.querySelector('video');
    video.srcObject = stream;
    video.play().catch(() => {});

    // Driven from the console's timer, like caption updates driven from the console's state.
    const n = stage.querySelector('.n');
    const timer = setInterval(() => { n.textContent = String(++ticks); }, 100);

    // Same element observed by a ResizeObserver from each window.
    let outCount = 0, inCount = 0;
    new win.ResizeObserver(() => { stage.querySelector('.ro-out').textContent = String(++outCount); }).observe(stage);
    new ResizeObserver(() => { stage.querySelector('.ro-in').textContent = String(++inCount); }).observe(stage);

    win.addEventListener('pagehide', () => { clearInterval(timer); log(kind + ' closed'); });
    log(kind + ' opened');
  }

  document.getElementById('pip').onclick = async () => {
    if (!('documentPictureInPicture' in window)) { log('Document PiP not supported in this browser'); return; }
    try {
      const win = await documentPictureInPicture.requestWindow({ width: 960, height: 540 });
      fill(win, 'PiP');
    } catch (e) { log('PiP error: ' + e.name + ' — ' + e.message); }
  };

  document.getElementById('popup').onclick = () => {
    const win = window.open('', 'spike-output', 'popup,width=960,height=540');
    if (!win) { log('popup blocked'); return; }
    fill(win, 'Popup');
  };
</script>
</body>
</html>
```

- [ ] **Step 2: Sanity-check it loads locally**

Run: `npx vite --port 5199 --strictPort` then open `http://localhost:5199/spikes/stream-output-spike.html` in Chrome, click all three buttons once (share any screen). Expected: log shows `sharing: …`, `PiP opened`, `Popup opened`, and the pink square spins in both windows. Stop Vite.

- [ ] **Step 3: Commit and hand to the user**

```bash
git add spikes/stream-output-spike.html
git commit -m "spike: output window capture test page (throwaway)"
```

Tell the user: open the file in Chrome (double-click works; if a button errors under `file://`, run `npx vite --port 5199` and use the URL above), run the checklist on a Mac and a Windows machine with OBS, and report the answers. **Decision rule for Task 8:** if OBS captures the PiP window and it keeps updating with the console minimised on both OSes → `PREFER_DOCUMENT_PIP = true`; otherwise `false`. Also record whether "RO (console)" stops counting while the console is minimised (expected; it confirms the own-window rule in Task 2).

---

### Task 1: Caption style tables (+ `translucent` theme type)

**Files:**
- Modify: `src/types.ts:25-27`
- Create: `src/components/captionStyle.ts`
- Test: `src/components/captionStyle.test.ts`

**Interfaces:**
- Produces:
  - `type CaptionTheme = 'light' | 'dark' | 'translucent'`
  - `type CaptionVariant = 'console' | 'stage'`
  - `captionThemeClasses(theme: DisplayConfig['captionTheme']): CaptionThemeClasses` with fields `box, finalText, pendingText, sourceSettled, sourcePartial, latencyBadge, idleOverlay, idleTitle` (all `string`)
  - `captionSizing(variant: CaptionVariant, fontSize: DisplayConfig['fontSize']): CaptionSizing` with fields `text, source, sourceGap, padding, radius` (all `string`)

The console strings below are copied **verbatim** from `Admin.tsx` (theme ternaries at 1201–1320 and `boxTextSizeClass` at 103–116). Tailwind v4 only generates classes that appear literally in source, so every class must be a whole literal — never build class names by concatenation.

- [ ] **Step 1: Extend the theme type**

In `src/types.ts` replace:

```ts
  /** Color scheme of the live caption box. 'light' (black text on white) is
   *  the default; 'dark' is white text on black, for a darker room/stage. */
  captionTheme?: 'light' | 'dark';
```

with:

```ts
  /** Color scheme of the live caption box. 'light' (black text on white) is
   *  the default; 'dark' is white text on black, for a darker room/stage;
   *  'translucent' is white text on 70% black, so a slide shows through the
   *  caption bar on a stream. */
  captionTheme?: 'light' | 'dark' | 'translucent';
```

- [ ] **Step 2: Write the failing test**

`src/components/captionStyle.test.ts`:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/components/captionStyle.test.ts`
Expected: FAIL — `Failed to resolve import "./captionStyle"`.

- [ ] **Step 4: Write the implementation**

`src/components/captionStyle.ts`:

```ts
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
```

- [ ] **Step 5: Run test to verify it passes, then typecheck**

Run: `npx vitest run src/components/captionStyle.test.ts && npm run lint`
Expected: 6 tests PASS; `tsc --noEmit` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/components/captionStyle.ts src/components/captionStyle.test.ts
git commit -m "feat: caption style tables with a translucent theme"
```

---

### Task 2: Make `SubtitleText` correct inside a scaled, foreign window

Two latent bugs that only appear in the Output window: (a) the `ResizeObserver` is the console's, which per the spec only delivers during the console's rendering — so none arrive while the console is minimised; (b) the reserved line height comes from `getBoundingClientRect()`, which includes the stage's CSS `scale()`, so at scale 0.5 the box would reserve half the height and clip lines.

**Files:**
- Modify: `src/asr/subtitleLines.ts` (append)
- Modify: `src/asr/subtitleLines.test.ts` (append)
- Modify: `src/components/SubtitleText.tsx:57-75`

**Interfaces:**
- Produces: `unscaledHeight(rectHeight: number, rectWidth: number, layoutWidth: number): number`

- [ ] **Step 1: Write the failing test**

Append to `src/asr/subtitleLines.test.ts` (add `unscaledHeight` to its existing import from `./subtitleLines`):

```ts
describe('unscaledHeight', () => {
  it('returns the rect height when nothing is scaled', () => {
    expect(unscaledHeight(41.25, 800, 800)).toBe(41.25);
  });

  it('undoes an ancestor scale, keeping fractional pixels', () => {
    // A 1920-wide stage drawn at half size: 30.5 on screen is 61 in layout.
    expect(unscaledHeight(30.5, 960, 1920)).toBe(61);
  });

  it('falls back to the rect height when widths are unknown', () => {
    expect(unscaledHeight(20, 0, 1920)).toBe(20);
    expect(unscaledHeight(20, 960, 0)).toBe(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/asr/subtitleLines.test.ts`
Expected: FAIL — `unscaledHeight is not a function` (or not exported).

- [ ] **Step 3: Implement the helper**

Append to `src/asr/subtitleLines.ts`:

```ts
/**
 * An element's layout height from its bounding rect, with any ancestor CSS
 * scale undone. `getBoundingClientRect` reports what is on screen — inside the
 * Output stage that is the 1920×1080 box after `scale()` — while the reserved
 * height is applied in layout pixels. Widths of the same element give the
 * scale; the rect is kept (rather than `offsetHeight`) for its fractional
 * precision.
 */
export function unscaledHeight(rectHeight: number, rectWidth: number, layoutWidth: number): number {
  if (!rectWidth || !layoutWidth) return rectHeight;
  return rectHeight * (layoutWidth / rectWidth);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/asr/subtitleLines.test.ts`
Expected: PASS (all existing tests plus 3 new).

- [ ] **Step 5: Use it in `SubtitleText`**

In `src/components/SubtitleText.tsx` change the import:

```ts
import { fitSubtitlePage, isContinuation, unscaledHeight } from '../asr/subtitleLines';
```

Replace the resize effect:

```ts
  // A narrower box fits fewer words per line, so the block has to be paged
  // again on resize — otherwise a rotated phone shows three or four lines.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
```

with:

```ts
  // A narrower box fits fewer words per line, so the block has to be paged
  // again on resize — otherwise a rotated phone shows three or four lines.
  //
  // The observer comes from the window the caption is IN. Rendered into the
  // Output window, the console's own ResizeObserver would only deliver during
  // the console's rendering — which stops while the console is minimised.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const Observer = el.ownerDocument.defaultView?.ResizeObserver;
    if (!Observer) return;
    const observer = new Observer(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
```

Replace:

```ts
    el.textContent = 'A';
    const oneLine = el.scrollHeight || 0;
    setLineHeight(el.getBoundingClientRect().height || oneLine);
```

with:

```ts
    el.textContent = 'A';
    const oneLine = el.scrollHeight || 0;
    const rect = el.getBoundingClientRect();
    setLineHeight(unscaledHeight(rect.height, rect.width, el.offsetWidth) || oneLine);
```

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm test && npm run lint`
Expected: all tests PASS; tsc exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/asr/subtitleLines.ts src/asr/subtitleLines.test.ts src/components/SubtitleText.tsx
git commit -m "fix: subtitle measurement survives a scaled stage in another window"
```

---

### Task 3: Extract `LiveCaptionBox` from `Admin.tsx` (no visual change)

**Files:**
- Create: `src/components/useCaptionStackAnimation.ts`
- Create: `src/components/LiveCaptionBox.tsx`
- Modify: `src/pages/Admin.tsx` (imports line 1 & 50; lines 101–116; 609–739; 1198–1330)
- Harness (uncommitted): `harness.html`, `src/harness/main.tsx`, `src/harness/CaptionCompare.tsx`, `harness/compare-caption.mjs`

**Interfaces:**
- Consumes: `captionThemeClasses`, `captionSizing`, `CaptionVariant` (Task 1); `CaptionRow` from `src/asr/captionStack.ts`
- Produces:
  - `useCaptionStackAnimation(rows: CaptionRow[]): (key: string) => (node: HTMLDivElement | null) => void`
  - `interface CaptionView { sourceText: string; targetText: string; hasPartial: boolean; rows: CaptionRow[]; latencyMs: number | null; isIdle: boolean }`
  - `default function LiveCaptionBox(props: { config: DisplayConfig; view: CaptionView; variant: CaptionVariant }): JSX.Element`

- [ ] **Step 1: Build the harness with a verbatim copy of today's box**

`harness.html` (project root):

```html
<!doctype html>
<html lang="th">
  <head><meta charset="UTF-8" /><title>harness</title></head>
  <body><div id="root"></div><script type="module" src="/src/harness/main.tsx"></script></body>
</html>
```

`src/harness/main.tsx`:

`npm run lint` type-checks these harness files too (tsconfig has no `include`), so they must stay type-correct. React 19's types have no global `JSX` namespace — use `ReactElement`.

```tsx
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import CaptionCompare from './CaptionCompare';

const view = new URLSearchParams(location.search).get('view');
const views: Record<string, () => ReactElement> = {
  'caption-compare': () => <CaptionCompare />
};

createRoot(document.getElementById('root')!).render((views[view ?? ''] ?? (() => <p>unknown view</p>))());
```

`src/harness/CaptionCompare.tsx` — the `Original` component is today's JSX from `Admin.tsx:1198–1330` with only the refs/animation removed (they do not affect a still frame). Before Step 3 it renders `Original` twice; after Step 5 the right column becomes `LiveCaptionBox`.

```tsx
import { Zap } from 'lucide-react';
import SubtitleText from '../components/SubtitleText';
import type { CaptionRow } from '../asr/captionStack';
import type { DisplayConfig } from '../types';

type View = {
  sourceText: string; targetText: string; hasPartial: boolean;
  rows: CaptionRow[]; latencyMs: number | null; isIdle: boolean;
};

function boxTextSizeClass(size: DisplayConfig['fontSize']): string {
  switch (size) {
    case 'small': return 'text-xl sm:text-2xl';
    case 'medium': return 'text-2xl sm:text-3xl';
    case 'xlarge': return 'text-4xl sm:text-5xl';
    case 'large':
    default: return 'text-3xl sm:text-4xl';
  }
}

const CAPTION_ROWS = 3;

export function Original({ config, view }: { config: DisplayConfig; view: View }) {
  const isDarkCaption = config.captionTheme === 'dark';
  const { sourceText: boxSourceText, targetText: boxTargetText, hasPartial, rows: captionRows } = view;
  return (
    <div
      className={`relative w-full rounded-2xl border shadow-sm px-6 py-6 sm:px-10 sm:py-[28.8px] text-left overflow-hidden transition-colors ${
        isDarkCaption ? 'bg-black border-slate-700' : 'bg-white border-slate-200'
      }`}
    >
      {config.showOriginal && (
        <SubtitleText
          text={boxSourceText}
          maxLines={1}
          className={`text-base sm:text-lg mb-2 ${
            isDarkCaption
              ? hasPartial ? 'text-slate-600' : 'text-slate-400'
              : hasPartial ? 'text-slate-300' : 'text-slate-400'
          }`}
        />
      )}
      {config.showPrevious ? (
        <div className="relative overflow-hidden">
          {captionRows.map((row, index) => {
            const isLive = index === CAPTION_ROWS - 1;
            return (
              <div
                key={row.key}
                className={`${boxTextSizeClass(config.fontSize)} leading-snug overflow-hidden`}
                style={{ height: '1.375em', opacity: 1 - (CAPTION_ROWS - 1 - index) * 0.35, transition: 'opacity 220ms ease-out' }}
              >
                <SubtitleText
                  text={isLive ? row.text || 'กำลังแปล…' : row.text}
                  maxLines={1}
                  reserveLines={false}
                  overflow={isLive ? 'page' : 'clip'}
                  className={`${boxTextSizeClass(config.fontSize)} leading-snug tracking-tight ${
                    isLive && !row.text
                      ? `font-normal ${isDarkCaption ? 'text-slate-600' : 'text-slate-300'}`
                      : `font-bold ${isDarkCaption ? 'text-white' : 'text-black'}`
                  }`}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <SubtitleText
          text={boxTargetText || 'กำลังแปล…'}
          maxLines={2}
          className={`${boxTextSizeClass(config.fontSize)} leading-snug tracking-tight ${
            boxTargetText
              ? `font-bold ${isDarkCaption ? 'text-white' : 'text-black'}`
              : `font-normal ${isDarkCaption ? 'text-slate-600' : 'text-slate-300'}`
          }`}
        />
      )}
      {config.showLatency && (
        <span
          className={`mt-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] border ${
            view.latencyMs ? '' : 'invisible'
          } ${
            isDarkCaption
              ? 'bg-white/5 text-slate-400 border-slate-700'
              : 'bg-slate-100 text-slate-500 border-slate-200'
          }`}
        >
          <Zap className="w-3 h-3 text-amber-500" />
          <span>{view.latencyMs ?? 0}ms</span>
        </span>
      )}
      {view.isIdle && (
        <div
          className={`absolute inset-0 rounded-2xl flex flex-col items-center justify-center text-center px-6 ${
            isDarkCaption ? 'bg-black text-slate-500' : 'bg-white text-slate-400'
          }`}
        >
          <div className={`font-bold text-sm ${isDarkCaption ? 'text-slate-300' : 'text-slate-700'}`}>
            พร้อมรับเสียงจากไมโครโฟน
          </div>
          <p className="text-xs leading-relaxed mt-1">
            กดปุ่มไมโครโฟนวงกลมกลางจอ จากนั้นพูดใส่ไมโครโฟนเพื่อทำการแปลภาษาแบบเรียลไทม์
          </p>
        </div>
      )}
    </div>
  );
}

const ROWS: CaptionRow[] = [
  { key: '4', seq: 4, text: 'The committee reviewed the proposal last week.' },
  { key: '5', seq: 5, text: 'Funding will be decided at the next meeting.' },
  { key: '6', seq: 6, text: 'We now turn to the clinical results' }
];

const base = { sourceText: '', targetText: '', hasPartial: false, rows: ROWS, latencyMs: null, isIdle: false };

export const SCENARIOS: Array<{ id: string; config: DisplayConfig; view: View }> = (['light', 'dark'] as const).flatMap((theme) => [
  { id: `${theme}-idle`, config: { fontSize: 'medium', captionTheme: theme }, view: { ...base, isIdle: true } },
  { id: `${theme}-final`, config: { fontSize: 'medium', captionTheme: theme }, view: { ...base, targetText: 'Good morning everyone, and welcome to the annual research conference of the faculty.' } },
  { id: `${theme}-partial-source`, config: { fontSize: 'large', captionTheme: theme, showOriginal: true }, view: { ...base, hasPartial: true, sourceText: 'สวัสดีครับทุกท่าน ยินดีต้อนรับ', targetText: 'Hello everyone, welcome' } },
  { id: `${theme}-pending`, config: { fontSize: 'small', captionTheme: theme }, view: { ...base, hasPartial: true } },
  { id: `${theme}-stack`, config: { fontSize: 'medium', captionTheme: theme, showPrevious: true }, view: { ...base, hasPartial: true, targetText: 'We now turn to the clinical results' } },
  { id: `${theme}-latency`, config: { fontSize: 'xlarge', captionTheme: theme, showLatency: true }, view: { ...base, targetText: 'Thank you.', latencyMs: 820 } }
]);

// Replaced in Step 5 by LiveCaptionBox.
const Candidate = Original;

export default function CaptionCompare() {
  return (
    <div className="p-6 space-y-6 bg-slate-100 min-h-screen">
      {SCENARIOS.map((s) => (
        <div key={s.id} className="grid grid-cols-2 gap-6">
          <div data-testid={`before-${s.id}`}><Original config={s.config} view={s.view} /></div>
          <div data-testid={`after-${s.id}`}><Candidate config={s.config} view={s.view} /></div>
        </div>
      ))}
    </div>
  );
}
```

`harness/compare-caption.mjs`:

```js
// Pixel-compares every before/after pair in the caption-compare harness view.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

// Usage: node harness/compare-caption.mjs [viewportWidth]
// `sm:` classes switch on the VIEWPORT (640px), so run once wide and once narrow.
const width = Number(process.argv[2] ?? 2200);
const url = 'http://localhost:5199/harness.html?view=caption-compare';
mkdirSync('harness/out', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height: 1400 } });
await page.goto(url);
await page.waitForTimeout(500); // SubtitleText measures in layout effects
const ids = await page.$$eval('[data-testid^="before-"]', (els) => els.map((e) => e.dataset.testid.slice(7)));
let failures = 0;
for (const id of ids) {
  const before = await page.getByTestId(`before-${id}`).screenshot({ path: `harness/out/before-${id}.png` });
  const after = await page.getByTestId(`after-${id}`).screenshot({ path: `harness/out/after-${id}.png` });
  const same = before.equals(after);
  if (!same) failures++;
  console.log(`${same ? 'SAME' : 'DIFF'}  ${id}`);
}
await browser.close();
console.log(ids.length ? `${ids.length - failures}/${ids.length} identical` : 'no scenarios found');
process.exit(failures || !ids.length ? 1 : 0);
```

- [ ] **Step 2: Prove the harness compares correctly while both columns are the original**

Run in one terminal: `npx vite --port 5199 --strictPort`
Run: `node harness/compare-caption.mjs 2200`
Expected: `12/12 identical`, exit 0. If any pair differs here, the harness itself is non-deterministic — fix that before going on. Open two PNGs from `harness/out/` and confirm they show the scenario (not blank).

- [ ] **Step 3: Create the animation hook**

`src/components/useCaptionStackAnimation.ts` — moved from `Admin.tsx:650–739`; behaviour unchanged except `getComputedStyle` now comes from the node's own window.

```ts
import { useLayoutEffect, useRef, useState } from 'react';
import type { CaptionRow } from '../asr/captionStack';
import { readSetting } from '../storage/safeStorage';

/**
 * The rolling-stack slide.
 *
 * The slide is measured, not predicted. Each row is keyed by its utterance,
 * so React MOVES the same node up the stack, and the animation is simply
 * "you were there, you are here now, cover the difference". Nothing about
 * the caption pipeline can talk it into a shift that did not happen, or out
 * of one that did — which is what every earlier attempt at this got wrong.
 *
 * Returns the ref factory each row must use: `ref={rowRef(row.key)}`.
 */
export function useCaptionStackAnimation(rows: CaptionRow[]) {
  const rowNodesRef = useRef(new Map<string, HTMLDivElement>());
  const rowTopsRef = useRef(new Map<string, number>());
  // The animation currently playing for each row, if any — so a shift that
  // lands before the previous one finishes can be handled deliberately
  // instead of by accident.
  const rowAnimsRef = useRef(new Map<string, Animation>());
  const [captionDebug] = useState(() => readSetting('captionStackDebug') === '1');

  // The translateY a row is rendering RIGHT NOW, mid-animation or not.
  // getComputedStyle reports the live interpolated value regardless of how
  // many keyframes are involved, so this is the one place both 2D and 3D
  // transform matrices need reading (a translate3d keyframe on some engines
  // computes to matrix3d instead of matrix). Read through the node's own
  // window: in the Output window the console's is the wrong one.
  const currentTranslateY = (node: HTMLElement): number => {
    try {
      const view = node.ownerDocument.defaultView;
      const transform = view?.getComputedStyle(node).transform;
      if (!transform || transform === 'none' || typeof DOMMatrixReadOnly === 'undefined') return 0;
      return new DOMMatrixReadOnly(transform).m42;
    } catch {
      return 0;
    }
  };

  useLayoutEffect(() => {
    const previousTops = rowTopsRef.current;
    const nextTops = new Map<string, number>();
    rowNodesRef.current.forEach((node, key) => nextTops.set(key, node.offsetTop));
    rowTopsRef.current = nextTops;
    if (previousTops.size === 0) return; // first paint: the stack arrived, it did not move

    const moves: string[] = [];
    nextTops.forEach((top, key) => {
      const node = rowNodesRef.current.get(key);
      if (!node || typeof node.animate !== 'function') return;
      // A row that was already on screen slides from where it was; a row that
      // is new to the stack rides in from just under the bottom edge.
      const from = previousTops.get(key) ?? top + node.offsetHeight;
      let delta = from - top;

      // Rapid, back-to-back sentences close faster than one 220ms slide can
      // finish, so the next shift for this row lands while its animation from
      // the PREVIOUS shift is still running. `node.animate()` again here
      // would start a second animation on the same property — WAAPI has the
      // newer one replace the older wholesale, so the row would cut straight
      // from wherever it visually was to this shift's theoretical start point,
      // an instant jump that reads as a skip. Reading the live transform
      // before cancelling makes the new animation continue from exactly where
      // the eye last saw the row, no matter how many shifts have piled up.
      const running = rowAnimsRef.current.get(key);
      if (running?.playState === 'running') {
        delta = currentTranslateY(node);
        running.cancel();
      }
      if (delta === 0) return;

      moves.push(`${key}: ${from}→${top}`);
      const anim = node.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
        { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
      );
      rowAnimsRef.current.set(key, anim);
      anim.addEventListener('finish', () => {
        if (rowAnimsRef.current.get(key) === anim) rowAnimsRef.current.delete(key);
      });
    });

    // Switched on with `localStorage.captionStackDebug = '1'` (then reload).
    // The stack has now been rebuilt several times off reports of it "not
    // sliding sometimes", and guessing has cost more than measuring would
    // have: this prints what the rows actually were, and what actually moved.
    if (captionDebug) {
      // eslint-disable-next-line no-console
      console.debug(
        '[caption-stack]',
        rows.map((row) => `${row.key}:${JSON.stringify(row.text.slice(0, 24))}`).join(' | '),
        moves.length > 0 ? `moved ${moves.join(', ')}` : 'no movement'
      );
    }
  }, [rows, captionDebug]);

  // A fresh callback per render, exactly as the inline ref in Admin.tsx was —
  // this extraction does not change when React attaches and detaches rows.
  return (key: string) => (node: HTMLDivElement | null) => {
    const nodes = rowNodesRef.current;
    if (node) {
      nodes.set(key, node);
    } else {
      nodes.delete(key);
      // The row is gone for good once it falls off the top of the stack —
      // nothing will ever animate it again, so its Animation handle would
      // otherwise just sit in the map for the rest of the session.
      rowAnimsRef.current.get(key)?.cancel();
      rowAnimsRef.current.delete(key);
    }
  };
}
```

- [ ] **Step 4: Create `LiveCaptionBox`**

`src/components/LiveCaptionBox.tsx`:

```tsx
import { Zap } from 'lucide-react';
import SubtitleText from './SubtitleText';
import type { CaptionRow } from '../asr/captionStack';
import type { DisplayConfig } from '../types';
import { captionSizing, captionThemeClasses, type CaptionVariant } from './captionStyle';
import { useCaptionStackAnimation } from './useCaptionStackAnimation';

/** Everything the box shows, computed once by the console and handed to
 *  every copy of the box — the console's and the Output stage's. */
export interface CaptionView {
  /** Live source text, else the latest caption's. */
  sourceText: string;
  /** Live translation, else the latest caption's. */
  targetText: string;
  /** A sentence is still being spoken. */
  hasPartial: boolean;
  /** Rolling-stack rows, oldest first (used when `showPrevious`). */
  rows: CaptionRow[];
  latencyMs: number | null;
  /** Nothing has been said yet this session. */
  isIdle: boolean;
}

interface LiveCaptionBoxProps {
  config: DisplayConfig;
  view: CaptionView;
  /** 'console' shows operator-only extras (placeholder, latency, idle hint);
   *  'stage' shows only what belongs on a broadcast. */
  variant: CaptionVariant;
}

const PENDING_TEXT = 'กำลังแปล…';

/**
 * The live subtitle. Two-line mode pages the way broadcast subtitles do: a
 * caption that outgrows the block restarts from the word that no longer
 * fitted. Rolling mode instead keeps one line per sentence, newest on the
 * bottom line and older ones fading upwards out of the block. Either way the
 * box holds ONE fixed height for a given display setting: nothing that
 * happens while someone speaks may resize it.
 */
export default function LiveCaptionBox({ config, view, variant }: LiveCaptionBoxProps) {
  const theme = captionThemeClasses(config.captionTheme);
  const size = captionSizing(variant, config.fontSize);
  const onConsole = variant === 'console';
  const rowRef = useCaptionStackAnimation(view.rows);
  const pending = (text: string) => (onConsole ? text || PENDING_TEXT : text);

  return (
    <div
      className={`relative w-full ${size.radius} border shadow-sm ${size.padding} text-left overflow-hidden transition-colors ${theme.box}`}
    >
      {/* Every slot below is ALWAYS mounted and every one of them is locked
          to its own line count, so the box is exactly as tall as the display
          settings demand and not one pixel more. The idle hint sits on top
          of the content instead of replacing it, because a box that resized
          under a speaker would shove the whole page around mid-sentence. */}
      {config.showOriginal && (
        <SubtitleText
          text={view.sourceText}
          maxLines={1}
          className={`${size.source} ${size.sourceGap} ${view.hasPartial ? theme.sourcePartial : theme.sourceSettled}`}
        />
      )}
      {config.showPrevious ? (
        <div className="relative overflow-hidden">
          {/* Keyed by utterance, so a line that climbs is the SAME node in a
              new place — which is what lets the animation measure the move
              instead of guessing it. The fade belongs to the slot, not to the
              sentence: a line dims by climbing, the way a lyric does. */}
          {view.rows.map((row, index) => {
            const isLive = index === view.rows.length - 1;
            const text = isLive ? pending(row.text) : row.text;
            return (
              <div
                key={row.key}
                ref={rowRef(row.key)}
                // One line tall, in CSS, from the very first paint:
                // leading-snug is a 1.375 line-height, so 1.375em of this
                // element's own font size IS one line.
                className={`${size.text} leading-snug overflow-hidden`}
                style={{
                  height: '1.375em',
                  opacity: 1 - (view.rows.length - 1 - index) * 0.35,
                  transition: 'opacity 220ms ease-out'
                }}
              >
                <SubtitleText
                  text={text}
                  maxLines={1}
                  reserveLines={false}
                  // The live line follows the speaker (newest words win); a
                  // finished one is read from its start.
                  overflow={isLive ? 'page' : 'clip'}
                  className={`${size.text} leading-snug tracking-tight ${
                    isLive && !row.text ? `font-normal ${theme.pendingText}` : `font-bold ${theme.finalText}`
                  }`}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <SubtitleText
          text={pending(view.targetText)}
          maxLines={2}
          className={`${size.text} leading-snug tracking-tight ${
            view.targetText ? `font-bold ${theme.finalText}` : `font-normal ${theme.pendingText}`
          }`}
        />
      )}
      {/* The last MEASURED latency, kept on screen between sentences. */}
      {onConsole && config.showLatency && (
        <span
          className={`mt-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] border ${
            view.latencyMs ? '' : 'invisible'
          } ${theme.latencyBadge}`}
        >
          <Zap className="w-3 h-3 text-amber-500" />
          <span>{view.latencyMs ?? 0}ms</span>
        </span>
      )}

      {onConsole && view.isIdle && (
        <div
          className={`absolute inset-0 rounded-2xl flex flex-col items-center justify-center text-center px-6 ${theme.idleOverlay}`}
        >
          <div className={`font-bold text-sm ${theme.idleTitle}`}>พร้อมรับเสียงจากไมโครโฟน</div>
          <p className="text-xs leading-relaxed mt-1">
            กดปุ่มไมโครโฟนวงกลมกลางจอ จากนั้นพูดใส่ไมโครโฟนเพื่อทำการแปลภาษาแบบเรียลไทม์
          </p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Point the harness at `LiveCaptionBox` and compare**

In `src/harness/CaptionCompare.tsx` replace:

```tsx
// Replaced in Step 5 by LiveCaptionBox.
const Candidate = Original;
```

with:

```tsx
import LiveCaptionBox from '../components/LiveCaptionBox';

function Candidate({ config, view }: { config: DisplayConfig; view: View }) {
  return <LiveCaptionBox config={config} view={view} variant="console" />;
}
```

(move the `import` to the top of the file). With Vite still running:

Run: `node harness/compare-caption.mjs 2200 && node harness/compare-caption.mjs 600`
Expected: `12/12 identical` both times (2200 covers the `sm:` classes, 600 the base classes). On any `DIFF`, open `harness/out/before-<id>.png` and `after-<id>.png` and fix `LiveCaptionBox`/`captionStyle` until identical.

- [ ] **Step 6: Switch `Admin.tsx` to the component**

1. Line 1: remove `useLayoutEffect` from the React import.
2. Line 50: replace `import SubtitleText from '../components/SubtitleText';` with `import LiveCaptionBox, { type CaptionView } from '../components/LiveCaptionBox';`
3. Delete `boxTextSizeClass` and its comment (lines 101–116).
4. Replace line 618 `const isDarkCaption = config.captionTheme === 'dark';` with nothing (delete it).
5. After the `captionRows` `useMemo` (ends line 648), delete everything from the comment `// The slide is measured, not predicted.` through the end of the `useLayoutEffect` (line 739) and insert:

```tsx
  // One description of the live box, handed to every copy of it — the
  // console's and the Output window's — so they can never disagree.
  const captionView = useMemo<CaptionView>(
    () => ({
      sourceText: boxSourceText,
      targetText: boxTargetText,
      hasPartial,
      rows: captionRows,
      latencyMs: latestCaption?.latencyMs ?? null,
      isIdle: !latestCaption && !hasPartial
    }),
    [boxSourceText, boxTargetText, hasPartial, captionRows, latestCaption]
  );
```

6. Replace the whole inner box — from `<div className={\`relative w-full rounded-2xl border shadow-sm …` down to its closing `</div>` just before the outer `</div>` that closes `shrink-0 px-3 pt-3 sm:px-6 sm:pt-4` — with:

```tsx
            <LiveCaptionBox config={config} view={captionView} variant="console" />
```

Keep the section comment above the outer wrapper but shorten it to:

```tsx
          {/* ─────────────────────────────────────────────────────────────
              LIVE SUBTITLE — pinned to the top edge (components/LiveCaptionBox).
          ────────────────────────────────────────────────────────────── */}
```

- [ ] **Step 7: Verify**

Run: `npm run lint && npm test`
Expected: tsc exits 0 (no unused-symbol or missing-symbol errors — `latestCaption`, `hasPartial`, `boxSourceText`, `boxTargetText`, `captionRows` are still defined above `captionView`); all tests PASS.
Run: `grep -n "isDarkCaption\|boxTextSizeClass\|rowNodesRef\|SubtitleText" src/pages/Admin.tsx`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add src/components/useCaptionStackAnimation.ts src/components/LiveCaptionBox.tsx src/pages/Admin.tsx
git commit -m "refactor: extract the live caption box from Admin"
```

---

### Task 4: Translucent theme button

**Files:**
- Modify: `src/pages/Admin.tsx` (theme buttons, around the `ธีมคำบรรยาย (Caption Theme)` label)
- Harness (uncommitted): `src/harness/ThemeButtons.tsx`, `src/harness/main.tsx`, `harness/shoot.mjs`

**Interfaces:**
- Consumes: `DisplayConfig['captionTheme']` including `'translucent'` (Task 1)

- [ ] **Step 1: Add the button**

In `Admin.tsx`, change `<div className="grid grid-cols-2 gap-1.5">` directly under the `ธีมคำบรรยาย (Caption Theme)` label to `<div className="grid grid-cols-3 gap-1.5">`, and after the `ตัวขาวพื้นดำ` button add:

```tsx
                      <button
                        type="button"
                        onClick={() => setConfig((c) => ({ ...c, captionTheme: 'translucent' }))}
                        className={`flex items-center justify-center gap-1.5 py-2 px-1 rounded-lg text-[11px] font-bold border transition-all ${
                          config.captionTheme === 'translucent'
                            ? 'border-[#DE5C8E] ring-2 ring-pink-100 bg-white text-slate-800'
                            : 'border-slate-200 bg-slate-50 text-slate-500 hover:bg-white'
                        }`}
                      >
                        <span className="w-3.5 h-3.5 rounded-full bg-black/60 text-white flex items-center justify-center text-[8px] font-black">A</span>
                        <span>โปร่งแสง</span>
                      </button>
```

- [ ] **Step 2: Mirror the block in the harness and look at it**

`src/harness/ThemeButtons.tsx` — the theme block from `Admin.tsx` as it stands after Step 1 (if you changed any class in Step 1, change it here identically), at the sidebar's real outer widths (`lg:w-96` = 384px desktop, `w-84` = 336px mobile, each with `p-4` content padding):

```tsx
import { useState } from 'react';
import LiveCaptionBox from '../components/LiveCaptionBox';
import type { DisplayConfig } from '../types';

export default function ThemeButtons() {
  const [config, setConfig] = useState<DisplayConfig>({ fontSize: 'medium', captionTheme: 'translucent' });
  return (
    <div className="p-6 space-y-6 bg-slate-100 min-h-screen">
      {[384, 336].map((width) => (
        <div key={width} data-testid={`buttons-${width}`} className="bg-white p-4" style={{ width }}>
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5">ธีมคำบรรยาย (Caption Theme)</label>
            <div className="grid grid-cols-3 gap-1.5">
              <button
                type="button"
                onClick={() => setConfig((c) => ({ ...c, captionTheme: 'light' }))}
                className={`flex items-center justify-center gap-1.5 py-2 px-1 rounded-lg text-[11px] font-bold border transition-all ${
                  (config.captionTheme ?? 'light') === 'light'
                    ? 'border-[#DE5C8E] ring-2 ring-pink-100 bg-white text-slate-800'
                    : 'border-slate-200 bg-slate-50 text-slate-500 hover:bg-white'
                }`}
              >
                <span className="w-3.5 h-3.5 rounded-full bg-white border border-slate-300 text-black flex items-center justify-center text-[8px] font-black">A</span>
                <span>ตัวดำพื้นขาว</span>
              </button>
              <button
                type="button"
                onClick={() => setConfig((c) => ({ ...c, captionTheme: 'dark' }))}
                className={`flex items-center justify-center gap-1.5 py-2 px-1 rounded-lg text-[11px] font-bold border transition-all ${
                  config.captionTheme === 'dark'
                    ? 'border-[#DE5C8E] ring-2 ring-pink-100 bg-white text-slate-800'
                    : 'border-slate-200 bg-slate-50 text-slate-500 hover:bg-white'
                }`}
              >
                <span className="w-3.5 h-3.5 rounded-full bg-black text-white flex items-center justify-center text-[8px] font-black">A</span>
                <span>ตัวขาวพื้นดำ</span>
              </button>
              <button
                type="button"
                onClick={() => setConfig((c) => ({ ...c, captionTheme: 'translucent' }))}
                className={`flex items-center justify-center gap-1.5 py-2 px-1 rounded-lg text-[11px] font-bold border transition-all ${
                  config.captionTheme === 'translucent'
                    ? 'border-[#DE5C8E] ring-2 ring-pink-100 bg-white text-slate-800'
                    : 'border-slate-200 bg-slate-50 text-slate-500 hover:bg-white'
                }`}
              >
                <span className="w-3.5 h-3.5 rounded-full bg-black/60 text-white flex items-center justify-center text-[8px] font-black">A</span>
                <span>โปร่งแสง</span>
              </button>
            </div>
          </div>
        </div>
      ))}
      <div data-testid="console-box" className="w-[1000px]">
        <LiveCaptionBox config={config} view={{ sourceText: '', targetText: 'The committee reviewed the proposal last week.', hasPartial: false, rows: [], latencyMs: null, isIdle: false }} variant="console" />
      </div>
      <div data-testid="console-idle" className="w-[1000px]">
        <LiveCaptionBox config={config} view={{ sourceText: '', targetText: '', hasPartial: false, rows: [], latencyMs: null, isIdle: true }} variant="console" />
      </div>
    </div>
  );
}
```

Register it in `src/harness/main.tsx`: `import ThemeButtons from './ThemeButtons';` and add `'theme-buttons': () => <ThemeButtons />` to `views`.

`harness/shoot.mjs` (generic screenshotter reused by later tasks):

```js
// Usage: node harness/shoot.mjs <view> <width> <height> [testid ...]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const [view, width = '1600', height = '1000', ...ids] = process.argv.slice(2);
mkdirSync('harness/out', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) } });
await page.goto(`http://localhost:5199/harness.html?view=${view}`);
await page.waitForTimeout(500);
await page.screenshot({ path: `harness/out/${view}-${width}x${height}.png`, fullPage: true });
for (const id of ids) {
  const box = await page.getByTestId(id).boundingBox();
  console.log(id, JSON.stringify(box));
  await page.getByTestId(id).screenshot({ path: `harness/out/${view}-${id}.png` });
}
await browser.close();
```

Run (Vite on 5199): `node harness/shoot.mjs theme-buttons 1600 1000 buttons-384 buttons-336 console-box console-idle`
Then Read each PNG. Expected: three buttons on one row at both widths, labels `ตัวดำพื้นขาว` / `ตัวขาวพื้นดำ` / `โปร่งแสง` not clipped or wrapped onto a second line; the selected (translucent) button has the pink ring; the console box is dark grey with white text; the idle hint is grey (not a darker patch inside a lighter box). If a label wraps at 336px, add `whitespace-nowrap` to the three label spans and change the buttons' `text-[11px]` to `text-[10px]`, in both `Admin.tsx` and the harness copy, and re-shoot.

- [ ] **Step 3: Typecheck and commit**

Run: `npm run lint`
Expected: exit 0.

```bash
git add src/pages/Admin.tsx
git commit -m "feat: translucent caption theme option"
```

---

### Task 5: Output stage geometry

**Files:**
- Create: `src/stream/outputLayout.ts`
- Test: `src/stream/outputLayout.test.ts`

**Interfaces:**
- Produces:
  - `STAGE_WIDTH = 1920`, `STAGE_HEIGHT = 1080`, `CENTRE_SNAP_PCT = 2`
  - `interface BarPosition { x: number; y: number }` — `x` = bar centre, % of stage width; `y` = bar bottom edge, % of stage height
  - `interface BarSize { widthPct: number; heightPct: number }`
  - `fitScale(viewportWidth: number, viewportHeight: number): number`
  - `clampBar(pos: BarPosition, bar: BarSize): BarPosition`
  - `dragBar(origin: BarPosition, delta: { dx: number; dy: number }, stageOnScreen: { width: number; height: number }, bar: BarSize): BarPosition`

- [ ] **Step 1: Write the failing test**

`src/stream/outputLayout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { clampBar, dragBar, fitScale } from './outputLayout';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/stream/outputLayout.test.ts`
Expected: FAIL — cannot resolve `./outputLayout`.

- [ ] **Step 3: Write the implementation**

`src/stream/outputLayout.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/stream/outputLayout.test.ts`
Expected: 11 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stream/outputLayout.ts src/stream/outputLayout.test.ts
git commit -m "feat: output stage geometry"
```

---

### Task 6: Per-device Output prefs

**Files:**
- Create: `src/storage/outputStore.ts`
- Test: `src/storage/outputStore.test.ts`

**Interfaces:**
- Produces:
  - `interface OutputPrefs { x: number; y: number; widthPct: number; locked: boolean }` (x/y as `BarPosition`)
  - `DEFAULT_OUTPUT_PREFS: OutputPrefs = { x: 50, y: 96, widthPct: 80, locked: false }`
  - `MIN_BAR_WIDTH_PCT = 30`, `MAX_BAR_WIDTH_PCT = 100`
  - `OUTPUT_PREFS_KEY = 'ai_translate_output_prefs'`
  - `loadOutputPrefs(): OutputPrefs`, `saveOutputPrefs(prefs: OutputPrefs): void`

- [ ] **Step 1: Write the failing test**

`src/storage/outputStore.test.ts`:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_OUTPUT_PREFS, OUTPUT_PREFS_KEY, loadOutputPrefs, saveOutputPrefs } from './outputStore';

describe('outputStore', () => {
  beforeEach(() => localStorage.clear());

  it('starts from the defaults: bottom-centre, 4% up, 80% wide, unlocked', () => {
    expect(loadOutputPrefs()).toEqual({ x: 50, y: 96, widthPct: 80, locked: false });
    expect(DEFAULT_OUTPUT_PREFS).toEqual({ x: 50, y: 96, widthPct: 80, locked: false });
  });

  it('round-trips what was saved', () => {
    saveOutputPrefs({ x: 42.5, y: 70, widthPct: 65, locked: true });
    expect(loadOutputPrefs()).toEqual({ x: 42.5, y: 70, widthPct: 65, locked: true });
  });

  it('falls back to defaults for unreadable storage', () => {
    localStorage.setItem(OUTPUT_PREFS_KEY, '{not json');
    expect(loadOutputPrefs()).toEqual(DEFAULT_OUTPUT_PREFS);
  });

  it('repairs each bad field on its own', () => {
    localStorage.setItem(OUTPUT_PREFS_KEY, JSON.stringify({ x: 'left', y: 250, widthPct: 5, locked: 'yes' }));
    expect(loadOutputPrefs()).toEqual({ x: 50, y: 96, widthPct: 80, locked: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/outputStore.test.ts`
Expected: FAIL — cannot resolve `./outputStore`.

- [ ] **Step 3: Write the implementation**

`src/storage/outputStore.ts`:

```ts
/** Where the caption bar sits on the Output stage, how wide it is, and
 *  whether it is locked — per device, same spirit as micStore: the layout is
 *  tuned to one room's projector and one OBS scene. */

import { readSetting, writeSetting } from './safeStorage';

export const OUTPUT_PREFS_KEY = 'ai_translate_output_prefs';
export const MIN_BAR_WIDTH_PCT = 30;
export const MAX_BAR_WIDTH_PCT = 100;

export interface OutputPrefs {
  /** Bar centre, % of stage width. */
  x: number;
  /** Bar bottom edge, % of stage height. */
  y: number;
  widthPct: number;
  /** Dragging disabled — set before going live. */
  locked: boolean;
}

export const DEFAULT_OUTPUT_PREFS: OutputPrefs = { x: 50, y: 96, widthPct: 80, locked: false };

function numberIn(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function loadOutputPrefs(): OutputPrefs {
  const raw = readSetting(OUTPUT_PREFS_KEY);
  if (!raw) return DEFAULT_OUTPUT_PREFS;
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return DEFAULT_OUTPUT_PREFS;
    parsed = value as Record<string, unknown>;
  } catch {
    return DEFAULT_OUTPUT_PREFS;
  }
  return {
    x: numberIn(parsed.x, 0, 100, DEFAULT_OUTPUT_PREFS.x),
    y: numberIn(parsed.y, 0, 100, DEFAULT_OUTPUT_PREFS.y),
    widthPct: numberIn(parsed.widthPct, MIN_BAR_WIDTH_PCT, MAX_BAR_WIDTH_PCT, DEFAULT_OUTPUT_PREFS.widthPct),
    locked: typeof parsed.locked === 'boolean' ? parsed.locked : DEFAULT_OUTPUT_PREFS.locked
  };
}

export function saveOutputPrefs(prefs: OutputPrefs): void {
  writeSetting(OUTPUT_PREFS_KEY, JSON.stringify(prefs));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/outputStore.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/outputStore.ts src/storage/outputStore.test.ts
git commit -m "feat: per-device output prefs"
```

---

### Task 7: `useScreenShare`

**Files:**
- Create: `src/stream/useScreenShare.ts`
- Test: `src/stream/useScreenShare.test.ts`

**Interfaces:**
- Produces:
  - `type ShareStatus = 'idle' | 'sharing' | 'ended' | 'error'`
  - `type ShareError = 'system-denied' | 'unsupported' | 'failed'`
  - `classifyDisplayMediaError(err: unknown): 'cancelled' | 'system-denied' | 'failed'`
  - `interface ScreenShare { stream: MediaStream | null; status: ShareStatus; error: ShareError | null; label: string; start: () => Promise<void>; stop: () => void }`
  - `useScreenShare(): ScreenShare`

- [ ] **Step 1: Write the failing test**

`src/stream/useScreenShare.test.ts`:

```ts
// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyDisplayMediaError, useScreenShare } from './useScreenShare';

type FakeTrack = { label: string; stop: ReturnType<typeof vi.fn>; onended: (() => void) | null };

function fakeStream(label = 'Screen 2') {
  const track: FakeTrack = { label, stop: vi.fn(), onended: null };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}

const domError = (name: string, message: string) => Object.assign(new Error(message), { name });

let getDisplayMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getDisplayMedia = vi.fn();
  Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia }, configurable: true });
});

afterEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
});

describe('classifyDisplayMediaError', () => {
  it('reads a plain NotAllowedError as the operator cancelling the picker', () => {
    expect(classifyDisplayMediaError(domError('NotAllowedError', 'Permission denied'))).toBe('cancelled');
  });

  it('reads "denied by system" as the macOS Screen Recording permission', () => {
    expect(classifyDisplayMediaError(domError('NotAllowedError', 'Permission denied by system'))).toBe('system-denied');
  });

  it('reads anything else as a failure', () => {
    expect(classifyDisplayMediaError(domError('NotReadableError', 'Could not start video source'))).toBe('failed');
    expect(classifyDisplayMediaError('boom')).toBe('failed');
  });
});

describe('useScreenShare', () => {
  it('shares a display and reports its label', async () => {
    const { stream } = fakeStream('Screen 2');
    getDisplayMedia.mockResolvedValue(stream);
    const { result } = renderHook(() => useScreenShare());

    await act(() => result.current.start());

    expect(result.current.status).toBe('sharing');
    expect(result.current.stream).toBe(stream);
    expect(result.current.label).toBe('Screen 2');
    expect(result.current.error).toBeNull();
  });

  it('does nothing when the operator cancels the picker', async () => {
    getDisplayMedia.mockRejectedValue(domError('NotAllowedError', 'Permission denied'));
    const { result } = renderHook(() => useScreenShare());

    await act(() => result.current.start());

    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('reports the macOS permission problem', async () => {
    getDisplayMedia.mockRejectedValue(domError('NotAllowedError', 'Permission denied by system'));
    const { result } = renderHook(() => useScreenShare());

    await act(() => result.current.start());

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('system-denied');
  });

  it('reports a browser with no screen sharing', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    const { result } = renderHook(() => useScreenShare());

    await act(() => result.current.start());

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('unsupported');
  });

  it('marks the share ended when the track ends on its own', async () => {
    const { stream, track } = fakeStream();
    getDisplayMedia.mockResolvedValue(stream);
    const { result } = renderHook(() => useScreenShare());
    await act(() => result.current.start());

    act(() => track.onended?.());

    expect(result.current.status).toBe('ended');
    expect(result.current.stream).toBeNull();
  });

  it('stops the tracks when the operator stops sharing', async () => {
    const { stream, track } = fakeStream();
    getDisplayMedia.mockResolvedValue(stream);
    const { result } = renderHook(() => useScreenShare());
    await act(() => result.current.start());

    act(() => result.current.stop());

    expect(track.stop).toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
    expect(result.current.stream).toBeNull();
  });

  it('replaces a running share and stops the old one', async () => {
    const first = fakeStream('Screen 1');
    const second = fakeStream('Screen 2');
    getDisplayMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    const { result } = renderHook(() => useScreenShare());

    await act(() => result.current.start());
    await act(() => result.current.start());

    expect(first.track.stop).toHaveBeenCalled();
    expect(result.current.stream).toBe(second.stream);
    // The old track ending later must not end the new share.
    act(() => first.track.onended?.());
    expect(result.current.status).toBe('sharing');
  });

  it('keeps a running share when a second attempt fails', async () => {
    const { stream } = fakeStream();
    getDisplayMedia.mockResolvedValueOnce(stream).mockRejectedValueOnce(domError('NotReadableError', 'x'));
    const { result } = renderHook(() => useScreenShare());

    await act(() => result.current.start());
    await act(() => result.current.start());

    expect(result.current.status).toBe('sharing');
    expect(result.current.stream).toBe(stream);
    expect(result.current.error).toBe('failed');
  });

  it('stops the tracks when the console unmounts', async () => {
    const { stream, track } = fakeStream();
    getDisplayMedia.mockResolvedValue(stream);
    const { result, unmount } = renderHook(() => useScreenShare());
    await act(() => result.current.start());

    unmount();

    expect(track.stop).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/stream/useScreenShare.test.ts`
Expected: FAIL — cannot resolve `./useScreenShare`.

- [ ] **Step 3: Write the implementation**

`src/stream/useScreenShare.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The projector display, shared into the console.
 *
 * Deliberately independent of the translation session: an operator sets the
 * share up before the meeting starts, and ending a session leaves it running.
 */

export type ShareStatus = 'idle' | 'sharing' | 'ended' | 'error';
export type ShareError = 'system-denied' | 'unsupported' | 'failed';

export interface ScreenShare {
  stream: MediaStream | null;
  status: ShareStatus;
  error: ShareError | null;
  /** The browser's name for what is shared, e.g. "Screen 2". */
  label: string;
  start: () => Promise<void>;
  stop: () => void;
}

// Chrome-only hints are passed through as-is; other browsers ignore them.
// `selfBrowserSurface: 'exclude'` keeps the console's own tab out of the
// picker — sharing it would put the console inside its own broadcast.
const DISPLAY_MEDIA_OPTIONS = {
  video: { frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  audio: false,
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'include',
  monitorTypeSurfaces: 'include'
} as DisplayMediaStreamOptions;

/**
 * Chrome rejects with NotAllowedError both when the operator closes the
 * picker and when macOS has not granted Screen Recording; only the message
 * tells them apart ("Permission denied" vs "Permission denied by system").
 */
export function classifyDisplayMediaError(err: unknown): 'cancelled' | 'system-denied' | 'failed' {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  const message = typeof err === 'object' && err !== null ? String((err as { message?: unknown }).message ?? '') : '';
  if (name === 'NotAllowedError') return /system/i.test(message) ? 'system-denied' : 'cancelled';
  return 'failed';
}

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => {
    track.onended = null;
    track.stop();
  });
}

export function useScreenShare(): ScreenShare {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<ShareStatus>('idle');
  const [error, setError] = useState<ShareError | null>(null);
  const [label, setLabel] = useState('');
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(true);

  const release = useCallback((next: ShareStatus) => {
    stopTracks(streamRef.current);
    streamRef.current = null;
    setStream(null);
    setStatus(next);
  }, []);

  const start = useCallback(async () => {
    const mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    if (!mediaDevices?.getDisplayMedia) {
      setError('unsupported');
      setStatus('error');
      return;
    }

    let next: MediaStream;
    try {
      next = await mediaDevices.getDisplayMedia(DISPLAY_MEDIA_OPTIONS);
    } catch (err) {
      const kind = classifyDisplayMediaError(err);
      if (kind === 'cancelled') return;
      setError(kind);
      // A share that is already running keeps running; only say "error"
      // when there is nothing on screen.
      if (!streamRef.current) setStatus('error');
      return;
    }

    if (!mountedRef.current) {
      stopTracks(next);
      return;
    }

    stopTracks(streamRef.current);
    streamRef.current = next;
    const [track] = next.getVideoTracks();
    if (track) {
      // Chrome's own "Stop sharing" button, or the display being unplugged.
      track.onended = () => {
        if (streamRef.current === next) release('ended');
      };
    }
    setStream(next);
    setLabel(track?.label ?? '');
    setError(null);
    setStatus('sharing');
  }, [release]);

  const stop = useCallback(() => release('idle'), [release]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopTracks(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  return { stream, status, error, label, start, stop };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/stream/useScreenShare.test.ts && npm run lint`
Expected: 12 tests PASS; tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/stream/useScreenShare.ts src/stream/useScreenShare.test.ts
git commit -m "feat: screen share hook"
```

---

### Task 8: `useOutputWindow`

**Files:**
- Create: `src/stream/useOutputWindow.ts`
- Test: `src/stream/useOutputWindow.test.ts`

**Interfaces:**
- Produces:
  - `PREFER_DOCUMENT_PIP: boolean` — **set from the Task 0 result** (`true` if OBS captured PiP reliably on both OSes, else `false`)
  - `OUTPUT_WINDOW_SIZE = { width: 960, height: 540 }`
  - `type OutputWindowKind = 'pip' | 'popup'`, `type OutputWindowError = 'blocked' | 'failed'`
  - `requestOutputWindow(host: Window, preferPip: boolean): Promise<{ win: Window; kind: OutputWindowKind } | null>`
  - `prepareOutputDocument(source: Document, target: Document): HTMLElement`
  - `interface OutputWindow { container: HTMLElement | null; kind: OutputWindowKind | null; isOpen: boolean; error: OutputWindowError | null; open: () => Promise<void>; close: () => void }`
  - `useOutputWindow(preferPip?: boolean): OutputWindow`

- [ ] **Step 1: Write the failing test**

`src/stream/useOutputWindow.test.ts`:

```ts
// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareOutputDocument, requestOutputWindow, useOutputWindow } from './useOutputWindow';

function fakeWindow() {
  const listeners = new Map<string, () => void>();
  const win = {
    document: document.implementation.createHTMLDocument('output'),
    closed: false,
    close: vi.fn(() => {
      win.closed = true;
    }),
    focus: vi.fn(),
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    fire: (type: string) => listeners.get(type)?.()
  };
  return win;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.head.replaceChildren();
});

// The console's document is the real jsdom document: it has an http:// URL,
// so relative stylesheet links resolve the way they do in the browser.
function addConsoleStyles() {
  document.head.innerHTML = '<style>.a{color:red}</style><link rel="stylesheet" href="/assets/index.css">';
}

describe('prepareOutputDocument', () => {
  it('copies the app stylesheets with absolute URLs and returns a mount point', () => {
    addConsoleStyles();
    const target = document.implementation.createHTMLDocument('output');

    const root = prepareOutputDocument(document, target);

    expect(target.head.querySelectorAll('style').length).toBe(1);
    const link = target.head.querySelector('link[rel="stylesheet"]')!;
    expect(link.getAttribute('href')).toMatch(/^https?:\/\/.+\/assets\/index\.css$/);
    expect(root.ownerDocument).toBe(target);
    expect(target.body.contains(root)).toBe(true);
  });

  it('does not pile up copies when a window is prepared twice', () => {
    addConsoleStyles();
    const target = document.implementation.createHTMLDocument('output');

    prepareOutputDocument(document, target);
    prepareOutputDocument(document, target);

    expect(target.head.querySelectorAll('style').length).toBe(1);
    expect(target.head.querySelectorAll('link').length).toBe(1);
    expect(target.body.children.length).toBe(1);
  });
});

describe('requestOutputWindow', () => {
  it('uses Document PiP when preferred and available', async () => {
    const pipWin = fakeWindow();
    const host = { documentPictureInPicture: { requestWindow: vi.fn().mockResolvedValue(pipWin) }, open: vi.fn() };
    const result = await requestOutputWindow(host as unknown as Window, true);
    expect(result).toEqual({ win: pipWin, kind: 'pip' });
    expect(host.open).not.toHaveBeenCalled();
  });

  it('falls back to a popup without Document PiP', async () => {
    const popup = fakeWindow();
    const host = { open: vi.fn().mockReturnValue(popup) };
    const result = await requestOutputWindow(host as unknown as Window, true);
    expect(result).toEqual({ win: popup, kind: 'popup' });
  });

  it('uses a popup when PiP is not preferred', async () => {
    const popup = fakeWindow();
    const host = { documentPictureInPicture: { requestWindow: vi.fn() }, open: vi.fn().mockReturnValue(popup) };
    const result = await requestOutputWindow(host as unknown as Window, false);
    expect(result?.kind).toBe('popup');
    expect(host.documentPictureInPicture.requestWindow).not.toHaveBeenCalled();
  });

  it('returns null when the popup is blocked', async () => {
    const host = { open: vi.fn().mockReturnValue(null) };
    expect(await requestOutputWindow(host as unknown as Window, false)).toBeNull();
  });
});

describe('useOutputWindow', () => {
  it('opens a window and exposes a container inside it', async () => {
    const popup = fakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const { result } = renderHook(() => useOutputWindow(false));

    await act(() => result.current.open());

    expect(result.current.isOpen).toBe(true);
    expect(result.current.kind).toBe('popup');
    expect(result.current.container?.ownerDocument).toBe(popup.document);
  });

  it('reports a blocked popup', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderHook(() => useOutputWindow(false));

    await act(() => result.current.open());

    expect(result.current.isOpen).toBe(false);
    expect(result.current.error).toBe('blocked');
  });

  it('notices when the viewer closes the window', async () => {
    const popup = fakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const { result } = renderHook(() => useOutputWindow(false));
    await act(() => result.current.open());

    act(() => popup.fire('pagehide'));

    expect(result.current.isOpen).toBe(false);
    expect(result.current.container).toBeNull();
  });

  it('closes the window on request and on unmount', async () => {
    const popup = fakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const { result, unmount } = renderHook(() => useOutputWindow(false));
    await act(() => result.current.open());

    act(() => result.current.close());
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(result.current.isOpen).toBe(false);

    const again = fakeWindow();
    vi.spyOn(window, 'open').mockReturnValue(again as unknown as Window);
    await act(() => result.current.open());
    unmount();
    expect(again.close).toHaveBeenCalledTimes(1);
  });

  it('focuses an already-open window instead of opening another', async () => {
    const popup = fakeWindow();
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const { result } = renderHook(() => useOutputWindow(false));

    await act(() => result.current.open());
    await act(() => result.current.open());

    expect(open).toHaveBeenCalledTimes(1);
    expect(popup.focus).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/stream/useOutputWindow.test.ts`
Expected: FAIL — cannot resolve `./useOutputWindow`.

- [ ] **Step 3: Write the implementation**

`src/stream/useOutputWindow.ts` (set `PREFER_DOCUMENT_PIP` from the Task 0 result):

```ts
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The window OBS captures.
 *
 * Opened by the console and rendered into with a React portal, so it shares
 * the console's state instead of syncing a copy of it. Document
 * Picture-in-Picture is preferred because it stays on top and cannot be
 * minimised — and a minimised Chrome window stops painting, which OBS
 * captures as a frozen frame. A popup is the fallback.
 */

// Decided by the spike (spikes/stream-output-spike.html): whether OBS Window
// Capture reliably captures a Document PiP window on macOS and Windows.
export const PREFER_DOCUMENT_PIP = true;
export const OUTPUT_WINDOW_SIZE = { width: 960, height: 540 };

export type OutputWindowKind = 'pip' | 'popup';
export type OutputWindowError = 'blocked' | 'failed';

export interface OutputWindow {
  /** Where to portal the stage; null while no window is open. */
  container: HTMLElement | null;
  kind: OutputWindowKind | null;
  isOpen: boolean;
  error: OutputWindowError | null;
  /** Must be called from a click handler — both window kinds need a user gesture. */
  open: () => Promise<void>;
  close: () => void;
}

interface DocumentPictureInPictureApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

export async function requestOutputWindow(
  host: Window,
  preferPip: boolean
): Promise<{ win: Window; kind: OutputWindowKind } | null> {
  const pip = (host as Window & { documentPictureInPicture?: DocumentPictureInPictureApi }).documentPictureInPicture;
  if (preferPip && pip) {
    return { win: await pip.requestWindow(OUTPUT_WINDOW_SIZE), kind: 'pip' };
  }
  const win = host.open(
    '',
    'live-translation-output',
    `popup,width=${OUTPUT_WINDOW_SIZE.width},height=${OUTPUT_WINDOW_SIZE.height}`
  );
  return win ? { win, kind: 'popup' } : null;
}

/**
 * Gives the Output document the console's styles and a bare black body, and
 * returns the element to portal into. Links are rewritten to absolute URLs:
 * the new document's base URL is not guaranteed to be the console's.
 */
export function prepareOutputDocument(source: Document, target: Document): HTMLElement {
  target.title = 'Live Translation — Output';
  target.head.querySelectorAll('[data-output-style]').forEach((node) => node.remove());
  source.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
    const copy = node.cloneNode(true) as Element;
    if (node.tagName === 'LINK') copy.setAttribute('href', (node as HTMLLinkElement).href);
    copy.setAttribute('data-output-style', '');
    target.head.appendChild(target.importNode(copy, true));
  });
  target.body.replaceChildren();
  target.body.style.cssText = 'margin:0;background:#000;overflow:hidden;';
  const root = target.createElement('div');
  root.id = 'output-root';
  target.body.appendChild(root);
  return root;
}

export function useOutputWindow(preferPip: boolean = PREFER_DOCUMENT_PIP): OutputWindow {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [kind, setKind] = useState<OutputWindowKind | null>(null);
  const [error, setError] = useState<OutputWindowError | null>(null);
  const winRef = useRef<Window | null>(null);

  const forget = useCallback(() => {
    winRef.current = null;
    setContainer(null);
    setKind(null);
  }, []);

  const close = useCallback(() => {
    const win = winRef.current;
    forget();
    if (win && !win.closed) win.close();
  }, [forget]);

  const open = useCallback(async () => {
    const existing = winRef.current;
    if (existing && !existing.closed) {
      existing.focus();
      return;
    }

    let result: Awaited<ReturnType<typeof requestOutputWindow>>;
    try {
      result = await requestOutputWindow(window, preferPip);
    } catch {
      setError('failed');
      return;
    }
    if (!result) {
      setError('blocked');
      return;
    }

    const { win } = result;
    const root = prepareOutputDocument(document, win.document);
    winRef.current = win;
    win.addEventListener('pagehide', () => {
      if (winRef.current === win) forget();
    });
    setError(null);
    setKind(result.kind);
    setContainer(root);
  }, [preferPip, forget]);

  useEffect(
    () => () => {
      const win = winRef.current;
      winRef.current = null;
      if (win && !win.closed) win.close();
    },
    []
  );

  return { container, kind, isOpen: container !== null, error, open, close };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/stream/useOutputWindow.test.ts && npm run lint`
Expected: 11 tests PASS; tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/stream/useOutputWindow.ts src/stream/useOutputWindow.test.ts
git commit -m "feat: output window hook (Document PiP with popup fallback)"
```

---

### Task 9: `OutputStage`

**Files:**
- Create: `src/stream/OutputStage.tsx`
- Test: `src/stream/OutputStage.test.tsx`
- Modify (tuning only, if needed): `src/components/captionStyle.ts` stage sizes
- Harness (uncommitted): `src/harness/Stage.tsx`, `src/harness/main.tsx`, `harness/stage.mjs`

**Interfaces:**
- Consumes: `LiveCaptionBox`, `CaptionView` (Task 3); `STAGE_WIDTH`, `STAGE_HEIGHT`, `fitScale`, `dragBar`, `BarPosition` (Task 5); `OutputPrefs` (Task 6); `useOutputWindow` (Task 8, harness only)
- Produces: `default function OutputStage(props: { stream: MediaStream | null; config: DisplayConfig; caption: CaptionView; prefs: OutputPrefs; onMove: (position: BarPosition) => void }): JSX.Element`

- [ ] **Step 1: Write the failing test**

`src/stream/OutputStage.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import OutputStage from './OutputStage';
import type { CaptionView } from '../components/LiveCaptionBox';

// jsdom has no PointerEvent; a MouseEvent carrying a pointerId is enough here.
beforeAll(() => {
  if (!('PointerEvent' in window)) {
    class PointerEventPolyfill extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    Object.defineProperty(window, 'PointerEvent', { value: PointerEventPolyfill, configurable: true });
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const caption: CaptionView = {
  sourceText: '',
  targetText: 'Welcome to the conference.',
  hasPartial: false,
  rows: [],
  latencyMs: 900,
  isIdle: false
};

function renderStage(prefs = { x: 50, y: 96, widthPct: 80, locked: false }, onMove = vi.fn()) {
  render(<OutputStage stream={null} config={{ fontSize: 'large', captionTheme: 'translucent', showLatency: true }} caption={caption} prefs={prefs} onMove={onMove} />);
  return { bar: screen.getByTestId('output-caption-bar'), stage: screen.getByTestId('output-stage'), onMove };
}

describe('OutputStage', () => {
  it('places the bar by its bottom-centre at the saved position and width', () => {
    const { bar } = renderStage({ x: 40, y: 90, widthPct: 70, locked: false });
    expect(bar.style.left).toBe('40%');
    expect(bar.style.top).toBe('90%');
    expect(bar.style.width).toBe('70%');
    expect(bar.style.transform).toBe('translate(-50%, -100%)');
  });

  it('shows the caption but none of the operator-only extras', () => {
    renderStage();
    expect(screen.getByText('Welcome to the conference.')).toBeTruthy();
    expect(screen.queryByText(/ms$/)).toBeNull();
    expect(screen.queryByText('พร้อมรับเสียงจากไมโครโฟน')).toBeNull();
  });

  it('reports where a drag left the bar', () => {
    const { bar, stage, onMove } = renderStage();
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({ width: 960, height: 540, left: 0, top: 0, right: 960, bottom: 540, x: 0, y: 0, toJSON: () => ({}) });

    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 480, clientY: 500 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 480, clientY: 446 }); // up 54px = 10%
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 480, clientY: 446 });

    expect(onMove).toHaveBeenCalledWith({ x: 50, y: 86 });
  });

  it('ignores drags while locked', () => {
    const { bar, stage, onMove } = renderStage({ x: 50, y: 96, widthPct: 80, locked: true });
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({ width: 960, height: 540, left: 0, top: 0, right: 960, bottom: 540, x: 0, y: 0, toJSON: () => ({}) });

    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 480, clientY: 500 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 100, clientY: 100 });

    expect(onMove).not.toHaveBeenCalled();
  });

  it('does not report a click that did not move the bar', () => {
    const { bar, onMove } = renderStage();
    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 480, clientY: 500 });
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 480, clientY: 500 });
    expect(onMove).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/stream/OutputStage.test.tsx`
Expected: FAIL — cannot resolve `./OutputStage`.

- [ ] **Step 3: Write the implementation**

`src/stream/OutputStage.tsx`:

```tsx
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import LiveCaptionBox, { type CaptionView } from '../components/LiveCaptionBox';
import type { OutputPrefs } from '../storage/outputStore';
import type { DisplayConfig } from '../types';
import { STAGE_HEIGHT, STAGE_WIDTH, dragBar, fitScale, type BarPosition } from './outputLayout';

interface OutputStageProps {
  /** The shared display; null draws a black slide area. */
  stream: MediaStream | null;
  /** The console's display settings — the bar looks exactly like the console box. */
  config: DisplayConfig;
  caption: CaptionView;
  prefs: OutputPrefs;
  /** Called once per finished drag with the bar's new position. */
  onMove: (position: BarPosition) => void;
}

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  origin: BarPosition;
  current: BarPosition;
}

/**
 * The broadcast image: the shared display with the caption bar on top, in a
 * fixed 1920×1080 stage scaled to whatever window holds it. What is drawn
 * here is exactly what OBS captures, so nothing operator-only appears.
 */
export default function OutputStage({ stream, config, caption, prefs, onMove }: OutputStageProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [scale, setScale] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);

  // Sized by the window the stage is IN — the Output window, not the console.
  useLayoutEffect(() => {
    const view = rootRef.current?.ownerDocument.defaultView;
    if (!view) return;
    const update = () => setScale(fitScale(view.innerWidth, view.innerHeight));
    update();
    view.addEventListener('resize', update);
    return () => view.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    if (!stream) return;
    // Muted, so autoplay is allowed; jsdom returns undefined here.
    const playing = video.play() as Promise<void> | undefined;
    playing?.catch(() => undefined);
  }, [stream]);

  const barSize = () => ({
    widthPct: prefs.widthPct,
    heightPct: ((barRef.current?.offsetHeight ?? 0) / STAGE_HEIGHT) * 100
  });

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (prefs.locked || e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const origin = { x: prefs.x, y: prefs.y };
    setDrag({ pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origin, current: origin });
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const current = dragBar(
      drag.origin,
      { dx: e.clientX - drag.startX, dy: e.clientY - drag.startY },
      { width: rect.width, height: rect.height },
      barSize()
    );
    setDrag({ ...drag, current });
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    setDrag(null);
    if (drag.current.x !== drag.origin.x || drag.current.y !== drag.origin.y) onMove(drag.current);
  };

  const position = drag?.current ?? { x: prefs.x, y: prefs.y };

  return (
    <div ref={rootRef} className="fixed inset-0 flex items-center justify-center overflow-hidden bg-black">
      <div
        ref={stageRef}
        data-testid="output-stage"
        className="relative shrink-0 overflow-hidden bg-black"
        style={{ width: STAGE_WIDTH * scale, height: STAGE_HEIGHT * scale }}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ width: STAGE_WIDTH, height: STAGE_HEIGHT, transform: `scale(${scale})` }}
        >
          <video ref={videoRef} autoPlay muted playsInline className="absolute inset-0 w-full h-full object-contain" />
          <div
            ref={barRef}
            data-testid="output-caption-bar"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className={`absolute select-none touch-none ${prefs.locked ? '' : 'cursor-move'} ${
              drag ? 'outline-2 outline-offset-8 outline-white/70 rounded-[24px]' : ''
            }`}
            style={{
              left: `${position.x}%`,
              top: `${position.y}%`,
              width: `${prefs.widthPct}%`,
              transform: 'translate(-50%, -100%)'
            }}
          >
            <LiveCaptionBox config={config} view={caption} variant="stage" />
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/stream/OutputStage.test.tsx && npm run lint`
Expected: 5 tests PASS; tsc exits 0.

- [ ] **Step 5: Harness — the stage in a page and in a real popup**

`src/harness/Stage.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import OutputStage from '../stream/OutputStage';
import { useOutputWindow } from '../stream/useOutputWindow';
import { DEFAULT_OUTPUT_PREFS, type OutputPrefs } from '../storage/outputStore';
import type { DisplayConfig } from '../types';

/** A fake "slide": a canvas stream with a moving marker so frozen frames are obvious. */
function useFakeSlideStream(): MediaStream | null {
  const [stream, setStream] = useState<MediaStream | null>(null);
  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    const ctx = canvas.getContext('2d')!;
    let frame = 0;
    const id = setInterval(() => {
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(0, 0, 1920, 1080);
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 96px sans-serif';
      ctx.fillText('Clinical Results 2026', 160, 260);
      ctx.font = '48px sans-serif';
      ['• Primary endpoint met', '• 1,204 participants', '• Follow-up: 18 months'].forEach((t, i) => ctx.fillText(t, 160, 420 + i * 90));
      ctx.fillStyle = '#de5c8e';
      ctx.fillRect(160 + ((frame++ * 8) % 1600), 900, 80, 80);
    }, 33);
    setStream(canvas.captureStream(30));
    return () => clearInterval(id);
  }, []);
  return stream;
}

export default function Stage() {
  const params = new URLSearchParams(location.search);
  const config: DisplayConfig = {
    fontSize: (params.get('size') as DisplayConfig['fontSize']) ?? 'large',
    captionTheme: (params.get('theme') as DisplayConfig['captionTheme']) ?? 'translucent',
    showOriginal: params.get('original') === '1'
  };
  const stream = useFakeSlideStream();
  const [prefs, setPrefs] = useState<OutputPrefs>({ ...DEFAULT_OUTPUT_PREFS, locked: params.get('locked') === '1' });
  const output = useOutputWindow(false);
  const caption = useMemo(
    () => ({
      sourceText: 'สวัสดีครับทุกท่าน ยินดีต้อนรับสู่การประชุมวิชาการประจำปี',
      targetText: 'Good morning everyone, and welcome to the annual research conference of the faculty of medicine.',
      hasPartial: false,
      rows: [],
      latencyMs: 820,
      isIdle: false
    }),
    []
  );
  const stage = (
    <OutputStage
      stream={params.get('nostream') === '1' ? null : stream}
      config={config}
      caption={caption}
      prefs={prefs}
      onMove={(p) => setPrefs((prev) => ({ ...prev, ...p }))}
    />
  );
  return (
    <>
      {params.get('popup') === '1' ? (
        <button data-testid="open-popup" onClick={() => void output.open()} className="m-4 px-3 py-2 bg-pink-600 text-white rounded">
          open
        </button>
      ) : (
        stage
      )}
      {output.container && createPortal(stage, output.container)}
      <pre data-testid="prefs" className="fixed top-0 right-0 z-50 bg-white text-xs p-1">{JSON.stringify(prefs)}</pre>
    </>
  );
}
```

Register in `src/harness/main.tsx`: `import Stage from './Stage';` and `stage: () => <Stage />` in `views`.

Also add a console-box reference to compare proportions — in `src/harness/Stage.tsx` nothing more; use the `theme-buttons` view's `console-box` screenshot from Task 4 (1000px wide console box at desktop sizes).

`harness/stage.mjs`:

```js
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('harness/out', { recursive: true });
const base = 'http://localhost:5199/harness.html?view=stage';
const browser = await chromium.launch();

async function shot(name, query, viewport) {
  const page = await browser.newPage({ viewport });
  await page.goto(`${base}&${query}`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `harness/out/stage-${name}.png` });
  return page;
}

for (const theme of ['light', 'dark', 'translucent']) {
  await (await shot(`${theme}-1280`, `theme=${theme}&original=1`, { width: 1280, height: 720 })).close();
}
await (await shot('xlarge-960', 'size=xlarge', { width: 960, height: 540 })).close();
await (await shot('nostream', 'nostream=1', { width: 960, height: 540 })).close();
await (await shot('letterbox', 'theme=dark', { width: 1200, height: 540 })).close();

// Drag: move the bar up and left, then check the reported prefs.
const page = await shot('before-drag', '', { width: 960, height: 540 });
const bar = page.getByTestId('output-caption-bar');
const box = await bar.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2 - 150, { steps: 10 });
await page.screenshot({ path: 'harness/out/stage-dragging.png' });
await page.mouse.up();
await page.screenshot({ path: 'harness/out/stage-after-drag.png' });
console.log('prefs after drag', await page.getByTestId('prefs').textContent());
await page.close();

// Locked: dragging must not move it.
const locked = await shot('locked', 'locked=1', { width: 960, height: 540 });
const lbox = await locked.getByTestId('output-caption-bar').boundingBox();
await locked.mouse.move(lbox.x + 50, lbox.y + 20);
await locked.mouse.down();
await locked.mouse.move(lbox.x - 200, lbox.y - 200, { steps: 5 });
await locked.mouse.up();
console.log('prefs after locked drag', await locked.getByTestId('prefs').textContent());
await locked.close();

// Real popup: portal into another window.
const opener = await browser.newPage({ viewport: { width: 400, height: 300 } });
await opener.goto(`${base}&popup=1&theme=translucent&original=1`);
const [popup] = await Promise.all([opener.waitForEvent('popup'), opener.getByTestId('open-popup').click()]);
await popup.setViewportSize({ width: 960, height: 540 });
await popup.waitForTimeout(800);
await popup.screenshot({ path: 'harness/out/stage-popup.png' });
const lines = await popup.evaluate(() => {
  // The translation paragraph: the last visible <p> in the bar (SubtitleText's
  // measuring twin is aria-hidden). Its on-screen height, unscaled, in lines.
  const visible = document.querySelectorAll('[data-testid="output-caption-bar"] p:not([aria-hidden])');
  const p = visible[visible.length - 1];
  if (!p) return -1;
  const scale = Math.min(innerWidth / 1920, innerHeight / 1080);
  return Math.round(p.getBoundingClientRect().height / scale / parseFloat(getComputedStyle(p).lineHeight));
});
console.log('popup caption visible lines (expect 1 or 2):', lines);
await browser.close();
```

Run (Vite on 5199): `node harness/stage.mjs`
Read every `harness/out/stage-*.png`. Expected:
- Slide fills the stage; `letterbox` shows black bars left/right of the 16:9 stage; `nostream` is black with the bar.
- Bar bottom edge ~4% above the bottom, centred, 80% wide; no latency badge, no idle hint.
- All three themes readable over the slide; translucent shows the slide faintly through the bar.
- Text is fully inside the bar (no clipped descenders on Thai source line) at 960×540 — this is the Task 2 transform fix in action.
- `stage-dragging.png` shows the outline; `stage-after-drag.png` has no outline and the bar moved up-left; printed prefs `x` < 50 and `y` < 96.
- Locked: prefs unchanged `{"x":50,"y":96,...}`.
- `stage-popup.png` matches `stage-translucent-1280.png` in composition; printed lines is 1 or 2.

**Proportion check:** compare `stage-translucent-1280.png` against `harness/out/theme-buttons-console-box.png` (Task 4). The translation text height relative to the box width should look the same. If the stage text is visibly larger/smaller, adjust the four `stageText` px values in `src/components/captionStyle.ts` by the same factor, re-run `npx vitest run src/components/captionStyle.test.ts` (it checks ordering only) and re-shoot.

- [ ] **Step 6: Commit**

```bash
git add src/stream/OutputStage.tsx src/stream/OutputStage.test.tsx src/components/captionStyle.ts
git commit -m "feat: output stage with draggable caption bar"
```

---

### Task 10: สตรีม tab, status chip and OBS guide

**Files:**
- Create: `src/stream/StreamPanel.tsx`
- Test: `src/stream/StreamPanel.test.tsx`
- Harness (uncommitted): `src/harness/Panel.tsx`, `src/harness/main.tsx`

**Interfaces:**
- Consumes: `ScreenShare` (Task 7); `OutputWindow` (Task 8); `OutputPrefs`, `DEFAULT_OUTPUT_PREFS`, `MIN_BAR_WIDTH_PCT`, `MAX_BAR_WIDTH_PCT` (Task 6); `clampBar` (Task 5)
- Produces:
  - `default function StreamPanel(props: { share: ScreenShare; output: OutputWindow; prefs: OutputPrefs; onPrefsChange: (prefs: OutputPrefs) => void }): JSX.Element`
  - `function StreamStatusChip(props: { share: ScreenShare; output: OutputWindow }): JSX.Element | null`

- [ ] **Step 1: Write the failing test**

`src/stream/StreamPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StreamPanel, { StreamStatusChip } from './StreamPanel';
import type { ScreenShare } from './useScreenShare';
import type { OutputWindow } from './useOutputWindow';
import { DEFAULT_OUTPUT_PREFS } from '../storage/outputStore';

afterEach(cleanup);

const share = (over: Partial<ScreenShare> = {}): ScreenShare => ({
  stream: null, status: 'idle', error: null, label: '', start: vi.fn(), stop: vi.fn(), ...over
});
const output = (over: Partial<OutputWindow> = {}): OutputWindow => ({
  container: null, kind: null, isOpen: false, error: null, open: vi.fn(), close: vi.fn(), ...over
});

describe('StreamPanel', () => {
  it('starts a share from the picker button', () => {
    const s = share();
    render(<StreamPanel share={s} output={output()} prefs={DEFAULT_OUTPUT_PREFS} onPrefsChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /เลือกจอที่จะแชร์/ }));
    expect(s.start).toHaveBeenCalled();
  });

  it('shows what is shared and lets the operator stop it', () => {
    const s = share({ status: 'sharing', label: 'Screen 2' });
    render(<StreamPanel share={s} output={output()} prefs={DEFAULT_OUTPUT_PREFS} onPrefsChange={vi.fn()} />);
    expect(screen.getByText(/Screen 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'หยุดแชร์' }));
    expect(s.stop).toHaveBeenCalled();
  });

  it('says the share stopped and offers to share again', () => {
    render(<StreamPanel share={share({ status: 'ended' })} output={output()} prefs={DEFAULT_OUTPUT_PREFS} onPrefsChange={vi.fn()} />);
    expect(screen.getByText(/แชร์จอหยุดแล้ว/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /แชร์ใหม่/ })).toBeTruthy();
  });

  it('explains the macOS Screen Recording permission', () => {
    render(<StreamPanel share={share({ status: 'error', error: 'system-denied' })} output={output()} prefs={DEFAULT_OUTPUT_PREFS} onPrefsChange={vi.fn()} />);
    expect(screen.getByText(/Screen Recording/)).toBeTruthy();
  });

  it('opens and closes the Output window', () => {
    const closed = output();
    const { rerender } = render(<StreamPanel share={share()} output={closed} prefs={DEFAULT_OUTPUT_PREFS} onPrefsChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /เปิดหน้าต่าง Output/ }));
    expect(closed.open).toHaveBeenCalled();

    const open = output({ isOpen: true, kind: 'pip' });
    rerender(<StreamPanel share={share()} output={open} prefs={DEFAULT_OUTPUT_PREFS} onPrefsChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /ปิดหน้าต่าง Output/ }));
    expect(open.close).toHaveBeenCalled();
  });

  it('tells the operator to allow popups when blocked', () => {
    render(<StreamPanel share={share()} output={output({ error: 'blocked' })} prefs={DEFAULT_OUTPUT_PREFS} onPrefsChange={vi.fn()} />);
    expect(screen.getByText(/อนุญาต popup/)).toBeTruthy();
  });

  it('changes width, keeping the bar on the stage', () => {
    const onPrefsChange = vi.fn();
    render(<StreamPanel share={share()} output={output()} prefs={{ ...DEFAULT_OUTPUT_PREFS, x: 30, widthPct: 50 }} onPrefsChange={onPrefsChange} />);
    fireEvent.change(screen.getByLabelText(/ความกว้างแถบคำแปล/), { target: { value: '90' } });
    expect(onPrefsChange).toHaveBeenCalledWith({ ...DEFAULT_OUTPUT_PREFS, x: 45, widthPct: 90 });
  });

  it('locks and resets the position', () => {
    const onPrefsChange = vi.fn();
    const prefs = { x: 20, y: 50, widthPct: 40, locked: false };
    render(<StreamPanel share={share()} output={output()} prefs={prefs} onPrefsChange={onPrefsChange} />);
    fireEvent.click(screen.getByLabelText(/ล็อกตำแหน่ง/));
    expect(onPrefsChange).toHaveBeenLastCalledWith({ ...prefs, locked: true });
    fireEvent.click(screen.getByRole('button', { name: /รีเซ็ตตำแหน่ง/ }));
    expect(onPrefsChange).toHaveBeenLastCalledWith({ ...prefs, x: DEFAULT_OUTPUT_PREFS.x, y: DEFAULT_OUTPUT_PREFS.y });
  });
});

describe('StreamStatusChip', () => {
  it('renders nothing when idle', () => {
    const { container } = render(<StreamStatusChip share={share()} output={output()} />);
    expect(container.textContent).toBe('');
  });

  it('shows sharing and Output state', () => {
    render(<StreamStatusChip share={share({ status: 'sharing' })} output={output({ isOpen: true })} />);
    expect(screen.getByText('แชร์จอ')).toBeTruthy();
    expect(screen.getByText('Output')).toBeTruthy();
  });

  it('flags a share that stopped while Output is still open', () => {
    render(<StreamStatusChip share={share({ status: 'ended' })} output={output({ isOpen: true })} />);
    expect(screen.getByText('แชร์จอหยุด')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/stream/StreamPanel.test.tsx`
Expected: FAIL — cannot resolve `./StreamPanel`.

- [ ] **Step 3: Write the implementation**

`src/stream/StreamPanel.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { AlertTriangle, AppWindow, Lock, MonitorUp, RotateCcw, Square } from 'lucide-react';
import type { ScreenShare } from './useScreenShare';
import type { OutputWindow } from './useOutputWindow';
import { clampBar } from './outputLayout';
import { DEFAULT_OUTPUT_PREFS, MAX_BAR_WIDTH_PCT, MIN_BAR_WIDTH_PCT, type OutputPrefs } from '../storage/outputStore';

interface StreamPanelProps {
  share: ScreenShare;
  output: OutputWindow;
  prefs: OutputPrefs;
  onPrefsChange: (prefs: OutputPrefs) => void;
}

function Thumbnail({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream;
    if (!stream) return;
    const playing = video.play() as Promise<void> | undefined;
    playing?.catch(() => undefined);
  }, [stream]);
  return <video ref={ref} autoPlay muted playsInline className="w-full aspect-video rounded-lg bg-black object-contain" />;
}

const section = 'space-y-2.5 bg-slate-50 p-3.5 rounded-xl border border-slate-200';
const primaryButton =
  'w-full flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-lg text-xs font-bold bg-[#DE5C8E] hover:bg-[#c94577] text-white transition-all';
const secondaryButton =
  'flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-semibold border border-slate-200 bg-white text-slate-600 hover:text-slate-900 transition-all';
const warning = 'flex gap-2 text-[11px] leading-relaxed text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2.5';

/** The สตรีม tab: share the projector display, open the window OBS captures,
 *  and place the caption bar. Independent of the translation session. */
export default function StreamPanel({ share, output, prefs, onPrefsChange }: StreamPanelProps) {
  const sharing = share.status === 'sharing';

  const setWidth = (widthPct: number) => {
    const { x, y } = clampBar({ x: prefs.x, y: prefs.y }, { widthPct, heightPct: 0 });
    onPrefsChange({ ...prefs, widthPct, x, y });
  };

  return (
    <div className="space-y-4">
      <div className={section}>
        <div className="text-xs font-bold text-slate-800">1. แชร์หน้าจอสไลด์</div>
        {sharing ? (
          <>
            <Thumbnail stream={share.stream} />
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700 min-w-0">
                <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                <span className="truncate">กำลังแชร์: {share.label || 'หน้าจอ'}</span>
              </span>
              <button type="button" onClick={share.stop} className={secondaryButton}>
                <Square className="w-3 h-3" />
                <span>หยุดแชร์</span>
              </button>
            </div>
            <button type="button" onClick={() => void share.start()} className={`${secondaryButton} w-full`}>
              <MonitorUp className="w-3.5 h-3.5" />
              <span>เปลี่ยนจอที่แชร์</span>
            </button>
          </>
        ) : (
          <>
            {share.status === 'ended' && (
              <div className={warning}>
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>แชร์จอหยุดแล้ว — หน้าต่าง Output ยังเปิดอยู่และแสดงพื้นดำกับคำแปล กดแชร์ใหม่เพื่อให้สไลด์กลับมา</span>
              </div>
            )}
            <button type="button" onClick={() => void share.start()} className={primaryButton}>
              <MonitorUp className="w-4 h-4" />
              <span>{share.status === 'ended' ? 'แชร์ใหม่ (เลือกจอที่จะแชร์)' : 'เลือกจอที่จะแชร์'}</span>
            </button>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              เลือก <b>ทั้งหน้าจอ</b> ของจอ projector ที่เปิดสไลด์ — อย่าเลือกจอที่มีหน้านี้อยู่ ภาพจะซ้อนกันไม่รู้จบ
            </p>
          </>
        )}
        {share.error === 'system-denied' && (
          <div className={warning}>
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              macOS ยังไม่อนุญาตให้เบราว์เซอร์บันทึกหน้าจอ: เปิด System Settings → Privacy &amp; Security → Screen Recording
              แล้วเปิดสิทธิ์ให้ Chrome/Edge จากนั้น <b>ปิดและเปิดเบราว์เซอร์ใหม่</b>
            </span>
          </div>
        )}
        {share.error === 'unsupported' && (
          <div className={warning}>
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>เบราว์เซอร์นี้แชร์หน้าจอไม่ได้ — ใช้ Google Chrome หรือ Microsoft Edge</span>
          </div>
        )}
        {share.error === 'failed' && (
          <div className={warning}>
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>แชร์หน้าจอไม่สำเร็จ ลองใหม่อีกครั้ง</span>
          </div>
        )}
      </div>

      <div className={section}>
        <div className="text-xs font-bold text-slate-800">2. หน้าต่าง Output (ให้ OBS จับ)</div>
        {output.isOpen ? (
          <button type="button" onClick={output.close} className={`${secondaryButton} w-full`}>
            <AppWindow className="w-3.5 h-3.5" />
            <span>ปิดหน้าต่าง Output</span>
          </button>
        ) : (
          <button type="button" onClick={() => void output.open()} className={primaryButton}>
            <AppWindow className="w-4 h-4" />
            <span>เปิดหน้าต่าง Output</span>
          </button>
        )}
        {output.error === 'blocked' && (
          <div className={warning}>
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>เบราว์เซอร์บล็อกหน้าต่างใหม่ — กดไอคอนที่ช่อง address bar เพื่ออนุญาต popup สำหรับเว็บนี้ แล้วกดเปิดอีกครั้ง</span>
          </div>
        )}
        {output.error === 'failed' && (
          <div className={warning}>
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>เปิดหน้าต่าง Output ไม่สำเร็จ ลองกดอีกครั้ง</span>
          </div>
        )}

        <div>
          <label htmlFor="output-bar-width" className="flex justify-between text-[11px] font-bold text-slate-700 mb-1">
            <span>ความกว้างแถบคำแปล</span>
            <span className="font-mono text-slate-500">{prefs.widthPct}%</span>
          </label>
          <input
            id="output-bar-width"
            type="range"
            min={MIN_BAR_WIDTH_PCT}
            max={MAX_BAR_WIDTH_PCT}
            step={5}
            value={prefs.widthPct}
            onChange={(e) => setWidth(Number(e.target.value))}
            className="w-full accent-[#DE5C8E]"
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-[11px] font-semibold text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={prefs.locked}
              onChange={(e) => onPrefsChange({ ...prefs, locked: e.target.checked })}
              className="accent-[#DE5C8E]"
            />
            <Lock className="w-3 h-3" />
            <span>ล็อกตำแหน่ง</span>
          </label>
          <button
            type="button"
            onClick={() => onPrefsChange({ ...prefs, x: DEFAULT_OUTPUT_PREFS.x, y: DEFAULT_OUTPUT_PREFS.y })}
            className={secondaryButton}
          >
            <RotateCcw className="w-3 h-3" />
            <span>รีเซ็ตตำแหน่ง</span>
          </button>
        </div>
        <p className="text-[11px] text-slate-500 leading-relaxed">
          ลากแถบคำแปลในหน้าต่าง Output เพื่อย้ายตำแหน่ง — ผู้ชมจะเห็นแถบขยับด้วย จัดให้เสร็จก่อนเริ่มถ่ายทอด แล้วกดล็อก
        </p>
      </div>

      <details className="bg-white rounded-xl border border-slate-200 p-3.5 text-[11px] text-slate-600 leading-relaxed">
        <summary className="text-xs font-bold text-slate-800 cursor-pointer">วิธีตั้งค่า OBS</summary>
        <ol className="list-decimal pl-4 mt-2 space-y-1.5">
          <li>เพิ่ม Source แบบ <b>Window Capture</b> แล้วเลือกหน้าต่าง "Live Translation — Output" (บน Windows เลือก Capture Method เป็น "Windows 10 (1903 and up)")</li>
          <li>ปิดตัวเลือก <b>Capture Cursor</b> เพื่อไม่ให้เมาส์ขึ้นบน stream</li>
          <li>ถ้าเป็นหน้าต่าง popup ที่มีแถบ address bar ให้ crop ด้านบนออก (คลิกขวา Source → Transform → Edit Transform)</li>
          <li><b>ห้าม minimise หน้าต่าง Output</b> — Chrome จะหยุดวาดภาพ และ OBS จะได้ภาพค้าง ย้ายไปไว้มุมจอหรือให้หน้าต่างอื่นอยู่ข้างๆ แทน</li>
          <li>macOS: ครั้งแรกต้องให้สิทธิ์ Screen Recording ทั้งกับ Chrome/Edge และ OBS ใน System Settings — ทำก่อนวันงาน</li>
          <li>ถ้าเสียงคลิป YouTube ดังผ่านลำโพงห้อง ไมโครโฟนจะได้ยินและแปลด้วย — กด "พัก" session ระหว่างเปิดคลิปถ้าไม่ต้องการ</li>
        </ol>
      </details>
    </div>
  );
}

/** Header status: visible from every tab, so the operator always knows the
 *  broadcast window is live — or that the slides dropped out of it. */
export function StreamStatusChip({ share, output }: { share: ScreenShare; output: OutputWindow }) {
  const ended = share.status === 'ended' && output.isOpen;
  if (share.status !== 'sharing' && !output.isOpen) return null;
  return (
    <div className="flex items-center gap-1 shrink-0">
      {share.status === 'sharing' && (
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          <span>แชร์จอ</span>
        </span>
      )}
      {ended && (
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
          <AlertTriangle className="w-3 h-3" />
          <span>แชร์จอหยุด</span>
        </span>
      )}
      {output.isOpen && (
        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-pink-50 text-[#DE5C8E] border border-pink-200">
          <AppWindow className="w-3 h-3" />
          <span>Output</span>
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/stream/StreamPanel.test.tsx && npm run lint`
Expected: 11 tests PASS; tsc exits 0. If `AppWindow` or `MonitorUp` is not exported by the installed `lucide-react`, run `node -e "const l=require('lucide-react');console.log(['AppWindow','MonitorUp','RotateCcw','Square','Lock','AlertTriangle'].map(n=>n+':'+!!l[n]).join(' '))"` and substitute `ExternalLink` / `Monitor` for any `false`.

- [ ] **Step 5: Harness — look at it at sidebar widths**

`src/harness/Panel.tsx`:

`TabStrip` below is the sidebar tab strip exactly as Task 11 Step 1 will make it in `Admin.tsx` (three columns, สตรีม active). Keep the two in sync: if Task 11 changes a class or label, change it here too.

```tsx
import { useState } from 'react';
import { BookOpen, Languages, MonitorUp } from 'lucide-react';
import StreamPanel, { StreamStatusChip } from '../stream/StreamPanel';
import { DEFAULT_OUTPUT_PREFS } from '../storage/outputStore';
import type { ScreenShare } from '../stream/useScreenShare';
import type { OutputWindow } from '../stream/useOutputWindow';

const noop = async () => undefined;
const states: Array<{ id: string; share: ScreenShare; output: OutputWindow }> = [
  { id: 'idle', share: { stream: null, status: 'idle', error: null, label: '', start: noop, stop: () => {} }, output: { container: null, kind: null, isOpen: false, error: null, open: noop, close: () => {} } },
  { id: 'live', share: { stream: null, status: 'sharing', error: null, label: 'Screen 2 (projector) — a very long display name', start: noop, stop: () => {} }, output: { container: null, kind: 'pip', isOpen: true, error: null, open: noop, close: () => {} } },
  { id: 'problems', share: { stream: null, status: 'ended', error: 'system-denied', label: '', start: noop, stop: () => {} }, output: { container: null, kind: null, isOpen: true, error: 'blocked', open: noop, close: () => {} } }
];

function TabStrip() {
  const activeTab: string = 'stream';
  const tab = (id: string) =>
    `py-2 px-1 rounded-lg font-semibold flex items-center justify-center gap-1.5 transition-all ${
      activeTab === id ? 'bg-white text-[#DE5C8E] shadow-xs' : 'text-slate-500 hover:text-slate-800'
    }`;
  return (
    <div className="grid grid-cols-3 p-1.5 bg-slate-50 border-b border-slate-200 text-xs gap-1 shrink-0">
      <button className={tab('languages')}>
        <Languages className="w-4 h-4" />
        <span className="whitespace-nowrap">ภาษาและการตั้งค่า</span>
      </button>
      <button className={tab('dictionary')}>
        <BookOpen className="w-4 h-4" />
        <span className="whitespace-nowrap">พจนานุกรม</span>
      </button>
      <button className={tab('stream')}>
        <MonitorUp className="w-4 h-4" />
        <span className="whitespace-nowrap">สตรีม</span>
      </button>
    </div>
  );
}

export default function Panel() {
  const [prefs, setPrefs] = useState(DEFAULT_OUTPUT_PREFS);
  return (
    <div className="flex gap-6 p-6 bg-slate-100 min-h-screen items-start">
      {states.map((s) => (
        <div key={s.id} className="space-y-3">
          <div data-testid={`chip-${s.id}`} className="bg-white p-2 w-fit"><StreamStatusChip share={s.share} output={s.output} /></div>
          {[384, 336].map((w) => (
            // Same shell as the <aside>: tab strip then p-4 content.
            <div key={w} data-testid={`panel-${s.id}-${w}`} className="bg-white border border-slate-200 overflow-hidden" style={{ width: w }}>
              <TabStrip />
              <div className="p-4"><StreamPanel share={s.share} output={s.output} prefs={prefs} onPrefsChange={setPrefs} /></div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
```

Register in `src/harness/main.tsx`: `import Panel from './Panel';` and `panel: () => <Panel />`.

Run (Vite on 5199): `node harness/shoot.mjs panel 1500 2400 panel-idle-384 panel-live-336 panel-problems-336 chip-live chip-problems`
Read the PNGs. Expected: no horizontal overflow at 336px; long share label truncates with ellipsis on one line; the lock checkbox and reset button sit on one row; warnings wrap cleanly; chips on one line; three tabs on one row with `ภาษาและการตั้งค่า` not overflowing its cell. Fix classes in `StreamPanel.tsx` for anything that overflows, re-run tests, re-shoot. If the first tab label overflows at 336px, change it to `ตั้งค่า` in `TabStrip` and carry that change into Task 11 Step 1.

- [ ] **Step 6: Commit**

```bash
git add src/stream/StreamPanel.tsx src/stream/StreamPanel.test.tsx
git commit -m "feat: stream tab panel and status chip"
```

---

### Task 11: Wire it into the console

**Files:**
- Modify: `src/pages/Admin.tsx`

**Interfaces:**
- Consumes: `useScreenShare` (7), `useOutputWindow` (8), `OutputStage` (9), `StreamPanel`, `StreamStatusChip` (10), `loadOutputPrefs`, `saveOutputPrefs`, `OutputPrefs` (6), `BarPosition` (5), `captionView` (3)

- [ ] **Step 1: Imports, state, tab**

In `Admin.tsx`, add `MonitorUp` to the existing `lucide-react` import list (after `LogOut`), and add these imports below the existing ones:

```tsx
import { createPortal } from 'react-dom';
import OutputStage from '../stream/OutputStage';
import StreamPanel, { StreamStatusChip } from '../stream/StreamPanel';
import { useScreenShare } from '../stream/useScreenShare';
import { useOutputWindow } from '../stream/useOutputWindow';
import type { BarPosition } from '../stream/outputLayout';
import { loadOutputPrefs, saveOutputPrefs, type OutputPrefs } from '../storage/outputStore';
```

Change the tab state:

```tsx
  const [activeTab, setActiveTab] = useState<'languages' | 'dictionary' | 'stream'>('languages');
```

Directly after the `config` `useState` block, add:

```tsx
  // ── Stream output ─────────────────────────────────────────────────────────
  // The projector display and the window OBS captures. Both live as long as
  // this console does and are independent of the translation session: set up
  // before the meeting, untouched when a session ends. Signing out unmounts
  // the console, and the hooks' cleanups stop the share and close the window.
  const share = useScreenShare();
  const output = useOutputWindow();
  const [outputPrefs, setOutputPrefs] = useState<OutputPrefs>(() => loadOutputPrefs());
  const updateOutputPrefs = useCallback((next: OutputPrefs) => {
    setOutputPrefs(next);
    saveOutputPrefs(next);
  }, []);
  const moveOutputBar = useCallback(
    (position: BarPosition) => updateOutputPrefs({ ...outputPrefs, ...position }),
    [outputPrefs, updateOutputPrefs]
  );

  // Reloading or closing the console takes the Output window with it, and
  // OBS with it goes to black mid-broadcast. Ask first.
  useEffect(() => {
    if (!output.isOpen) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [output.isOpen]);
```

In the sidebar tab strip change `grid grid-cols-2 p-1.5` to `grid grid-cols-3 p-1.5`, and after the พจนานุกรม button add:

```tsx
              <button
                onClick={() => setActiveTab('stream')}
                className={`py-2 px-1 rounded-lg font-semibold flex items-center justify-center gap-1.5 transition-all ${
                  activeTab === 'stream' ? 'bg-white text-[#DE5C8E] shadow-xs' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <MonitorUp className="w-4 h-4" />
                <span className="whitespace-nowrap">สตรีม</span>
              </button>
```

After the `{activeTab === 'dictionary' && ( … )}` block add:

```tsx
              {activeTab === 'stream' && (
                <StreamPanel share={share} output={output} prefs={outputPrefs} onPrefsChange={updateOutputPrefs} />
              )}
```

- [ ] **Step 2: Portal and header chip**

Directly after the `captionView` `useMemo` (Task 3), add:

```tsx
  // The broadcast image, drawn into the Output window. Rendered from every
  // screen below — including the project picker — so switching projects
  // mid-event does not blank the stream.
  const outputPortal = output.container
    ? createPortal(
        <OutputStage
          stream={share.stream}
          config={config}
          caption={captionView}
          prefs={outputPrefs}
          onMove={moveOutputBar}
        />,
        output.container
      )
    : null;
```

Add `{outputPortal}` as the first child of each of the three returned trees:
1. The `projects.loading` return: wrap as `<>{outputPortal}<div className="min-h-screen …">กำลังโหลดโปรเจกต์…</div></>`.
2. The `!projects.currentProject` return: first child inside the `<>` fragment.
3. The main return: first child inside `<div className="flex flex-col h-screen …">`.

In the header, after `<LiveCostBadge cost={liveCost} isRecording={isSessionActive} />` (desktop row), add:

```tsx
            <StreamStatusChip share={share} output={output} />
```

- [ ] **Step 3: Typecheck and test**

Run: `npm run lint && npm test`
Expected: tsc exits 0; all tests PASS.

- [ ] **Step 4: Confirm the tab strip matches the harness**

Diff the tab strip in `Admin.tsx` against `TabStrip` in `src/harness/Panel.tsx`: the container classes, the button classes and the three labels must be identical (only `onClick` and the real `activeTab` differ). If they differ, make the harness match `Admin.tsx`, then run `node harness/shoot.mjs panel 1500 2400 panel-idle-384 panel-idle-336` and Read the PNGs. Expected: three tabs on one row at both widths, no label overflowing its cell.

- [ ] **Step 5: End-to-end in real Chrome (manual, with the dev server)**

Run: `npm run dev`, sign in, open a project. Then:
1. สตรีม tab → เลือกจอที่จะแชร์ → pick a screen/window. Expected: thumbnail moves; header shows `แชร์จอ`.
2. เปิดหน้าต่าง Output. Expected: a PiP (or popup) window with the shared screen and an empty caption bar; header shows `Output`.
3. Start a session and speak. Expected: the Output bar shows the same text as the console box, live partial included.
4. Change font size and theme (including โปร่งแสง) in the ภาษา tab. Expected: Output changes immediately.
5. Drag the bar; reload is not needed — close and reopen the Output window. Expected: bar returns at the dragged position. Tick ล็อกตำแหน่ง; dragging does nothing.
6. Minimise the console window (not the Output). Expected: the Output keeps updating captions while speaking.
7. Click Chrome's "Stop sharing". Expected: Output slide area goes black, captions continue, สตรีม tab says `แชร์จอหยุดแล้ว`, header shows `แชร์จอหยุด`.
8. Press reload on the console with Output open. Expected: browser asks to confirm leaving.
9. Stop the session. Expected: Output window stays open.

Record any failure and fix before committing.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Admin.tsx
git commit -m "feat: stream tab and output window in the console"
```

---

### Task 12: Docs, hardware checklist, cleanup

**Files:**
- Modify: `SYSTEM_OVERVIEW.md`
- Create: `docs/stream-output-checklist.md`
- Delete: `spikes/stream-output-spike.html`, `harness.html`, `src/harness/`, `harness/`

- [ ] **Step 1: Document the feature in `SYSTEM_OVERVIEW.md`**

Replace the section heading and body of `### 2.1 กล่อง Subtitle เดียว สำหรับ crop ไป OBS` with:

```markdown
### 2.1 กล่อง Subtitle เดียว และหน้าต่าง Output สำหรับ OBS
พื้นที่แสดงคำแปลหลักเป็น **กล่องเดียว** แสดงทีละข้อความ (เหมือน subtitle บน
YouTube) วาดโดย `src/components/LiveCaptionBox.tsx` ประวัติทั้งหมดอยู่ใน panel
พับเก็บด้านล่าง

แท็บ **สตรีม** ในแถบข้างใช้ถ่ายทอดสด โดย OBS จับหน้าต่างเดียว:

1. **แชร์หน้าจอ** (`src/stream/useScreenShare.ts`) — เลือกจอ projector ที่เปิดสไลด์
   หรือคลิป YouTube ภาพเปลี่ยนตามจอจริง สลับสไลด์หรือเปิดคลิปได้โดยไม่ต้องแชร์ใหม่
2. **หน้าต่าง Output** (`src/stream/useOutputWindow.ts`) — Document
   Picture-in-Picture (อยู่บนสุดเสมอ ย่อไม่ได้) หรือ popup ถ้าเบราว์เซอร์ไม่รองรับ
   console วาดลงหน้าต่างนี้ด้วย React portal จึงใช้ state ชุดเดียวกัน ไม่มีการ sync
   และไม่แตะเซิร์ฟเวอร์
3. **Stage 1920×1080** (`src/stream/OutputStage.tsx`) — สไลด์เต็มพื้นที่ + แถบคำแปล
   ที่หน้าตาตรงกับกล่องใน console ทุกอย่าง (ขนาดตัวอักษร ธีม แสดงต้นฉบับ) แต่ไม่มี
   ป้าย latency และข้อความ "กำลังแปล…" ลากแถบย้ายตำแหน่งได้ในหน้าต่าง Output
   ปรับความกว้างและล็อกตำแหน่งได้จากแท็บสตรีม ค่าเก็บต่อเครื่อง
   (`src/storage/outputStore.ts`)

ธีมคำบรรยายมีสามแบบ: ตัวดำพื้นขาว, ตัวขาวพื้นดำ และ **โปร่งแสง** (พื้นดำ 70%
เห็นสไลด์ด้านหลัง)

**ข้อจำกัดที่ต้องรู้:** Chrome หยุดวาดหน้าต่างที่ถูก minimise — ห้าม minimise
หน้าต่าง Output ระหว่างถ่ายทอด (console minimise ได้) การแชร์จอและหน้าต่าง Output
ไม่ผูกกับ session แปลภาษา จบ session แล้วยังเปิดอยู่ ถ้า refresh console หน้าต่าง
Output จะปิดตาม ระบบจึงถามยืนยันก่อน checklist ทดสอบบนเครื่องจริงอยู่ที่
`docs/stream-output-checklist.md`
```

In the §1.3 file table, add rows:

```markdown
| `src/components/LiveCaptionBox.tsx` | กล่องคำแปลสด ใช้ร่วมกันระหว่าง console และหน้าต่าง Output (`captionStyle.ts` = สี/ขนาด, `useCaptionStackAnimation.ts` = animation) |
| `src/stream/useScreenShare.ts` | แชร์หน้าจอ projector + สถานะ + แยกกรณี macOS ไม่ให้สิทธิ์ |
| `src/stream/useOutputWindow.ts` | เปิด/ปิดหน้าต่าง Output (Document PiP หรือ popup) และคัดลอก stylesheet |
| `src/stream/OutputStage.tsx` | ภาพที่ถ่ายทอด 1920×1080: สไลด์ + แถบคำแปลที่ลากได้ |
| `src/stream/outputLayout.ts` | คณิตศาสตร์ของ stage (scale, clamp, drag, snap) — pure ทั้งไฟล์ |
| `src/stream/StreamPanel.tsx` | แท็บสตรีม, ป้ายสถานะบน header, คู่มือตั้งค่า OBS |
| `src/storage/outputStore.ts` | ตำแหน่ง/ความกว้าง/ล็อกของแถบคำแปล ต่อเครื่อง |
```

- [ ] **Step 2: Write the real-hardware checklist**

`docs/stream-output-checklist.md`:

```markdown
# Checklist ทดสอบหน้าต่าง Output บนเครื่องจริง

ทำบน **macOS หนึ่งเครื่อง และ Windows หนึ่งเครื่อง** ต่อจอ projector (หรือจอที่สอง)
แบบ extend และเปิด OBS ไว้ ใช้เวลาประมาณ 1 ชั่วโมงครึ่ง

## เตรียม
- [ ] macOS: System Settings → Privacy & Security → Screen Recording เปิดให้ Chrome/Edge และ OBS แล้ว
- [ ] เปิด PowerPoint แบบ slideshow เต็มจอบนจอ projector

## หน้าต่าง Output
- [ ] แท็บสตรีม → เลือกจอที่จะแชร์ → เลือก **ทั้งจอ** projector — ภาพตัวอย่างขยับ
- [ ] เปิดหน้าต่าง Output — ได้หน้าต่าง PiP (หรือ popup) เห็นสไลด์
- [ ] OBS → Window Capture เลือกหน้าต่าง "Live Translation — Output" ได้ และภาพขยับ
      (Windows: Capture Method "Windows 10 (1903 and up)")
- [ ] ปิด Capture Cursor แล้วเมาส์ไม่ขึ้นใน OBS
- [ ] แถบ "Chrome กำลังแชร์หน้าจอ" ขึ้นจอไหน: ______ (ถ้าขึ้นบน projector กด "ซ่อน")

## ระหว่างพูด
- [ ] เริ่ม session พูด — คำแปลใน OBS ตรงกับกล่องใน console
- [ ] ใช้รีโมต/คีย์บอร์ดเลื่อนสไลด์ — สไลด์ใน OBS เปลี่ยนตาม คำแปลยังขึ้นต่อเนื่อง
- [ ] คลิกปรับค่าใน console แล้วกดรีโมต — สไลด์ไม่เลื่อน (ปกติ) คลิกที่ slideshow หนึ่งครั้งแล้วเลื่อนได้
- [ ] เปิดคลิป YouTube เต็มจอบนจอ projector — OBS เห็นคลิป เสียงคลิปเข้า OBS
- [ ] minimise console — คำแปลใน OBS ยังขยับ
- [ ] เปลี่ยนขนาดตัวอักษร / ธีม (รวมโปร่งแสง) — OBS เปลี่ยนตามทันที
- [ ] ลากแถบคำแปล → ล็อก → ลากไม่ได้ → ปิดเปิดหน้าต่าง Output แล้วตำแหน่งยังอยู่

## กรณีผิดปกติ
- [ ] กด "หยุดแชร์" ของ Chrome — OBS เป็นพื้นดำ + คำแปล, แท็บสตรีมบอกแชร์จอหยุด, แชร์ใหม่ได้
- [ ] ถอดสาย projector — เหมือนข้อบน
- [ ] กด refresh console — เบราว์เซอร์ถามยืนยัน

## ทนทาน
- [ ] เปิดทิ้งไว้ 1 ชั่วโมงระหว่างพูดเป็นระยะ — ภาพใน OBS ไม่กระตุก ไม่ค้าง คำแปลไม่ล่าช้าลง

ผลลัพธ์ / ปัญหาที่พบ:
```

- [ ] **Step 3: Remove the spike and harness**

```bash
git rm spikes/stream-output-spike.html
rm -rf harness.html src/harness harness
git status --short
```

Expected: `git status` shows only `D spikes/stream-output-spike.html` plus the two doc changes — no harness files listed (they were never committed).

- [ ] **Step 4: Full verification**

Run: `npm run lint && npm test && npm run build`
Expected: tsc exits 0; all tests PASS; `vite build` and the esbuild server bundle both succeed.

- [ ] **Step 5: Commit**

```bash
git add SYSTEM_OVERVIEW.md docs/stream-output-checklist.md
git commit -m "docs: stream output overview and hardware checklist; remove spike"
```

Then hand `docs/stream-output-checklist.md` to the user to run on real hardware.
