# Gemini-only Transcription/Translation/Summarization Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every connection to the separate Python ASR backend (`../thai-realtime-asr-mt`) and do transcription, translation, and end-of-session summarization entirely through the Gemini API, called from this repo's own Node server, while keeping the operator-facing UI the same except for the small set of changes that are an unavoidable consequence of removing the backend.

**Architecture:** Browser mic → AudioWorklet PCM capture → client-side silence/cap-based chunker → each finished chunk WAV-encoded and POSTed to a new Node/Express route → Node calls Gemini (`@google/genai`, server-held API key) for structured JSON transcription+translation → response flows back through a client-side reorder queue into the existing caption reducer/UI. End of session: full transcript POSTed to a second Gemini route for a summary, same fallback contract as the old backend (AI failure never loses the transcript).

**Tech Stack:** TypeScript, React 19, Express, Vite, Vitest (+ `@testing-library/react`, jsdom), `@google/genai` (new), `multer` (new).

**Spec:** [`docs/superpowers/specs/2026-09-07-gemini-transcription-migration-design.md`](../specs/2026-09-07-gemini-transcription-migration-design.md)

## Global Constraints

- `GEMINI_API_KEY` is used only in `server/gemini.ts` / `server.ts` — it must never reach the browser or appear in any client-bundled code.
- Chunk-cut rule (owned by `src/asr/audio/chunker.ts`): cut on trailing silence ≥600ms after ≥1s of buffered speech, OR a hard cap of 8000ms, with a minimum chunk length of 600ms below which buffered audio is discarded rather than sent.
- Sessions are single-tab/local only — no cross-tab session adoption, no shared session registry, no health polling of a remote session.
- The glossary persists in `localStorage` under the key `ai_translate_glossary` (see `src/glossary.ts`) — not a server file.
- `GEMINI_MODEL` / `GEMINI_SUMMARY_MODEL` are env-configurable (`.env`), defaulting to `gemini-2.5-flash`.
- `/api/gemini/summarize` must never lose the transcript on an AI failure — always fall back to `{ summary: '', items: <count> }`, exactly like the old backend's Vertex-failure fallback.
- Existing JSX/UI stays unchanged except the specific text/behavior changes called out in the design spec's §7 (header subtitle, "Ping" repurposed to a health-check RTT, dictionary reload button removed, live word-by-word interim text replaced by a generic listening state, the "restarts listening ~1s" notice removed, multi-tab session picker/health-poll/`recognizer_alive` banners removed).
- Testing style: dependency-injected fakes, matching the two patterns already used in this repo — `server/asrTokenBroker.test.ts`'s `fakeFetch` factory, and `src/hooks/useProjects.test.ts`'s `FakeStorage` class (`// @vitest-environment jsdom` docblock) for any test touching `localStorage`. Do not introduce a new mocking framework.
- `vitest.config.ts` runs `src/**/*.test.ts(x)` and `server/**/*.test.ts` under the `node` environment by default; a test file that needs the DOM must add `// @vitest-environment jsdom` as its first line.

---

## Task 1: WAV encoder utility

**Files:**
- Create: `src/asr/audio/wav.ts`
- Test: `src/asr/audio/wav.test.ts`

**Interfaces:**
- Produces: `encodeWavBuffer(samples: Int16Array, sampleRate: number): ArrayBuffer` — wraps 16-bit mono PCM samples in a standard 44-byte WAV header. Used by Task 9's capture hook to package each finished audio chunk before it's POSTed to the server.

- [ ] **Step 1: Write the failing test**

Create `src/asr/audio/wav.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { encodeWavBuffer } from './wav';

function readString(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

describe('encodeWavBuffer', () => {
  it('writes a valid 16-bit mono PCM WAV header', () => {
    const samples = new Int16Array([0, 1000, -1000, 32767, -32768]);
    const buffer = encodeWavBuffer(samples, 16000);
    const view = new DataView(buffer);

    expect(readString(view, 0, 4)).toBe('RIFF');
    expect(readString(view, 8, 4)).toBe('WAVE');
    expect(readString(view, 12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(readString(view, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(buffer.byteLength).toBe(44 + samples.length * 2);
  });

  it('round-trips sample data unchanged', () => {
    const samples = new Int16Array([0, 1000, -1000, 32767, -32768]);
    const buffer = encodeWavBuffer(samples, 16000);
    const view = new DataView(buffer);
    for (let i = 0; i < samples.length; i++) {
      expect(view.getInt16(44 + i * 2, true)).toBe(samples[i]);
    }
  });

  it('handles an empty sample array', () => {
    const buffer = encodeWavBuffer(new Int16Array([]), 16000);
    expect(buffer.byteLength).toBe(44);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/asr/audio/wav.test.ts`
Expected: FAIL — `wav.ts` does not exist yet (`Cannot find module './wav'`).

- [ ] **Step 3: Write the implementation**

Create `src/asr/audio/wav.ts`:

```ts
// Wraps raw 16-bit mono PCM samples in a standard 44-byte WAV header so a
// chunk of buffered audio can be sent to Gemini as a self-describing
// audio/wav blob, with no server-side re-encoding needed.
export function encodeWavBuffer(samples: Int16Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample; // mono
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, samples[i], true);
  }

  return buffer;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/asr/audio/wav.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/asr/audio/wav.ts src/asr/audio/wav.test.ts
git commit -m "$(cat <<'EOF'
Add WAV encoder for Gemini audio chunks

Part of the Gemini-only transcription migration — wraps buffered PCM
samples in a WAV header before a chunk is sent to the new transcribe
endpoint.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Chunk cutter (silence/cap-based endpointing)

**Files:**
- Create: `src/asr/audio/chunker.ts`
- Test: `src/asr/audio/chunker.test.ts`

**Interfaces:**
- Produces: `createChunker(opts: ChunkerOptions): Chunker`, `Chunker.pushFrame(frame: Int16Array): Int16Array | null`, `Chunker.flush(): Int16Array | null`. Used by Task 9's capture hook — one `Chunker` instance per active mic session, fed one PCM frame at a time from the existing AudioWorklet (`src/asr/audio/pcm.ts`'s `FRAME_SAMPLES`-sized frames).

- [ ] **Step 1: Write the failing test**

Create `src/asr/audio/chunker.test.ts`. To keep the arithmetic easy to read, tests use `sampleRate: 1000` (so 1 sample = 1ms) and 100-sample (100ms) frames.

```ts
import { describe, expect, it } from 'vitest';
import { createChunker } from './chunker';

function makeFrame(value: number, length = 100): Int16Array {
  return new Int16Array(length).fill(value);
}

const LOUD = 3000; // above the default silence RMS threshold
const SILENT = 0;

describe('createChunker', () => {
  it('cuts once trailing silence follows enough buffered speech', () => {
    const chunker = createChunker({ sampleRate: 1000, minSpeechMs: 200, silenceMs: 200, minChunkMs: 100, maxChunkMs: 10000 });

    expect(chunker.pushFrame(makeFrame(LOUD))).toBeNull(); // 100ms speech
    expect(chunker.pushFrame(makeFrame(LOUD))).toBeNull(); // 200ms speech total
    expect(chunker.pushFrame(makeFrame(SILENT))).toBeNull(); // 100ms silence
    const result = chunker.pushFrame(makeFrame(SILENT)); // 200ms silence total -> cut

    expect(result).not.toBeNull();
    expect(result!.length).toBe(400); // the 4 frames buffered before the cut
  });

  it('does not cut before the minimum speech duration, even with immediate silence', () => {
    const chunker = createChunker({ sampleRate: 1000, minSpeechMs: 300, silenceMs: 100, minChunkMs: 500, maxChunkMs: 10000 });

    expect(chunker.pushFrame(makeFrame(SILENT))).toBeNull();
    expect(chunker.pushFrame(makeFrame(SILENT))).toBeNull();
    // Only 200ms buffered, below both minSpeechMs and minChunkMs — flush
    // discards it rather than sending near-silence.
    expect(chunker.flush()).toBeNull();
  });

  it('hard-caps a continuous, pause-free chunk at maxChunkMs', () => {
    const chunker = createChunker({ sampleRate: 1000, minSpeechMs: 100000, silenceMs: 100000, minChunkMs: 100, maxChunkMs: 300 });

    expect(chunker.pushFrame(makeFrame(LOUD))).toBeNull(); // 100ms
    expect(chunker.pushFrame(makeFrame(LOUD))).toBeNull(); // 200ms
    const result = chunker.pushFrame(makeFrame(LOUD)); // 300ms -> hits the cap

    expect(result).not.toBeNull();
    expect(result!.length).toBe(300);
  });

  it('flush returns whatever is buffered above the minimum, as the end of speech', () => {
    const chunker = createChunker({ sampleRate: 1000, minSpeechMs: 500, silenceMs: 500, minChunkMs: 150, maxChunkMs: 10000 });

    chunker.pushFrame(makeFrame(LOUD)); // 100ms
    chunker.pushFrame(makeFrame(LOUD)); // 200ms — below minSpeechMs, so pushFrame itself never cut

    const flushed = chunker.flush();
    expect(flushed).not.toBeNull();
    expect(flushed!.length).toBe(200);
  });

  it('resets its buffer after a cut, so the next chunk starts empty', () => {
    const chunker = createChunker({ sampleRate: 1000, minSpeechMs: 100, silenceMs: 100, minChunkMs: 50, maxChunkMs: 10000 });

    chunker.pushFrame(makeFrame(LOUD));
    chunker.pushFrame(makeFrame(SILENT)); // cuts here (100ms speech, 100ms silence)

    // Immediately after the cut, a single 100ms silent frame is below both
    // minSpeechMs and minChunkMs, so nothing should be pending.
    expect(chunker.flush()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/asr/audio/chunker.test.ts`
Expected: FAIL — `Cannot find module './chunker'`

- [ ] **Step 3: Write the implementation**

Create `src/asr/audio/chunker.ts`:

```ts
export interface ChunkerOptions {
  sampleRate: number;
  /** Trailing silence, after enough speech, that ends a chunk. Default 600ms. */
  silenceMs?: number;
  /** Minimum buffered duration before trailing silence is allowed to cut it. Default 1000ms. */
  minSpeechMs?: number;
  /** Hard cap so continuous, pause-free speech still gets sent periodically. Default 8000ms. */
  maxChunkMs?: number;
  /** Below this, a cut is discarded instead of sent (avoids near-silence chunks). Default 600ms. */
  minChunkMs?: number;
  /** Int16 RMS below this counts as silence for endpointing. Default 500. */
  silenceRmsThreshold?: number;
}

export interface Chunker {
  /** Feed one PCM frame. Returns a completed chunk when a cut fires, else null. */
  pushFrame(frame: Int16Array): Int16Array | null;
  /** Force-cut whatever is currently buffered (e.g. on pause/stop). */
  flush(): Int16Array | null;
}

function rms(frame: Int16Array): number {
  let sumSquares = 0;
  for (let i = 0; i < frame.length; i++) sumSquares += frame[i] * frame[i];
  return Math.sqrt(sumSquares / frame.length);
}

function concat(frames: Int16Array[]): Int16Array {
  const total = frames.reduce((sum, f) => sum + f.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

export function createChunker(opts: ChunkerOptions): Chunker {
  const silenceSamples = ((opts.silenceMs ?? 600) / 1000) * opts.sampleRate;
  const minSpeechSamples = ((opts.minSpeechMs ?? 1000) / 1000) * opts.sampleRate;
  const maxChunkSamples = ((opts.maxChunkMs ?? 8000) / 1000) * opts.sampleRate;
  const minChunkSamples = ((opts.minChunkMs ?? 600) / 1000) * opts.sampleRate;
  const silenceRmsThreshold = opts.silenceRmsThreshold ?? 500;

  let frames: Int16Array[] = [];
  let bufferedSamples = 0;
  let trailingSilenceSamples = 0;

  const cut = (): Int16Array | null => {
    const tooShort = bufferedSamples < minChunkSamples;
    const result = tooShort ? null : concat(frames);
    frames = [];
    bufferedSamples = 0;
    trailingSilenceSamples = 0;
    return result;
  };

  return {
    pushFrame(frame: Int16Array): Int16Array | null {
      frames.push(frame);
      bufferedSamples += frame.length;
      trailingSilenceSamples = rms(frame) < silenceRmsThreshold ? trailingSilenceSamples + frame.length : 0;

      if (bufferedSamples >= maxChunkSamples) return cut();
      if (bufferedSamples >= minSpeechSamples && trailingSilenceSamples >= silenceSamples) return cut();
      return null;
    },
    flush(): Int16Array | null {
      return cut();
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/asr/audio/chunker.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/asr/audio/chunker.ts src/asr/audio/chunker.test.ts
git commit -m "$(cat <<'EOF'
Add silence/cap-based audio chunker

Part of the Gemini-only transcription migration — decides when a buffered
run of PCM frames becomes one chunk to send for transcription, per the
design spec's chunk-cut rule (silence >=600ms after >=1s speech, or an
8s hard cap).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Reorder queue

**Files:**
- Create: `src/asr/reorderQueue.ts`
- Test: `src/asr/reorderQueue.test.ts`

**Interfaces:**
- Produces: `createReorderQueue<T>(onInOrder: (item: T) => void): ReorderQueue<T>`, `ReorderQueue<T>.push(seq: number, item: T): void`. Used by Task 9's capture hook so a chunk's Gemini response that arrives out of order (a later chunk's request finishing first) is held until its predecessor's result has been applied — the seq starts at 0 for each hook instance.

- [ ] **Step 1: Write the failing test**

Create `src/asr/reorderQueue.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createReorderQueue } from './reorderQueue';

describe('createReorderQueue', () => {
  it('emits items immediately when they arrive in order', () => {
    const emitted: string[] = [];
    const queue = createReorderQueue<string>((item) => emitted.push(item));
    queue.push(0, 'a');
    queue.push(1, 'b');
    expect(emitted).toEqual(['a', 'b']);
  });

  it('holds an out-of-order item until its predecessor arrives', () => {
    const emitted: string[] = [];
    const queue = createReorderQueue<string>((item) => emitted.push(item));
    queue.push(1, 'b');
    expect(emitted).toEqual([]);
    queue.push(0, 'a');
    expect(emitted).toEqual(['a', 'b']);
  });

  it('drains multiple buffered items once the gap is filled', () => {
    const emitted: number[] = [];
    const queue = createReorderQueue<number>((item) => emitted.push(item));
    queue.push(2, 20);
    queue.push(1, 10);
    queue.push(3, 30);
    expect(emitted).toEqual([]);
    queue.push(0, 0);
    expect(emitted).toEqual([0, 10, 20, 30]);
  });

  it('ignores a stale duplicate seq', () => {
    const emitted: number[] = [];
    const queue = createReorderQueue<number>((item) => emitted.push(item));
    queue.push(0, 1);
    queue.push(0, 999); // duplicate of an already-emitted seq
    expect(emitted).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/asr/reorderQueue.test.ts`
Expected: FAIL — `Cannot find module './reorderQueue'`

- [ ] **Step 3: Write the implementation**

Create `src/asr/reorderQueue.ts`:

```ts
export interface ReorderQueue<T> {
  push(seq: number, item: T): void;
}

// Applies items in strictly increasing seq order (starting at 0), holding
// anything that arrives ahead of its turn until the gap is filled. Each
// chunk sent by useGeminiCapture gets one seq; its Gemini response can come
// back out of order (a later, shorter chunk finishing first), and this is
// what keeps captions appearing in the order they were spoken.
export function createReorderQueue<T>(onInOrder: (item: T) => void): ReorderQueue<T> {
  let nextSeq = 0;
  const pending = new Map<number, T>();

  return {
    push(seq: number, item: T): void {
      if (seq < nextSeq) return; // stale/duplicate — already emitted
      if (seq > nextSeq) {
        pending.set(seq, item);
        return;
      }
      onInOrder(item);
      nextSeq++;
      while (pending.has(nextSeq)) {
        const next = pending.get(nextSeq)!;
        pending.delete(nextSeq);
        onInOrder(next);
        nextSeq++;
      }
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/asr/reorderQueue.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/asr/reorderQueue.ts src/asr/reorderQueue.test.ts
git commit -m "$(cat <<'EOF'
Add reorder queue for out-of-order Gemini chunk responses

Part of the Gemini-only transcription migration — keeps captions applied
in the order they were spoken even when a later chunk's request resolves
before an earlier one's.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Glossary module (client-side storage)

**Files:**
- Create: `src/glossary.ts`
- Test: `src/glossary.test.ts`

**Interfaces:**
- Produces: `GlossarySection` (`'protected_terms' | 'person_names' | 'thai_corrections'`), `GlossarySections` (`Record<GlossarySection, Record<string, string>>`), `GLOSSARY_STORAGE_KEY`, `emptyGlossary(): GlossarySections`, `loadGlossary(): GlossarySections`, `saveGlossary(sections: GlossarySections): void`. Used by: Task 6 (`server/gemini.ts`, type-only import for the request shape), Task 10 (`DictionaryManager.tsx`, replaces its old imports from the now-deleted `../asr/protocol` / `../asr/commands`), and Task 11 (`Admin.tsx`, glossary state + persistence).

- [ ] **Step 1: Write the failing test**

Create `src/glossary.test.ts`. This follows the exact `FakeStorage` pattern already used in `src/hooks/useProjects.test.ts` for tests that touch `localStorage`, because Node's own experimental global `localStorage` shadows jsdom's without behaving like real browser storage.

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyGlossary, GLOSSARY_STORAGE_KEY, loadGlossary, saveGlossary } from './glossary';

class FakeStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { value: new FakeStorage(), configurable: true });
});

describe('loadGlossary', () => {
  it('returns an empty glossary when nothing is stored', () => {
    expect(loadGlossary()).toEqual(emptyGlossary());
  });

  it('round-trips a saved glossary', () => {
    const sections = {
      protected_terms: { ความดันโลหิตสูง: 'hypertension' },
      person_names: {},
      thai_corrections: {}
    };
    saveGlossary(sections);
    expect(loadGlossary()).toEqual(sections);
  });

  it('falls back to empty on corrupt stored JSON', () => {
    localStorage.setItem(GLOSSARY_STORAGE_KEY, '{not json');
    expect(loadGlossary()).toEqual(emptyGlossary());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/glossary.test.ts`
Expected: FAIL — `Cannot find module './glossary'`

- [ ] **Step 3: Write the implementation**

Create `src/glossary.ts`:

```ts
export type GlossarySection = 'protected_terms' | 'person_names' | 'thai_corrections';
export type GlossarySections = Record<GlossarySection, Record<string, string>>;

export const GLOSSARY_STORAGE_KEY = 'ai_translate_glossary';

export function emptyGlossary(): GlossarySections {
  return { protected_terms: {}, person_names: {}, thai_corrections: {} };
}

export function loadGlossary(): GlossarySections {
  try {
    const raw = localStorage.getItem(GLOSSARY_STORAGE_KEY);
    if (!raw) return emptyGlossary();
    const parsed = JSON.parse(raw) as Partial<GlossarySections>;
    return { ...emptyGlossary(), ...parsed };
  } catch {
    return emptyGlossary();
  }
}

export function saveGlossary(sections: GlossarySections): void {
  try {
    localStorage.setItem(GLOSSARY_STORAGE_KEY, JSON.stringify(sections));
  } catch {
    // ignore quota errors, matching useProjects.ts's existing pattern
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/glossary.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/glossary.ts src/glossary.test.ts
git commit -m "$(cat <<'EOF'
Add local glossary storage module

Part of the Gemini-only transcription migration — moves the glossary from
the old backend's shared server file to localStorage, keeping the same
three sections DictionaryManager already understands.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Server Gemini client wrapper

**Files:**
- Create: `server/gemini.ts`
- Test: `server/gemini.test.ts`

**Interfaces:**
- Consumes: `GlossarySections` from `src/glossary.ts` (Task 4).
- Produces: `GenerateContentClient` (the injectable interface: `generateContent(args: { model: string; contents: unknown; config?: unknown }): Promise<{ text: string }>`), `TranscribeChunkInput`, `TranscribeChunkResult`, `TranscriptLine`, `transcribeChunk(client, input, model): Promise<TranscribeChunkResult>`, `summarizeTranscript(client, transcript, model): Promise<string>`. Used by Task 6 (`server/geminiRoutes.ts`) and Task 7 (`server.ts`, which constructs the real `GenerateContentClient` adapter around `@google/genai`).

- [ ] **Step 1: Install the Gemini SDK**

Run: `npm install @google/genai`

- [ ] **Step 2: Write the failing test**

Create `server/gemini.test.ts`. This follows the same dependency-injection style as the existing `server/asrTokenBroker.test.ts` (a fake implementation passed in, no module mocking).

```ts
import { describe, expect, it, vi } from 'vitest';
import { summarizeTranscript, transcribeChunk, type GenerateContentClient } from './gemini';
import { emptyGlossary } from '../src/glossary';

function fakeClient(text: string): { client: GenerateContentClient; calls: unknown[] } {
  const calls: unknown[] = [];
  const client: GenerateContentClient = {
    generateContent: vi.fn(async (args) => {
      calls.push(args);
      return { text };
    })
  };
  return { client, calls };
}

describe('transcribeChunk', () => {
  it('sends the audio as inline base64 data and parses the structured JSON response', async () => {
    const { client, calls } = fakeClient(JSON.stringify({ source_text: 'สวัสดี', target_text: 'Hello' }));
    const result = await transcribeChunk(
      client,
      {
        audio: Buffer.from([1, 2, 3]),
        mimeType: 'audio/wav',
        sourceLang: 'th',
        targetLang: 'en',
        glossary: emptyGlossary(),
        context: ''
      },
      'gemini-test-model'
    );

    expect(result).toEqual({ sourceText: 'สวัสดี', targetText: 'Hello' });
    const args = calls[0] as { model: string; contents: Array<{ parts: Array<Record<string, unknown>> }> };
    expect(args.model).toBe('gemini-test-model');
    expect(args.contents[0].parts[0]).toEqual({
      inlineData: { mimeType: 'audio/wav', data: Buffer.from([1, 2, 3]).toString('base64') }
    });
  });

  it('includes glossary terms and prior context in the prompt text', async () => {
    const { client, calls } = fakeClient(JSON.stringify({ source_text: 'a', target_text: 'b' }));
    await transcribeChunk(
      client,
      {
        audio: Buffer.from([1]),
        mimeType: 'audio/wav',
        sourceLang: 'th',
        targetLang: 'en',
        glossary: { protected_terms: { ความดันโลหิตสูง: 'hypertension' }, person_names: {}, thai_corrections: {} },
        context: 'previous sentence'
      },
      'gemini-test-model'
    );
    const args = calls[0] as { contents: Array<{ parts: Array<{ text?: string }> }> };
    const promptText = args.contents[0].parts[1].text ?? '';
    expect(promptText).toContain('ความดันโลหิตสูง');
    expect(promptText).toContain('hypertension');
    expect(promptText).toContain('previous sentence');
  });

  it('throws when Gemini returns malformed JSON', async () => {
    const { client } = fakeClient('not json');
    await expect(
      transcribeChunk(
        client,
        { audio: Buffer.from([1]), mimeType: 'audio/wav', sourceLang: 'th', targetLang: 'en', glossary: emptyGlossary(), context: '' },
        'model'
      )
    ).rejects.toThrow(/non-JSON/);
  });

  it('throws when a required field is missing from the response', async () => {
    const { client } = fakeClient(JSON.stringify({ source_text: 'only source' }));
    await expect(
      transcribeChunk(
        client,
        { audio: Buffer.from([1]), mimeType: 'audio/wav', sourceLang: 'th', targetLang: 'en', glossary: emptyGlossary(), context: '' },
        'model'
      )
    ).rejects.toThrow(/missing/);
  });
});

describe('summarizeTranscript', () => {
  it('sends a text-only prompt built from the transcript lines', async () => {
    const { client, calls } = fakeClient('Meeting summary text');
    const summary = await summarizeTranscript(
      client,
      [
        { sourceText: 'สวัสดี', targetText: 'Hello' },
        { sourceText: 'ลาก่อน', targetText: 'Goodbye' }
      ],
      'gemini-test-model'
    );

    expect(summary).toBe('Meeting summary text');
    const args = calls[0] as { contents: Array<{ parts: Array<{ text: string }> }> };
    expect(args.contents[0].parts[0].text).toContain('สวัสดี => Hello');
    expect(args.contents[0].parts[0].text).toContain('ลาก่อน => Goodbye');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run server/gemini.test.ts`
Expected: FAIL — `Cannot find module './gemini'`

- [ ] **Step 4: Write the implementation**

Create `server/gemini.ts`:

```ts
import type { GlossarySections } from '../src/glossary';

// Injectable so tests never touch the real network or the @google/genai
// module — server.ts wires the real SDK to this shape (see Task 7).
export interface GenerateContentClient {
  generateContent(args: { model: string; contents: unknown; config?: unknown }): Promise<{ text: string }>;
}

export interface TranscribeChunkInput {
  audio: Buffer;
  mimeType: string;
  sourceLang: string;
  targetLang: string;
  glossary: GlossarySections;
  context: string;
}

export interface TranscribeChunkResult {
  sourceText: string;
  targetText: string;
}

export interface TranscriptLine {
  sourceText: string;
  targetText: string;
}

const LANG_NAMES: Record<string, string> = { th: 'Thai', en: 'English' };

const TRANSCRIBE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    source_text: { type: 'string' },
    target_text: { type: 'string' }
  },
  required: ['source_text', 'target_text']
};

function langName(code: string): string {
  return LANG_NAMES[code] ?? code;
}

function glossaryPromptLines(sections: GlossarySections): string[] {
  const lines: string[] = [];
  const protectedTerms = Object.entries(sections.protected_terms ?? {});
  if (protectedTerms.length > 0) {
    lines.push('Always keep these exact translations for these terms:');
    protectedTerms.forEach(([term, translation]) => lines.push(`- "${term}" -> "${translation}"`));
  }
  const personNames = Object.entries(sections.person_names ?? {});
  if (personNames.length > 0) {
    lines.push('Transliterate these speaker names exactly as given:');
    personNames.forEach(([term, translation]) => lines.push(`- "${term}" -> "${translation}"`));
  }
  const corrections = Object.entries(sections.thai_corrections ?? {});
  if (corrections.length > 0) {
    lines.push('If you hear these commonly mis-heard words, correct them before transcribing:');
    corrections.forEach(([term, correction]) => lines.push(`- "${term}" -> "${correction}"`));
  }
  return lines;
}

function buildTranscribePrompt(input: TranscribeChunkInput): string {
  const lines = [
    `You are transcribing live conference audio spoken in ${langName(input.sourceLang)}.`,
    `Transcribe the audio verbatim in ${langName(input.sourceLang)}, then translate it naturally into ${langName(input.targetLang)}.`,
    'Respond with strict JSON matching the given schema. Do not include any text outside the JSON.'
  ];
  if (input.context.trim()) {
    lines.push(`Previous context, for coherence only — do not repeat it in your output: "${input.context.trim()}"`);
  }
  lines.push(...glossaryPromptLines(input.glossary));
  return lines.join('\n');
}

export async function transcribeChunk(
  client: GenerateContentClient,
  input: TranscribeChunkInput,
  model: string
): Promise<TranscribeChunkResult> {
  const response = await client.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: input.mimeType, data: input.audio.toString('base64') } },
          { text: buildTranscribePrompt(input) }
        ]
      }
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: TRANSCRIBE_RESPONSE_SCHEMA
    }
  });

  let parsed: { source_text?: string; target_text?: string };
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error('Gemini returned a non-JSON transcription response');
  }
  if (!parsed.source_text || !parsed.target_text) {
    throw new Error('Gemini transcription response is missing source_text or target_text');
  }
  return { sourceText: parsed.source_text, targetText: parsed.target_text };
}

export async function summarizeTranscript(
  client: GenerateContentClient,
  transcript: TranscriptLine[],
  model: string
): Promise<string> {
  const lines = transcript.map((line, i) => `[${i + 1}] ${line.sourceText} => ${line.targetText}`);
  const prompt = [
    'Summarize the following conference transcript into a concise set of key points, in the language the transcript is mostly in.',
    'Transcript:',
    ...lines
  ].join('\n');

  const response = await client.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }]
  });
  return response.text.trim();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/gemini.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json server/gemini.ts server/gemini.test.ts
git commit -m "$(cat <<'EOF'
Add server-side Gemini client wrapper

Part of the Gemini-only transcription migration — transcribeChunk() and
summarizeTranscript() wrap @google/genai behind an injectable
GenerateContentClient interface so route handlers (Task 6) and their
tests never touch the real SDK or network.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Server Gemini routes

**Files:**
- Create: `server/geminiRoutes.ts`
- Test: `server/geminiRoutes.test.ts`

**Interfaces:**
- Consumes: `GenerateContentClient`, `transcribeChunk`, `summarizeTranscript`, `TranscriptLine` from `server/gemini.ts` (Task 5); `GlossarySections` from `src/glossary.ts` (Task 4).
- Produces: `GeminiRouteDeps` (`{ client: GenerateContentClient; model: string; summaryModel: string }`), `registerGeminiRoutes(app: Express, deps: GeminiRouteDeps): void`. Used by Task 7 (`server.ts`).
- Route contracts: `POST /api/gemini/transcribe` (multipart: `audio` file field + `meta` JSON field `{sourceLang, targetLang, glossary, context}`) → `{ source_text, target_text, latencyMs }` on success, `400` on a malformed request, `502` on a Gemini failure. `POST /api/gemini/summarize` (JSON body `{ items: Array<{source_text, target_text}> }`) → always `200` with `{ summary, items: <count> }` (empty `summary` on AI failure, never an error status).

- [ ] **Step 1: Install multer**

Run: `npm install multer && npm install --save-dev @types/multer`

- [ ] **Step 2: Write the failing test**

Create `server/geminiRoutes.test.ts`. This starts a real ephemeral HTTP server and drives it with the global `fetch`/`FormData`/`Blob` (available in the Node version this repo already targets), rather than adding a new HTTP-testing dependency.

```ts
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerGeminiRoutes } from './geminiRoutes';
import type { GenerateContentClient } from './gemini';

async function withServer(
  deps: { client: GenerateContentClient; model: string; summaryModel: string },
  run: (baseUrl: string) => Promise<void>
) {
  const app = express();
  app.use(express.json());
  registerGeminiRoutes(app, deps);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function fakeClient(text: string): GenerateContentClient {
  return { generateContent: vi.fn(async () => ({ text })) };
}

describe('POST /api/gemini/transcribe', () => {
  it('transcribes an uploaded audio chunk and returns source/target text', async () => {
    const client = fakeClient(JSON.stringify({ source_text: 'สวัสดี', target_text: 'Hello' }));
    await withServer({ client, model: 'test-model', summaryModel: 'test-model' }, async (baseUrl) => {
      const form = new FormData();
      form.append('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }), 'chunk.wav');
      form.append(
        'meta',
        JSON.stringify({
          sourceLang: 'th',
          targetLang: 'en',
          glossary: { protected_terms: {}, person_names: {}, thai_corrections: {} },
          context: ''
        })
      );

      const res = await fetch(`${baseUrl}/api/gemini/transcribe`, { method: 'POST', body: form });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.source_text).toBe('สวัสดี');
      expect(body.target_text).toBe('Hello');
      expect(typeof body.latencyMs).toBe('number');
    });
  });

  it('rejects a request with no audio file', async () => {
    const client = fakeClient('{}');
    await withServer({ client, model: 'm', summaryModel: 'm' }, async (baseUrl) => {
      const form = new FormData();
      form.append('meta', JSON.stringify({ sourceLang: 'th', targetLang: 'en' }));
      const res = await fetch(`${baseUrl}/api/gemini/transcribe`, { method: 'POST', body: form });
      expect(res.status).toBe(400);
    });
  });

  it('returns 502 when the Gemini call fails', async () => {
    const client: GenerateContentClient = {
      generateContent: vi.fn(async () => {
        throw new Error('quota exceeded');
      })
    };
    await withServer({ client, model: 'm', summaryModel: 'm' }, async (baseUrl) => {
      const form = new FormData();
      form.append('audio', new Blob([new Uint8Array([1])], { type: 'audio/wav' }), 'chunk.wav');
      form.append('meta', JSON.stringify({ sourceLang: 'th', targetLang: 'en' }));
      const res = await fetch(`${baseUrl}/api/gemini/transcribe`, { method: 'POST', body: form });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toContain('quota exceeded');
    });
  });
});

describe('POST /api/gemini/summarize', () => {
  it('returns the summary and item count on success', async () => {
    const client = fakeClient('Meeting went well.');
    await withServer({ client, model: 'm', summaryModel: 'test-model' }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/gemini/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ source_text: 'a', target_text: 'b' }] })
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.summary).toBe('Meeting went well.');
      expect(body.items).toBe(1);
    });
  });

  it('falls back to an empty summary, never losing the item count, when Gemini fails', async () => {
    const client: GenerateContentClient = {
      generateContent: vi.fn(async () => {
        throw new Error('down');
      })
    };
    await withServer({ client, model: 'm', summaryModel: 'm' }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/gemini/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            { source_text: 'a', target_text: 'b' },
            { source_text: 'c', target_text: 'd' }
          ]
        })
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.summary).toBe('');
      expect(body.items).toBe(2);
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run server/geminiRoutes.test.ts`
Expected: FAIL — `Cannot find module './geminiRoutes'`

- [ ] **Step 4: Write the implementation**

Create `server/geminiRoutes.ts`:

```ts
import type { Express, Request, Response } from 'express';
import multer from 'multer';
import { summarizeTranscript, transcribeChunk, type GenerateContentClient, type TranscriptLine } from './gemini';
import type { GlossarySections } from '../src/glossary';

export interface GeminiRouteDeps {
  client: GenerateContentClient;
  model: string;
  summaryModel: string;
}

interface TranscribeMeta {
  sourceLang?: string;
  targetLang?: string;
  glossary?: GlossarySections;
  context?: string;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

export function registerGeminiRoutes(app: Express, deps: GeminiRouteDeps): void {
  app.post('/api/gemini/transcribe', upload.single('audio'), async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'Missing audio file' });
      return;
    }
    let meta: TranscribeMeta;
    try {
      meta = JSON.parse((req.body?.meta as string) ?? '{}');
    } catch {
      res.status(400).json({ error: 'Invalid meta JSON' });
      return;
    }
    if (!meta.sourceLang || !meta.targetLang) {
      res.status(400).json({ error: 'meta.sourceLang and meta.targetLang are required' });
      return;
    }

    const startedAt = Date.now();
    try {
      const result = await transcribeChunk(
        deps.client,
        {
          audio: req.file.buffer,
          mimeType: req.file.mimetype || 'audio/wav',
          sourceLang: meta.sourceLang,
          targetLang: meta.targetLang,
          glossary: meta.glossary ?? { protected_terms: {}, person_names: {}, thai_corrections: {} },
          context: meta.context ?? ''
        },
        deps.model
      );
      res.json({ source_text: result.sourceText, target_text: result.targetText, latencyMs: Date.now() - startedAt });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Gemini transcription failed' });
    }
  });

  app.post('/api/gemini/summarize', async (req: Request, res: Response) => {
    const items = Array.isArray(req.body?.items)
      ? (req.body.items as Array<{ source_text?: string; target_text?: string }>)
      : null;
    if (!items) {
      res.status(400).json({ error: 'Missing items array' });
      return;
    }
    const transcript: TranscriptLine[] = items.map((item) => ({
      sourceText: item.source_text ?? '',
      targetText: item.target_text ?? ''
    }));
    try {
      const summary = await summarizeTranscript(deps.client, transcript, deps.summaryModel);
      res.json({ summary, items: items.length });
    } catch {
      // Fallback contract: an AI failure never loses the transcript —
      // respond with an empty summary and the item count, same as the old
      // backend's Vertex-failure fallback.
      res.json({ summary: '', items: items.length });
    }
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/geminiRoutes.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json server/geminiRoutes.ts server/geminiRoutes.test.ts
git commit -m "$(cat <<'EOF'
Add /api/gemini/transcribe and /api/gemini/summarize routes

Part of the Gemini-only transcription migration. Not yet wired into
server.ts (Task 7) or reachable from the client (Task 9/11).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Wire server.ts — add Gemini routes, remove the ASR token broker

**Files:**
- Modify: `server.ts`
- Delete: `server/asrTokenBroker.ts`, `server/asrTokenBroker.test.ts`
- Modify: `.env`

**Interfaces:**
- Consumes: `registerGeminiRoutes`, `GeminiRouteDeps` from `server/geminiRoutes.ts` (Task 6); `GenerateContentClient` from `server/gemini.ts` (Task 5); `GoogleGenAI` from `@google/genai`.

- [ ] **Step 1: Delete the obsolete token broker**

```bash
rm server/asrTokenBroker.ts server/asrTokenBroker.test.ts
```

- [ ] **Step 2: Replace `server.ts`**

Replace the full contents of `server.ts`:

```ts
import "dotenv/config";
import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { createServer } from "http";
import { GoogleGenAI } from "@google/genai";
import { registerGeminiRoutes } from "./server/geminiRoutes";
import type { GenerateContentClient } from "./server/gemini";

async function startServer() {
  const app = express();
  const PORT = 3000;

  const httpServer = createServer(app);

  // Transcript items for a long session add up; the default 100kb JSON body
  // limit is too small for /api/gemini/summarize's full-transcript payload.
  app.use(express.json({ limit: "5mb" }));

  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    const genAI = new GoogleGenAI({ apiKey });
    const client: GenerateContentClient = {
      generateContent: (args) =>
        genAI.models.generateContent(args as Parameters<typeof genAI.models.generateContent>[0]),
    };
    registerGeminiRoutes(app, {
      client,
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      summaryModel: process.env.GEMINI_SUMMARY_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash",
    });
  } else {
    // No key configured — fail loudly and specifically rather than letting
    // the client's fetch hit a generic 404 with no explanation.
    const unconfigured = (_req: express.Request, res: express.Response) => {
      res.status(503).json({ error: "GEMINI_API_KEY is not configured on the server" });
    };
    app.post("/api/gemini/transcribe", unconfigured);
    app.post("/api/gemini/summarize", unconfigured);
  }

  // API endpoints
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
```

- [ ] **Step 3: Update `.env`**

Replace the `.env` file contents:

```
# GEMINI_API_KEY: Required for Gemini AI API calls.
# AI Studio automatically injects this at runtime from user secrets.
# Users configure this via the Secrets panel in the AI Studio UI.
GEMINI_API_KEY=<your key from the AI Studio Secrets panel>

# APP_URL: The URL where this applet is hosted.
# AI Studio automatically injects this at runtime with the Cloud Run service URL.
# Used for self-referential links, OAuth callbacks, and API endpoints.
APP_URL="MY_APP_URL"

# --- Gemini transcription/translation/summarization ---
# Model used for /api/gemini/transcribe (must support audio input). Override
# here if a better-suited model becomes available without a code change.
GEMINI_MODEL="gemini-2.5-flash"
# Model used for /api/gemini/summarize (text-only). Falls back to
# GEMINI_MODEL above if unset.
# GEMINI_SUMMARY_MODEL="gemini-2.5-flash"
```

- [ ] **Step 4: Run the full test suite to confirm nothing else broke**

Run: `npm test`
Expected: All suites pass except any files that still reference now-deleted client-side modules from earlier in this migration — at this point in the plan (after Task 6), that should be none, since only `server/asrTokenBroker.*` was deleted and nothing else imports it. Confirm with:

Run: `npx vitest run`
Expected: PASS (no failures; `server/asrTokenBroker.test.ts` no longer exists to run)

- [ ] **Step 5: Manual smoke test**

Run: `npm run dev`, then in another terminal:

```bash
curl -s http://localhost:3000/api/health
```

Expected: `{"status":"ok"}`. (Do not smoke-test `/api/gemini/transcribe` yet — nothing sends it real audio until Task 9/11 land; a `GEMINI_API_KEY`-configured server will still accept a POST but there is no client to drive it yet.)

- [ ] **Step 6: Commit**

```bash
git add server.ts .env
git rm server/asrTokenBroker.ts server/asrTokenBroker.test.ts
git commit -m "$(cat <<'EOF'
Wire Gemini routes into server.ts, remove the ASR token broker

server.ts now constructs the real @google/genai client and registers the
transcribe/summarize routes directly. ASR_BACKEND_URL,
VITE_ASR_BACKEND_URL and ASR_OPERATOR_PASSWORD are gone from .env — with
the Gemini key held server-side, there is nothing left for the old
operator-password gate to protect.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Rewrite the captions store for local chunk results

**Files:**
- Modify: `src/asr/captions.ts`
- Modify: `src/asr/captions.test.ts`

**Interfaces:**
- Produces: `Caption` (unchanged shape: `{ seq, sourceText, targetText, sourceLang, targetLang, ts, latencyMs, isEdited }`), `CaptionState`, `initialCaptionState`, `CaptionAction` (now `{kind:'add', seq, sourceText, targetText, sourceLang, targetLang, latencyMs}` | `{kind:'edit', seq, targetText}` | `{kind:'reset'}`), `captionsReducer`, `selectCaptions`. Consumed by Task 9 (the hook dispatches `'add'`) and Task 11 (`Admin.tsx`, unchanged consumption of `selectCaptions`/`Caption`).

> Note: `tsc --noEmit` (the `lint` script) will show errors in `src/pages/Admin.tsx` after this task, because it still dispatches the old `{kind:'frame', frame}` action shape. This is expected and resolved by Task 11 — do not modify `Admin.tsx` in this task.

- [ ] **Step 1: Replace the failing test**

Replace the full contents of `src/asr/captions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { captionsReducer, initialCaptionState, selectCaptions } from './captions';

describe('captionsReducer + selectCaptions', () => {
  it('adds a caption and returns it sorted by seq', () => {
    let state = captionsReducer(initialCaptionState, {
      kind: 'add',
      seq: 1,
      sourceText: 'b',
      targetText: 'B',
      sourceLang: 'th',
      targetLang: 'en',
      latencyMs: 100
    });
    state = captionsReducer(state, {
      kind: 'add',
      seq: 0,
      sourceText: 'a',
      targetText: 'A',
      sourceLang: 'th',
      targetLang: 'en',
      latencyMs: 50
    });

    const captions = selectCaptions(state);
    expect(captions.map((c) => c.seq)).toEqual([0, 1]);
    expect(captions[0]).toMatchObject({ sourceText: 'a', targetText: 'A', latencyMs: 50, isEdited: false });
  });

  it('lets an edit override the target text without touching the source', () => {
    let state = captionsReducer(initialCaptionState, {
      kind: 'add',
      seq: 0,
      sourceText: 'a',
      targetText: 'A',
      sourceLang: 'th',
      targetLang: 'en',
      latencyMs: 50
    });
    state = captionsReducer(state, { kind: 'edit', seq: 0, targetText: 'A (corrected)' });

    const [caption] = selectCaptions(state);
    expect(caption.sourceText).toBe('a');
    expect(caption.targetText).toBe('A (corrected)');
    expect(caption.isEdited).toBe(true);
  });

  it('reset clears everything back to the initial state', () => {
    let state = captionsReducer(initialCaptionState, {
      kind: 'add',
      seq: 0,
      sourceText: 'a',
      targetText: 'A',
      sourceLang: 'th',
      targetLang: 'en',
      latencyMs: 50
    });
    state = captionsReducer(state, { kind: 'reset' });
    expect(state).toEqual(initialCaptionState);
    expect(selectCaptions(state)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails against the current implementation**

Run: `npx vitest run src/asr/captions.test.ts`
Expected: FAIL — the current `captionsReducer` only understands `{kind:'frame'|'edit'|'reset'}`, so the `'add'` actions above are type/behavior mismatches (dispatch falls through without adding anything).

- [ ] **Step 3: Replace the implementation**

Replace the full contents of `src/asr/captions.ts`:

```ts
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

interface StoredCaption {
  sourceText: string;
  targetText: string;
  sourceLang: string;
  targetLang: string;
  ts: number;
  latencyMs: number;
}

export interface CaptionState {
  items: Record<number, StoredCaption>;
  edits: Record<number, string>;
}

export const initialCaptionState: CaptionState = { items: {}, edits: {} };

export type CaptionAction =
  | { kind: 'add'; seq: number; sourceText: string; targetText: string; sourceLang: string; targetLang: string; latencyMs: number }
  | { kind: 'edit'; seq: number; targetText: string }
  | { kind: 'reset' };

export function captionsReducer(state: CaptionState, action: CaptionAction): CaptionState {
  if (action.kind === 'reset') return initialCaptionState;

  if (action.kind === 'edit') {
    return { ...state, edits: { ...state.edits, [action.seq]: action.targetText } };
  }

  return {
    ...state,
    items: {
      ...state.items,
      [action.seq]: {
        sourceText: action.sourceText,
        targetText: action.targetText,
        sourceLang: action.sourceLang,
        targetLang: action.targetLang,
        ts: Date.now() / 1000,
        latencyMs: action.latencyMs
      }
    }
  };
}

export function selectCaptions(state: CaptionState): Caption[] {
  return Object.keys(state.items)
    .map(Number)
    .sort((a, b) => a - b)
    .map((seq) => {
      const item = state.items[seq];
      const edit = state.edits[seq];
      return {
        seq,
        sourceText: item.sourceText,
        // An operator edit outranks whatever Gemini returned — the
        // alternative, losing a correction the operator just typed, is what
        // makes people stop trusting the edit button.
        targetText: edit ?? item.targetText,
        sourceLang: item.sourceLang,
        targetLang: item.targetLang,
        ts: item.ts,
        latencyMs: item.latencyMs,
        isEdited: edit !== undefined
      };
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/asr/captions.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/asr/captions.ts src/asr/captions.test.ts
git commit -m "$(cat <<'EOF'
Replace frame-based caption reducer with a local-append reducer

Part of the Gemini-only transcription migration. The Caption/output shape
is unchanged; only how entries are added changes, from folding wire
protocol frames to appending a Gemini chunk result directly. Admin.tsx
still dispatches the old 'frame' action shape until Task 11 rewrites it —
expected, tracked in that task.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: New capture hook — `useGeminiCapture`

**Files:**
- Create: `src/asr/audio/useGeminiCapture.ts`

**Interfaces:**
- Consumes: `createChunker`, `Chunker` from `src/asr/audio/chunker.ts` (Task 2); `encodeWavBuffer` from `src/asr/audio/wav.ts` (Task 1); `createReorderQueue` from `src/asr/reorderQueue.ts` (Task 3); `FRAME_SAMPLES`, `SAMPLE_RATE`, `WORKLET_SRC` from `src/asr/audio/pcm.ts` (unchanged); `GlossarySections` from `src/glossary.ts` (Task 4).
- Produces: `CaptionResult` (`{seq, sourceText, targetText, sourceLang, targetLang, latencyMs}`), `GeminiCaptureState` (`{status: 'idle'|'starting'|'listening'|'error', error: string|null, lastChunkError: string|null}`), `useGeminiCapture(opts): GeminiCaptureState & {flush: () => Promise<void>}`. Used by Task 11 (`Admin.tsx`), replacing `useAudioCapture`.

> No dedicated test file for this task, matching this repo's existing convention: `src/asr/audio/useAudioCapture.ts` (the file this replaces) has no test file either — it's a browser-only side-effecting hook (mic access, `AudioContext`, `AudioWorklet`) that isn't practical to unit test, and is instead covered by the manual verification in Task 14. Its pure logic (chunk-cutting, WAV encoding, reordering) is already covered by Tasks 1-3's unit tests.

- [ ] **Step 1: Write the implementation**

Create `src/asr/audio/useGeminiCapture.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GlossarySections } from '../../glossary';
import { createChunker, type Chunker } from './chunker';
import { encodeWavBuffer } from './wav';
import { createReorderQueue } from '../reorderQueue';
import { FRAME_SAMPLES, SAMPLE_RATE, WORKLET_SRC } from './pcm';

export interface CaptionResult {
  seq: number;
  sourceText: string;
  targetText: string;
  sourceLang: string;
  targetLang: string;
  latencyMs: number;
}

export interface GeminiCaptureState {
  status: 'idle' | 'starting' | 'listening' | 'error';
  /** Fatal, session-ending error (mic/device/permission). */
  error: string | null;
  /** Most recent non-fatal per-chunk send/response failure, or null. One
   *  failed chunk does not end the session — capture keeps listening. */
  lastChunkError: string | null;
}

interface TranscribeResponseBody {
  source_text?: string;
  target_text?: string;
  latencyMs?: number;
  error?: string;
}

export function useGeminiCapture(opts: {
  active: boolean;
  paused: boolean;
  sourceLang: string;
  targetLang: string;
  glossary: GlossarySections;
  context: string;
  onResult: (result: CaptionResult) => void;
  deviceId?: string;
}): GeminiCaptureState & { flush: () => Promise<void> } {
  const { active, deviceId } = opts;
  const [state, setState] = useState<GeminiCaptureState>({ status: 'idle', error: null, lastChunkError: null });

  // Latest-value refs for everything a chunk send needs but that must NOT
  // tear down and restart the mic when it changes — mirrors the onFrameRef
  // pattern the old control-socket hook (useAsrSocket.ts) used.
  const pausedRef = useRef(opts.paused);
  pausedRef.current = opts.paused;
  const sourceLangRef = useRef(opts.sourceLang);
  sourceLangRef.current = opts.sourceLang;
  const targetLangRef = useRef(opts.targetLang);
  targetLangRef.current = opts.targetLang;
  const glossaryRef = useRef(opts.glossary);
  glossaryRef.current = opts.glossary;
  const contextRef = useRef(opts.context);
  contextRef.current = opts.context;
  const onResultRef = useRef(opts.onResult);
  onResultRef.current = opts.onResult;

  // Set by the effect below to whatever function can force-flush the
  // in-progress chunk right now; read by the stable flush() this hook
  // returns, so callers get one stable identity across renders.
  const flushImplRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    if (!active) {
      setState({ status: 'idle', error: null, lastChunkError: null });
      flushImplRef.current = async () => undefined;
      return;
    }

    let disposed = false;
    let aborted = false;
    let stream: MediaStream | null = null;
    let track: MediaStreamTrack | null = null;
    let ctx: AudioContext | null = null;
    let framerNode: AudioWorkletNode | null = null;
    let micNode: MediaStreamAudioSourceNode | null = null;
    let sinkNode: GainNode | null = null;

    let seqCounter = 0;
    let chunker: Chunker | null = null;
    const reorder = createReorderQueue<CaptionResult | null>((result) => {
      if (result) onResultRef.current(result);
    });

    const teardown = () => {
      track?.removeEventListener('ended', onDeviceLost);
      if (framerNode) {
        framerNode.port.onmessage = null;
        framerNode.port.close();
        framerNode.disconnect();
      }
      micNode?.disconnect();
      sinkNode?.disconnect();
      stream?.getTracks().forEach((t) => t.stop());
      if (ctx && ctx.state !== 'closed') {
        void ctx.close();
      }
    };

    const fail = (message: string) => {
      teardown();
      if (disposed || aborted) return;
      aborted = true;
      setState((s) => ({ ...s, status: 'error', error: message }));
    };

    const onDeviceLost = () => {
      fail(
        'ไมโครโฟนถูกตัดการเชื่อมต่อหรือถูกใช้งานโดยแอปพลิเคชันอื่น — ไม่มีเสียงถูกส่งเข้าเซสชันนี้แล้ว (the microphone was disconnected or taken by another application)'
      );
    };

    const sendChunk = async (samples: Int16Array) => {
      const seq = seqCounter++;
      const sourceLang = sourceLangRef.current;
      const targetLang = targetLangRef.current;
      const startedAt = Date.now();
      try {
        const wav = encodeWavBuffer(samples, SAMPLE_RATE);
        const form = new FormData();
        form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav');
        form.append(
          'meta',
          JSON.stringify({
            sourceLang,
            targetLang,
            glossary: glossaryRef.current,
            context: contextRef.current
          })
        );
        const res = await fetch('/api/gemini/transcribe', { method: 'POST', body: form });
        const body = (await res.json()) as TranscribeResponseBody;
        if (!res.ok || !body.source_text || !body.target_text) {
          throw new Error(body.error || `Gemini transcription failed (HTTP ${res.status})`);
        }
        if (disposed) return;
        setState((s) => ({ ...s, lastChunkError: null }));
        reorder.push(seq, {
          seq,
          sourceText: body.source_text,
          targetText: body.target_text,
          sourceLang,
          targetLang,
          latencyMs: body.latencyMs ?? Date.now() - startedAt
        });
      } catch (err) {
        if (disposed) return;
        // One failed chunk does not end the session — drop it and keep
        // listening, the same philosophy the old backend's backpressure
        // handling used for a dropped audio frame.
        setState((s) => ({
          ...s,
          lastChunkError: err instanceof Error ? err.message : 'ส่งเสียงไปยัง Gemini ไม่สำเร็จ'
        }));
        reorder.push(seq, null);
      }
    };

    const start = async () => {
      setState({ status: 'starting', error: null, lastChunkError: null });

      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        fail('ต้องเปิดหน้านี้ผ่าน HTTPS หรือ localhost จึงจะใช้ไมโครโฟนได้ (microphone needs a secure context)');
        return;
      }

      // No backend audio-processing chain to fight anymore — unlike the old
      // useAudioCapture.ts, the browser's own echo/noise/gain cleanup stays
      // on.
      const constraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      };

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { ...constraints, deviceId: { exact: deviceId } } : constraints
        });
      } catch {
        fail('เปิดไมโครโฟนไม่สำเร็จ — ตรวจสอบสิทธิ์และอุปกรณ์ (could not open the microphone)');
        return;
      }
      if (disposed || aborted) {
        teardown();
        return;
      }

      track = stream.getAudioTracks()[0] ?? null;
      track?.addEventListener('ended', onDeviceLost);

      ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      if (ctx.sampleRate !== SAMPLE_RATE) {
        fail(`เบราว์เซอร์ใช้ sample rate ${ctx.sampleRate} Hz แทน 16000 Hz — ใช้ส่งเสียงไม่ได้`);
        return;
      }
      await ctx.resume();
      if (disposed || aborted) {
        teardown();
        return;
      }

      const blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(blobUrl);
      } catch {
        fail('โหลดตัวประมวลผลเสียงไม่สำเร็จ (audio worklet failed to load)');
        return;
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      if (disposed || aborted) {
        teardown();
        return;
      }

      chunker = createChunker({ sampleRate: SAMPLE_RATE });

      framerNode = new AudioWorkletNode(ctx, 'pcm-framer', {
        numberOfOutputs: 1,
        channelCountMode: 'explicit',
        channelCount: 1,
        processorOptions: { frameSamples: FRAME_SAMPLES }
      });

      framerNode.port.onmessage = (event: MessageEvent<Int16Array>) => {
        if (pausedRef.current || !chunker) return;
        const finished = chunker.pushFrame(event.data);
        if (finished) void sendChunk(finished);
      };

      micNode = ctx.createMediaStreamSource(stream);
      micNode.connect(framerNode);
      // A worklet that reaches no destination is not guaranteed to be pulled
      // by the rendering graph, so it needs a sink — at gain 0.
      sinkNode = ctx.createGain();
      sinkNode.gain.value = 0;
      framerNode.connect(sinkNode).connect(ctx.destination);

      flushImplRef.current = async () => {
        const remaining = chunker?.flush();
        if (remaining) await sendChunk(remaining);
      };

      setState((s) => ({ ...s, status: 'listening' }));
    };

    start().catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      fail(`เกิดข้อผิดพลาดที่ไม่คาดคิดขณะเริ่มรับเสียง (unexpected error starting audio capture: ${detail})`);
    });

    return () => {
      disposed = true;
      flushImplRef.current = async () => undefined;
      teardown();
    };
  }, [active, deviceId]);

  const flush = useCallback(() => flushImplRef.current(), []);

  return { ...state, flush };
}
```

- [ ] **Step 2: Type-check this file in isolation**

Run: `npx tsc --noEmit`
Expected: No errors reported for `src/asr/audio/useGeminiCapture.ts` itself. (The overall `tsc` run may still show pre-existing errors in `src/pages/Admin.tsx`, per Task 8's note — those are resolved in Task 11.)

- [ ] **Step 3: Commit**

```bash
git add src/asr/audio/useGeminiCapture.ts
git commit -m "$(cat <<'EOF'
Add useGeminiCapture hook

Part of the Gemini-only transcription migration. Replaces
useAudioCapture.ts's WebSocket-based streaming with: mic -> AudioWorklet
PCM framer -> chunker (Task 2) -> WAV-encode (Task 1) -> POST to
/api/gemini/transcribe -> reorder queue (Task 3) -> onResult callback.
Not yet wired into Admin.tsx (Task 11) or removed as a replacement for
useAudioCapture.ts (Task 12).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Update `DictionaryManager.tsx` for local glossary storage

**Files:**
- Modify: `src/components/DictionaryManager.tsx`

**Interfaces:**
- Consumes: `GlossarySection`, `GlossarySections` from `src/glossary.ts` (Task 4), replacing the old imports from the (now-deleted-in-Task-12) `../asr/protocol` and `../asr/commands`.
- Produces: `DictionaryManagerProps` now has no `onReload` field. Consumed by Task 11 (`Admin.tsx`).

- [ ] **Step 1: Update the imports**

In `src/components/DictionaryManager.tsx`, replace:

```ts
import type { GlossarySections } from '../asr/protocol';
import type { GlossarySection } from '../asr/commands';
```

with:

```ts
import type { GlossarySection, GlossarySections } from '../glossary';
```

- [ ] **Step 2: Drop the `onReload` prop**

Replace:

```tsx
export interface DictionaryManagerProps {
  sections: GlossarySections | null;
  onAdd: (section: GlossarySection, abbr: string, full: string) => void;
  onRemove: (section: GlossarySection, abbr: string) => void;
  onReload: () => void;
  disabled: boolean;
}

export default function DictionaryManager({ sections, onAdd, onRemove, onReload, disabled }: DictionaryManagerProps) {
```

with:

```tsx
export interface DictionaryManagerProps {
  sections: GlossarySections | null;
  onAdd: (section: GlossarySection, abbr: string, full: string) => void;
  onRemove: (section: GlossarySection, abbr: string) => void;
  disabled: boolean;
}

export default function DictionaryManager({ sections, onAdd, onRemove, disabled }: DictionaryManagerProps) {
```

- [ ] **Step 3: Correct the shared-glossary warning text**

The old text claimed the glossary is a file "shared by every session on the server" — that's no longer true (it's `localStorage`, per-browser). Replace:

```tsx
      {/* The glossary is process-wide on the backend: one file shared by
          every live session. A console that implied otherwise would let one
          operator silently change another venue's event. */}
      <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-xs leading-relaxed">
        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
        <span>พจนานุกรมนี้ใช้ร่วมกันทุกเซสชันบนเซิร์ฟเวอร์ การแก้ไขจะมีผลกับทุกงานที่กำลังถ่ายทอดสดอยู่ในขณะนี้</span>
      </div>
```

with:

```tsx
      {/* The glossary is stored locally in this browser and shared by every
          session started from it — there is no server file anymore. */}
      <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-xs leading-relaxed">
        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
        <span>พจนานุกรมนี้บันทึกไว้ในเบราว์เซอร์นี้ และใช้ร่วมกันทุก session ที่เริ่มจากเบราว์เซอร์นี้</span>
      </div>
```

- [ ] **Step 4: Remove the reload button**

Replace:

```tsx
      <button
        type="button"
        onClick={onReload}
        disabled={disabled}
        className="w-full py-1.5 text-[11px] text-slate-500 hover:text-slate-800 font-medium disabled:opacity-40"
      >
        โหลดพจนานุกรมใหม่จากไฟล์บนเซิร์ฟเวอร์
      </button>

      {/* Paste-from-Excel modal */}
```

with:

```tsx
      {/* Paste-from-Excel modal */}
```

- [ ] **Step 5: Type-check this file**

Run: `npx tsc --noEmit`
Expected: No new errors introduced by this file. (`src/pages/Admin.tsx` will show an error about the now-removed `onReload` prop it still passes — expected, resolved in Task 11.)

- [ ] **Step 6: Commit**

```bash
git add src/components/DictionaryManager.tsx
git commit -m "$(cat <<'EOF'
Update DictionaryManager for local glossary storage

Part of the Gemini-only transcription migration. Types now come from
src/glossary.ts instead of the deleted-in-Task-12 protocol/commands
modules. Drops the "reload from server file" button (no server file
exists anymore) and corrects the shared-glossary warning text to
describe local, per-browser storage instead of a shared server file.
Admin.tsx still passes an onReload prop until Task 11 — expected,
tracked in that task.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Rewrite `Admin.tsx`

**Files:**
- Modify: `src/pages/Admin.tsx`

**Interfaces:**
- Consumes: `captionsReducer`, `initialCaptionState`, `selectCaptions`, `Caption` from `src/asr/captions.ts` (Task 8); `useGeminiCapture`, `CaptionResult` from `src/asr/audio/useGeminiCapture.ts` (Task 9); `loadGlossary`, `saveGlossary`, `GlossarySection`, `GlossarySections` from `src/glossary.ts` (Task 4); `DictionaryManager` (Task 10, no `onReload` prop); `useProjects` (unchanged); `ProjectPanel.tsx` exports (unchanged).

This is a full replacement of the file — the data/session plumbing changes throughout, while the JSX layout, styling, and every feature not tied to the old backend stay the same (subtitle box, font-size/show-original/show-latency settings, edit/copy/hide per caption, TXT/SRT export, project picker/history/bill modal, session history modal, dictionary manager UI). The specific, approved departures from current behavior are the ones listed in the design spec's §7 (header subtitle text, "Ping" now measures `/api/health` round-trip instead of a control-socket heartbeat, the dictionary reload button gone (Task 10), no live word-by-word interim text, no "restarts listening ~1s" notice, no multi-tab session picker/health-poll/`recognizer_alive` banners).

- [ ] **Step 1: Replace the full contents of `src/pages/Admin.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Mic,
  MicOff,
  Languages,
  BookOpen,
  Copy,
  Check,
  Download,
  Trash2,
  Sparkles,
  Zap,
  Activity,
  Edit2,
  Radio,
  Menu,
  ShieldAlert,
  FileText,
  ArrowLeftRight,
  Pause,
  Play,
  ClipboardList,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
// ProjectPanel.tsx has NO default export — it exports five named components.
import { BillModal, HistoryPanel, ProjectHeaderBar, ProjectPicker, SessionHistoryModal } from '../components/ProjectPanel';
import DictionaryManager from '../components/DictionaryManager';
import { captionsReducer, initialCaptionState, selectCaptions, type Caption } from '../asr/captions';
import { useGeminiCapture, type CaptionResult } from '../asr/audio/useGeminiCapture';
import { useProjects } from '../hooks/useProjects';
import { loadGlossary, saveGlossary, type GlossarySection, type GlossarySections } from '../glossary';
import type { DisplayConfig, Project } from '../types';

const PING_INTERVAL_MS = 3000;
// Bounded wait for the end-of-session summary before giving up and showing
// the "AI summary failed" fallback — keeps ending a session from hanging on
// a stuck Gemini call.
const REPORT_WAIT_TIMEOUT_MS = 20000;

// Only the pair this console supports. Anything else is not a language
// Gemini is instructed to expect.
const LANGS: Record<'th' | 'en', string> = { th: 'ไทย (Thai)', en: 'อังกฤษ (English)' };
const other = (lang: string) => (lang === 'th' ? 'en' : 'th');

interface ReportResult {
  summary: string;
  items: number;
}

function formatSrtTime(ms: number): string {
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  const msPart = String(Math.floor(ms % 1000)).padStart(3, '0');
  return `${h}:${m}:${s},${msPart}`;
}

function textSizeClass(size: DisplayConfig['fontSize']): string {
  switch (size) {
    case 'small':
      return 'text-sm sm:text-base';
    case 'medium':
      return 'text-base sm:text-lg';
    case 'xlarge':
      return 'text-xl sm:text-2xl';
    case 'large':
    default:
      return 'text-lg sm:text-xl';
  }
}

// The live subtitle box is the thing an operator will OBS-crop for
// streaming, so it reads a size tier larger than the history list.
function boxTextSizeClass(size: DisplayConfig['fontSize']): string {
  switch (size) {
    case 'small':
      return 'text-2xl sm:text-3xl';
    case 'medium':
      return 'text-3xl sm:text-4xl';
    case 'xlarge':
      return 'text-5xl sm:text-6xl';
    case 'large':
    default:
      return 'text-4xl sm:text-5xl';
  }
}

export default function Admin() {
  const projects = useProjects();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [micActive, setMicActive] = useState(false);
  const [sourceLang, setSourceLangState] = useState<'th' | 'en'>('th');
  const [targetLang, setTargetLangState] = useState<'th' | 'en'>('en');
  const [paused, setPaused] = useState(false);
  const [glossary, setGlossary] = useState<GlossarySections>(() => loadGlossary());
  const [report, setReport] = useState<ReportResult | null>(null);
  const [pingMs, setPingMs] = useState<number | null>(null);

  const [config, setConfig] = useState<DisplayConfig>({ fontSize: 'large', showOriginal: false, showLatency: false });
  const [activeTab, setActiveTab] = useState<'languages' | 'dictionary'>('languages');
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showSessionHistory, setShowSessionHistory] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [finishedProject, setFinishedProject] = useState<Project | null>(null);

  // Captions have no "delete" concept anymore (there is no server to delete
  // them from) — "delete" stays a local-only hide so an operator can tidy
  // the visible history without losing anything from the export.
  const [hiddenSeqs, setHiddenSeqs] = useState<Set<number>>(new Set());
  const [editingSeq, setEditingSeq] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [copiedSeq, setCopiedSeq] = useState<number | null>(null);

  const [captionState, dispatchCaption] = useReducer(captionsReducer, initialCaptionState);
  const allCaptions = useMemo(() => selectCaptions(captionState), [captionState]);
  const captions = useMemo(() => allCaptions.filter((c) => !hiddenSeqs.has(c.seq)), [allCaptions, hiddenSeqs]);

  const transcriptScrollRef = useRef<HTMLDivElement>(null);

  // ── Gemini capture result → captions ─────────────────────────────────────
  const handleCaptureResult = useCallback((result: CaptionResult) => {
    dispatchCaption({
      kind: 'add',
      seq: result.seq,
      sourceText: result.sourceText,
      targetText: result.targetText,
      sourceLang: result.sourceLang,
      targetLang: result.targetLang,
      latencyMs: result.latencyMs
    });
  }, []);

  // Last 1-2 captions, handed to each new chunk as coherence context so a
  // chunk boundary landing mid-sentence doesn't translate in a vacuum.
  const contextText = useMemo(
    () =>
      allCaptions
        .slice(-2)
        .map((c) => `${c.sourceText} => ${c.targetText}`)
        .join(' / '),
    [allCaptions]
  );

  const capture = useGeminiCapture({
    active: micActive,
    paused,
    sourceLang,
    targetLang,
    glossary,
    context: contextText,
    onResult: handleCaptureResult
  });

  // ── "Ping" — round-trip time of our own server's /api/health, not a
  //    control-socket heartbeat (there is no persistent socket anymore) ─────
  useEffect(() => {
    if (!sessionId || !micActive) {
      setPingMs(null);
      return;
    }
    let cancelled = false;
    const timer = setInterval(async () => {
      const startedAt = Date.now();
      try {
        const res = await fetch('/api/health', { signal: AbortSignal.timeout(4000) });
        if (!res.ok) throw new Error('unhealthy');
        if (!cancelled) setPingMs(Date.now() - startedAt);
      } catch {
        if (!cancelled) setPingMs(null);
      }
    }, PING_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, micActive]);

  // ── Session + mic as one combined "Session" toggle, matching the original
  //    single Start/Stop button ─────────────────────────────────────────────
  const [endingSession, setEndingSession] = useState(false);

  const startSessionAndMic = () => {
    if (micActive) return;
    const id = `local_${Date.now()}`;
    setSessionId(id);
    dispatchCaption({ kind: 'reset' });
    setHiddenSeqs(new Set());
    setReport(null);
    projects.attachAsrSession(id, sourceLang, targetLang);
    setMicActive(true);
  };

  // Ending the session flushes whatever audio is still buffered (so the
  // last few words of a sentence aren't lost), then asks Gemini for a
  // summary of the whole transcript before letting go of the session id.
  const stopSessionAndMic = async () => {
    await capture.flush();
    setMicActive(false);
    if (sessionId) {
      setEndingSession(true);
      const items = allCaptions.map((c) => ({ source_text: c.sourceText, target_text: c.targetText }));
      try {
        const res = await fetch('/api/gemini/summarize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
          signal: AbortSignal.timeout(REPORT_WAIT_TIMEOUT_MS)
        });
        const data = (await res.json()) as { summary?: string; items?: number };
        const summary = data.summary ?? '';
        const itemCount = data.items ?? items.length;
        setReport({ summary, items: itemCount });
        projects.saveSessionSummary(sessionId, summary, itemCount);
      } catch {
        // Same fallback contract as the old backend: an AI failure never
        // loses the transcript, it just ships without a summary.
        setReport({ summary: '', items: items.length });
        projects.saveSessionSummary(sessionId, '', items.length);
      }
      setEndingSession(false);
    }
    setSessionId(null);
    setPaused(false);
    projects.detachAsrSession();
  };

  const isSessionActive = !!sessionId && micActive;

  const handleRequestFinishProject = async () => {
    await stopSessionAndMic();
    const finished = projects.finishProject(allCaptions);
    dispatchCaption({ kind: 'reset' });
    setHiddenSeqs(new Set());
    if (finished) setFinishedProject(finished);
  };

  const handleSwitchProject = () => {
    if (projects.activeSession) return; // one microphone, one live buffer
    projects.clearSelection();
  };

  // ── Language swap ────────────────────────────────────────────────────────
  const setLanguage = (source: 'th' | 'en') => {
    setSourceLangState(source);
    setTargetLangState(other(source) as 'th' | 'en');
  };

  const handleSwapLanguages = () => setLanguage(targetLang);

  // ── Glossary ──────────────────────────────────────────────────────────────
  const persistGlossary = (next: GlossarySections) => {
    setGlossary(next);
    saveGlossary(next);
  };

  const handleGlossaryAdd = (section: GlossarySection, term: string, equivalent: string) => {
    persistGlossary({ ...glossary, [section]: { ...glossary[section], [term]: equivalent } });
  };

  const handleGlossaryRemove = (section: GlossarySection, term: string) => {
    const next = { ...glossary[section] };
    delete next[term];
    persistGlossary({ ...glossary, [section]: next });
  };

  // ── Caption item actions ─────────────────────────────────────────────────
  const handleCopyItem = (item: Caption) => {
    navigator.clipboard.writeText(`${item.sourceText}\n${item.targetText}`);
    setCopiedSeq(item.seq);
    setTimeout(() => setCopiedSeq(null), 1500);
  };

  const startEditing = (item: Caption) => {
    setEditingSeq(item.seq);
    setEditDraft(item.targetText);
  };

  const saveEdit = () => {
    if (editingSeq === null) return;
    dispatchCaption({ kind: 'edit', seq: editingSeq, targetText: editDraft.trim() });
    setEditingSeq(null);
  };

  const hideItem = (seq: number) => {
    setHiddenSeqs((prev) => new Set(prev).add(seq));
  };

  const clearTranscripts = () => {
    if (window.confirm('ล้างประวัติการแปลทั้งหมด?')) {
      dispatchCaption({ kind: 'reset' });
      setHiddenSeqs(new Set());
    }
  };

  // Auto-scroll the feed as new captions arrive, unless the operator is
  // actively editing one (a scroll jump under an open editor is disorienting).
  useEffect(() => {
    if (editingSeq !== null) return;
    const el = transcriptScrollRef.current;
    if (!el) return;
    const id = setTimeout(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }), 80);
    return () => clearTimeout(id);
  }, [captions.length, editingSeq]);

  // ── Export ───────────────────────────────────────────────────────────────
  const exportTranscript = (type: 'txt' | 'srt') => {
    if (captions.length === 0) return;
    const dateStr = new Date().toISOString().slice(0, 10);
    let content = '';

    if (type === 'txt') {
      content = `=== Live Translation Transcript (${dateStr}) ===\n${sourceLang} -> ${targetLang}\n\n`;
      content += captions
        .map(
          (c, i) =>
            `[${i + 1}] ${new Date(c.ts * 1000).toLocaleTimeString()}${c.isEdited ? ' (edited)' : ''} [${c.latencyMs || '-'}ms]\nOriginal: ${c.sourceText}\nTranslated: ${c.targetText}\n`
        )
        .join('\n');
    } else {
      const startBase = captions[0].ts * 1000;
      content = captions
        .map((c, idx) => {
          const startTime = Math.max(0, c.ts * 1000 - startBase);
          const endTime = startTime + 3500;
          return `${idx + 1}\n${formatSrtTime(startTime)} --> ${formatSrtTime(endTime)}\n${c.targetText}\n`;
        })
        .join('\n');
    }

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript_${dateStr}.${type}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isListening = capture.status === 'listening';
  const micPermissionError = capture.status === 'error';

  // The live subtitle box always shows ONE caption at a time — the latest —
  // like a YouTube subtitle, so an operator can crop just this box in OBS
  // for streaming.
  const latestCaption = captions.length > 0 ? captions[captions.length - 1] : null;
  const boxSourceText = latestCaption?.sourceText || '';
  const boxTargetText = latestCaption?.targetText ?? '';
  const isEditingBox = editingSeq !== null && editingSeq === latestCaption?.seq;

  // ── No project selected: the picker is the whole screen, as it always was ──
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
        {finishedProject && <BillModal project={finishedProject} onClose={() => setFinishedProject(null)} />}
      </>
    );
  }

  return (
    <div className="flex flex-col h-screen w-full bg-slate-100 text-slate-800 font-sans overflow-hidden">
      {showHistory && <HistoryPanel projects={projects.endedProjects} onClose={() => setShowHistory(false)} />}
      {finishedProject && <BillModal project={finishedProject} onClose={() => setFinishedProject(null)} />}
      {showSessionHistory && (
        <SessionHistoryModal project={projects.currentProject} onClose={() => setShowSessionHistory(false)} />
      )}

      {/* ─────────────────────────────────────────────────────────────
          TOP CONTROL & METRICS BAR
      ────────────────────────────────────────────────────────────── */}
      <header className="h-15 bg-white border-b border-slate-200 px-3 sm:px-6 flex items-center justify-between shrink-0 z-30 shadow-xs">
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => setMobileSettingsOpen(!mobileSettingsOpen)}
            className="lg:hidden p-2 text-slate-600 hover:bg-slate-100 rounded-lg"
            title="เปิดเมนูตั้งค่า"
          >
            <Menu className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-2.5">
            <div className="w-8.5 h-8.5 rounded-lg bg-[#DE5C8E] flex items-center justify-center text-white shadow-xs">
              <Sparkles className="w-4.5 h-4.5" />
            </div>
            <div className="flex flex-col">
              <span className="font-bold text-sm text-slate-900 tracking-tight leading-none">AI Live Translator</span>
              <span className="text-[11px] text-slate-400 font-medium leading-tight mt-0.5">Powered by Google Gemini</span>
            </div>
          </div>

          <div className="hidden sm:flex items-center gap-1.5">
            <ProjectHeaderBar
              project={projects.currentProject}
              activeSession={projects.activeSession}
              onRequestFinish={handleRequestFinishProject}
              onSwitchProject={handleSwitchProject}
              onOpenHistory={() => setShowHistory(true)}
            />
            <button
              type="button"
              onClick={() => setShowSessionHistory(true)}
              className="p-1.5 text-slate-400 hover:text-[#DE5C8E] rounded-full hover:bg-slate-100 transition-all shrink-0"
              title="ดู session และสรุปการประชุมย้อนหลังในโปรเจกต์นี้"
            >
              <ClipboardList className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <div
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
              isSessionActive
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-300 ring-2 ring-emerald-100'
                : 'bg-slate-100 text-slate-500 border border-slate-200'
            }`}
          >
            {isSessionActive ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                <span className="tracking-wider text-[11px] font-bold uppercase whitespace-nowrap">
                  {paused ? 'พักการถอดความ' : 'กำลังแปลสด'}
                </span>
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-slate-400" />
                <span className="text-[11px] whitespace-nowrap">พร้อมใช้งาน</span>
              </>
            )}
          </div>

          <div className="hidden md:flex items-center gap-2 bg-slate-100 px-3 py-1.5 rounded-full text-[11px] font-mono border border-slate-200">
            <Zap className={`w-3.5 h-3.5 ${isSessionActive ? 'text-amber-500' : 'text-slate-400'}`} />
            <span className="text-slate-500">Latency:</span>
            <span className="font-semibold text-slate-800">{captions.at(-1)?.latencyMs ? `${captions.at(-1)!.latencyMs}ms` : '--'}</span>
            <span className="text-slate-300">|</span>
            <Activity className="w-3.5 h-3.5 text-emerald-600" />
            <span className="text-slate-500">Ping:</span>
            <span className="font-semibold text-slate-800">{pingMs !== null ? `${pingMs}ms` : '--'}</span>
          </div>

          {sessionId && (
            <button
              onClick={() => setPaused((p) => !p)}
              title={paused ? 'เล่นต่อ' : 'พักการถอดความ'}
              className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600"
            >
              {paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
            </button>
          )}

          <button
            onClick={isSessionActive ? stopSessionAndMic : startSessionAndMic}
            disabled={capture.status === 'starting' || endingSession}
            className={`px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition-all shadow-xs whitespace-nowrap disabled:opacity-50 ${
              isSessionActive ? 'bg-rose-600 hover:bg-rose-700 text-white animate-pulse' : 'bg-[#DE5C8E] hover:bg-[#c94577] text-white'
            }`}
          >
            {isSessionActive ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            <span>
              {capture.status === 'starting'
                ? 'กำลังเริ่ม…'
                : endingSession
                ? 'กำลังสรุปผลการประชุม…'
                : isSessionActive
                ? 'จบ Session'
                : 'เริ่ม Session'}
            </span>
          </button>
        </div>
      </header>

      <div className="sm:hidden px-3 py-2 bg-white border-b border-slate-200 shrink-0 overflow-x-auto flex items-center gap-1.5">
        <ProjectHeaderBar
          project={projects.currentProject}
          activeSession={projects.activeSession}
          onRequestFinish={handleRequestFinishProject}
          onSwitchProject={handleSwitchProject}
          onOpenHistory={() => setShowHistory(true)}
        />
        <button
          type="button"
          onClick={() => setShowSessionHistory(true)}
          className="p-1.5 text-slate-400 hover:text-[#DE5C8E] rounded-full hover:bg-slate-100 transition-all shrink-0"
          title="ดู session และสรุปการประชุมย้อนหลังในโปรเจกต์นี้"
        >
          <ClipboardList className="w-4 h-4" />
        </button>
      </div>

      {capture.lastChunkError && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-xs flex items-center gap-2 shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{capture.lastChunkError}</span>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          MAIN WORKSPACE LAYOUT
      ────────────────────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden relative">
        <aside
          className={`fixed inset-y-15 left-0 z-20 w-84 lg:w-96 bg-white border-r border-slate-200 flex flex-col transition-transform duration-200 lg:static lg:translate-x-0 ${
            mobileSettingsOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'
          }`}
        >
          <div className="grid grid-cols-2 p-1.5 bg-slate-50 border-b border-slate-200 text-xs gap-1 shrink-0">
            <button
              onClick={() => setActiveTab('languages')}
              className={`py-2 px-1 rounded-lg font-semibold flex items-center justify-center gap-1.5 transition-all ${
                activeTab === 'languages' ? 'bg-white text-[#DE5C8E] shadow-xs' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <Languages className="w-4 h-4" />
              <span className="whitespace-nowrap">ภาษาและการตั้งค่า</span>
            </button>
            <button
              onClick={() => setActiveTab('dictionary')}
              className={`py-2 px-1 rounded-lg font-semibold flex items-center justify-center gap-1.5 transition-all ${
                activeTab === 'dictionary' ? 'bg-white text-[#DE5C8E] shadow-xs' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <BookOpen className="w-4 h-4" />
              <span className="whitespace-nowrap">พจนานุกรม</span>
            </button>
          </div>

          <div className="flex-1 p-4 overflow-y-auto space-y-4">
            {activeTab === 'languages' && (
              <div className="space-y-4">
                <div className="space-y-3 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-800">คู่ภาษาแปลสด (Thai ↔ English)</span>
                    <button
                      type="button"
                      onClick={handleSwapLanguages}
                      className="text-[11px] px-2.5 py-1 bg-white hover:bg-pink-50 text-[#DE5C8E] border border-pink-200 rounded-lg font-bold flex items-center gap-1 shadow-2xs transition-all"
                      title="สลับภาษาผู้พูดและภาษาแปล"
                    >
                      <ArrowLeftRight className="w-3.5 h-3.5" />
                      <span>สลับภาษา</span>
                    </button>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">ภาษาของผู้พูด (Source Language)</label>
                    <select
                      value={sourceLang}
                      onChange={(e) => setLanguage(e.target.value as 'th' | 'en')}
                      className="w-full p-2.5 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:border-[#DE5C8E] font-semibold text-slate-800"
                    >
                      <option value="th">{LANGS.th}</option>
                      <option value="en">{LANGS.en}</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">ภาษาที่แปลเป็น (Target — อัตโนมัติ)</label>
                    <select
                      value={targetLang}
                      onChange={(e) => setLanguage(other(e.target.value) as 'th' | 'en')}
                      className="w-full p-2.5 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:border-[#DE5C8E] font-semibold text-[#DE5C8E]"
                    >
                      <option value="en">แปลเป็นอังกฤษ (English)</option>
                      <option value="th">แปลเป็นไทย (Thai)</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">ขนาดตัวอักษรข้อความแปล (Font Size)</label>
                  <select
                    value={config.fontSize}
                    onChange={(e) => setConfig((c) => ({ ...c, fontSize: e.target.value as DisplayConfig['fontSize'] }))}
                    className="w-full p-2.5 text-xs bg-slate-50 border border-slate-200 rounded-lg outline-none focus:bg-white focus:border-[#DE5C8E] font-medium"
                  >
                    <option value="small">ขนาดเล็ก (Small)</option>
                    <option value="medium">ขนาดปานกลาง (Medium)</option>
                    <option value="large">ขนาดใหญ่ (Large - แนะนำ)</option>
                    <option value="xlarge">ขนาดใหญ่พิเศษ (Extra Large)</option>
                  </select>
                </div>

                <div className="pt-3 border-t border-slate-200 space-y-2.5">
                  <label className="flex items-center gap-2.5 cursor-pointer text-xs font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={config.showOriginal !== false}
                      onChange={(e) => setConfig((c) => ({ ...c, showOriginal: e.target.checked }))}
                      className="rounded text-[#DE5C8E] focus:ring-[#DE5C8E] w-4 h-4"
                    />
                    <span>แสดงประโยคต้นฉบับคู่กับคำแปล</span>
                  </label>
                  <label className="flex items-center gap-2.5 cursor-pointer text-xs font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={config.showLatency !== false}
                      onChange={(e) => setConfig((c) => ({ ...c, showLatency: e.target.checked }))}
                      className="rounded text-[#DE5C8E] focus:ring-[#DE5C8E] w-4 h-4"
                    />
                    <span>แสดงความเร็วการตอบสนอง (Latency ms)</span>
                  </label>
                </div>
              </div>
            )}

            {activeTab === 'dictionary' && (
              <DictionaryManager sections={glossary} disabled={false} onAdd={handleGlossaryAdd} onRemove={handleGlossaryRemove} />
            )}
          </div>

          <div className="p-3 border-t border-slate-200 lg:hidden">
            <button
              onClick={() => setMobileSettingsOpen(false)}
              className="w-full py-2 bg-slate-100 text-slate-700 text-xs font-semibold rounded-lg"
            >
              ปิดหน้าต่างตั้งค่า
            </button>
          </div>
        </aside>

        {mobileSettingsOpen && (
          <div onClick={() => setMobileSettingsOpen(false)} className="fixed inset-0 bg-black/30 z-10 lg:hidden" />
        )}

        {/* ─────────────────────────────────────────────────────────────
            MAIN TRANSLATION FEED
        ────────────────────────────────────────────────────────────── */}
        <main className="flex-1 flex flex-col bg-slate-50 min-w-0">
          <div className="px-4 py-2.5 bg-white border-b border-slate-200 flex items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <Radio className={`w-4 h-4 ${isListening ? 'text-emerald-500 animate-pulse' : 'text-slate-400'}`} />
              <div className="flex items-center gap-1.5 bg-slate-100 px-2.5 py-1 rounded-lg border border-slate-200">
                <span className="font-bold text-slate-800">
                  {LANGS[sourceLang]} ➔ {LANGS[targetLang]}
                </span>
                <button
                  onClick={handleSwapLanguages}
                  className="p-1 hover:bg-white rounded-md text-slate-500 hover:text-[#DE5C8E] transition-all"
                  title="สลับภาษาผู้พูดและภาษาแปล"
                >
                  <ArrowLeftRight className="w-3.5 h-3.5" />
                </button>
              </div>
              <span className="text-slate-400 font-medium hidden sm:inline">({captions.length} รายการ)</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => exportTranscript('txt')}
                disabled={captions.length === 0}
                className="px-2.5 py-1.5 text-xs text-slate-700 hover:text-slate-900 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg font-semibold transition-all disabled:opacity-40 flex items-center gap-1.5 shadow-2xs"
                title="ส่งออกข้อความ TXT"
              >
                <Download className="w-3.5 h-3.5 text-slate-500" />
                <span>TXT</span>
              </button>
              <button
                onClick={() => exportTranscript('srt')}
                disabled={captions.length === 0}
                className="px-2.5 py-1.5 text-xs text-slate-700 hover:text-slate-900 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg font-semibold transition-all disabled:opacity-40 flex items-center gap-1.5 shadow-2xs"
                title="ส่งออกคำบรรยาย SRT"
              >
                <FileText className="w-3.5 h-3.5 text-slate-500" />
                <span>SRT</span>
              </button>
              <button
                onClick={clearTranscripts}
                disabled={captions.length === 0}
                className="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 transition-all disabled:opacity-30 ml-1"
                title="ล้างประวัติข้อความทั้งหมด"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          {micPermissionError && (
            <div className="p-3 bg-rose-50 border-b border-rose-200 text-rose-800 text-xs flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <ShieldAlert className="w-4 h-4 text-rose-600 shrink-0" />
                <span className="truncate">{capture.error}</span>
              </div>
              <button
                onClick={() => {
                  setMicActive(false);
                  setTimeout(() => setMicActive(true), 100);
                }}
                className="px-3 py-1 bg-rose-600 text-white rounded-lg text-xs font-semibold flex items-center gap-1 shrink-0"
              >
                <RefreshCw className="w-3 h-3" />
                <span>ลองใหม่อีกครั้ง</span>
              </button>
            </div>
          )}

          {isListening && (
            <div className="px-4 py-2 bg-emerald-50 border-b border-emerald-200 flex items-center justify-between gap-3 text-xs text-emerald-900 transition-all shrink-0">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                  </span>
                  <span className="font-bold text-emerald-800 shrink-0">กำลังฟัง:</span>
                </div>
                <div className="flex-1 truncate font-mono text-xs text-emerald-800 font-medium">
                  <span className="text-emerald-600/80 italic">กำลังรอเสียงพูด... (พูดใส่ไมโครโฟนได้ทันที)</span>
                </div>
              </div>
            </div>
          )}

          {/* ─────────────────────────────────────────────────────────────
              LIVE SUBTITLE — one box, one caption at a time.
          ────────────────────────────────────────────────────────────── */}
          <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-8 min-h-0">
            <div className="relative w-full max-w-4xl bg-white rounded-2xl border border-slate-200 shadow-sm px-6 py-10 sm:px-12 sm:py-14 text-center">
              {latestCaption && !isEditingBox && (
                <div className="absolute top-3 right-3 flex items-center gap-1">
                  <button
                    onClick={() => handleCopyItem(latestCaption)}
                    className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md hover:bg-slate-100 transition-all"
                    title="คัดลอกข้อความ"
                  >
                    {copiedSeq === latestCaption.seq ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => startEditing(latestCaption)}
                    className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md hover:bg-slate-100 transition-all"
                    title="แก้ไขคำแปล"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {!latestCaption ? (
                <div className="flex flex-col items-center gap-3 text-slate-400">
                  <div className="w-14 h-14 rounded-2xl bg-slate-50 border border-slate-200 flex items-center justify-center text-[#DE5C8E]">
                    <Mic className="w-7 h-7" />
                  </div>
                  <div className="max-w-sm">
                    <div className="font-bold text-slate-700 text-sm">พร้อมรับเสียงจากไมโครโฟน</div>
                    <p className="text-xs text-slate-400 leading-relaxed mt-1">
                      กดปุ่ม <strong>&quot;เริ่ม Session&quot;</strong> ด้านบน จากนั้นพูดใส่ไมโครโฟนเพื่อทำการแปลภาษาแบบเรียลไทม์
                    </p>
                  </div>
                </div>
              ) : isEditingBox ? (
                <div className="space-y-3 text-left max-w-2xl mx-auto">
                  <label className="text-xs font-bold text-slate-600 block">คำแปล:</label>
                  <input
                    type="text"
                    autoFocus
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
                    className="w-full p-3 text-lg font-bold text-slate-900 text-center border border-slate-300 rounded-lg outline-none focus:border-[#DE5C8E]"
                  />
                  <div className="flex items-center justify-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setEditingSeq(null)}
                      className="px-3.5 py-1.5 text-xs text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg font-medium transition-all"
                    >
                      ยกเลิก
                    </button>
                    <button
                      type="button"
                      onClick={saveEdit}
                      className="px-3.5 py-1.5 text-xs text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg font-semibold flex items-center gap-1.5 shadow-xs transition-all"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>บันทึก</span>
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {config.showOriginal && boxSourceText && <p className="text-slate-400 text-base sm:text-lg mb-3">{boxSourceText}</p>}
                  <p className={`${boxTextSizeClass(config.fontSize)} font-bold text-slate-900 leading-snug tracking-tight`}>
                    {boxTargetText || <span className="text-slate-300 font-normal text-2xl sm:text-3xl">กำลังแปล…</span>}
                  </p>
                  {config.showLatency && latestCaption?.latencyMs ? (
                    <span className="mt-3 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 font-mono text-[10px] text-slate-500 border border-slate-200">
                      <Zap className="w-3 h-3 text-amber-500" />
                      <span>{latestCaption.latencyMs}ms</span>
                    </span>
                  ) : null}
                </>
              )}
            </div>
          </div>

          {/* ─────────────────────────────────────────────────────────────
              HISTORY — collapsed by default so the subtitle box above stays
              the primary view; full edit/hide/copy tooling lives here.
          ────────────────────────────────────────────────────────────── */}
          {captions.length > 0 && (
            <div className="border-t border-slate-200 bg-white shrink-0">
              <button
                onClick={() => setShowAllHistory((v) => !v)}
                className="w-full flex items-center justify-between px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                <span>ประวัติทั้งหมด ({captions.length} รายการ)</span>
                {showAllHistory ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
              {showAllHistory && (
                <div ref={transcriptScrollRef} className="max-h-64 overflow-y-auto p-3.5 space-y-3 border-t border-slate-100">
                  {captions.map((item, index) => {
                    // Editing the latest caption happens in the box above, not
                    // duplicated here.
                    const isEditing = editingSeq === item.seq && item.seq !== latestCaption?.seq;
                    const isLatest = index === captions.length - 1;
                    return (
                      <div
                        key={item.seq}
                        className={`p-4 rounded-xl border transition-all shadow-xs ${
                          isEditing
                            ? 'bg-amber-50/90 border-amber-300 ring-2 ring-amber-200'
                            : isLatest
                            ? 'bg-white border-[#DE5C8E]/40 ring-1 ring-[#DE5C8E]/20'
                            : 'bg-white border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        {isEditing ? (
                          <div className="space-y-2.5">
                            {/* Original text has no re-transcription command in
                                this pipeline — it's corrected by re-speaking, not typed. */}
                            <div>
                              <label className="text-xs font-bold text-slate-600 block mb-1">ประโยคต้นฉบับ (แก้ไขไม่ได้):</label>
                              <p className="w-full p-2.5 text-xs bg-slate-100 border border-slate-200 rounded-lg text-slate-500">
                                {item.sourceText}
                              </p>
                            </div>
                            <div>
                              <label className="text-xs font-bold text-slate-600 block mb-1">คำแปล:</label>
                              <input
                                type="text"
                                autoFocus
                                value={editDraft}
                                onChange={(e) => setEditDraft(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
                                className="w-full p-2.5 text-xs bg-white border border-slate-300 rounded-lg font-bold text-slate-900 outline-none focus:border-[#DE5C8E]"
                              />
                            </div>
                            <div className="flex items-center justify-end gap-2 pt-1">
                              <button
                                type="button"
                                onClick={() => setEditingSeq(null)}
                                className="px-3.5 py-1.5 text-xs text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg font-medium transition-all"
                              >
                                ยกเลิก
                              </button>
                              <button
                                type="button"
                                onClick={saveEdit}
                                className="px-3.5 py-1.5 text-xs text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg font-semibold flex items-center gap-1.5 shadow-xs transition-all"
                              >
                                <Check className="w-3.5 h-3.5" />
                                <span>บันทึก</span>
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-xs text-slate-400">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-[11px] text-slate-400">{new Date(item.ts * 1000).toLocaleTimeString()}</span>
                                {config.showLatency && item.latencyMs ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 font-mono text-[10px] text-slate-600 border border-slate-200">
                                    <Zap className="w-3 h-3 text-amber-500" />
                                    <span>{item.latencyMs}ms</span>
                                  </span>
                                ) : null}
                                {item.isEdited && (
                                  <span className="text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded-md font-medium border border-amber-200">
                                    แก้ไขแล้ว
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => handleCopyItem(item)}
                                  className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md hover:bg-slate-100 transition-all"
                                  title="คัดลอกข้อความ"
                                >
                                  {copiedSeq === item.seq ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                                </button>
                                <button
                                  onClick={() => startEditing(item)}
                                  className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md hover:bg-slate-100 transition-all"
                                  title="แก้ไขคำแปล"
                                >
                                  <Edit2 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => hideItem(item.seq)}
                                  className="p-1.5 text-slate-400 hover:text-rose-600 rounded-md hover:bg-rose-50 transition-all"
                                  title="ซ่อนรายการนี้ (ไม่ลบจากเซิร์ฟเวอร์)"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>

                            {config.showOriginal && item.sourceText && (
                              <div className="text-xs text-slate-500 font-medium leading-relaxed">{item.sourceText}</div>
                            )}

                            <div className={`${textSizeClass(config.fontSize)} font-bold text-slate-900 leading-snug tracking-tight`}>
                              {item.targetText || <span className="text-slate-400 font-normal">กำลังแปล…</span>}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {report && (
            <div className="p-3.5 bg-white border-t border-slate-200 shrink-0 space-y-1.5 max-h-40 overflow-y-auto">
              <h2 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                <ClipboardList className="w-3.5 h-3.5 text-[#DE5C8E]" />
                <span>สรุปช่วงการประชุม</span>
              </h2>
              {report.summary ? (
                <p className="text-xs text-slate-600 whitespace-pre-wrap leading-relaxed">{report.summary}</p>
              ) : (
                // The transcript is preserved even when the summarize call
                // itself fails (quota, network) — say so plainly instead of
                // leaving a blank panel that looks broken.
                <p className="text-xs text-amber-700 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>สรุปด้วย AI ไม่สำเร็จ — บันทึกไว้ {report.items} ข้อความ ดูได้ที่ &quot;ประวัติทั้งหมด&quot; ด้านบน</span>
                </p>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check the full project**

Run: `npm run lint`
Expected: PASS with no errors. This is the point in the plan where every dangling reference from Tasks 8 and 10 (the old `'frame'` caption action, the removed `onReload` prop) is resolved.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: All suites pass.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Admin.tsx
git commit -m "$(cat <<'EOF'
Rewrite Admin.tsx for the Gemini-only pipeline

Replaces every piece of session/socket/token wiring that talked to the
Python ASR backend with the local Gemini chunk-capture pipeline
(useGeminiCapture, the rewritten captions store, local glossary state).
UI/JSX is unchanged except the approved departures from the design spec's
section 7: header subtitle text, "Ping" now measures /api/health
round-trip time, no live word-by-word interim transcript, no
"restarts listening" notice, and the multi-tab session picker /
health-poll / recognizer-alive banners are gone (single-tab sessions
only, per that design decision).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Delete obsolete client-side ASR files

**Files:**
- Delete: `src/asr/useAsrSocket.ts`, `src/asr/useAsrSocket.test.ts`
- Delete: `src/asr/protocol.ts`
- Delete: `src/asr/sessions.ts`, `src/asr/sessions.test.ts`
- Delete: `src/asr/commands.ts`, `src/asr/commands.test.ts`
- Delete: `src/asr/tokens.ts`, `src/asr/tokens.test.ts`
- Delete: `src/asr/closeCodes.ts`, `src/asr/closeCodes.test.ts`
- Delete: `src/asr/__tests__/drift.test.ts` (and the now-empty `src/asr/__tests__/` directory)
- Delete: `src/asr/__fixtures__/protocol/` (entire directory, all fixture files)
- Delete: `src/asr/audio/useAudioCapture.ts`

By this point (after Task 11), nothing in the tree imports any of these — `src/pages/Admin.tsx` no longer references them, `src/asr/captions.ts` no longer imports from `protocol.ts`, and `src/asr/audio/useGeminiCapture.ts` replaced `useAudioCapture.ts` without depending on it.

- [ ] **Step 1: Confirm nothing still references these files**

Run:

```bash
grep -rn "useAsrSocket\|asr/protocol\|asr/sessions\|asr/commands\|asr/tokens\|asr/closeCodes\|useAudioCapture" src server --include="*.ts" --include="*.tsx" | grep -v "src/asr/useAsrSocket.ts\|src/asr/protocol.ts\|src/asr/sessions.ts\|src/asr/commands.ts\|src/asr/tokens.ts\|src/asr/closeCodes.ts\|src/asr/audio/useAudioCapture.ts\|\.test\.ts"
```

Expected: no output (empty). If anything prints, stop and resolve that reference before deleting — it means an earlier task's rewrite missed something.

- [ ] **Step 2: Delete the files**

```bash
rm src/asr/useAsrSocket.ts src/asr/useAsrSocket.test.ts
rm src/asr/protocol.ts
rm src/asr/sessions.ts src/asr/sessions.test.ts
rm src/asr/commands.ts src/asr/commands.test.ts
rm src/asr/tokens.ts src/asr/tokens.test.ts
rm src/asr/closeCodes.ts src/asr/closeCodes.test.ts
rm -rf src/asr/__tests__
rm -rf src/asr/__fixtures__
rm src/asr/audio/useAudioCapture.ts
```

- [ ] **Step 3: Type-check and run the full test suite**

Run: `npm run lint`
Expected: PASS with no errors.

Run: `npm test`
Expected: All remaining suites pass (the ones just deleted no longer run).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Delete obsolete Python-backend/wire-protocol client files

Part of the Gemini-only transcription migration. Removes
useAsrSocket.ts, protocol.ts, sessions.ts, commands.ts, tokens.ts,
closeCodes.ts (and their tests), the protocol wire-format test fixtures,
and the old WebSocket-based useAudioCapture.ts — nothing in the tree
has referenced any of them since Task 11.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Update `SYSTEM_OVERVIEW.md`

**Files:**
- Modify: `SYSTEM_OVERVIEW.md`

- [ ] **Step 1: Replace the full contents**

Replace the full contents of `SYSTEM_OVERVIEW.md`:

```markdown
# สรุปการทำงานของระบบ AI Realtime Conference Interpreter & Translator
(System Overview & Architecture Documentation)

> อัปเดตล่าสุด: 2026-09-07 — เขียนใหม่ทั้งฉบับหลังย้ายออกจาก ASR backend
> แยก (`../thai-realtime-asr-mt`) มาใช้ Google Gemini API ทั้งหมดในสาขา
> `feat/trans_with_gemini` รายละเอียดการออกแบบและแผนการทำงานทั้งหมดอยู่ที่
> [`docs/superpowers/specs/2026-09-07-gemini-transcription-migration-design.md`](docs/superpowers/specs/2026-09-07-gemini-transcription-migration-design.md)
> และ [`docs/superpowers/plans/2026-09-07-gemini-transcription-migration.md`](docs/superpowers/plans/2026-09-07-gemini-transcription-migration.md)

ระบบ **AI Realtime Conference Interpreter & Translator** คือ operator console
สำหรับถอดความเสียงพูดสด (Speech-to-Text) และแปลภาษาแบบเรียลไทม์ (Thai ↔
English) สำหรับการประชุม สัมมนา งานแถลงข่าว และการบรรยายสองภาษา — ออกแบบให้
กล่องคำแปลหลักเป็นกล่องเดียวแบบ subtitle เพื่อให้ crop ด้วย OBS ไปสตรีมต่อได้

**การเปลี่ยนแปลงใหญ่ที่สุด**: ระบบนี้เคยพึ่งพา backend Python แยกต่างหาก
(`thai-realtime-asr-mt`, FastAPI + Google Cloud Speech Chirp 3 + Google
Translate) สำหรับ ASR และแปลภาษา ตอนนี้ backend นั้นถูกถอดออกทั้งหมด —
repo นี้กลับมาทำทุกอย่างเองอีกครั้ง โดยใช้ **Google Gemini API เพียงตัวเดียว**
ทั้งถอดเสียง แปลภาษา และสรุปช่วงประชุม เรียกผ่าน Node server ของ repo นี้เอง
(ไม่มี Python process, ไม่มี WebSocket ไปหา backend แยก, ไม่มีรหัสผ่าน
operator อีกต่อไป — API key ของ Gemini อยู่ฝั่งเซิร์ฟเวอร์เท่านั้น)

---

## 1. สถาปัตยกรรมระบบ (System Architecture)

```
[ไมโครโฟนของผู้ใช้ในเบราว์เซอร์]
        │  AudioWorklet → 16kHz mono PCM
        ▼
 ┌────────────────────────────┐
 │  ตัดเสียงเป็นช่วงๆ (chunker) │  ตัดเมื่อเงียบ ≥600ms หลังพูด ≥1s
 │  src/asr/audio/chunker.ts   │  หรือครบเพดาน 8s
 └──────────────┬───────────────┘
                │ WAV blob ต่อ chunk
                ▼
 ┌────────────────────────────┐        ┌──────────────────────────────────┐
 │  Node server.ts             │  HTTP  │  Google Gemini API                │
 │  POST /api/gemini/transcribe│───────►│  (ถอดเสียง + แปลภาษาในคำขอเดียว,   │
 │  POST /api/gemini/summarize │        │   คืนค่าเป็น JSON โครงสร้างตายตัว) │
 │  ถือ GEMINI_API_KEY เอง      │        └──────────────────────────────────┘
 │  (ไม่เคยส่งไปถึง browser)     │
 └──────────────┬───────────────┘
                │ { source_text, target_text, latencyMs }
                ▼
 ┌────────────────────────────┐
 │  React Operator Console     │  เรียงผลลัพธ์ตามลำดับที่พูดจริงด้วย
 │  (repo นี้)                 │  reorder queue แล้วต่อเข้า caption store
 └────────────────────────────┘
```

**จุดสำคัญของสถาปัตยกรรมนี้**:
- **Session เป็นของแต่ละแท็บเบราว์เซอร์เอง** ไม่มี session registry กลาง
  อีกต่อไป — แต่ละแท็บที่กด "เริ่ม Session" จะจับเสียงและถอดความเป็นของ
  ตัวเอง ไม่มีการดูร่วมกันหลายแท็บเหมือนตอนที่ยังมี backend Python
- **การถอดความเป็นแบบแบ่งช่วง (chunked)** ไม่ใช่ streaming ต่อเนื่อง — ตัด
  เสียงเป็นชิ้นๆ ตามจังหวะเงียบของผู้พูด (หรือทุก 8 วินาทีถ้าพูดต่อเนื่องไม่
  หยุด) แล้วส่งแต่ละชิ้นไปถอดความ+แปลพร้อมกันในคำขอเดียว
- **พจนานุกรมเก็บไว้ใน localStorage ของเบราว์เซอร์** ไม่ใช่ไฟล์บนเซิร์ฟเวอร์
  อีกต่อไป ใช้ร่วมกันทุก session ที่เริ่มจากเบราว์เซอร์เดียวกัน และถูกส่งไป
  เป็นส่วนหนึ่งของคำสั่งถอดความทุกครั้ง (ให้ Gemini ยึดคำศัพท์ตามนั้น)

---

## 2. ฟังก์ชันหลักของระบบ (Core System Features)

### 2.1 กล่อง Subtitle เดียว สำหรับ crop ไป OBS
พื้นที่แสดงคำแปลหลักเป็น **กล่องเดียว** แสดงคำแปลของ caption ล่าสุดเท่านั้น
(เหมือน subtitle บน YouTube) แทนรายการที่เลื่อนยาวลงเรื่อยๆ ประวัติทั้งหมด
(แก้ไข/คัดลอก/ซ่อนรายการ) อยู่ใน panel พับเก็บด้านล่างกล่อง (ค่าเริ่มต้นพับอยู่)

### 2.2 การจับคู่ภาษา (Thai ⇄ English เท่านั้น)
เลือกภาษาต้นทางแล้วปลายทางจะสลับให้อัตโนมัติเสมอ มีปุ่ม **⇅ สลับภาษา** ทั้งใน
sidebar และแถบหัวฟีด การสลับภาษาไม่ทำให้เกิดการหยุดชะงักใดๆ — มีผลแค่กับ
คำขอถอดความชิ้นถัดไปเท่านั้น

### 2.3 พจนานุกรมศัพท์เฉพาะทาง (Glossary — 3 หมวด, เก็บในเบราว์เซอร์)
พจนานุกรมเก็บอยู่ใน localStorage ของเบราว์เซอร์ แบ่ง 3 หมวด:
- **ศัพท์เฉพาะ** (`protected_terms`) — ไทย → อังกฤษ คำที่ต้องคงคำแปลไว้เสมอ
- **ชื่อบุคคล** (`person_names`) — ไทย → อังกฤษ ชื่อผู้พูดที่ถอดเสียงเป็น
  อังกฤษ
- **แก้คำไทยที่ฟังผิด** (`thai_corrections`) — ไทย → ไทย แก้คำที่ระบบมักได้
  ยินผิด

รองรับค้นหา, เพิ่ม/ลบทีละคำ, และวางสองคอลัมน์จาก Excel/Sheets พร้อมกันได้
คำในพจนานุกรมถูกส่งไปเป็นส่วนหนึ่งของคำสั่งให้ Gemini ทุกครั้งที่ถอดความ

### 2.4 การบันทึกและสรุปช่วงประชุมอัตโนมัติ (Auto Section Report)
ไม่มีปุ่ม "เริ่มบันทึก" — ทุกคำที่ถอดความสำเร็จจะถูกเก็บไว้ในรายการอัตโนมัติ
ตลอด session กด "จบ Session" แล้วระบบจะส่ง transcript ทั้งหมดไปให้ Gemini
สรุปเป็นข้อความสั้นๆ (สูงสุด 20 วินาที) ถ้าเรียกไม่สำเร็จ ระบบจะยังคง
transcript ดิบไว้ครบ (ไม่เสียข้อมูล) และขึ้นข้อความเตือนแทนสรุป AI

### 2.5 ประวัติ Session ในโปรเจกต์และสรุปย้อนหลัง
กดไอคอน 📋 ข้างชื่อโปรเจกต์เพื่อเปิดดูรายการ session ทั้งหมดที่เคยบันทึกไว้
ในโปรเจกต์นี้ (เรียงล่าสุดก่อน) คลิกแต่ละ session เพื่อกางดูสรุปการประชุม
ของครั้งนั้น — ยังไม่มี database จริง ข้อมูลนี้เก็บอยู่ใน localStorage
เดียวกับข้อมูล project อื่นๆ

### 2.6 การส่งออกผลลัพธ์ (Export)
- **TXT**: บันทึกบทสนทนาการประชุมพร้อมเวลาและคำแปล
- **SRT**: ไฟล์คำบรรยายพร้อม Timecode สำหรับประกอบวิดีโอ

ทั้งสองแบบดึงจากรายการ caption ทั้งหมดของ project รวมคำแปลที่ operator แก้ไข
เองด้วย

### 2.7 สิ่งที่เปลี่ยนไปจากช่วงที่มี backend Python
- **ไม่มี session หลายแท็บร่วมกัน** — แต่ละแท็บที่กด "เริ่ม Session" จับเสียง
  เป็นของตัวเอง ไม่มี session registry กลางให้แท็บอื่นมาดูร่วม
- **ไม่มี partial transcript แบบ real-time ทีละคำ** ระหว่างกำลังฟัง — ระบบ
  ถอดความเป็นชิ้นๆ (chunked) จึงเห็นคำแปลเป็นก้อนเมื่อ Gemini ตอบกลับมา
  แทนที่จะเห็นทีละคำขณะพูด
- **ไม่มีการรีสตาร์ทการฟังเมื่อสลับภาษา** เพราะไม่มี session ฝั่งเซิร์ฟเวอร์
  ให้รีสตาร์ท

---

## 3. วิธีการเริ่มใช้งาน (Quick User Guide)

**เตรียมก่อนใช้งาน**: ตั้งค่า `GEMINI_API_KEY` ใน `.env` ของ repo นี้ (ดู
คอมเมนต์ในไฟล์) และตรวจสอบว่า `GEMINI_MODEL` ชี้ไปยังโมเดล Gemini ที่รองรับ
การรับเสียงเป็น input

1. **เลือกหรือสร้างโปรเจกต์** จากหน้าแรก
2. **กด "เริ่ม Session"** มุมขวาบน — ระบบจะขอสิทธิ์ไมโครโฟนและเริ่มบันทึก
   ช่วงประชุมอัตโนมัติ
3. **พูดใส่ไมโครโฟน** — คำแปลจะขึ้นในกล่อง subtitle กลางจอทีละชิ้นตามจังหวะ
   ที่ Gemini ประมวลผลเสร็จ
4. **สลับภาษา / พัก-เล่นต่อ** ได้จากปุ่มในแถบหัวเรื่องหรือ sidebar โดยไม่ต้อง
   หยุด session
5. **กด "จบ Session"** เมื่อเลิกใช้งาน — รอสรุปผลสักครู่ (ขึ้น "กำลังสรุปผล
   การประชุม…") แล้วจะเห็น panel สรุปโผล่ขึ้นมาอัตโนมัติที่ด้านล่าง
6. ดูสรุปย้อนหลังของ session ก่อนๆ ได้จากไอคอน 📋 ข้างชื่อโปรเจกต์ (§2.5)

---

## 4. แผนพัฒนาต่อ (Roadmap)

| # | Sub-project | สถานะ |
|---|---|---|
| — | Gemini-only transcription/translation/summarization migration (เอกสารนี้บรรยายผลลัพธ์) | **เสร็จแล้ว** |
| P1 | Auth จริง — Supabase email/password, Node เป็น BFF ตรวจ JWT | ยังไม่เริ่ม |
| P2 | Persistence จริง — Postgres + Drizzle แทน localStorage | ยังไม่เริ่ม |
| P3 | Usage metering จริง + billing PDF (ปัจจุบัน bill เป็นตัวเลขประมาณการ placeholder เท่านั้น) | ยังไม่เริ่ม |

**ข้อตกลงเดิมที่ยังใช้ได้อยู่**: ไม่มีระบบ self-registration (แอดมินสร้าง
account ให้ user เอง), billing เป็นรายงานสรุปในระบบไม่ผูก payment gateway,
เก็บเฉพาะข้อความ (text-only ไม่มี object storage สำหรับไฟล์เสียง)
```

- [ ] **Step 2: Commit**

```bash
git add SYSTEM_OVERVIEW.md
git commit -m "$(cat <<'EOF'
Rewrite SYSTEM_OVERVIEW.md for the Gemini-only architecture

Documents the removal of the thai-realtime-asr-mt backend and the new
chunked Gemini transcribe/translate/summarize pipeline, replacing the
description of the now-removed Python backend integration.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full type-check**

Run: `npm run lint`
Expected: PASS, zero errors.

- [ ] **Step 2: Full automated test suite**

Run: `npm test`
Expected: PASS, every suite green (including all tests added in Tasks 1, 2, 3, 4, 5, 6, and the rewritten Task 8 suite; confirm the deleted suites from Task 7/12 no longer appear in the run).

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: Succeeds with no errors (exercises both the Vite client build and the esbuild server bundle, including the new `@google/genai`/`multer` dependencies).

- [ ] **Step 4: Manual smoke test**

With a real `GEMINI_API_KEY` set in `.env`:

1. Run `npm run dev` and open the app in a browser.
2. Create or open a project, click "เริ่ม Session", grant microphone permission.
3. Speak a short sentence in Thai. Confirm: the "กำลังฟัง..." indicator appears while capturing, then a translated caption appears in the subtitle box with a plausible latency figure once a chunk resolves.
4. Click "สลับภาษา" and speak a sentence in English; confirm the box now shows Thai as the translation.
5. Open the พจนานุกรม tab, add a term to "ศัพท์เฉพาะ", and confirm it appears in the list after a page reload (persisted via `localStorage`).
6. Click "จบ Session"; confirm the button shows "กำลังสรุปผลการประชุม…" briefly, then a summary panel appears at the bottom.
7. Export TXT and SRT and confirm both files download with sensible content.
8. Check the browser's Network tab: confirm no request ever contains `GEMINI_API_KEY` — only requests to this app's own `/api/gemini/*` and `/api/health` endpoints.

- [ ] **Step 5: Report results**

If every check above passes, the migration is complete. If any manual step fails, use `superpowers:systematic-debugging` before making further changes — do not patch symptoms ad hoc.
