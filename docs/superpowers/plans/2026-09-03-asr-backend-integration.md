# P0 — ASR Backend Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn this React app into an operator console for the `thai-realtime-asr-mt` FastAPI backend, replacing the Gemini translation path and the browser Web Speech API.

**Architecture:** The browser holds a real operator token and talks directly to Python over HTTP (sessions) and two WebSockets (`/ws/{sid}` for captions and control, `/ws/{sid}/audio` for 16 kHz PCM). The Node server keeps only Vite/static serving plus one new endpoint, `POST /api/asr/token`, which exchanges a shared operator password held in its env for an operator JWT — that endpoint is the seam where Supabase auth lands in P1. All Gemini and Socket.IO code is deleted.

**Tech Stack:** React 19, TypeScript 5.8, Vite 6, Express 4, Vitest (added by Task 1), the Web Audio `AudioWorklet` API, and the `thai-realtime-asr-mt` v1 wire protocol.

**Spec:** [`docs/superpowers/specs/2026-09-03-asr-backend-integration-design.md`](../specs/2026-09-03-asr-backend-integration-design.md)

## Global Constraints

- **Sibling repo path.** The Python backend is expected at `../thai-realtime-asr-mt` relative to this repo root, overridable with the `ASR_REPO_PATH` env var. Several tests read files from it.
- **Audio format is fixed and non-negotiable:** 16000 Hz, 1 channel, `pcm_s16le`, `frame_ms` 20 → `FRAME_SAMPLES` 320, `FRAME_BYTES` 640. One frame per binary message. The server ceiling is 5120 bytes (8 frames); exceeding it, sending an empty message, or sending an odd byte count closes the socket with `4403`.
- **Backpressure means drop, never buffer.** Above `FRAME_BYTES * 8` = 5120 bytes of `WebSocket.bufferedAmount`, discard the frame and increment a counter.
- **Ignore unknown frame `type` values and unknown fields.** This is required by the protocol, not optional hardening.
- **Optional envelope fields are serialised as `null`, never omitted.** Test for `null`, never for key absence.
- **Outbound command payloads are strict.** An unknown field in a command is a `bad_request`. Send exactly the documented fields.
- **Never write server-owned state optimistically.** `source_lang`, `target_lang`, `paused`, `mode`, `gate` and the glossary are projections of server broadcasts. Send the command, wait for the broadcast, render the broadcast.
- **Token TTLs:** operator 12 h, source 12 h. Refresh at 80% of TTL, not on failure.
- **WS rate limits are per connection:** burst 20, 5/sec refill, socket closed after 20 consecutive throttled commands. Never poll over the WebSocket; health polling uses HTTP.
- **Sessions must be created with `{"ingest": "remote"}`.** A `local` session opens the *server's* microphone.
- **`MAX_SESSIONS` is 3.** A create beyond the cap returns a conflict that must be surfaced specifically.
- **Commit after every task.** Branch: `feat/asr-backend-integration`, cut from `feat/new_ui`.

---

## File Structure

**Created — `src/asr/` (the protocol client, no React inside except the hooks):**

| File | Responsibility |
|---|---|
| `src/asr/protocol.ts` | Generated v1 types, copied verbatim from the Python repo. Never hand-edited. |
| `src/asr/captions.ts` | Pure caption reducer. Owns the `seq`/`rev` rules. No React, no I/O. |
| `src/asr/closeCodes.ts` | WebSocket close codes and `control.error` codes → operator-readable Thai/English strings. |
| `src/asr/sessions.ts` | Session HTTP calls plus the pure `chooseSession` adoption rule. |
| `src/asr/tokens.ts` | Operator token source with 80%-of-TTL refresh; source-token minting. |
| `src/asr/commands.ts` | Command frame builders with client-generated ids. |
| `src/asr/useAsrSocket.ts` | Control WebSocket lifecycle and frame dispatch. |
| `src/asr/audio/pcm.ts` | Pure float32 → int16 conversion, and the worklet source string. |
| `src/asr/audio/useAudioCapture.ts` | Microphone → worklet → audio WebSocket. |
| `src/asr/__fixtures__/protocol/*.json` | Golden frames copied from the Python repo, kept honest by a drift test. |

**Created — UI, splitting `Admin.tsx` (1403 lines, unwieldy):**

| File | Responsibility |
|---|---|
| `src/components/SessionBar.tsx` | Session adopt/create/end, health indicators, mic start/stop. |
| `src/components/CaptionFeed.tsx` | Caption list, interim line, client-side editing, export. |
| `src/components/ControlPanel.tsx` | Languages, pause, mode, gate, report. |

**Created — Node:**

| File | Responsibility |
|---|---|
| `server/asrTokenBroker.ts` | Password → operator token exchange with caching. Testable without a network. |

**Modified:** `server.ts` (359 → ~80 lines), `src/pages/Admin.tsx`, `src/components/DictionaryManager.tsx`, `src/hooks/useProjects.ts`, `src/types.ts`, `package.json`, `.env.example`, `SYSTEM_OVERVIEW.md`.

**Created — config:** `vitest.config.ts`.

---

## Task 1: Test harness, protocol types, and drift guards

**Files:**
- Create: `vitest.config.ts`
- Create: `src/asr/protocol.ts` (copied)
- Create: `src/asr/__fixtures__/protocol/*.json` (copied)
- Create: `src/asr/__tests__/drift.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: every type in `src/asr/protocol.ts` — notably `AnyFrame`, `FrameType`, `CaptionPayload`, `TargetPayload`, `WelcomePayload`, `GlossarySections`, `GateSettings`, `ErrorCode`, `Role`, `PROTOCOL_VERSION`. Also the npm script `npm test`.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/asr-backend-integration
```

- [ ] **Step 2: Install Vitest**

```bash
npm install --save-dev vitest@^3.2.4
```

- [ ] **Step 3: Add the test script to `package.json`**

In the `"scripts"` block, add:

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 4: Create `vitest.config.ts`**

A separate config file so the Vite dev-server settings in `vite.config.ts` (which disable file watching under `DISABLE_HMR`) never affect the test runner.

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'server/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: Copy the generated protocol types and the golden frames**

These are generated artifacts in the Python repo. Copying rather than importing keeps this repo buildable on its own; Step 7 adds the test that stops the copies from drifting.

```bash
ASR_REPO="${ASR_REPO_PATH:-../thai-realtime-asr-mt}"
mkdir -p src/asr/__fixtures__/protocol
cp "$ASR_REPO/frontend/src/protocol.ts" src/asr/protocol.ts
cp "$ASR_REPO"/tests/golden/protocol/*.json src/asr/__fixtures__/protocol/
ls src/asr/__fixtures__/protocol | wc -l   # expect 28
```

- [ ] **Step 6: Write the failing drift test**

Create `src/asr/__tests__/drift.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ASR_REPO = process.env.ASR_REPO_PATH ?? join(process.cwd(), '..', 'thai-realtime-asr-mt');
const hasSourceRepo = existsSync(ASR_REPO);

// These copies are generated in the Python repo. If the backend regenerates
// them and this repo does not re-copy, the client silently speaks an older
// dialect than the server — which is exactly the failure a version-tolerant
// protocol will NOT report at runtime.
describe.skipIf(!hasSourceRepo)('protocol artifacts match the backend', () => {
  it('protocol.ts is byte-identical to the generated source', () => {
    const ours = readFileSync(join(process.cwd(), 'src/asr/protocol.ts'), 'utf8');
    const theirs = readFileSync(join(ASR_REPO, 'frontend/src/protocol.ts'), 'utf8');
    expect(ours).toBe(theirs);
  });

  it('every golden frame is present and identical', () => {
    const dir = join(ASR_REPO, 'tests/golden/protocol');
    const names = readdirSync(dir).filter((n) => n.endsWith('.json'));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const ours = readFileSync(join(process.cwd(), 'src/asr/__fixtures__/protocol', name), 'utf8');
      expect(readFileSync(join(dir, name), 'utf8'), name).toBe(ours);
    }
  });
});
```

- [ ] **Step 7: Run the tests**

Run: `npm test`
Expected: PASS, 2 tests. If `protocol.ts` differs, re-run the copy in Step 5 — never hand-edit either file.

- [ ] **Step 8: Commit**

```bash
git add vitest.config.ts package.json package-lock.json src/asr/
git commit -m "test: add vitest, copy v1 protocol types and golden frames with drift guard"
```

---

## Task 2: Caption reducer

The highest-risk pure logic in P0. `seq` says which caption a frame belongs to; it does **not** order frames within that caption. Target frames carry `data.rev`, and a target frame applies only when its `rev` exceeds the highest already applied for that `seq`.

Targets are held in a map keyed by `seq`, separate from finals, so a `caption.target_update` arriving *before* its `caption.final` is not lost.

**Files:**
- Create: `src/asr/captions.ts`
- Create: `src/asr/captions.test.ts`

**Interfaces:**
- Consumes: `AnyFrame`, `CaptionPayload`, `TargetPayload` from `src/asr/protocol.ts` (Task 1).
- Produces:
  - `interface Caption { seq: number; sourceText: string; targetText: string; sourceLang: string; targetLang: string; ts: number; latencyMs: number; isEdited: boolean }`
  - `interface CaptionState { finals: Record<number, FinalEntry>; targets: Record<number, TargetEntry>; edits: Record<number, string>; interim: InterimEntry | null }`
  - `const initialCaptionState: CaptionState`
  - `type CaptionAction = { kind: 'frame'; frame: AnyFrame } | { kind: 'edit'; seq: number; targetText: string } | { kind: 'reset' }`
  - `function captionsReducer(state: CaptionState, action: CaptionAction): CaptionState`
  - `function selectCaptions(state: CaptionState): Caption[]` — ascending by `seq`

- [ ] **Step 1: Write the failing tests**

Create `src/asr/captions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnyFrame } from './protocol';
import { captionsReducer, initialCaptionState, selectCaptions } from './captions';

function golden(name: string): AnyFrame {
  const path = join(process.cwd(), 'src/asr/__fixtures__/protocol', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as AnyFrame;
}

function apply(frames: AnyFrame[]) {
  return frames.reduce((s, frame) => captionsReducer(s, { kind: 'frame', frame }), initialCaptionState);
}

describe('captionsReducer', () => {
  it('appends a final caption with an empty translation', () => {
    const out = selectCaptions(apply([golden('caption_final')]));
    expect(out).toHaveLength(1);
    expect(out[0].seq).toBe(41);
    expect(out[0].sourceText).toBe('ยาพาราเซตามอลสองเม็ด');
    expect(out[0].targetText).toBe('');
    expect(out[0].sourceLang).toBe('th');
  });

  it('applies a target update to the caption with the matching seq', () => {
    const out = selectCaptions(apply([golden('caption_final'), golden('caption_target_update')]));
    expect(out[0].targetText).toBe('two paracetamol tablets');
    expect(out[0].latencyMs).toBe(981);
  });

  it('applies a target that arrives before its final', () => {
    const out = selectCaptions(apply([golden('caption_target_update'), golden('caption_final')]));
    expect(out).toHaveLength(1);
    expect(out[0].targetText).toBe('two paracetamol tablets');
  });

  it('ignores a target whose rev is lower than one already applied', () => {
    const high = golden('caption_target_update') as any;
    const stale = { ...high, data: { ...high.data, rev: 1, target_text: 'STALE' } };
    const out = selectCaptions(apply([golden('caption_final'), high, stale]));
    expect(out[0].targetText).toBe('two paracetamol tablets');
  });

  it('ignores a target whose rev equals the one already applied', () => {
    const first = golden('caption_target_update') as any;
    const duplicate = { ...first, data: { ...first.data, target_text: 'DUPLICATE' } };
    const out = selectCaptions(apply([golden('caption_final'), first, duplicate]));
    expect(out[0].targetText).toBe('two paracetamol tablets');
  });

  it('lets a target_partial be superseded by a higher-rev target_update', () => {
    const base = golden('caption_target_update') as any;
    const partial = { ...base, type: 'caption.target_partial', data: { ...base.data, rev: 1, target_text: 'two para' } };
    const out = selectCaptions(apply([golden('caption_final'), partial, base]));
    expect(out[0].targetText).toBe('two paracetamol tablets');
  });

  it('discards a target_partial that arrives after a higher-rev update', () => {
    const base = golden('caption_target_update') as any;
    const late = { ...base, type: 'caption.target_partial', data: { ...base.data, rev: 2, target_text: 'two para' } };
    const out = selectCaptions(apply([golden('caption_final'), base, late]));
    expect(out[0].targetText).toBe('two paracetamol tablets');
  });

  it('orders captions by seq regardless of arrival order', () => {
    const a = golden('caption_final') as any;
    const b = { ...a, seq: 12, data: { ...a.data, source_text: 'earlier' } };
    const out = selectCaptions(apply([a, b]));
    expect(out.map((c) => c.seq)).toEqual([12, 41]);
  });

  it('holds a partial as the interim line without appending it', () => {
    const state = apply([golden('caption_partial')]);
    expect(selectCaptions(state)).toHaveLength(0);
    expect(state.interim?.sourceText).toBe('ยาพาราเซตามอลสองเม็ด');
  });

  it('clears the interim line when its final arrives', () => {
    const state = apply([golden('caption_partial'), golden('caption_final')]);
    expect(state.interim).toBeNull();
    expect(selectCaptions(state)).toHaveLength(1);
  });

  it('ignores unknown frame types', () => {
    const unknown = { v: 1, type: 'caption.hologram', session: 's', ts: 1, seq: 41, data: {} } as unknown as AnyFrame;
    const out = selectCaptions(apply([golden('caption_final'), unknown]));
    expect(out).toHaveLength(1);
  });

  it('ignores non-caption frames it does not own', () => {
    const out = selectCaptions(apply([golden('caption_final'), golden('glossary_state')]));
    expect(out).toHaveLength(1);
  });

  it('applies a client-side edit and marks the caption edited', () => {
    let state = apply([golden('caption_final'), golden('caption_target_update')]);
    state = captionsReducer(state, { kind: 'edit', seq: 41, targetText: 'two paracetamol' });
    const out = selectCaptions(state);
    expect(out[0].targetText).toBe('two paracetamol');
    expect(out[0].isEdited).toBe(true);
  });

  it('keeps a client-side edit when a later server target arrives', () => {
    const base = golden('caption_target_update') as any;
    const later = { ...base, data: { ...base.data, rev: 9, target_text: 'SERVER REWRITE' } };
    let state = apply([golden('caption_final'), base]);
    state = captionsReducer(state, { kind: 'edit', seq: 41, targetText: 'operator wins' });
    state = captionsReducer(state, { kind: 'frame', frame: later });
    expect(selectCaptions(state)[0].targetText).toBe('operator wins');
  });

  it('resets to empty', () => {
    const state = captionsReducer(apply([golden('caption_final')]), { kind: 'reset' });
    expect(selectCaptions(state)).toHaveLength(0);
    expect(state.interim).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/asr/captions.test.ts`
Expected: FAIL — `Failed to resolve import "./captions"`.

- [ ] **Step 3: Write the implementation**

Create `src/asr/captions.ts`:

```ts
import type { AnyFrame, CaptionPayload, TargetPayload } from './protocol';

export interface Caption {
  seq: number;
  sourceText: string;
  targetText: string;
  sourceLang: string;
  targetLang: string;
  ts: number;
  latencyMs: number;
  isEdited: boolean;
}

interface FinalEntry {
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  ts: number;
  latencyMs: number;
}

interface TargetEntry {
  targetText: string;
  targetLang: string;
  latencyMs: number;
  rev: number;
}

interface InterimEntry {
  seq: number;
  sourceText: string;
}

export interface CaptionState {
  finals: Record<number, FinalEntry>;
  // Kept separate from `finals` so a target_update that overtakes its own
  // caption.final is held rather than dropped. Merging them would make
  // correctness depend on arrival order, which the protocol does not promise.
  targets: Record<number, TargetEntry>;
  edits: Record<number, string>;
  interim: InterimEntry | null;
}

export const initialCaptionState: CaptionState = {
  finals: {},
  targets: {},
  edits: {},
  interim: null,
};

export type CaptionAction =
  | { kind: 'frame'; frame: AnyFrame }
  | { kind: 'edit'; seq: number; targetText: string }
  | { kind: 'reset' };

function applyTarget(state: CaptionState, seq: number, data: TargetPayload): CaptionState {
  const existing = state.targets[seq];
  // The rule from protocol-v1.md: seq says WHICH caption, rev orders the
  // frames within it. A strict `>` also drops exact duplicates, which a
  // reconnect can deliver.
  if (existing && data.rev <= existing.rev) return state;
  return {
    ...state,
    targets: {
      ...state.targets,
      [seq]: {
        targetText: data.target_text,
        targetLang: data.target_lang,
        latencyMs: data.latency_ms,
        rev: data.rev,
      },
    },
  };
}

export function captionsReducer(state: CaptionState, action: CaptionAction): CaptionState {
  if (action.kind === 'reset') return initialCaptionState;

  if (action.kind === 'edit') {
    return { ...state, edits: { ...state.edits, [action.seq]: action.targetText } };
  }

  const frame = action.frame;
  const seq = typeof frame.seq === 'number' ? frame.seq : null;

  switch (frame.type) {
    case 'caption.partial': {
      if (seq === null) return state;
      const data = frame.data as CaptionPayload;
      return { ...state, interim: { seq, sourceText: data.source_text } };
    }

    case 'caption.final': {
      if (seq === null) return state;
      const data = frame.data as CaptionPayload;
      return {
        ...state,
        finals: {
          ...state.finals,
          [seq]: {
            sourceText: data.source_text,
            sourceLang: data.source_lang,
            targetLang: data.target_lang,
            ts: frame.ts,
            latencyMs: data.latency_ms,
          },
        },
        interim: state.interim?.seq === seq ? null : state.interim,
      };
    }

    case 'caption.target_partial':
    case 'caption.target_update': {
      if (seq === null) return state;
      return applyTarget(state, seq, frame.data as TargetPayload);
    }

    // Every other frame type, known or unknown, belongs to someone else.
    // Ignoring unknown types is required by the protocol.
    default:
      return state;
  }
}

export function selectCaptions(state: CaptionState): Caption[] {
  return Object.keys(state.finals)
    .map(Number)
    .sort((a, b) => a - b)
    .map((seq) => {
      const final = state.finals[seq];
      const target = state.targets[seq];
      const edit = state.edits[seq];
      return {
        seq,
        sourceText: final.sourceText,
        // An operator edit outranks anything the server sends afterwards.
        // The alternative — letting a late target overwrite a correction the
        // operator just typed — is the behaviour that makes people stop
        // trusting the edit button.
        targetText: edit ?? target?.targetText ?? '',
        sourceLang: final.sourceLang,
        targetLang: target?.targetLang ?? final.targetLang,
        ts: final.ts,
        latencyMs: target?.latencyMs ?? final.latencyMs,
        isEdited: edit !== undefined,
      };
    });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/asr/captions.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/asr/captions.ts src/asr/captions.test.ts
git commit -m "feat(asr): add caption reducer with seq/rev ordering rules"
```

---

## Task 3: Close-code and error-code messages

Every disconnect the operator can see, stated once. `4404` in particular is a *normal* condition — the Python session registry is in memory, so a backend restart invalidates every session id.

**Files:**
- Create: `src/asr/closeCodes.ts`
- Create: `src/asr/closeCodes.test.ts`

**Interfaces:**
- Consumes: `ErrorCode` from `src/asr/protocol.ts`.
- Produces:
  - `function describeCloseCode(code: number): { message: string; sessionGone: boolean; retryable: boolean }`
  - `function describeErrorCode(code: ErrorCode, fallback: string): string`

- [ ] **Step 1: Write the failing test**

Create `src/asr/closeCodes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { describeCloseCode, describeErrorCode } from './closeCodes';

describe('describeCloseCode', () => {
  it('marks 4404 as a gone session that must not be retried', () => {
    const r = describeCloseCode(4404);
    expect(r.sessionGone).toBe(true);
    expect(r.retryable).toBe(false);
    expect(r.message).toMatch(/session/i);
  });

  it('marks 4401 as retryable after a fresh token', () => {
    const r = describeCloseCode(4401);
    expect(r.retryable).toBe(true);
    expect(r.sessionGone).toBe(false);
  });

  it('describes 4408 as another device already sending audio', () => {
    expect(describeCloseCode(4408).message).toMatch(/audio/i);
    expect(describeCloseCode(4408).retryable).toBe(false);
  });

  it('describes 4403, 4409 and 4429', () => {
    expect(describeCloseCode(4403).message).toBeTruthy();
    expect(describeCloseCode(4409).message).toBeTruthy();
    expect(describeCloseCode(4429).retryable).toBe(true);
  });

  it('treats a normal 1000 close as non-retryable and not an error', () => {
    expect(describeCloseCode(1000).retryable).toBe(false);
  });

  it('falls back for an unrecognised code without throwing', () => {
    expect(describeCloseCode(4999).message).toContain('4999');
  });
});

describe('describeErrorCode', () => {
  it('maps forbidden to an operator-role message', () => {
    expect(describeErrorCode('forbidden', 'raw')).toMatch(/operator/i);
  });

  it('uses the server message for an unmapped code', () => {
    expect(describeErrorCode('internal', 'boom')).toContain('boom');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/asr/closeCodes.test.ts`
Expected: FAIL — cannot resolve `./closeCodes`.

- [ ] **Step 3: Write the implementation**

Create `src/asr/closeCodes.ts`:

```ts
import type { ErrorCode } from './protocol';

export interface CloseDescription {
  message: string;
  /** The session id is dead. Clear it; never reconnect with it. */
  sessionGone: boolean;
  /** Safe to reconnect, possibly after obtaining a fresh token. */
  retryable: boolean;
}

const CLOSE_CODES: Record<number, CloseDescription> = {
  1000: { message: 'ปิดการเชื่อมต่อแล้ว (closed normally)', sessionGone: false, retryable: false },
  4401: {
    message: 'โทเคนหมดอายุหรือไม่ถูกต้อง — กำลังขอโทเคนใหม่ (token expired or invalid)',
    sessionGone: false,
    retryable: true,
  },
  4403: {
    message: 'สิทธิ์ไม่เพียงพอสำหรับการเชื่อมต่อนี้ (forbidden for this role or session)',
    sessionGone: false,
    retryable: false,
  },
  4404: {
    // The registry is in memory; a backend restart makes every existing id
    // invalid. Reconnecting with the same id can only fail again, so the UI
    // must offer a NEW session instead of retrying.
    message: 'เซสชันนี้ไม่มีอยู่แล้ว — เซิร์ฟเวอร์อาจรีสตาร์ต ต้องสร้างเซสชันใหม่ (session no longer exists)',
    sessionGone: true,
    retryable: false,
  },
  4408: {
    message: 'มีอุปกรณ์อื่นกำลังส่งเสียงเข้าเซสชันนี้อยู่แล้ว (another device is already sending audio)',
    sessionGone: false,
    retryable: false,
  },
  4409: {
    message: 'เวอร์ชันโปรโตคอลไม่ตรงกับเซิร์ฟเวอร์ (unsupported protocol version)',
    sessionGone: false,
    retryable: false,
  },
  4429: {
    message: 'ส่งคำสั่งถี่เกินไป ระบบตัดการเชื่อมต่อชั่วคราว (rate limited)',
    sessionGone: false,
    retryable: true,
  },
};

export function describeCloseCode(code: number): CloseDescription {
  return (
    CLOSE_CODES[code] ?? {
      message: `การเชื่อมต่อถูกปิด (closed, code ${code})`,
      sessionGone: false,
      retryable: true,
    }
  );
}

const ERROR_CODES: Partial<Record<ErrorCode, string>> = {
  unauthenticated: 'โทเคนไม่ถูกต้องหรือหมดอายุ (unauthenticated)',
  forbidden: 'คำสั่งนี้ต้องใช้สิทธิ์ operator (operator role required)',
  bad_request: 'รูปแบบคำสั่งไม่ถูกต้อง (bad request)',
  not_found: 'ไม่พบสิ่งที่อ้างถึง (not found)',
  conflict: 'สถานะขัดแย้งกัน (conflict)',
  rate_limited: 'ส่งคำสั่งถี่เกินไป (rate limited)',
};

export function describeErrorCode(code: ErrorCode, fallback: string): string {
  return ERROR_CODES[code] ?? fallback;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/asr/closeCodes.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/asr/closeCodes.ts src/asr/closeCodes.test.ts
git commit -m "feat(asr): map close and error codes to operator-readable messages"
```

---

## Task 4: Node token broker and `/api/asr/token`

The shared operator password lives only here. The browser gets a token, never the password. In P1 this endpoint gains a Supabase JWT check and a per-user `subject`.

**Files:**
- Create: `server/asrTokenBroker.ts`
- Create: `server/asrTokenBroker.test.ts`
- Modify: `server.ts` (add the route; the deletions come in Task 5)
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface BrokerOptions { backendUrl: string; password: string; fetchImpl?: typeof fetch; now?: () => number }`
  - `interface OperatorToken { token: string; expiresAt: number }`
  - `function createTokenBroker(opts: BrokerOptions): { getToken(): Promise<OperatorToken> }`
  - HTTP: `POST /api/asr/token` → `200 {"token": string, "expiresAt": number}`, or `503 {"error": string}`.

- [ ] **Step 1: Write the failing test**

Create `server/asrTokenBroker.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createTokenBroker } from './asrTokenBroker';

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch');
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    } as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('createTokenBroker', () => {
  it('posts the password to /auth/login and returns the token', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { token: 'tok-1', expires_in: 43200 } }]);
    const broker = createTokenBroker({
      backendUrl: 'http://localhost:8765',
      password: 'hunter2',
      fetchImpl: impl,
      now: () => 1_000_000,
    });

    const result = await broker.getToken();

    expect(result.token).toBe('tok-1');
    expect(result.expiresAt).toBe(1_000_000 + 43200 * 1000);
    expect(calls[0].url).toBe('http://localhost:8765/auth/login');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ password: 'hunter2' });
  });

  it('reuses a cached token instead of logging in again', async () => {
    const { impl } = fakeFetch([{ status: 200, body: { token: 'tok-1', expires_in: 43200 } }]);
    const broker = createTokenBroker({
      backendUrl: 'http://localhost:8765',
      password: 'hunter2',
      fetchImpl: impl,
      now: () => 1_000_000,
    });

    await broker.getToken();
    const second = await broker.getToken();

    expect(second.token).toBe('tok-1');
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('logs in again once the cached token passes 80% of its life', async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { token: 'tok-1', expires_in: 100 } },
      { status: 200, body: { token: 'tok-2', expires_in: 100 } },
    ]);
    let clock = 0;
    const broker = createTokenBroker({
      backendUrl: 'http://localhost:8765',
      password: 'hunter2',
      fetchImpl: impl,
      now: () => clock,
    });

    await broker.getToken();
    clock = 81_000; // 81 s into a 100 s token
    const refreshed = await broker.getToken();

    expect(refreshed.token).toBe('tok-2');
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it('throws a message that does not leak the password on 401', async () => {
    const { impl } = fakeFetch([{ status: 401, body: { detail: 'invalid credentials' } }]);
    const broker = createTokenBroker({
      backendUrl: 'http://localhost:8765',
      password: 'wrong',
      fetchImpl: impl,
    });

    await expect(broker.getToken()).rejects.toThrow(/rejected the operator password/i);
    await expect(broker.getToken()).rejects.not.toThrow(/wrong/);
  });

  it('surfaces a connection failure as a distinct message', async () => {
    const impl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const broker = createTokenBroker({ backendUrl: 'http://localhost:8765', password: 'p', fetchImpl: impl });

    await expect(broker.getToken()).rejects.toThrow(/could not reach the ASR backend/i);
  });

  it('does not cache a failure', async () => {
    const { impl } = fakeFetch([
      { status: 401, body: {} },
      { status: 200, body: { token: 'tok-1', expires_in: 43200 } },
    ]);
    const broker = createTokenBroker({ backendUrl: 'http://localhost:8765', password: 'p', fetchImpl: impl });

    await expect(broker.getToken()).rejects.toThrow();
    await expect(broker.getToken()).resolves.toMatchObject({ token: 'tok-1' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- server/asrTokenBroker.test.ts`
Expected: FAIL — cannot resolve `./asrTokenBroker`.

- [ ] **Step 3: Write the implementation**

Create `server/asrTokenBroker.ts`:

```ts
export interface BrokerOptions {
  backendUrl: string;
  password: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface OperatorToken {
  token: string;
  /** Epoch ms at which the backend stops accepting this token. */
  expiresAt: number;
}

/** Refresh once 80% of the token's life is gone, rather than after a 4401. */
const REFRESH_AT = 0.8;

export function createTokenBroker(opts: BrokerOptions) {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const base = opts.backendUrl.replace(/\/+$/, '');

  let cached: { token: OperatorToken; refreshAt: number } | null = null;
  let inFlight: Promise<OperatorToken> | null = null;

  async function login(): Promise<OperatorToken> {
    let response: Response;
    try {
      response = await doFetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: opts.password }),
      });
    } catch (cause) {
      // Distinct from a rejected password: one is a config error the operator
      // fixes in .env, the other means the Python process is not running.
      throw new Error(`Could not reach the ASR backend at ${base}`, { cause });
    }

    if (!response.ok) {
      // Never echo the attempted password into a log or an HTTP response.
      throw new Error(`The ASR backend rejected the operator password (HTTP ${response.status})`);
    }

    const body = (await response.json()) as { token?: string; expires_in?: number };
    if (!body.token || typeof body.expires_in !== 'number') {
      throw new Error('The ASR backend returned a malformed token response');
    }

    const issuedAt = now();
    const token: OperatorToken = {
      token: body.token,
      expiresAt: issuedAt + body.expires_in * 1000,
    };
    cached = { token, refreshAt: issuedAt + body.expires_in * 1000 * REFRESH_AT };
    return token;
  }

  return {
    async getToken(): Promise<OperatorToken> {
      if (cached && now() < cached.refreshAt) return cached.token;
      // Collapse concurrent callers onto one login; the endpoint is rate
      // limited per IP at LOGIN_RATE_PER_MIN (5).
      if (!inFlight) {
        inFlight = login().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- server/asrTokenBroker.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire the route into `server.ts`**

Add the import at the top of `server.ts`, next to the other imports:

```ts
import { createTokenBroker } from "./server/asrTokenBroker";
```

Inside `startServer()`, immediately after `app.use(express.json());`, add:

```ts
  const asrBroker = createTokenBroker({
    backendUrl: process.env.ASR_BACKEND_URL || "http://localhost:8765",
    password: process.env.ASR_OPERATOR_PASSWORD || "",
  });

  // The ONE thing this server still protects: the shared operator password.
  // The browser gets a token and talks to Python directly for everything
  // else, because control commands travel over the WebSocket and need a real
  // operator token regardless — proxying the HTTP half would guard nothing.
  app.post("/api/asr/token", async (_req, res) => {
    if (!process.env.ASR_OPERATOR_PASSWORD) {
      res.status(503).json({ error: "ASR_OPERATOR_PASSWORD is not configured on the server" });
      return;
    }
    try {
      const token = await asrBroker.getToken();
      res.json(token);
    } catch (err: any) {
      res.status(503).json({ error: err?.message || "Could not obtain an ASR token" });
    }
  });
```

- [ ] **Step 6: Replace `.env.example`**

```bash
cat > .env.example <<'EOF'
# URL of the thai-realtime-asr-mt FastAPI backend, as this Node server
# reaches it.
ASR_BACKEND_URL="http://localhost:8765"

# The same backend as the BROWSER reaches it. Vite inlines any VITE_-prefixed
# variable into the client bundle, so this must never hold a secret — it is
# only a URL. The browser opens both WebSockets against it directly.
VITE_ASR_BACKEND_URL="http://localhost:8765"

# The shared operator password configured on that backend as
# OPERATOR_PASSWORD_HASH. Held only by this server and exchanged for a
# short-lived operator token; it is never sent to a browser. Deliberately has
# NO VITE_ prefix — that would publish it to every visitor.
ASR_OPERATOR_PASSWORD="MY_OPERATOR_PASSWORD"

# APP_URL: The URL where this applet is hosted.
APP_URL="MY_APP_URL"
EOF
```

- [ ] **Step 7: Verify the endpoint by hand**

With the Python backend running (`uv run python server/main.py` in `../thai-realtime-asr-mt`) and `ASR_OPERATOR_PASSWORD` set in `.env`:

```bash
npm run dev &
sleep 5
curl -s -X POST http://localhost:3000/api/asr/token
```

Expected: `{"token":"eyJ...","expiresAt":1234567890000}`. Then stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add server/asrTokenBroker.ts server/asrTokenBroker.test.ts server.ts .env.example
git commit -m "feat(server): broker ASR operator tokens without exposing the shared password"
```

---

## Task 5: Delete Gemini and Socket.IO from the server

**Files:**
- Modify: `server.ts` (359 → ~80 lines)
- Modify: `package.json`

**Interfaces:**
- Consumes: `/api/asr/token` from Task 4 (which must survive this deletion).
- Produces: a `server.ts` exposing only `GET /api/health`, `POST /api/asr/token`, the Vite middleware in dev, and static serving in production.

- [ ] **Step 1: Delete the Gemini layer**

From `server.ts`, delete: `GEMINI_TIMEOUT_MS`, `withTimeout`, `getAiClient`, `QUICK_PHRASES`, `performTranslation`, `buildTranslationPrompt`, and the imports of `GoogleGenAI` and `uuidv4`.

- [ ] **Step 2: Delete the Socket.IO layer**

From `startServer()`, delete: the `Server` import and the `io` construction with its `cors: { origin: "*" }` block, the `currentConfig`, `transcripts`, `isMeetingActive` and `meetingVersion` variables, `meetingStatus()`, and the whole `io.on("connection", ...)` block with all ten handlers (`update-config`, `start-meeting`, `stop-meeting`, `ping-check`, `new-transcription`, `clear-transcripts`, `load-transcripts`, `update-transcript-item`, `delete-transcript-item`, `retranslate-item`).

Also delete the `import { Server } from "socket.io";` line.

- [ ] **Step 3: Remove the dead dependencies**

```bash
npm uninstall @google/genai socket.io socket.io-client uuid @types/uuid
```

- [ ] **Step 4: Verify the server still builds and starts**

```bash
npm run lint
```

Expected: type errors ONLY in `src/pages/Admin.tsx` (it still imports `socket.io-client`). Those are fixed in Task 11. `server.ts` itself must be clean.

```bash
wc -l server.ts
```

Expected: roughly 80 lines, and certainly under 120.

- [ ] **Step 5: Confirm nothing Gemini-shaped survives**

```bash
grep -rn "genai\|GEMINI\|socket.io\|performTranslation\|QUICK_PHRASES" server.ts
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add server.ts package.json package-lock.json
git commit -m "refactor(server): remove Gemini translation and Socket.IO layers"
```

---

## Task 6: Client token source

**Files:**
- Create: `src/asr/tokens.ts`
- Create: `src/asr/tokens.test.ts`

**Interfaces:**
- Consumes: `POST /api/asr/token` (Task 4).
- Produces:
  - `function createOperatorTokenSource(opts?: { fetchImpl?: typeof fetch; now?: () => number }): { get(): Promise<string> }`
  - `async function mintSourceToken(backendUrl: string, sessionId: string, operatorToken: string, fetchImpl?: typeof fetch): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `src/asr/tokens.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createOperatorTokenSource, mintSourceToken } from './tokens';

function jsonFetch(responses: Array<{ ok?: boolean; status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch');
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => next.body,
    } as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('createOperatorTokenSource', () => {
  it('fetches a token from the Node broker', async () => {
    const { impl, calls } = jsonFetch([{ body: { token: 'op-1', expiresAt: 100_000 } }]);
    const source = createOperatorTokenSource({ fetchImpl: impl, now: () => 0 });

    expect(await source.get()).toBe('op-1');
    expect(calls[0].url).toBe('/api/asr/token');
    expect(calls[0].init?.method).toBe('POST');
  });

  it('caches until 80% of the remaining life has elapsed', async () => {
    const { impl } = jsonFetch([
      { body: { token: 'op-1', expiresAt: 100_000 } },
      { body: { token: 'op-2', expiresAt: 200_000 } },
    ]);
    let clock = 0;
    const source = createOperatorTokenSource({ fetchImpl: impl, now: () => clock });

    expect(await source.get()).toBe('op-1');
    clock = 79_000;
    expect(await source.get()).toBe('op-1');
    clock = 81_000;
    expect(await source.get()).toBe('op-2');
    expect(impl).toHaveBeenCalledTimes(2);
  });

  it('reports the broker error message when the endpoint is unconfigured', async () => {
    const { impl } = jsonFetch([{ ok: false, status: 503, body: { error: 'ASR_OPERATOR_PASSWORD is not configured on the server' } }]);
    const source = createOperatorTokenSource({ fetchImpl: impl });

    await expect(source.get()).rejects.toThrow(/not configured/);
  });
});

describe('mintSourceToken', () => {
  it('calls capture-link with the operator token and returns the source token', async () => {
    const { impl, calls } = jsonFetch([{ body: { token: 'src-1', url: 'capture.html?token=src-1', expires_in: 43200 } }]);

    const token = await mintSourceToken('http://localhost:8765', 'sess_ab12', 'op-1', impl);

    expect(token).toBe('src-1');
    expect(calls[0].url).toBe('http://localhost:8765/sessions/sess_ab12/capture-link');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer op-1');
  });

  it('reports a 404 as a missing session rather than a generic failure', async () => {
    const { impl } = jsonFetch([{ ok: false, status: 404, body: { detail: 'not found' } }]);

    await expect(mintSourceToken('http://localhost:8765', 'gone', 'op-1', impl)).rejects.toThrow(/session/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/asr/tokens.test.ts`
Expected: FAIL — cannot resolve `./tokens`.

- [ ] **Step 3: Write the implementation**

Create `src/asr/tokens.ts`:

```ts
const REFRESH_AT = 0.8;

export function createOperatorTokenSource(opts: { fetchImpl?: typeof fetch; now?: () => number } = {}) {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;

  let cached: { token: string; refreshAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function load(): Promise<string> {
    const response = await doFetch('/api/asr/token', { method: 'POST' });
    const body = (await response.json()) as { token?: string; expiresAt?: number; error?: string };
    if (!response.ok || !body.token || typeof body.expiresAt !== 'number') {
      throw new Error(body.error || `Could not obtain an ASR token (HTTP ${response.status})`);
    }
    const issuedAt = now();
    // Refresh before the token dies, not after a 4401 kills a live caption
    // stream. An event day can outlast the 12 h TTL.
    cached = { token: body.token, refreshAt: issuedAt + (body.expiresAt - issuedAt) * REFRESH_AT };
    return body.token;
  }

  return {
    async get(): Promise<string> {
      if (cached && now() < cached.refreshAt) return cached.token;
      if (!inFlight) {
        inFlight = load().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
  };
}

export async function mintSourceToken(
  backendUrl: string,
  sessionId: string,
  operatorToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const base = backendUrl.replace(/\/+$/, '');
  const response = await fetchImpl(`${base}/sessions/${sessionId}/capture-link`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${operatorToken}` },
  });
  if (response.status === 404) {
    throw new Error(`Session ${sessionId} no longer exists — create a new one`);
  }
  const body = (await response.json()) as { token?: string };
  if (!response.ok || !body.token) {
    throw new Error(`Could not mint a capture token (HTTP ${response.status})`);
  }
  return body.token;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/asr/tokens.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/asr/tokens.ts src/asr/tokens.test.ts
git commit -m "feat(asr): add operator token source with pre-expiry refresh"
```

---

## Task 7: Session client and the adoption rule

**Files:**
- Create: `src/asr/sessions.ts`
- Create: `src/asr/sessions.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface SessionSnapshot { id: string; source_lang: string; target_lang: string; clients: number; report_active: boolean; recognizer_alive: boolean; helper_alive: boolean | null; ingest: string; audio_alive: boolean | null }`
  - `type SessionChoice = { action: 'create' } | { action: 'adopt'; id: string } | { action: 'ask'; sessions: SessionSnapshot[] }`
  - `function chooseSession(sessions: SessionSnapshot[]): SessionChoice`
  - `async function listSessions(backendUrl: string, token: string, fetchImpl?: typeof fetch): Promise<SessionSnapshot[]>`
  - `async function createSession(backendUrl: string, token: string, fetchImpl?: typeof fetch): Promise<SessionSnapshot>`
  - `async function getSession(backendUrl: string, token: string, id: string, fetchImpl?: typeof fetch): Promise<SessionSnapshot | null>`
  - `async function deleteSession(backendUrl: string, token: string, id: string, fetchImpl?: typeof fetch): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/asr/sessions.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { chooseSession, createSession, getSession, listSessions, type SessionSnapshot } from './sessions';

function snapshot(id: string, extra: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id,
    source_lang: 'th',
    target_lang: 'en',
    clients: 0,
    report_active: false,
    recognizer_alive: true,
    helper_alive: null,
    ingest: 'remote',
    audio_alive: null,
    ...extra,
  };
}

function jsonFetch(responses: Array<{ ok?: boolean; status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch');
    return { ok: next.ok ?? true, status: next.status ?? 200, json: async () => next.body } as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('chooseSession', () => {
  it('creates when none are live', () => {
    expect(chooseSession([])).toEqual({ action: 'create' });
  });

  it('adopts silently when exactly one is live', () => {
    expect(chooseSession([snapshot('sess_a')])).toEqual({ action: 'adopt', id: 'sess_a' });
  });

  it('asks when several are live', () => {
    const many = [snapshot('sess_a'), snapshot('sess_b')];
    expect(chooseSession(many)).toEqual({ action: 'ask', sessions: many });
  });
});

describe('createSession', () => {
  it('requests remote ingest so the browser owns the microphone', async () => {
    const { impl, calls } = jsonFetch([{ body: snapshot('sess_new') }]);

    const created = await createSession('http://localhost:8765', 'op-1', impl);

    expect(created.id).toBe('sess_new');
    expect(calls[0].url).toBe('http://localhost:8765/sessions');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ ingest: 'remote' });
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer op-1');
  });

  it('reports the MAX_SESSIONS cap specifically', async () => {
    const { impl } = jsonFetch([{ ok: false, status: 409, body: { detail: 'session cap reached' } }]);

    await expect(createSession('http://localhost:8765', 'op-1', impl)).rejects.toThrow(/already running the maximum/i);
  });
});

describe('getSession', () => {
  it('returns null for a session the backend has forgotten', async () => {
    const { impl } = jsonFetch([{ ok: false, status: 404, body: {} }]);
    expect(await getSession('http://localhost:8765', 'op-1', 'gone', impl)).toBeNull();
  });

  it('returns the snapshot when it exists', async () => {
    const { impl } = jsonFetch([{ body: snapshot('sess_a', { recognizer_alive: false }) }]);
    const result = await getSession('http://localhost:8765', 'op-1', 'sess_a', impl);
    expect(result?.recognizer_alive).toBe(false);
  });
});

describe('listSessions', () => {
  it('returns the array the backend sends', async () => {
    const { impl } = jsonFetch([{ body: [snapshot('sess_a')] }]);
    expect(await listSessions('http://localhost:8765', 'op-1', impl)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/asr/sessions.test.ts`
Expected: FAIL — cannot resolve `./sessions`.

- [ ] **Step 3: Write the implementation**

Create `src/asr/sessions.ts`:

```ts
export interface SessionSnapshot {
  id: string;
  source_lang: string;
  target_lang: string;
  clients: number;
  report_active: boolean;
  /** Read from the engine's worker thread at call time. A reading, not a verdict. */
  recognizer_alive: boolean;
  /** null when DUAL_ASR is off — not a fault. */
  helper_alive: boolean | null;
  ingest: string;
  /** null for a local session, where the question does not apply. */
  audio_alive: boolean | null;
}

export type SessionChoice =
  | { action: 'create' }
  | { action: 'adopt'; id: string }
  | { action: 'ask'; sessions: SessionSnapshot[] };

/**
 * The console's documented rule: create if none is live, adopt if exactly one
 * is, ask when several are. Adopting "the first" of several would silently
 * attach one venue's operator to another venue's event.
 */
export function chooseSession(sessions: SessionSnapshot[]): SessionChoice {
  if (sessions.length === 0) return { action: 'create' };
  if (sessions.length === 1) return { action: 'adopt', id: sessions[0].id };
  return { action: 'ask', sessions };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export async function listSessions(
  backendUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SessionSnapshot[]> {
  const response = await fetchImpl(`${backendUrl.replace(/\/+$/, '')}/sessions`, {
    headers: authHeaders(token),
  });
  if (!response.ok) throw new Error(`Could not list sessions (HTTP ${response.status})`);
  return (await response.json()) as SessionSnapshot[];
}

export async function createSession(
  backendUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SessionSnapshot> {
  const response = await fetchImpl(`${backendUrl.replace(/\/+$/, '')}/sessions`, {
    method: 'POST',
    headers: authHeaders(token),
    // "remote" is required: a local session opens the SERVER's microphone,
    // and every local session shares that one physical device.
    body: JSON.stringify({ ingest: 'remote' }),
  });
  if (response.status === 409) {
    throw new Error('เซิร์ฟเวอร์กำลังรันเซสชันครบจำนวนสูงสุดแล้ว (the backend is already running the maximum number of sessions)');
  }
  if (!response.ok) throw new Error(`Could not create a session (HTTP ${response.status})`);
  return (await response.json()) as SessionSnapshot;
}

export async function getSession(
  backendUrl: string,
  token: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SessionSnapshot | null> {
  const response = await fetchImpl(`${backendUrl.replace(/\/+$/, '')}/sessions/${id}`, {
    headers: authHeaders(token),
  });
  // A forgotten session is the normal consequence of a backend restart, not
  // an error worth throwing over.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not read session ${id} (HTTP ${response.status})`);
  return (await response.json()) as SessionSnapshot;
}

export async function deleteSession(
  backendUrl: string,
  token: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${backendUrl.replace(/\/+$/, '')}/sessions/${id}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Could not end session ${id} (HTTP ${response.status})`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/asr/sessions.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/asr/sessions.ts src/asr/sessions.test.ts
git commit -m "feat(asr): add session HTTP client and adoption rule"
```

---

## Task 8: Command builders

**Files:**
- Create: `src/asr/commands.ts`
- Create: `src/asr/commands.test.ts`

**Interfaces:**
- Consumes: `PROTOCOL_VERSION` from `src/asr/protocol.ts`.
- Produces:
  - `function buildCommand(type: string, session: string, data: unknown, id?: string): { frame: Record<string, unknown>; id: string }`
  - Named helpers: `setPaused`, `setLanguages`, `setMode`, `setGate`, `glossaryAdd`, `glossaryRemove`, `glossaryReload`, `reportStart`, `reportStop`, `ping` — each `(session: string, ...args) => { frame; id }`.

- [ ] **Step 1: Write the failing test**

Create `src/asr/commands.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildCommand, glossaryAdd, setGate, setLanguages, setPaused } from './commands';

describe('buildCommand', () => {
  it('produces a complete v1 envelope with a unique id', () => {
    const { frame, id } = buildCommand('control.ping', 'sess_ab12', {});
    expect(frame.v).toBe(1);
    expect(frame.type).toBe('control.ping');
    expect(frame.session).toBe('sess_ab12');
    expect(typeof frame.ts).toBe('number');
    expect(frame.id).toBe(id);
    expect(id).toMatch(/^c-/);
  });

  it('sends ts in seconds, not milliseconds', () => {
    const { frame } = buildCommand('control.ping', 's', {});
    // The backend parses ts through the same model as every other frame and
    // treats it as epoch SECONDS.
    expect(frame.ts as number).toBeLessThan(1e11);
  });

  it('gives two commands different ids', () => {
    expect(buildCommand('control.ping', 's', {}).id).not.toBe(buildCommand('control.ping', 's', {}).id);
  });
});

describe('command helpers', () => {
  it('setLanguages sends exactly source and target', () => {
    const { frame } = setLanguages('s', 'th', 'en');
    expect(frame.type).toBe('control.set_languages');
    expect(frame.data).toEqual({ source: 'th', target: 'en' });
  });

  it('setPaused sends exactly paused', () => {
    expect(setPaused('s', true).frame.data).toEqual({ paused: true });
  });

  it('setGate sends exactly min_words and min_interval_ms', () => {
    expect(setGate('s', 3, 400).frame.data).toEqual({ min_words: 3, min_interval_ms: 400 });
  });

  it('glossaryAdd sends exactly section, abbr and full', () => {
    const { frame } = glossaryAdd('s', 'protected_terms', 'ความดันโลหิตสูง', 'hypertension');
    expect(frame.data).toEqual({ section: 'protected_terms', abbr: 'ความดันโลหิตสูง', full: 'hypertension' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/asr/commands.test.ts`
Expected: FAIL — cannot resolve `./commands`.

- [ ] **Step 3: Write the implementation**

Create `src/asr/commands.ts`:

```ts
import { PROTOCOL_VERSION } from './protocol';

export type GlossarySection = 'thai_corrections' | 'protected_terms' | 'person_names';

let counter = 0;

export interface BuiltCommand {
  frame: Record<string, unknown>;
  id: string;
}

/**
 * Command payloads are STRICT server-side: an unknown field is a
 * bad_request, not an ignored extra. Each helper below therefore sends the
 * documented fields and nothing else.
 */
export function buildCommand(type: string, session: string, data: unknown, id?: string): BuiltCommand {
  const commandId = id ?? `c-${Date.now().toString(36)}-${(counter += 1)}`;
  return {
    id: commandId,
    frame: {
      v: PROTOCOL_VERSION,
      type,
      session,
      // Epoch SECONDS — the backend parses this through the same model as
      // every other frame.
      ts: Date.now() / 1000,
      id: commandId,
      data,
    },
  };
}

export const setPaused = (session: string, paused: boolean) =>
  buildCommand('control.set_paused', session, { paused });

export const setLanguages = (session: string, source: string, target: string) =>
  buildCommand('control.set_languages', session, { source, target });

export const setMode = (session: string, mode: 'stream' | 'chunk') =>
  buildCommand('control.set_mode', session, { mode });

export const setGate = (session: string, minWords: number, minIntervalMs: number) =>
  buildCommand('control.set_gate', session, { min_words: minWords, min_interval_ms: minIntervalMs });

export const glossaryAdd = (session: string, section: GlossarySection, abbr: string, full: string) =>
  buildCommand('control.glossary_add', session, { section, abbr, full });

export const glossaryRemove = (session: string, section: GlossarySection, abbr: string) =>
  buildCommand('control.glossary_remove', session, { section, abbr });

export const glossaryReload = (session: string) => buildCommand('control.glossary_reload', session, {});

export const reportStart = (session: string) => buildCommand('control.report_start', session, {});

export const reportStop = (session: string) => buildCommand('control.report_stop', session, {});

export const ping = (session: string) => buildCommand('control.ping', session, {});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/asr/commands.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/asr/commands.ts src/asr/commands.test.ts
git commit -m "feat(asr): add strict v1 command builders"
```

---

## Task 9: Control WebSocket hook

**Files:**
- Create: `src/asr/useAsrSocket.ts`
- Create: `src/asr/useAsrSocket.test.ts`
- Modify: `package.json` (add `jsdom`, `@testing-library/react`)
- Modify: `vitest.config.ts`

**Interfaces:**
- Consumes: `describeCloseCode` (Task 3), `buildCommand` (Task 8), `AnyFrame` and `WelcomePayload` (Task 1).
- Produces:
  - `interface AsrSocketState { status: 'idle' | 'connecting' | 'open' | 'closed'; welcome: WelcomePayload | null; error: string | null; sessionGone: boolean }`
  - `function useAsrSocket(opts: { backendUrl: string; sessionId: string | null; token: string | null; onFrame: (frame: AnyFrame) => void }): AsrSocketState & { send: (built: BuiltCommand) => void }`

**`welcome` is the live projection of server state, not a one-shot snapshot.** `session.welcome` seeds it; `session.languages`, `session.paused`, `session.mode`, `gate.state` and `report.state` each fold their broadcast into it. Without this the UI would send `control.set_languages`, receive the confirming broadcast, and still render the old pair forever — which is precisely the state-desync this design forbids optimistic writes to avoid.

- [ ] **Step 1: Install the DOM test environment**

```bash
npm install --save-dev jsdom@^26.1.0 @testing-library/react@^16.3.0
```

- [ ] **Step 2: Add a jsdom project to `vitest.config.ts`**

Replace the file with:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure logic runs in node; anything touching React or WebSocket needs a
    // DOM, selected per file with the `@vitest-environment` docblock.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'server/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Write the failing test**

Create `src/asr/useAsrSocket.test.ts`:

```ts
// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ping } from './commands';
import { useAsrSocket } from './useAsrSocket';
import type { AnyFrame } from './protocol';

function golden(name: string): AnyFrame {
  return JSON.parse(readFileSync(join(process.cwd(), 'src/asr/__fixtures__/protocol', `${name}.json`), 'utf8'));
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string, public protocols?: string[]) {
    FakeWebSocket.instances.push(this);
  }
  send(payload: string) { this.sent.push(payload); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  serverClose(code: number) { this.readyState = 3; this.onclose?.({ code }); }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
});
afterEach(() => vi.unstubAllGlobals());

const base = { backendUrl: 'http://localhost:8765', sessionId: 'sess_ab12', token: 'op-1' };

describe('useAsrSocket', () => {
  it('connects to the session path with the bearer subprotocol', async () => {
    renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe('ws://localhost:8765/ws/sess_ab12');
    // The token travels in Sec-WebSocket-Protocol, never in the URL.
    expect(socket.protocols).toEqual(['bearer', 'op-1']);
    expect(socket.url).not.toContain('op-1');
  });

  it('does not connect without a session id or a token', () => {
    renderHook(() => useAsrSocket({ ...base, sessionId: null, onFrame: () => {} }));
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('stores session.welcome and reports the socket open', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].receive(golden('session_welcome'));
    });

    expect(result.current.status).toBe('open');
    expect(result.current.welcome?.source_lang).toBe('th');
    expect(result.current.welcome?.gate.min_words).toBe(3);
  });

  it('forwards every frame to onFrame', async () => {
    const onFrame = vi.fn();
    renderHook(() => useAsrSocket({ ...base, onFrame }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].receive(golden('caption_final'));
    });

    expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ type: 'caption.final' }));
  });

  it('folds a session.languages broadcast into welcome', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].receive(golden('session_welcome'));
      FakeWebSocket.instances[0].receive(golden('session_languages'));
    });

    // Without folding, the console would send set_languages, get the
    // confirming broadcast, and still render the old pair forever.
    expect(result.current.welcome?.source_lang).toBe(
      (golden('session_languages') as any).data.source_lang,
    );
    expect(result.current.welcome?.target_lang).toBe(
      (golden('session_languages') as any).data.target_lang,
    );
  });

  it('folds a session.paused broadcast into welcome', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].receive(golden('session_welcome'));
      FakeWebSocket.instances[0].receive(golden('session_paused'));
    });

    expect(result.current.welcome?.paused).toBe((golden('session_paused') as any).data.paused);
  });

  it('folds a gate.state broadcast into welcome', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].receive(golden('session_welcome'));
      FakeWebSocket.instances[0].receive(golden('gate_state'));
    });

    expect(result.current.welcome?.gate).toEqual((golden('gate_state') as any).data);
  });

  it('ignores a state broadcast that arrives before welcome', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].receive(golden('session_paused'));
    });

    // There is no partial WelcomePayload to build on, and inventing one would
    // put made-up languages on screen.
    expect(result.current.welcome).toBeNull();
  });

  it('surfaces control.error with a readable message', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].receive(golden('control_error'));
    });

    expect(result.current.error).toMatch(/operator/i);
  });

  it('flags a 4404 close as a gone session', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].serverClose(4404);
    });

    expect(result.current.sessionGone).toBe(true);
    expect(result.current.status).toBe('closed');
  });

  it('never reconnects after a 4404', async () => {
    renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].serverClose(4404);
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('sends a command as JSON on the open socket', async () => {
    const { result } = renderHook(() => useAsrSocket({ ...base, onFrame: () => {} }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0].open());

    act(() => result.current.send(ping('sess_ab12')));

    const sent = JSON.parse(FakeWebSocket.instances[0].sent[0]);
    expect(sent.type).toBe('control.ping');
    expect(sent.session).toBe('sess_ab12');
  });

  it('ignores a malformed text frame instead of throwing', async () => {
    const onFrame = vi.fn();
    renderHook(() => useAsrSocket({ ...base, onFrame }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].onmessage?.({ data: 'not json' });
    });

    expect(onFrame).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -- src/asr/useAsrSocket.test.ts`
Expected: FAIL — cannot resolve `./useAsrSocket`.

- [ ] **Step 5: Write the implementation**

Create `src/asr/useAsrSocket.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AnyFrame,
  ErrorPayload,
  GateSettings,
  LanguagesPayload,
  ModePayload,
  PausedPayload,
  ReportStatePayload,
  WelcomePayload,
} from './protocol';
import type { BuiltCommand } from './commands';
import { describeCloseCode, describeErrorCode } from './closeCodes';

export interface AsrSocketState {
  status: 'idle' | 'connecting' | 'open' | 'closed';
  welcome: WelcomePayload | null;
  error: string | null;
  sessionGone: boolean;
}

const RECONNECT_DELAY_MS = 2000;

function toWsUrl(backendUrl: string, path: string): string {
  const url = new URL(backendUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = path;
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

export function useAsrSocket(opts: {
  backendUrl: string;
  sessionId: string | null;
  token: string | null;
  onFrame: (frame: AnyFrame) => void;
}) {
  const { backendUrl, sessionId, token } = opts;
  const [state, setState] = useState<AsrSocketState>({
    status: 'idle',
    welcome: null,
    error: null,
    sessionGone: false,
  });

  const socketRef = useRef<WebSocket | null>(null);
  const onFrameRef = useRef(opts.onFrame);
  onFrameRef.current = opts.onFrame;

  useEffect(() => {
    if (!sessionId || !token) return;

    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (disposed) return;
      setState((s) => ({ ...s, status: 'connecting' }));

      // The token goes in Sec-WebSocket-Protocol so it stays out of proxy
      // logs, browser history and Referer headers.
      const socket = new WebSocket(toWsUrl(backendUrl, `/ws/${sessionId}`), ['bearer', token]);
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) return;
        setState((s) => ({ ...s, status: 'open', error: null }));
      };

      socket.onmessage = (event) => {
        if (disposed || typeof event.data !== 'string') return;
        let frame: AnyFrame;
        try {
          frame = JSON.parse(event.data) as AnyFrame;
        } catch {
          return;
        }

        // `welcome` is the live projection of server-owned state. Every
        // broadcast below folds into it, because the UI renders from it and
        // never writes it optimistically. A state frame arriving before
        // welcome is dropped: there is no partial WelcomePayload to build on,
        // and inventing one would put made-up languages on screen.
        const fold = (patch: Partial<WelcomePayload>) =>
          setState((s) => (s.welcome ? { ...s, welcome: { ...s.welcome, ...patch } } : s));

        switch (frame.type) {
          case 'session.welcome':
            setState((s) => ({ ...s, welcome: frame.data as WelcomePayload }));
            break;
          case 'session.languages': {
            const d = frame.data as LanguagesPayload;
            fold({ source_lang: d.source_lang, target_lang: d.target_lang, asr_switchable: d.asr_switchable });
            break;
          }
          case 'session.paused':
            fold({ paused: (frame.data as PausedPayload).paused });
            break;
          case 'session.mode':
            fold({ mode: (frame.data as ModePayload).mode });
            break;
          case 'gate.state':
            fold({ gate: frame.data as GateSettings });
            break;
          case 'report.state':
            fold({ report: frame.data as ReportStatePayload });
            break;
          case 'control.error': {
            const payload = frame.data as ErrorPayload;
            setState((s) => ({ ...s, error: describeErrorCode(payload.code, payload.message) }));
            break;
          }
          default:
            break;
        }

        // Every frame is forwarded, including unknown types — the consumer
        // decides. Ignoring what we don't recognise is required by the
        // protocol, and dropping it here would hide new backend frames.
        onFrameRef.current(frame);
      };

      socket.onclose = (event) => {
        if (disposed) return;
        const described = describeCloseCode(event.code);
        setState((s) => ({
          ...s,
          status: 'closed',
          sessionGone: described.sessionGone,
          error: event.code === 1000 ? s.error : described.message,
        }));
        // A 4404 session id can only fail again. Retrying it would spin
        // forever against a backend that restarted.
        if (described.retryable) {
          retryTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [backendUrl, sessionId, token]);

  const send = useCallback((built: BuiltCommand) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(built.frame));
  }, []);

  return { ...state, send };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- src/asr/useAsrSocket.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 7: Commit**

```bash
git add src/asr/useAsrSocket.ts src/asr/useAsrSocket.test.ts vitest.config.ts package.json package-lock.json
git commit -m "feat(asr): add control WebSocket hook with close-code handling"
```

---

## Task 10: Audio capture

Ported from the working `display/capture.html`. The pure conversion is unit-tested; the worklet graph is verified by hand in Task 15.

**Files:**
- Create: `src/asr/audio/pcm.ts`
- Create: `src/asr/audio/pcm.test.ts`
- Create: `src/asr/audio/useAudioCapture.ts`

**Interfaces:**
- Consumes: `describeCloseCode` (Task 3).
- Produces:
  - `const SAMPLE_RATE = 16000`, `FRAME_MS = 20`, `FRAME_SAMPLES = 320`, `FRAME_BYTES = 640`, `MAX_BUFFERED_BYTES = 5120`
  - `function floatToPcm16(sample: number): number`
  - `const WORKLET_SRC: string`
  - `interface AudioCaptureState { status: 'idle' | 'starting' | 'sending' | 'error'; backpressure: boolean; droppedFrames: number; error: string | null }`
  - `function useAudioCapture(opts: { backendUrl: string; sessionId: string | null; sourceToken: string | null; active: boolean; deviceId?: string }): AudioCaptureState`

- [ ] **Step 1: Write the failing test**

Create `src/asr/audio/pcm.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FRAME_BYTES, FRAME_SAMPLES, MAX_BUFFERED_BYTES, SAMPLE_RATE, WORKLET_SRC, floatToPcm16 } from './pcm';

describe('audio format constants', () => {
  it('matches what audio.hello is allowed to declare', () => {
    expect(SAMPLE_RATE).toBe(16000);
    expect(FRAME_SAMPLES).toBe(320);
    expect(FRAME_BYTES).toBe(640);
  });

  it('caps buffering at 8 frames, the server message ceiling', () => {
    expect(MAX_BUFFERED_BYTES).toBe(5120);
  });
});

describe('floatToPcm16', () => {
  it('maps silence to zero', () => {
    expect(floatToPcm16(0)).toBe(0);
  });

  it('maps full positive scale to 0x7fff', () => {
    expect(floatToPcm16(1)).toBe(0x7fff);
  });

  it('maps full negative scale to -0x8000', () => {
    expect(floatToPcm16(-1)).toBe(-0x8000);
  });

  it('clamps above full scale instead of wrapping the sign', () => {
    // Casting an out-of-range float straight to int16 wraps and inverts the
    // waveform mid-sample, which the recognizer hears as a consonant.
    expect(floatToPcm16(1.5)).toBe(0x7fff);
    expect(floatToPcm16(-1.5)).toBe(-0x8000);
  });
});

describe('WORKLET_SRC', () => {
  it('registers the processor the node constructs by name', () => {
    expect(WORKLET_SRC).toContain("registerProcessor('pcm-framer'");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/asr/audio/pcm.test.ts`
Expected: FAIL — cannot resolve `./pcm`.

- [ ] **Step 3: Write the implementation**

Create `src/asr/audio/pcm.ts`:

```ts
// The format, in one place. 16 kHz mono pcm_s16le is the only thing
// audio.hello accepts, and it is what the ASR engine already feeds Google
// Speech-to-Text — so ingest adds no resampling anywhere in the chain.
export const SAMPLE_RATE = 16000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 320
export const FRAME_BYTES = FRAME_SAMPLES * 2; // 640

// Above this much unsent data the socket is not keeping up, so frames are
// DROPPED rather than queued. Buffering grows latency without bound and puts
// a caption a minute behind the speaker. 8 frames is 160 ms, and is also the
// server's own max_pcm_message_bytes ceiling.
export const MAX_BUFFERED_BYTES = FRAME_BYTES * 8; // 5120

export function floatToPcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

// Registered from a Blob so no separate worklet file has to be served, which
// keeps this working identically under Vite dev and the production bundle.
// AudioWorkletProcessor runs at the context's own rate, and the context is
// pinned to 16 kHz, so no resampling happens in here.
export const WORKLET_SRC = `
class PcmFramer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buf = new Int16Array(options.processorOptions.frameSamples);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.slice());
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-framer', PcmFramer);
`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/asr/audio/pcm.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the capture hook**

Create `src/asr/audio/useAudioCapture.ts`:

```ts
import { useEffect, useRef, useState } from 'react';
import { describeCloseCode } from '../closeCodes';
import { FRAME_MS, FRAME_SAMPLES, MAX_BUFFERED_BYTES, SAMPLE_RATE, WORKLET_SRC } from './pcm';

export interface AudioCaptureState {
  status: 'idle' | 'starting' | 'sending' | 'error';
  backpressure: boolean;
  droppedFrames: number;
  error: string | null;
}

function toWsUrl(backendUrl: string, path: string): string {
  const url = new URL(backendUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = path;
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

export function useAudioCapture(opts: {
  backendUrl: string;
  sessionId: string | null;
  sourceToken: string | null;
  active: boolean;
  deviceId?: string;
}): AudioCaptureState {
  const { backendUrl, sessionId, sourceToken, active, deviceId } = opts;
  const [state, setState] = useState<AudioCaptureState>({
    status: 'idle',
    backpressure: false,
    droppedFrames: 0,
    error: null,
  });
  const droppedRef = useRef(0);

  useEffect(() => {
    if (!active || !sessionId || !sourceToken) {
      setState((s) => ({ ...s, status: 'idle', backpressure: false }));
      return;
    }

    let disposed = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let framerNode: AudioWorkletNode | null = null;
    let micNode: MediaStreamAudioSourceNode | null = null;
    let sinkNode: GainNode | null = null;
    let socket: WebSocket | null = null;
    let ready = false;

    const fail = (message: string) => {
      if (disposed) return;
      setState((s) => ({ ...s, status: 'error', error: message }));
    };

    const start = async () => {
      setState({ status: 'starting', backpressure: false, droppedFrames: 0, error: null });

      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        fail('ต้องเปิดหน้านี้ผ่าน HTTPS หรือ localhost จึงจะใช้ไมโครโฟนได้ (microphone needs a secure context)');
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        });
      } catch {
        fail('เปิดไมโครโฟนไม่สำเร็จ — ตรวจสอบสิทธิ์และอุปกรณ์ (could not open the microphone)');
        return;
      }
      if (disposed) return;

      ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      if (ctx.sampleRate !== SAMPLE_RATE) {
        // A browser may ignore the rate hint. audio.hello pins 16000, so
        // declaring a rate we are not sending would make every caption come
        // out at the wrong speed with nothing on screen to explain it.
        fail(`เบราว์เซอร์ใช้ sample rate ${ctx.sampleRate} Hz แทน 16000 Hz — ใช้ส่งเสียงไม่ได้`);
        return;
      }
      await ctx.resume();

      const blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(blobUrl);
      } catch {
        fail('โหลดตัวประมวลผลเสียงไม่สำเร็จ (audio worklet failed to load)');
        return;
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      if (disposed) return;

      framerNode = new AudioWorkletNode(ctx, 'pcm-framer', {
        numberOfOutputs: 1,
        // Without an explicit single channel, a stereo microphone reaches the
        // worklet as two channels and only the left is read — so a lectern
        // feed landing on the right leg uploads near-silence while every
        // health indicator still reads healthy.
        channelCountMode: 'explicit',
        channelCount: 1,
        processorOptions: { frameSamples: FRAME_SAMPLES },
      });

      framerNode.port.onmessage = (event: MessageEvent<Int16Array>) => {
        if (!socket || socket.readyState !== WebSocket.OPEN || !ready) return;
        if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
          droppedRef.current += 1;
          setState((s) => ({ ...s, droppedFrames: droppedRef.current }));
          return;
        }
        socket.send(event.data.buffer);
      };

      micNode = ctx.createMediaStreamSource(stream);
      micNode.connect(framerNode);
      // A worklet that reaches no destination is not guaranteed to be pulled
      // by the rendering graph, so it needs a sink — at gain 0, because
      // connecting to the speakers would feed a podium mic into the PA.
      sinkNode = ctx.createGain();
      sinkNode.gain.value = 0;
      framerNode.connect(sinkNode).connect(ctx.destination);

      socket = new WebSocket(toWsUrl(backendUrl, `/ws/${sessionId}/audio`), ['bearer', sourceToken]);
      socket.binaryType = 'arraybuffer';

      socket.onopen = () => {
        // audio.hello is the ONLY text frame this socket ever carries; a text
        // frame after the handshake closes it with 4403.
        socket?.send(
          JSON.stringify({
            v: 1,
            type: 'audio.hello',
            session: sessionId,
            ts: Date.now() / 1000,
            id: `hello-${Math.random().toString(16).slice(2, 10)}`,
            data: { sample_rate: SAMPLE_RATE, channels: 1, encoding: 'pcm_s16le', frame_ms: FRAME_MS },
          }),
        );
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        let msg: { type?: string; data?: { level?: string } };
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === 'audio.ready') {
          // Binary frames start only now. Sending earlier makes the server's
          // receive_text fail and closes the socket with 4403.
          ready = true;
          setState((s) => ({ ...s, status: 'sending', error: null }));
        } else if (msg.type === 'audio.backpressure') {
          setState((s) => ({ ...s, backpressure: msg.data?.level === 'high' }));
        }
      };

      socket.onclose = (event) => {
        ready = false;
        if (disposed || event.code === 1000) return;
        fail(describeCloseCode(event.code).message);
      };
    };

    void start();

    return () => {
      disposed = true;
      ready = false;
      socket?.close();
      framerNode?.port.close();
      micNode?.disconnect();
      framerNode?.disconnect();
      sinkNode?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      void ctx?.close();
    };
  }, [active, backendUrl, sessionId, sourceToken, deviceId]);

  return state;
}
```

- [ ] **Step 6: Type-check**

Run: `npm run lint`
Expected: type errors ONLY in `src/pages/Admin.tsx` and `src/components/DictionaryManager.tsx`. Nothing in `src/asr/`.

- [ ] **Step 7: Commit**

```bash
git add src/asr/audio/
git commit -m "feat(asr): add browser PCM capture ported from display/capture.html"
```

---

## Task 11: Reshape the shared types

**Files:**
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: `Caption` from `src/asr/captions.ts` (Task 2).
- Produces:
  - `interface TranscriptItem { seq: number; sourceText: string; targetText: string; sourceLang: string; targetLang: string; ts: number; latencyMs: number; isEdited: boolean }`
  - `interface DisplayConfig { fontSize; fontFamily; showOriginal; showLatency }`
  - `interface Project { …; asrSessionId?: string | null }`
  - `interface ProjectSession { id: string; asrSessionId: string; startedAt: number; endedAt?: number; sourceLang: string; targetLang: string }`

- [ ] **Step 1: Replace `src/types.ts`**

```ts
/** One caption as the operator sees it. Shaped to protocol v1 so that P2's
 *  `transcript_items` table is a direct mapping rather than a migration. */
export interface TranscriptItem {
  seq: number;
  sourceText: string;
  targetText: string;
  sourceLang: string;
  targetLang: string;
  ts: number;
  latencyMs: number;
  isEdited: boolean;
}

/** Purely local presentation. Everything the BACKEND owns — languages,
 *  paused, mode, gate, glossary — is read from its broadcasts instead. */
export interface DisplayConfig {
  fontSize?: 'small' | 'medium' | 'large' | 'xlarge';
  fontFamily?: string;
  showOriginal?: boolean;
  showLatency?: boolean;
}

export interface ProjectSession {
  id: string;
  /** The Python session this recording ran against. Dies with the backend. */
  asrSessionId: string;
  startedAt: number;
  endedAt?: number;
  sourceLang: string;
  targetLang: string;
}

export interface ProjectBill {
  sessionCount: number;
  durationMs: number;
  wordCount: number;
  estimatedCost: number;
}

export interface Project {
  id: string;
  name: string;
  status: 'active' | 'ended';
  sessions: ProjectSession[];
  transcripts: TranscriptItem[];
  createdAt: number;
  endedAt?: number;
  bill?: ProjectBill;
  autoFinished?: boolean;
  /** The live Python session, if one is currently attached. Null after a
   *  backend restart, which invalidates every session id it ever issued. */
  asrSessionId?: string | null;
}
```

- [ ] **Step 2: Confirm `DictionarySet` and `AppConfig` are gone**

```bash
grep -n "DictionarySet\|AppConfig\|dictionaryJson\|chunkSilenceMs\|aiModel\|speechEngine" src/types.ts
```

Expected: no output. The glossary is server state now (Task 13), and `chunkSilenceMs` is replaced by `control.set_gate`.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "refactor(types): reshape TranscriptItem to protocol v1 and split AppConfig"
```

---

## Task 12: Project store — attach ASR sessions

**Files:**
- Modify: `src/hooks/useProjects.ts`

**Interfaces:**
- Consumes: `Project`, `ProjectSession`, `TranscriptItem` from `src/types.ts` (Task 11).
- Produces, added to the `useProjects()` return value:
  - `attachAsrSession(asrSessionId: string, sourceLang: string, targetLang: string): void`
  - `detachAsrSession(): void`
  - `startSession` changes signature to `(asrSessionId: string, sourceLang: string, targetLang: string) => void`

- [ ] **Step 1: Update `countWords` for the new transcript shape**

In `src/hooks/useProjects.ts`, replace the body of `countWords`:

```ts
function countWords(transcripts: TranscriptItem[]): number {
  return transcripts.reduce((total, t) => {
    const text = `${t.sourceText} ${t.targetText}`.trim();
    return total + (text ? text.split(/\s+/).length : 0);
  }, 0);
}
```

- [ ] **Step 2: Replace `startSession` and add attach/detach**

Replace the existing `startSession`, and place `attachAsrSession` / `detachAsrSession` **after** the existing `endSession` declaration — `detachAsrSession` calls it, and keeping the declaration order readable avoids a confusing temporal-dead-zone lookup:

```ts
  const startSession = (asrSessionId: string, sourceLang: string, targetLang: string) => {
    if (!currentProject || activeSession) return;
    const session: ProjectSession = {
      id: `sess_${Date.now()}`,
      asrSessionId,
      startedAt: Date.now(),
      sourceLang,
      targetLang
    };
    setProjects((prev) =>
      prev.map((p: Project) => (p.id === currentProject.id ? { ...p, sessions: [...p.sessions, session] } : p))
    );
  };

  // A project outlives many ASR sessions: the Python registry is in memory,
  // so a backend restart forces a new session id under the same project.
  const attachAsrSession = (asrSessionId: string, sourceLang: string, targetLang: string) => {
    if (!currentProject) return;
    setProjects((prev) =>
      prev.map((p: Project) => (p.id === currentProject.id ? { ...p, asrSessionId } : p))
    );
    startSession(asrSessionId, sourceLang, targetLang);
  };

  const detachAsrSession = () => {
    if (!currentProject) return;
    endSession();
    setProjects((prev) =>
      prev.map((p: Project) => (p.id === currentProject.id ? { ...p, asrSessionId: null } : p))
    );
  };
```

- [ ] **Step 3: Export the new functions**

In the returned object at the end of `useProjects`, replace `startSession,` with:

```ts
    startSession,
    attachAsrSession,
    detachAsrSession,
```

- [ ] **Step 4: Update the migration in `loadProjects`**

Replace the `.map` inside `loadProjects` with:

```ts
    // Projects saved before per-project transcripts or ASR sessions existed
    // have neither field yet.
    return parsed.map((p) => ({ ...p, transcripts: p.transcripts || [], asrSessionId: p.asrSessionId ?? null }));
```

- [ ] **Step 5: Type-check**

Run: `npm run lint`
Expected: errors only in `src/pages/Admin.tsx` and `src/components/DictionaryManager.tsx`.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useProjects.ts
git commit -m "feat(projects): attach and detach ephemeral ASR sessions per project"
```

---

## Task 13: Glossary editor

`DictionaryManager.tsx` becomes a three-section editor over the backend's process-wide glossary. Presets survive as client-side templates that push terms in; the authoritative state is always `glossary.state`.

**Files:**
- Modify: `src/components/DictionaryManager.tsx` (replaced wholesale)

**Interfaces:**
- Consumes: `GlossarySections` (Task 1), `glossaryAdd`/`glossaryRemove`/`glossaryReload` (Task 8).
- Produces: `function DictionaryManager(props: { sections: GlossarySections | null; onAdd: (section, abbr, full) => void; onRemove: (section, abbr) => void; onReload: () => void; disabled: boolean }): JSX.Element`

- [ ] **Step 1: Replace the component**

Replace the entire contents of `src/components/DictionaryManager.tsx`:

```tsx
import { useState } from 'react';
import type { GlossarySections } from '../asr/protocol';
import type { GlossarySection } from '../asr/commands';

const SECTIONS: Array<{ key: GlossarySection; label: string; hint: string }> = [
  { key: 'thai_corrections', label: 'แก้คำไทยที่ฟังผิด', hint: 'ไทย → ไทย เช่น ยาพารา → ยาพาราเซตามอล' },
  { key: 'protected_terms', label: 'ศัพท์เฉพาะที่ต้องคงคำแปล', hint: 'ไทย → อังกฤษ เช่น ความดันโลหิตสูง → hypertension' },
  { key: 'person_names', label: 'ชื่อบุคคล', hint: 'ไทย → อังกฤษ เช่น นพ. สมชาย → Dr. Somchai' },
];

export interface DictionaryManagerProps {
  sections: GlossarySections | null;
  onAdd: (section: GlossarySection, abbr: string, full: string) => void;
  onRemove: (section: GlossarySection, abbr: string) => void;
  onReload: () => void;
  disabled: boolean;
}

export default function DictionaryManager({ sections, onAdd, onRemove, onReload, disabled }: DictionaryManagerProps) {
  const [active, setActive] = useState<GlossarySection>('protected_terms');
  const [abbr, setAbbr] = useState('');
  const [full, setFull] = useState('');

  const entries = Object.entries(sections?.[active] ?? {});

  const submit = () => {
    if (!abbr.trim() || !full.trim()) return;
    onAdd(active, abbr.trim(), full.trim());
    setAbbr('');
    setFull('');
  };

  return (
    <div className="flex flex-col gap-3">
      {/* The glossary is process-wide on the backend: one file shared by every
          live session. A console that implied otherwise would let one operator
          silently change another venue's event. */}
      <p className="text-xs text-amber-300 bg-amber-950/40 border border-amber-800 rounded p-2">
        ⚠️ พจนานุกรมนี้ใช้ร่วมกันทุกเซสชันบนเซิร์ฟเวอร์ การแก้ไขจะมีผลกับทุกงานที่กำลังถ่ายทอดอยู่
      </p>

      <div className="flex gap-2">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            onClick={() => setActive(s.key)}
            className={`px-3 py-1.5 rounded text-sm ${active === s.key ? 'bg-pink-600 text-white' : 'bg-slate-700 text-slate-200'}`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <p className="text-xs text-slate-400">{SECTIONS.find((s) => s.key === active)?.hint}</p>

      <div className="flex gap-2">
        <input
          value={abbr}
          onChange={(e) => setAbbr(e.target.value)}
          placeholder="คำที่ได้ยิน"
          disabled={disabled}
          className="flex-1 bg-slate-800 rounded px-2 py-1.5 text-sm"
        />
        <input
          value={full}
          onChange={(e) => setFull(e.target.value)}
          placeholder="คำที่ต้องการ"
          disabled={disabled}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          className="flex-1 bg-slate-800 rounded px-2 py-1.5 text-sm"
        />
        <button onClick={submit} disabled={disabled} className="px-3 py-1.5 rounded bg-pink-600 text-white text-sm disabled:opacity-40">
          เพิ่ม
        </button>
      </div>

      <div className="max-h-64 overflow-y-auto flex flex-col gap-1">
        {entries.length === 0 && <p className="text-sm text-slate-500">ยังไม่มีคำในหมวดนี้</p>}
        {entries.map(([key, value]) => (
          <div key={key} className="flex items-center gap-2 bg-slate-800/60 rounded px-2 py-1 text-sm">
            <span className="flex-1 truncate">{key}</span>
            <span className="text-slate-400">→</span>
            <span className="flex-1 truncate">{value}</span>
            <button onClick={() => onRemove(active, key)} disabled={disabled} className="text-slate-400 hover:text-red-400 disabled:opacity-40">
              ✕
            </button>
          </div>
        ))}
      </div>

      <button onClick={onReload} disabled={disabled} className="self-start text-xs text-slate-400 hover:text-slate-200 disabled:opacity-40">
        โหลดพจนานุกรมใหม่จากไฟล์บนเซิร์ฟเวอร์
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npm run lint`
Expected: errors only in `src/pages/Admin.tsx`.

- [ ] **Step 3: Commit**

```bash
git add src/components/DictionaryManager.tsx
git commit -m "feat(glossary): replace per-project dictionary with backend glossary editor"
```

---

## Task 14: Rewire the operator console

The largest task. `Admin.tsx` is 1403 lines and has grown unwieldy, so the session, feed and control regions move into their own components.

**Files:**
- Create: `src/components/SessionBar.tsx`
- Create: `src/components/CaptionFeed.tsx`
- Create: `src/components/ControlPanel.tsx`
- Modify: `src/pages/Admin.tsx`

**Interfaces:**
- Consumes: everything from Tasks 2, 3, 6, 7, 8, 9, 10, 11, 12, 13.
- Produces: a working console. No further task depends on its internals.

- [ ] **Step 1: Create `src/components/SessionBar.tsx`**

```tsx
import type { SessionSnapshot } from '../asr/sessions';

export interface SessionBarProps {
  session: SessionSnapshot | null;
  candidates: SessionSnapshot[];
  connecting: boolean;
  micActive: boolean;
  micStatus: string;
  backpressure: boolean;
  droppedFrames: number;
  onAdopt: (id: string) => void;
  onCreate: () => void;
  onEnd: () => void;
  onToggleMic: () => void;
}

function Health({ label, value }: { label: string; value: boolean | null }) {
  // null is "does not apply" — a local session has no remote source, and the
  // DUAL_ASR helper is absent when the feature is off. Painting either as
  // dead would cry wolf on a healthy event.
  if (value === null) return null;
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${value ? 'bg-emerald-900 text-emerald-300' : 'bg-red-900 text-red-300'}`}>
      {label}: {value ? 'ปกติ' : 'ขัดข้อง'}
    </span>
  );
}

export default function SessionBar(props: SessionBarProps) {
  const { session, candidates, connecting, micActive, micStatus, backpressure, droppedFrames } = props;

  if (!session && candidates.length > 1) {
    return (
      <div className="flex flex-col gap-2 p-3 bg-slate-800 rounded">
        <p className="text-sm">มีหลายเซสชันกำลังทำงานอยู่ เลือกเซสชันที่ต้องการควบคุม:</p>
        {candidates.map((c) => (
          <button key={c.id} onClick={() => props.onAdopt(c.id)} className="text-left px-3 py-2 bg-slate-700 rounded text-sm">
            {c.id} — {c.source_lang} → {c.target_lang} · {c.clients} จอ
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 p-3 bg-slate-800 rounded">
      <span className="text-sm font-mono">{session ? session.id : connecting ? 'กำลังเชื่อมต่อ…' : 'ยังไม่มีเซสชัน'}</span>

      {session && (
        <>
          <Health label="ASR" value={session.recognizer_alive} />
          <Health label="ตัวช่วยไทย" value={session.helper_alive} />
          <Health label="เสียงเข้า" value={session.audio_alive} />
        </>
      )}

      <div className="flex-1" />

      {!session && (
        <button onClick={props.onCreate} className="px-3 py-1.5 rounded bg-pink-600 text-white text-sm">
          สร้างเซสชันใหม่
        </button>
      )}

      {session && (
        <>
          <button
            onClick={props.onToggleMic}
            className={`px-3 py-1.5 rounded text-sm ${micActive ? 'bg-red-600' : 'bg-pink-600'} text-white`}
          >
            {micActive ? 'หยุดส่งเสียง' : 'เริ่มส่งเสียง'}
          </button>
          <button onClick={props.onEnd} className="px-3 py-1.5 rounded bg-slate-600 text-sm">
            จบเซสชัน
          </button>
        </>
      )}

      {micStatus && <span className="w-full text-xs text-slate-400">{micStatus}</span>}
      {backpressure && (
        <span className="w-full text-xs text-amber-300">
          เซิร์ฟเวอร์รับเสียงไม่ทัน กำลังตัดเฟรมทิ้ง ({droppedFrames} เฟรม)
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `src/components/CaptionFeed.tsx`**

```tsx
import { useState } from 'react';
import type { Caption } from '../asr/captions';
import type { DisplayConfig } from '../types';

export interface CaptionFeedProps {
  captions: Caption[];
  interim: string | null;
  config: DisplayConfig;
  onEdit: (seq: number, targetText: string) => void;
}

const FONT_SIZES: Record<string, string> = {
  small: 'text-base',
  medium: 'text-xl',
  large: 'text-2xl',
  xlarge: 'text-4xl',
};

export default function CaptionFeed({ captions, interim, config, onEdit }: CaptionFeedProps) {
  const [editingSeq, setEditingSeq] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const sizeClass = FONT_SIZES[config.fontSize ?? 'large'];

  return (
    <div className="flex flex-col gap-3">
      {captions.map((caption) => (
        <div key={caption.seq} className="border-b border-slate-800 pb-2">
          {config.showOriginal !== false && <p className="text-slate-400 text-sm">{caption.sourceText}</p>}

          {editingSeq === caption.seq ? (
            <div className="flex gap-2">
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onEdit(caption.seq, draft);
                    setEditingSeq(null);
                  }
                  if (e.key === 'Escape') setEditingSeq(null);
                }}
                className="flex-1 bg-slate-800 rounded px-2 py-1"
              />
              <button
                onClick={() => {
                  onEdit(caption.seq, draft);
                  setEditingSeq(null);
                }}
                className="px-3 rounded bg-pink-600 text-white text-sm"
              >
                บันทึก
              </button>
            </div>
          ) : (
            <p className={`${sizeClass} leading-snug`} style={{ fontFamily: config.fontFamily }}>
              {/* A final arrives with an empty translation and the target
                  follows. Showing a placeholder rather than waiting is why
                  source captions appear at ASR latency. */}
              {caption.targetText || <span className="text-slate-600 text-base">กำลังแปล…</span>}
              {caption.isEdited && <span className="ml-2 text-xs text-amber-400">แก้ไขแล้ว</span>}
            </p>
          )}

          <div className="flex gap-3 text-xs text-slate-500 mt-1">
            {config.showLatency !== false && <span>{caption.latencyMs} ms</span>}
            <button
              onClick={() => {
                setEditingSeq(caption.seq);
                setDraft(caption.targetText);
              }}
              className="hover:text-slate-300"
            >
              แก้ไข
            </button>
          </div>
        </div>
      ))}

      {interim && <p className="text-slate-500 italic">{interim}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Create `src/components/ControlPanel.tsx`**

```tsx
import type { WelcomePayload } from '../asr/protocol';

export interface ControlPanelProps {
  /** Server state, never local. Null until session.welcome arrives. */
  state: WelcomePayload | null;
  disabled: boolean;
  onSetLanguages: (source: string, target: string) => void;
  onSetPaused: (paused: boolean) => void;
  onSetGate: (minWords: number, minIntervalMs: number) => void;
  onReport: (start: boolean) => void;
}

export default function ControlPanel({ state, disabled, onSetLanguages, onSetPaused, onSetGate, onReport }: ControlPanelProps) {
  if (!state) return <p className="text-sm text-slate-500">รอสถานะจากเซิร์ฟเวอร์…</p>;

  const swap = () => onSetLanguages(state.target_lang, state.source_lang);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-xs text-slate-400 mb-1">ทิศทางการแปล</p>
        <div className="flex items-center gap-2">
          <span className="px-3 py-1.5 bg-slate-800 rounded text-sm">{state.source_lang}</span>
          <span>→</span>
          <span className="px-3 py-1.5 bg-slate-800 rounded text-sm">{state.target_lang}</span>
          <button onClick={swap} disabled={disabled || !state.asr_switchable} className="px-3 py-1.5 rounded bg-slate-700 text-sm disabled:opacity-40">
            ⇅ สลับภาษา
          </button>
        </div>
        {state.asr_switchable && (
          // Retargeting Speech-to-Text restarts the recognition stream.
          <p className="text-xs text-slate-500 mt-1">การสลับภาษาต้นทางจะรีสตาร์ทการฟังเสียงราว 1 วินาที</p>
        )}
      </div>

      <button
        onClick={() => onSetPaused(!state.paused)}
        disabled={disabled}
        className={`self-start px-3 py-1.5 rounded text-sm ${state.paused ? 'bg-emerald-600' : 'bg-slate-700'} disabled:opacity-40`}
      >
        {state.paused ? 'เล่นต่อ' : 'พักการถอดความ'}
      </button>

      <div>
        <p className="text-xs text-slate-400 mb-1">
          จังหวะแปลระหว่างพูด — อย่างน้อย {state.gate.min_words} คำ ทุก {state.gate.min_interval_ms} ms
        </p>
        <div className="flex gap-2">
          <button onClick={() => onSetGate(2, 250)} disabled={disabled} className="px-3 py-1.5 rounded bg-slate-700 text-sm disabled:opacity-40">
            ⚡ ไว
          </button>
          <button onClick={() => onSetGate(3, 400)} disabled={disabled} className="px-3 py-1.5 rounded bg-slate-700 text-sm disabled:opacity-40">
            ⚖️ มาตรฐาน
          </button>
          <button onClick={() => onSetGate(5, 700)} disabled={disabled} className="px-3 py-1.5 rounded bg-slate-700 text-sm disabled:opacity-40">
            🧘 ผ่อนคลาย
          </button>
        </div>
      </div>

      <button
        onClick={() => onReport(!state.report.active)}
        disabled={disabled}
        className="self-start px-3 py-1.5 rounded bg-slate-700 text-sm disabled:opacity-40"
      >
        {state.report.active ? `หยุดบันทึกช่วง (${state.report.count} รายการ)` : 'เริ่มบันทึกช่วงเพื่อสรุป'}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Rewrite `src/pages/Admin.tsx`**

Delete the whole file and replace it. The old file's project-panel, history and export markup is reused where noted; the socket, Web Speech and Gemini code has no replacement.

```tsx
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
// ProjectPanel.tsx has NO default export — it exports four named components.
import { BillModal, HistoryPanel, ProjectHeaderBar, ProjectPicker } from '../components/ProjectPanel';
import DictionaryManager from '../components/DictionaryManager';
import SessionBar from '../components/SessionBar';
import CaptionFeed from '../components/CaptionFeed';
import ControlPanel from '../components/ControlPanel';
import { captionsReducer, initialCaptionState, selectCaptions } from '../asr/captions';
import { useAsrSocket } from '../asr/useAsrSocket';
import { useAudioCapture } from '../asr/audio/useAudioCapture';
import { createOperatorTokenSource, mintSourceToken } from '../asr/tokens';
import { chooseSession, createSession, deleteSession, getSession, listSessions, type SessionSnapshot } from '../asr/sessions';
import * as cmd from '../asr/commands';
import type { GlossarySection } from '../asr/commands';
import type { AnyFrame, GlossarySections, ReportDonePayload } from '../asr/protocol';
import { useProjects } from '../hooks/useProjects';
import type { DisplayConfig, Project } from '../types';

const BACKEND_URL = import.meta.env.VITE_ASR_BACKEND_URL || 'http://localhost:8765';
const HEALTH_POLL_MS = 5000;
// Source tokens live 12 h and expiry is re-checked on EVERY audio frame, so a
// capture client that outlives its token is closed mid-stream with 4401. An
// event day can run past 12 h; re-mint at 80% rather than discover this at
// hour twelve of a conference.
const SOURCE_TOKEN_REFRESH_MS = 12 * 3600 * 1000 * 0.8;

export default function Admin() {
  const projects = useProjects();
  const tokenSource = useMemo(() => createOperatorTokenSource(), []);

  const [token, setToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [candidates, setCandidates] = useState<SessionSnapshot[]>([]);
  const [sourceToken, setSourceToken] = useState<string | null>(null);
  const [micActive, setMicActive] = useState(false);
  const [glossary, setGlossary] = useState<GlossarySections | null>(null);
  const [report, setReport] = useState<ReportDonePayload | null>(null);
  const [config, setConfig] = useState<DisplayConfig>({ fontSize: 'large', showOriginal: true, showLatency: true });
  const [showHistory, setShowHistory] = useState(false);
  const [finishedProject, setFinishedProject] = useState<Project | null>(null);
  const [captionState, dispatchCaption] = useReducer(captionsReducer, initialCaptionState);

  const captions = useMemo(() => selectCaptions(captionState), [captionState]);
  const bootstrapped = useRef(false);

  // ── Token ────────────────────────────────────────────────────────────────
  useEffect(() => {
    tokenSource
      .get()
      .then(setToken)
      .catch((err: Error) => setTokenError(err.message));
  }, [tokenSource]);

  // ── Adopt or offer to create a session ───────────────────────────────────
  useEffect(() => {
    if (!token || bootstrapped.current) return;
    bootstrapped.current = true;
    listSessions(BACKEND_URL, token)
      .then((live) => {
        const choice = chooseSession(live);
        if (choice.action === 'adopt') setSession(live.find((s) => s.id === choice.id) ?? null);
        else if (choice.action === 'ask') setCandidates(choice.sessions);
      })
      .catch((err: Error) => setTokenError(err.message));
  }, [token]);

  // ── Health polling over HTTP, never over the rate-limited WebSocket ──────
  useEffect(() => {
    if (!token || !session) return;
    const timer = setInterval(async () => {
      const fresh = await getSession(BACKEND_URL, token, session.id).catch(() => undefined);
      if (fresh === null) {
        // The backend forgot this session — a restart. Do not retry the id.
        setSession(null);
        setMicActive(false);
        setSourceToken(null);
        projects.detachAsrSession();
      } else if (fresh) {
        setSession(fresh);
      }
    }, HEALTH_POLL_MS);
    return () => clearInterval(timer);
  }, [token, session, projects]);

  // ── Control socket ───────────────────────────────────────────────────────
  const onFrame = useCallback((frame: AnyFrame) => {
    dispatchCaption({ kind: 'frame', frame });
    if (frame.type === 'glossary.state') setGlossary((frame.data as { sections: GlossarySections }).sections);
    else if (frame.type === 'session.welcome') setGlossary((frame.data as { glossary: { sections: GlossarySections } }).glossary.sections);
    else if (frame.type === 'report.done') setReport(frame.data as ReportDonePayload);
  }, []);

  const socket = useAsrSocket({ backendUrl: BACKEND_URL, sessionId: session?.id ?? null, token, onFrame });

  useEffect(() => {
    if (!socket.sessionGone) return;
    setSession(null);
    setMicActive(false);
    setSourceToken(null);
    projects.detachAsrSession();
  }, [socket.sessionGone, projects]);

  // ── Audio ────────────────────────────────────────────────────────────────
  const capture = useAudioCapture({
    backendUrl: BACKEND_URL,
    sessionId: session?.id ?? null,
    sourceToken,
    active: micActive,
  });

  useEffect(() => {
    if (!micActive || !token || !session) return;
    const timer = setInterval(() => {
      mintSourceToken(BACKEND_URL, session.id, token)
        .then(setSourceToken)
        .catch((err: Error) => setTokenError(err.message));
    }, SOURCE_TOKEN_REFRESH_MS);
    return () => clearInterval(timer);
  }, [micActive, token, session]);

  const toggleMic = async () => {
    if (micActive) {
      setMicActive(false);
      return;
    }
    if (!token || !session) return;
    try {
      setSourceToken(await mintSourceToken(BACKEND_URL, session.id, token));
      setMicActive(true);
    } catch (err) {
      setTokenError((err as Error).message);
    }
  };

  // ── Session actions ──────────────────────────────────────────────────────
  const adopt = async (id: string) => {
    if (!token) return;
    const found = await getSession(BACKEND_URL, token, id);
    setSession(found);
    setCandidates([]);
    if (found) projects.attachAsrSession(found.id, found.source_lang, found.target_lang);
  };

  const create = async () => {
    if (!token) return;
    try {
      const created = await createSession(BACKEND_URL, token);
      setSession(created);
      setCandidates([]);
      dispatchCaption({ kind: 'reset' });
      projects.attachAsrSession(created.id, created.source_lang, created.target_lang);
    } catch (err) {
      setTokenError((err as Error).message);
    }
  };

  const end = async () => {
    if (!token || !session) return;
    await deleteSession(BACKEND_URL, token, session.id);
    setSession(null);
    setMicActive(false);
    setSourceToken(null);
    projects.detachAsrSession();
  };

  // Ending the project also ends the ASR session: a project is durable, the
  // Python session is not, and leaving one running would keep billing a
  // recognizer for an event that is over.
  const finishProject = async () => {
    if (session && token) await deleteSession(BACKEND_URL, token, session.id);
    setSession(null);
    setMicActive(false);
    setSourceToken(null);
    const finished = projects.finishProject(captions);
    dispatchCaption({ kind: 'reset' });
    if (finished) setFinishedProject(finished);
  };

  // ── Export ───────────────────────────────────────────────────────────────
  const download = (name: string, body: string) => {
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const srtTime = (ms: number) => {
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
    const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
    return `${h}:${m}:${s},${String(Math.floor(ms % 1000)).padStart(3, '0')}`;
  };

  const exportTranscript = (type: 'txt' | 'srt') => {
    if (captions.length === 0) return;
    if (type === 'txt') {
      const body = captions
        .map((c) => `[${new Date(c.ts * 1000).toLocaleTimeString('th-TH')}]\n${c.sourceText}\n${c.targetText}\n`)
        .join('\n');
      download(`transcript-${Date.now()}.txt`, body);
      return;
    }
    const start = captions[0].ts;
    const body = captions
      .map((c, i) => {
        const from = (c.ts - start) * 1000;
        const to = from + 3000;
        return `${i + 1}\n${srtTime(from)} --> ${srtTime(to)}\n${c.targetText}\n`;
      })
      .join('\n');
    download(`subtitles-${Date.now()}.srt`, body);
  };

  const disabled = socket.status !== 'open';
  const send = socket.send;
  const sid = session?.id ?? '';

  // No project selected: the picker is the whole screen, as it is today.
  if (!projects.currentProject) {
    return (
      <>
        <ProjectPicker
          activeProjects={projects.activeProjects}
          canCreateProject={projects.canCreateProject}
          onSelect={projects.selectProject}
          onCreate={projects.createProject}
          onOpenHistory={() => setShowHistory(true)}
        />
        {showHistory && <HistoryPanel projects={projects.endedProjects} onClose={() => setShowHistory(false)} />}
      </>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 flex flex-col gap-4">
      <ProjectHeaderBar
        project={projects.currentProject}
        activeSession={projects.activeSession}
        onRequestFinish={finishProject}
        onSwitchProject={projects.clearSelection}
        onOpenHistory={() => setShowHistory(true)}
      />

      {tokenError && <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded p-2">{tokenError}</p>}
      {socket.error && <p className="text-sm text-amber-300 bg-amber-950/40 border border-amber-900 rounded p-2">{socket.error}</p>}

      <SessionBar
        session={session}
        candidates={candidates}
        connecting={socket.status === 'connecting'}
        micActive={micActive}
        micStatus={capture.error ?? (capture.status === 'sending' ? 'กำลังส่งเสียงเข้าเซิร์ฟเวอร์' : '')}
        backpressure={capture.backpressure}
        droppedFrames={capture.droppedFrames}
        onAdopt={adopt}
        onCreate={create}
        onEnd={end}
        onToggleMic={toggleMic}
      />

      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4">
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <button onClick={() => exportTranscript('txt')} className="px-3 py-1.5 rounded bg-slate-700 text-sm">
              ส่งออก .TXT
            </button>
            <button onClick={() => exportTranscript('srt')} className="px-3 py-1.5 rounded bg-slate-700 text-sm">
              ส่งออก .SRT
            </button>
          </div>
          <CaptionFeed
            captions={captions}
            interim={captionState.interim?.sourceText ?? null}
            config={config}
            onEdit={(seq, targetText) => dispatchCaption({ kind: 'edit', seq, targetText })}
          />
        </div>

        <div className="flex flex-col gap-6">
          <ControlPanel
            state={socket.welcome}
            disabled={disabled}
            onSetLanguages={(source, target) => send(cmd.setLanguages(sid, source, target))}
            onSetPaused={(paused) => send(cmd.setPaused(sid, paused))}
            onSetGate={(w, ms) => send(cmd.setGate(sid, w, ms))}
            onReport={(start) => send(start ? cmd.reportStart(sid) : cmd.reportStop(sid))}
          />

          <DictionaryManager
            sections={glossary}
            disabled={disabled}
            onAdd={(section: GlossarySection, abbr, full) => send(cmd.glossaryAdd(sid, section, abbr, full))}
            onRemove={(section: GlossarySection, abbr) => send(cmd.glossaryRemove(sid, section, abbr))}
            onReload={() => send(cmd.glossaryReload(sid))}
          />

          <div className="flex flex-col gap-2">
            <label className="text-xs text-slate-400">ขนาดตัวอักษร</label>
            <select
              value={config.fontSize}
              onChange={(e) => setConfig((c) => ({ ...c, fontSize: e.target.value as DisplayConfig['fontSize'] }))}
              className="bg-slate-800 rounded px-2 py-1.5 text-sm"
            >
              <option value="small">เล็ก</option>
              <option value="medium">กลาง</option>
              <option value="large">ใหญ่</option>
              <option value="xlarge">ใหญ่พิเศษ</option>
            </select>
          </div>
        </div>
      </div>

      {report && (
        <div className="p-3 bg-slate-800 rounded">
          <h2 className="text-sm font-semibold mb-2">สรุปช่วงการประชุม</h2>
          <p className="text-sm whitespace-pre-wrap">{report.summary}</p>
        </div>
      )}

      {showHistory && <HistoryPanel projects={projects.endedProjects} onClose={() => setShowHistory(false)} />}
      {finishedProject && <BillModal project={finishedProject} onClose={() => setFinishedProject(null)} />}
    </div>
  );
}
```

Note that `projects.finishProject(captions)` is fed the `Caption[]` from the reducer. `Caption` and `TranscriptItem` (Task 11) are structurally identical by design, so this assigns cleanly — that identity is deliberate, and P2's `transcript_items` table maps onto the same shape.

- [ ] **Step 5: Type-check**

Run: `npm run lint`
Expected: no output.

`ProjectPanel.tsx` reads only `Project`, `ProjectBill` and `ProjectSession` and touches no transcript fields, so the Task 11 reshape does not reach it. If the compiler disagrees, fix the reported line rather than assuming this note is right.

- [ ] **Step 6: Confirm nothing from the old stack survives**

```bash
grep -rn "socket.io\|SpeechRecognition\|webkitSpeechRecognition\|genai\|GEMINI\|new-transcription\|retranslate" src/ server.ts
```

Expected: no output.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 8: Commit**

```bash
git add src/pages/Admin.tsx src/components/SessionBar.tsx src/components/CaptionFeed.tsx src/components/ControlPanel.tsx src/components/ProjectPanel.tsx
git commit -m "feat(console): drive the ASR backend from React, removing Web Speech and Socket.IO"
```

---

## Task 15: End-to-end venue verification and docs

**Files:**
- Modify: `SYSTEM_OVERVIEW.md`
- Modify: `../thai-realtime-asr-mt/.env` (local only, not committed)

**Interfaces:**
- Consumes: everything.
- Produces: a verified working system and corrected documentation.

- [ ] **Step 1: Allow the app's origin through CORS on the backend**

In `../thai-realtime-asr-mt/.env`, add `http://localhost:3000` to `CORS_ORIGINS`:

```
CORS_ORIGINS=http://localhost:8765,http://127.0.0.1:8765,http://localhost:3000
```

The backend rejects a literal `*` at startup by design — do not use one.

- [ ] **Step 2: Start both servers**

```bash
# terminal 1
cd ../thai-realtime-asr-mt && uv run python server/main.py
# terminal 2
npm run dev
```

- [ ] **Step 3: Work the venue checklist**

Open `http://localhost:3000` and confirm each item, fixing anything that fails before continuing:

1. A session is created (or adopted) and its id appears in the session bar
2. "เริ่มส่งเสียง" opens the mic; `audio.ready` arrives and the status reads "กำลังส่งเสียงเข้าเซิร์ฟเวอร์"
3. Speaking Thai produces an interim line, then a final caption, then its English translation a moment later
4. "⇅ สลับภาษา" swaps direction; recognition resumes after roughly a second
5. "พักการถอดความ" stops captions; resuming continues **without losing** what came before
6. A glossary term added in the editor appears in the list and survives a reload
7. "เริ่มบันทึกช่วงเพื่อสรุป" then stop produces a summary panel
8. `.TXT` and `.SRT` export, including a caption edited by hand
9. Kill and restart the Python server: the console reports the session is gone, offers a new one, and does **not** spin reconnecting
10. Open a second browser tab and start its mic: it is refused with the `4408` message

- [ ] **Step 4: Correct the stale claim in `SYSTEM_OVERVIEW.md`**

Delete item 8 from §4.5 — the pause/resume transcript-wipe bug it describes was never present in this code. `start-meeting` only toggled a flag, and the sole `transcripts = []` sat in an explicitly invoked `clear-transcripts` handler.

- [ ] **Step 5: Rewrite the parts of `SYSTEM_OVERVIEW.md` that P0 invalidated**

Replace the architecture diagram in §1 and the feature list in §2 to state that ASR, translation, session management, language selection and the glossary are provided by `thai-realtime-asr-mt` over protocol v1. Specifically remove: §2.2's chunking presets and manual-cut button, §2.3's Gemini model list, §2.4's API-key console, and §2.5's test-input bar. Add a line pointing at [`docs/superpowers/specs/2026-09-03-asr-backend-integration-design.md`](../specs/2026-09-03-asr-backend-integration-design.md) and note that P1–P4 remain unbuilt.

- [ ] **Step 6: Final full check**

```bash
npm test && npm run lint && npm run build
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add SYSTEM_OVERVIEW.md
git commit -m "docs: rewrite system overview for the ASR backend integration"
```

---

## Definition of done

1. An operator opens the app, gets a token with no login prompt, and adopts or creates a remote-ingest session.
2. Speaking into the browser microphone produces Thai and English captions in the console.
3. Language swap, pause/resume, gate tuning, glossary edits and section reports all work from the React UI.
4. `.TXT` and `.SRT` export correctly, including client-side edits.
5. `grep -rn "socket.io\|SpeechRecognition\|genai\|GEMINI" src/ server.ts` returns nothing.
6. `npm test`, `npm run lint` and `npm run build` all pass.
7. The venue checklist in Task 15 Step 3 passes end to end.
