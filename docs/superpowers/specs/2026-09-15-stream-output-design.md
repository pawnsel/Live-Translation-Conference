# Stream output — design

> Status: approved by user in conversation, 2026-09-15. Target: an operator
> can share the projector display from inside the console and get ONE
> composed 16:9 window — slides with the live caption bar on top — that OBS
> captures as a single source. It replaces today's workflow of two browser
> windows side by side that OBS crops and assembles by hand for every event.
>
> OBS stays: it still owns encoding, RTMP and audio. Streaming straight from
> the browser (canvas → server → ffmpeg → RTMP) was considered and deferred;
> see §9.

## 1. The setting this is designed for

Established with the user, not assumed:

- **One machine.** Slides (PowerPoint, or a YouTube clip) run on the same
  computer as the console and OBS. No capture card.
- **Two displays, extended.** The laptop display holds the console, OBS and
  the Output window; the projector display shows the slides full screen.
  The projector display is what gets shared, so the console is never inside
  its own capture.
- **OS is not fixed.** Events are run on macOS or Windows, with Chrome or
  Edge. Nothing here may depend on an OS-specific workaround.
- **Observed at a past event:** Chrome keeps painting a window that is on
  screen but unfocused; it stops painting the moment the window is
  **minimised**, and OBS then captures a frozen frame. The Output window must
  therefore stay on screen, and the design pushes toward an always-on-top
  window (§3).

Uploading slides was ruled out by the user: presenters switch to YouTube
clips mid-talk, so the source has to be a live screen share.

## 2. Architecture

```
Console tab (Admin.tsx)
 ├─ useScreenShare   → getDisplayMedia → MediaStream (projector display)
 ├─ Stream tab UI    → output prefs (bar width, lock, reset position)
 └─ useOutputWindow  → Output window (same JS realm)
                        └─ React portal → <OutputStage>
                             ├─ <video srcObject={stream}>  (object-fit: contain)
                             └─ <LiveCaptionBox>  (same component as the console)
```

The Output window is opened by the console and rendered into with a React
portal, so it reads the **same** React state as the console: the same
`MediaStream` object, the same captions and live partial, the same display
config. There is no second page, no sync channel, no second login, and no
server change.

### Units

| Unit | Purpose | Depends on |
|---|---|---|
| `src/stream/useScreenShare.ts` | Owns the display `MediaStream` and its status (`idle` / `sharing` / `ended` / `error`), including the track `ended` event. | `navigator.mediaDevices.getDisplayMedia` |
| `src/stream/useOutputWindow.ts` | Opens/closes the Output window, copies the app's stylesheets into it, exposes its `document.body` as a portal target, reports when the viewer closes it. | Document PiP API, `window.open` fallback |
| `src/stream/OutputStage.tsx` | Pure render of the 1920×1080 stage: video + positioned caption bar + drag behaviour. Holds no state of its own beyond an in-progress drag. | `LiveCaptionBox`, `outputLayout.ts` |
| `src/stream/outputLayout.ts` | Pure functions: pointer delta → position in %, clamping to the stage, centre snap, font tier → stage px. | nothing |
| `src/storage/outputStore.ts` | Per-machine output prefs (position, bar width, lock), via `safeStorage`, same pattern as `micStore.ts`. | `safeStorage.ts` |
| `src/components/LiveCaptionBox.tsx` | The live caption box, extracted from `Admin.tsx`, used by both the console and the Output stage. | `SubtitleText`, `useCaptionStackAnimation` |
| `src/components/useCaptionStackAnimation.ts` | The rolling-stack slide animation, extracted from `Admin.tsx`. | Web Animations API |

## 3. The Output window

**Two candidate window kinds; a spike decides which is primary (§8 step 0).**

| | Document Picture-in-Picture | `window.open` popup |
|---|---|---|
| Address bar | none | a thin one — one-off crop in OBS |
| Can be covered / minimised | no — always on top, cannot be minimised | yes |
| Limits | Chrome/Edge 116+; Chrome caps its size; closes if the console reloads | effectively none |
| OBS Window Capture | **unverified on macOS and Windows** | known to work |

Preferred: Document PiP, because "always on top, cannot be minimised" is
exactly the failure observed in §1. `useOutputWindow` falls back to
`window.open` automatically when `documentPictureInPicture` is absent. If the
spike shows OBS cannot capture the PiP window, popup becomes primary and the
OBS guide tells operators to keep it uncovered.

**The stage.** A fixed 1920×1080 box scaled with a CSS transform to fit the
window, so every size and position is expressed in stage units and the
output looks identical at any window size. On a Retina Mac a 960-point-wide
window yields a 1920 px capture.

**Cross-window correctness.** Code rendered into the Output window runs in
the console's JS realm but lays out in the Output window's document. Anything
that measures or observes must use the element's own window
(`node.ownerDocument.defaultView`) — notably `ResizeObserver` and
`getComputedStyle` in `SubtitleText` and the stack animation — or the
caption will page and wrap against the wrong viewport. The Web Animations
API (`node.animate`) runs on the element's document timeline, so the
existing animation keeps running when the console window is minimised; no
rewrite to CSS transitions is needed. This must be verified, not assumed.

## 4. Layout and caption bar

**One layout: overlay at the bottom.** The shared display fills the stage
(`object-fit: contain`, so a 4:3 slide gets black side bars). With no active
share the slide area is black and the caption bar still renders.

**The caption bar looks exactly like the console's caption box.** Every
display setting is shared, and changing it in the console changes the Output
immediately: font size tier, font family, theme, show original, rolling
stack (`showPrevious`). There are no Output-only appearance settings.

- Font tiers map to stage px so the bar's text-to-width proportion matches
  what the operator sees in the console. The exact px values are chosen by
  comparing Playwright screenshots of both, not by guessing.
- Not shown on the stream: the latency badge and the "กำลังแปล…"
  placeholder. An idle bar is empty.

**Draggable.** The whole bar is dragged directly in the Output window — what
the operator sees is what goes out.

- A thin outline shows only while dragging.
- Snaps to horizontal centre when released near it.
- Position is stored as % of the stage, clamped so the bar never leaves it,
  and persisted per machine.
- **Lock position** toggle (console) disables dragging during a broadcast;
  **Reset position** returns to bottom-centre.
- Viewers see the bar move while it is dragged, because it is the broadcast
  image. The guide says to position before going live, then lock.
- OBS Window Capture's "Capture Cursor" should be off; the guide says so.

**Output-only prefs** are therefore just: position (default: bottom-centre, 4% of stage height above the bottom edge), bar width (% of stage, default 80%),
lock.

**New theme: `translucent`.** `DisplayConfig.captionTheme` becomes
`'light' | 'dark' | 'translucent'`. Translucent is black at 70% opacity
with the dark theme's text colours (white final text, dimmed partial and
source). It is a third button next to light/dark (`Admin.tsx`, theme
buttons) and applies to the console box too, where it reads as dark grey
over the page background.

## 5. Console controls

A third sidebar tab, **สตรีม**, beside `ภาษา` and `คำศัพท์`:

1. **แชร์หน้าจอ** — picker button; while sharing, the track label, a small
   live thumbnail and a Stop button.
2. **หน้าต่าง Output** — open/close; bar width slider; lock toggle; reset
   position.
3. **วิธีตั้งค่า OBS** — collapsible guide: Window Capture of the Output
   window, cursor capture off, macOS Screen Recording permission, keep the
   Output window on screen.

A status chip in the console header (`● แชร์จอ`, `⧉ Output`) is visible from
every tab.

Screen sharing and the Output window are **independent of the translation
session**: both can be set up before "เริ่ม Session", and ending a session
closes neither. Signing out stops the share and closes the Output window.

## 6. Error handling

| Event | Behaviour |
|---|---|
| Operator cancels the picker | Nothing; no error shown. |
| macOS denies screen recording at the system level | Explain how to enable Screen Recording for the browser in System Settings and that the browser must be restarted. |
| Share ends on its own (Chrome's Stop button, projector unplugged) | Output window stays open; slide area goes black; captions continue. Console shows "แชร์จอหยุดแล้ว" with a re-share button. The window is never closed automatically, because OBS would lose its source. |
| Document PiP unsupported | Fall back to `window.open` silently. |
| Popup blocked | Tell the operator to allow popups for this site. |
| Viewer closes the Output window | Status returns to closed; reopening restores the saved position. |
| Console reload/close while Output is open | `beforeunload` confirmation, because the Output window closes with it. |

## 7. Testing

1. **Unit (vitest):** `outputLayout.ts` (delta → %, clamping, centre snap,
   tier → px); theme class mapping for all three themes; `outputStore.ts`
   read/write/defaults and corrupt-storage fallback.
2. **Hooks:** `useScreenShare` with a mocked `getDisplayMedia` (cancel,
   system denial, track `ended`); `useOutputWindow` with PiP absent and with
   `window.open` returning `null`.
3. **Extraction is behaviour-preserving:** existing `captionStack` and
   `subtitleLines` tests stay green; Playwright screenshots of the console
   caption box before and after the extraction, in every theme and both
   stack modes, match.
4. **Visual (Playwright, Chrome with a fake display source):** Output stage
   in all three themes, dragging and lock, share ended → black slide area.
5. **Real hardware (user, from a checklist):** OBS captures the PiP window on
   macOS and on Windows; where Chrome's "sharing this screen" bar appears and
   whether it lands on the projector; slide clicker still advances slides
   while translating; a one-hour soak with no stutter or freeze.

## 8. Order of work

0. **Spike (throwaway):** a single HTML page that shares a display into a
   Document PiP window and into a popup, so the user can confirm on real
   macOS and Windows machines which one OBS captures reliably. Decides §3.
1. Extract `LiveCaptionBox` + `useCaptionStackAnimation` from `Admin.tsx`
   with no visual change.
2. Add the `translucent` theme.
3. `useScreenShare` + the สตรีม tab.
4. `useOutputWindow` + `OutputStage`.
5. Drag, lock, reset, persisted position.
6. OBS setup guide.

## 9. Out of scope

- **Streaming without OBS** (canvas → `captureStream` → server → ffmpeg →
  RTMP). Blocked by tab-audio mixing, background rendering throttling during a
  6-hour event, and server CPU/bandwidth. Steps 1–5 are reusable if this is
  revisited.
- **Other layouts** (letterboxed, side column, captions-only). Only the
  bottom overlay was requested.
- **OBS Browser Source / obs-websocket control.** Considered; rejected in
  favour of sharing inside the console.
- **Audio.** OBS continues to capture mic and desktop audio. If a YouTube
  clip plays through the room speakers the microphone will pick it up and
  translate it; operators pause the session during clips.
