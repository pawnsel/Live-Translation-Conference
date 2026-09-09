# Long-Session Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one recording session run through a ~2 hour conference without an operator restarting it, still produce a summary at the end, and never lose transcripts silently.

**Architecture:** Three independent phases. **A** moves Gemini reconnection into the proxy (the browser socket and microphone stay up across Gemini's 10-minute connection cap) and replaces the client's exhaustible retry budget with unbounded exponential backoff. **B** turns end-of-session summarisation into map-reduce so a two-hour transcript fits. **C** replaces silently swallowed storage writes with a storage-agnostic failure channel that survives the coming database phase.

**Tech Stack:** TypeScript, React 19, Vite, Express + `ws` (Node), Gemini Live API over WebSocket, vitest (`environment: 'node'` by default, `// @vitest-environment jsdom` per-file for DOM tests).

**Spec:** `docs/superpowers/specs/2026-09-08-long-session-resilience-design.md`

**Phases are independently shippable.** A, B and C share no code. Execute in order or in isolation; each ends green and deployable.

## Global Constraints

- Run everything from `Live-Translation-Conference/`. Tests: `npx vitest run`. Typecheck: `npm run lint` (`tsc --noEmit`). Both must pass before every commit.
- Never send prompt text from the browser. The browser sends structured glossary pairs; the server builds the instruction. This boundary is what stops a browser running arbitrary prompts on the billed key — do not weaken it.
- All operator-facing copy is Thai. Match the existing tone in `src/pages/Admin.tsx` and `src/components/ProjectPanel.tsx`.
- Comments explain *why*, not *what*, matching the density already in these files.
- The live model is `gemini-3.5-live-translate-preview`; the summary model is `gemini-3.6-flash`. Both come from env vars — never hardcode them outside `server.ts`.
- New constants, exact values: `MAX_UPSTREAM_SWAPS_IN_A_ROW = 3`, `RECONNECT_BASE_DELAY_MS = 800`, `RECONNECT_MAX_DELAY_MS = 10000`, `SUMMARY_CHUNK_CHARS = 12000`, `SUMMARY_MAP_CONCURRENCY = 4`, `SUMMARY_CALL_TIMEOUT_MS = 20000`, `SUMMARY_JOB_BUDGET_MS = 150000`.
- Changed constants: `MAX_SUMMARIZE_ITEMS` 2000 → 6000, `REPORT_WAIT_TIMEOUT_MS` 20000 → 180000.

---

# Phase A — Session continuity

## Task A1: Extract a testable bridge from the proxy

The per-connection logic in `registerGeminiLiveProxy` cannot be tested today: it only exists inside a `WebSocketServer` connection callback and constructs its own upstream `WebSocket`. Everything else in Phase A depends on being able to drive that logic with fakes, so this task changes structure only — no behaviour change.

**Files:**
- Create: `server/geminiLiveBridge.ts`
- Modify: `server/geminiLiveProxy.ts` (whole file — the connection body moves out)
- Test: `server/geminiLiveBridge.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface SocketLike {
    readonly readyState: number;
    send(data: string | Buffer, opts?: { binary?: boolean }): void;
    close(code?: number, reason?: string): void;
    on(event: string, cb: (...args: any[]) => void): this;
  }
  export type OpenUpstream = () => SocketLike;
  export interface BridgeOptions {
    model: string;
    targetLanguageCode: string;
    sourceLanguageCodes: string[];
    openUpstream: OpenUpstream;
  }
  export function createLiveBridge(client: SocketLike, opts: BridgeOptions): void;
  export const OPEN = 1;   // WebSocket.OPEN, redeclared so the module needs no ws import
  export const CONNECTING = 0;
  ```
  `ws`'s `WebSocket` satisfies `SocketLike` structurally, so `registerGeminiLiveProxy` passes real sockets unchanged.
  Also produced (moved verbatim from the proxy, now exported for tests): `cleanTerm`, `buildGlossaryInstruction`, `sanitizeVocabulary`, `sanitizeLangs`, `ALLOWED_TARGET_LANGS`, `ALLOWED_SOURCE_LANGS`, and the constants `GLOSSARY_WAIT_MS`, `MAX_VOCABULARY_TERMS`, `MAX_TERM_LENGTH`, `MAX_PENDING_FRAMES`, `MAX_GLOSSARY_PAIRS`.

- [ ] **Step 1: Write the failing test**

Create `server/geminiLiveBridge.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createLiveBridge, CONNECTING, OPEN, type SocketLike } from './geminiLiveBridge';

/** Minimal SocketLike double: records what was sent, lets a test fire events. */
export class FakeSocket implements SocketLike {
  readyState = OPEN;
  sent: Array<string | Buffer> = [];
  closed: { code?: number; reason?: string } | null = null;
  private handlers = new Map<string, Array<(...args: any[]) => void>>();

  send(data: string | Buffer) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  on(event: string, cb: (...args: any[]) => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }
  emit(event: string, ...args: any[]) {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
  /** Frames sent as JSON, parsed. */
  jsonSent(): any[] {
    return this.sent.map((s) => JSON.parse(s.toString()));
  }
}

/** Drives a bridge with a fake client and a queue of fake upstreams. */
export function makeBridge(overrides: { targetLanguageCode?: string } = {}) {
  const client = new FakeSocket();
  const upstreams: FakeSocket[] = [];
  createLiveBridge(client, {
    model: 'test-model',
    targetLanguageCode: overrides.targetLanguageCode ?? 'en',
    sourceLanguageCodes: ['th-TH'],
    openUpstream: () => {
      const up = new FakeSocket();
      up.readyState = CONNECTING;
      upstreams.push(up);
      return up;
    }
  });
  return { client, upstreams };
}

/** Opens the newest upstream and completes its setup handshake. */
export function completeSetup(up: FakeSocket) {
  up.readyState = OPEN;
  up.emit('open');
  up.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })), false);
}

describe('createLiveBridge', () => {
  it('sends setup carrying the language pair once the client config arrives', () => {
    const { client, upstreams } = makeBridge();
    const up = upstreams[0];
    up.readyState = OPEN;
    up.emit('open');

    client.emit(
      'message',
      Buffer.from(JSON.stringify({ targetLanguageCode: 'th', sourceLanguageCodes: ['en-US'] })),
      false
    );

    const setup = up.jsonSent().find((f) => f.setup)?.setup;
    expect(setup.model).toBe('models/test-model');
    expect(setup.generationConfig.translationConfig.targetLanguageCode).toBe('th');
    expect(setup.inputAudioTranscription.languageCodes).toEqual(['en-US']);
  });

  it('queues audio that arrives before setupComplete and flushes it after', () => {
    const { client, upstreams } = makeBridge();
    const up = upstreams[0];
    up.readyState = OPEN;
    up.emit('open');
    client.emit('message', Buffer.from(JSON.stringify({ targetLanguageCode: 'en' })), false);

    const audio = Buffer.from('audio-frame-1');
    client.emit('message', audio, true);
    expect(up.sent.filter((s) => s.toString() === 'audio-frame-1')).toHaveLength(0);

    up.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })), false);
    expect(up.sent.filter((s) => s.toString() === 'audio-frame-1')).toHaveLength(1);
  });

  it('relays upstream transcription frames to the client', () => {
    const { client, upstreams } = makeBridge();
    const up = upstreams[0];
    completeSetup(up);
    const frame = JSON.stringify({ serverContent: { outputTranscription: { text: 'hello' } } });
    up.emit('message', Buffer.from(frame), false);
    expect(client.sent.map((s) => s.toString())).toContain(frame);
  });

  it('drops audio-only model frames instead of relaying them', () => {
    const { client, upstreams } = makeBridge();
    const up = upstreams[0];
    completeSetup(up);
    const before = client.sent.length;
    up.emit(
      'message',
      Buffer.from(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'x' } }] } } })),
      false
    );
    expect(client.sent.length).toBe(before);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/geminiLiveBridge.test.ts`
Expected: FAIL — `Failed to resolve import "./geminiLiveBridge"`.

- [ ] **Step 3: Create the bridge module**

Create `server/geminiLiveBridge.ts`. Move the constants, the three sanitiser helpers and the entire body of the current `wss.on('connection', ...)` callback into `createLiveBridge`, changing only what the injected factory requires. No behaviour changes.

```ts
// Per-client bridge between the browser and one Gemini live session.
//
// Split out of geminiLiveProxy.ts so the connection logic can be driven by
// fakes in tests: the upstream socket arrives as a factory rather than being
// constructed here, and both sides are typed structurally so `ws`'s
// WebSocket satisfies them without this module importing `ws` at all.

export const CONNECTING = 0;
export const OPEN = 1;

export interface SocketLike {
  readonly readyState: number;
  send(data: string | Buffer, opts?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(event: string, cb: (...args: any[]) => void): this;
}

export type OpenUpstream = () => SocketLike;

export interface BridgeOptions {
  model: string;
  targetLanguageCode: string;
  sourceLanguageCodes: string[];
  openUpstream: OpenUpstream;
}

export const GLOSSARY_WAIT_MS = 1500;
export const MAX_VOCABULARY_TERMS = 500;
export const MAX_TERM_LENGTH = 100;
export const MAX_PENDING_FRAMES = 150;
export const MAX_GLOSSARY_PAIRS = 200;

export const ALLOWED_TARGET_LANGS = ['en', 'th'];
export const ALLOWED_SOURCE_LANGS = ['en-US', 'th-TH', 'en', 'th'];

export function sanitizeLangs(value: unknown, allowed: string[]): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && allowed.includes(v));
}

export function cleanTerm(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/["\r\n]/g, ' ').trim().slice(0, MAX_TERM_LENGTH);
}

export function buildGlossaryInstruction(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const lines: string[] = [];
  for (const pair of value.slice(0, MAX_GLOSSARY_PAIRS)) {
    const term = cleanTerm((pair as { term?: unknown })?.term);
    const translation = cleanTerm((pair as { translation?: unknown })?.translation);
    if (term && translation) lines.push(`"${term}" must always be translated as "${translation}".`);
  }
  if (lines.length === 0) return null;
  return `Glossary — use these exact translations, overriding your own wording:\n${lines.join('\n')}`;
}

export function sanitizeVocabulary(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const term = item.trim().slice(0, MAX_TERM_LENGTH);
    if (term) seen.add(term);
    if (seen.size >= MAX_VOCABULARY_TERMS) break;
  }
  return [...seen];
}

export function createLiveBridge(client: SocketLike, opts: BridgeOptions): void {
  const upstream = opts.openUpstream();

  let upstreamReady = false;
  let setupSent = false;
  let configReceived = false;
  let vocabulary: string[] = [];
  let glossaryInstruction: string | null = null;
  let targetLanguageCode = opts.targetLanguageCode;
  let sourceLanguageCodes = opts.sourceLanguageCodes;
  const pending: Buffer[] = [];

  const closeBoth = (code?: number, reason?: string) => {
    clearTimeout(glossaryTimer);
    if (client.readyState === OPEN || client.readyState === CONNECTING) client.close(code, reason);
    if (upstream.readyState === OPEN || upstream.readyState === CONNECTING) upstream.close();
  };

  const sendSetup = () => {
    if (setupSent || upstream.readyState !== OPEN) return;
    setupSent = true;
    clearTimeout(glossaryTimer);

    const inputAudioTranscription: Record<string, unknown> = { languageCodes: sourceLanguageCodes };
    // adaptationPhrases would do the same job but is marked deprecated in
    // the API's discovery document, so only customVocabulary is used.
    if (vocabulary.length > 0) inputAudioTranscription.customVocabulary = vocabulary;

    const setup: Record<string, unknown> = {
      model: `models/${opts.model}`,
      generationConfig: { responseModalities: ['TEXT'], translationConfig: { targetLanguageCode } },
      inputAudioTranscription
    };
    if (glossaryInstruction) setup.systemInstruction = { parts: [{ text: glossaryInstruction }] };

    upstream.send(JSON.stringify({ setup }));
  };

  const glossaryTimer = setTimeout(sendSetup, GLOSSARY_WAIT_MS);

  upstream.on('open', () => {
    if (configReceived) sendSetup();
  });

  upstream.on('message', (data: Buffer, isBinary: boolean) => {
    let parsed: Record<string, any> | null = null;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      parsed = null;
    }

    if (!upstreamReady && parsed?.setupComplete) {
      upstreamReady = true;
      for (const queued of pending.splice(0)) upstream.send(queued);
    }

    const parts = parsed?.serverContent?.modelTurn?.parts;
    if (Array.isArray(parts) && parts.length > 0 && parts.every((p: any) => p?.inlineData && !p.text)) {
      return;
    }

    if (client.readyState === OPEN) client.send(data, { binary: isBinary });
  });

  upstream.on('close', (code: number, reason: Buffer) => closeBoth(code, reason?.toString()));
  upstream.on('error', () => closeBoth(1011, 'upstream Gemini connection failed'));

  client.on('message', (data: Buffer, isBinary: boolean) => {
    if (!setupSent) {
      try {
        const parsed = JSON.parse(data.toString());
        if (
          parsed?.customVocabulary !== undefined ||
          parsed?.targetLanguageCode !== undefined ||
          parsed?.glossaryPairs !== undefined
        ) {
          configReceived = true;
          vocabulary = sanitizeVocabulary(parsed.customVocabulary);
          glossaryInstruction = buildGlossaryInstruction(parsed.glossaryPairs);
          const target = sanitizeLangs([parsed.targetLanguageCode], ALLOWED_TARGET_LANGS);
          if (target.length > 0) targetLanguageCode = target[0];
          const sources = sanitizeLangs(parsed.sourceLanguageCodes, ALLOWED_SOURCE_LANGS);
          if (sources.length > 0) sourceLanguageCodes = sources;
          sendSetup();
          return;
        }
      } catch {
        // Not a config frame — fall through and treat as normal traffic.
      }
    }

    if (upstreamReady) {
      upstream.send(data, { binary: isBinary });
    } else {
      if (pending.length >= MAX_PENDING_FRAMES) pending.shift();
      pending.push(data);
    }
  });

  client.on('close', () => closeBoth());
  client.on('error', () => closeBoth());
}
```

- [ ] **Step 4: Reduce the proxy to wiring**

Replace `server/geminiLiveProxy.ts` with:

```ts
import type { Server as HttpServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { createLiveBridge } from './geminiLiveBridge';

// Relays microphone audio from the browser to Gemini's live translation
// model and streams the transcription/translation back.
//
// Security model: the browser only ever talks to OUR WebSocket endpoint. It
// never sees GEMINI_API_KEY or the model name — this server is the only
// thing that holds the key and opens the real connection to Gemini. The
// per-connection logic lives in geminiLiveBridge.ts so it can be tested
// without sockets; this file owns only the endpoint and the API key.

const GEMINI_LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';
const PROXY_PATH = '/ws/gemini-live-transcribe';
const MAX_MESSAGE_BYTES = 1024 * 1024; // audio frames here are small (base64 PCM chunks)

export interface GeminiLiveProxyOptions {
  apiKey: string;
  model: string;
  // BCP-47 code the model translates INTO. Source language is
  // auto-detected — TranslationConfig has no source field (verified
  // against the API's own discovery document).
  targetLanguageCode: string;
  // Hints for the source-audio transcription, which is what surfaces the
  // original speech alongside the translation.
  sourceLanguageCodes: string[];
}

export function registerGeminiLiveProxy(httpServer: HttpServer, opts: GeminiLiveProxyOptions): void {
  const wss = new WebSocketServer({ server: httpServer, path: PROXY_PATH, maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', (client) => {
    createLiveBridge(client, {
      model: opts.model,
      targetLanguageCode: opts.targetLanguageCode,
      sourceLanguageCodes: opts.sourceLanguageCodes,
      openUpstream: () => new WebSocket(`${GEMINI_LIVE_WS_URL}?key=${opts.apiKey}`)
    });
  });
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run && npm run lint`
Expected: all suites PASS (57 existing + 4 new), tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add server/geminiLiveBridge.ts server/geminiLiveBridge.test.ts server/geminiLiveProxy.ts
git commit -m "refactor: extract testable live bridge from the Gemini proxy"
```

---

## Task A2: Request session resumption and context compression

**Files:**
- Modify: `server/geminiLiveBridge.ts`
- Test: `server/geminiLiveBridge.test.ts`

**Interfaces:**
- Consumes: `createLiveBridge`, `FakeSocket`, `makeBridge`, `completeSetup` from Task A1.
- Produces: an internal `buildSetup(resumeHandle: string | null)` used by Task A3's swap; a bridge that tracks `resumeHandle` from `sessionResumptionUpdate`.

- [ ] **Step 1: Write the failing tests**

Append to `server/geminiLiveBridge.test.ts`:

```ts
describe('session resumption', () => {
  it('asks for resumption and context compression in the first setup', () => {
    const { client, upstreams } = makeBridge();
    const up = upstreams[0];
    up.readyState = OPEN;
    up.emit('open');
    client.emit('message', Buffer.from(JSON.stringify({ targetLanguageCode: 'en' })), false);

    const setup = up.jsonSent().find((f) => f.setup)?.setup;
    // No handle on a first connection — an empty object still opts into the
    // sessionResumptionUpdate frames a later swap needs.
    expect(setup.sessionResumption).toEqual({});
    expect(setup.contextWindowCompression).toEqual({ slidingWindow: {} });
  });

  it('does not relay sessionResumptionUpdate or goAway to the client', () => {
    const { client, upstreams } = makeBridge();
    const up = upstreams[0];
    completeSetup(up);
    const before = client.sent.length;
    up.emit('message', Buffer.from(JSON.stringify({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } })), false);
    up.emit('message', Buffer.from(JSON.stringify({ goAway: { timeLeft: '60s' } })), false);
    expect(client.sent.length).toBe(before);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/geminiLiveBridge.test.ts -t "session resumption"`
Expected: FAIL — first test gets `undefined` for `setup.sessionResumption`; second sees the frames relayed.

- [ ] **Step 3: Implement**

In `server/geminiLiveBridge.ts`, add `let resumeHandle: string | null = null;` beside the other per-connection state, then replace `sendSetup` with a builder plus a sender:

```ts
  // Built here rather than from the client's config frame, which is long
  // gone by the time a swap (Task A3) needs to open a replacement session.
  const buildSetup = (handle: string | null): Record<string, unknown> => {
    const inputAudioTranscription: Record<string, unknown> = { languageCodes: sourceLanguageCodes };
    // adaptationPhrases would do the same job but is marked deprecated in
    // the API's discovery document, so only customVocabulary is used.
    if (vocabulary.length > 0) inputAudioTranscription.customVocabulary = vocabulary;

    const setup: Record<string, unknown> = {
      model: `models/${opts.model}`,
      generationConfig: { responseModalities: ['TEXT'], translationConfig: { targetLanguageCode } },
      inputAudioTranscription,
      // An empty object still opts into the sessionResumptionUpdate frames;
      // a handle is only present when replacing an expiring session.
      sessionResumption: handle ? { handle } : {},
      // Left at the API's own defaults rather than invented token counts —
      // without it a long meeting's session can die of context overflow well
      // before the connection cap, making seams more frequent than necessary.
      contextWindowCompression: { slidingWindow: {} }
    };
    if (glossaryInstruction) setup.systemInstruction = { parts: [{ text: glossaryInstruction }] };
    return setup;
  };

  const sendSetup = () => {
    if (setupSent || upstream.readyState !== OPEN) return;
    setupSent = true;
    clearTimeout(glossaryTimer);
    upstream.send(JSON.stringify({ setup: buildSetup(resumeHandle) }));
  };
```

In the upstream `message` handler, immediately after the `setupComplete` block, consume the two control frames:

```ts
    // Both are the proxy's business, not the browser's: relaying goAway would
    // invite the client to react to something being handled here already.
    if (parsed?.sessionResumptionUpdate) {
      const update = parsed.sessionResumptionUpdate;
      // A handle the server has declared unusable must never be offered back.
      resumeHandle = update.resumable === false ? null : (update.newHandle ?? resumeHandle);
      return;
    }
    if (parsed?.goAway) return;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/geminiLiveBridge.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/geminiLiveBridge.ts server/geminiLiveBridge.test.ts
git commit -m "feat: request Gemini session resumption and context compression"
```

---

## Task A3: Swap the upstream instead of dropping the client

**Files:**
- Modify: `server/geminiLiveBridge.ts`
- Test: `server/geminiLiveBridge.test.ts`

**Interfaces:**
- Consumes: `buildSetup`, `resumeHandle` from Task A2.
- Produces: `MAX_UPSTREAM_SWAPS_IN_A_ROW` (exported constant, value 3).

Sequential, never concurrent: the old upstream is closed before the replacement opens, so there is no window in which two Gemini sessions could emit text for the same audio. Audio arriving during the swap takes the `pending` path that already exists for the initial handshake.

- [ ] **Step 1: Write the failing tests**

Append to `server/geminiLiveBridge.test.ts`:

```ts
describe('upstream swap', () => {
  it('opens a replacement on goAway and keeps the client socket open', () => {
    const { client, upstreams } = makeBridge();
    completeSetup(upstreams[0]);
    upstreams[0].emit('message', Buffer.from(JSON.stringify({ goAway: { timeLeft: '60s' } })), false);

    expect(upstreams).toHaveLength(2);
    expect(upstreams[0].closed).not.toBeNull();
    expect(client.closed).toBeNull();
  });

  it('resumes the replacement with the latest handle', () => {
    const { upstreams } = makeBridge();
    completeSetup(upstreams[0]);
    upstreams[0].emit('message', Buffer.from(JSON.stringify({ sessionResumptionUpdate: { newHandle: 'h9', resumable: true } })), false);
    upstreams[0].emit('message', Buffer.from(JSON.stringify({ goAway: {} })), false);

    completeSetup(upstreams[1]);
    const setup = upstreams[1].jsonSent().find((f) => f.setup)?.setup;
    expect(setup.sessionResumption).toEqual({ handle: 'h9' });
  });

  it('opens a fresh session when the server said the handle is not resumable', () => {
    const { upstreams } = makeBridge();
    completeSetup(upstreams[0]);
    upstreams[0].emit('message', Buffer.from(JSON.stringify({ sessionResumptionUpdate: { newHandle: 'h9', resumable: true } })), false);
    upstreams[0].emit('message', Buffer.from(JSON.stringify({ sessionResumptionUpdate: { resumable: false } })), false);
    upstreams[0].emit('message', Buffer.from(JSON.stringify({ goAway: {} })), false);

    completeSetup(upstreams[1]);
    const setup = upstreams[1].jsonSent().find((f) => f.setup)?.setup;
    expect(setup.sessionResumption).toEqual({});
  });

  it('queues audio during the swap and flushes it into the replacement', () => {
    const { client, upstreams } = makeBridge();
    completeSetup(upstreams[0]);
    upstreams[0].emit('message', Buffer.from(JSON.stringify({ goAway: {} })), false);

    client.emit('message', Buffer.from('mid-swap-audio'), true);
    completeSetup(upstreams[1]);

    expect(upstreams[1].sent.map((s) => s.toString())).toContain('mid-swap-audio');
  });

  it('swaps on an unexpected close with no goAway', () => {
    const { client, upstreams } = makeBridge();
    completeSetup(upstreams[0]);
    upstreams[0].emit('close', 1006, Buffer.from(''));

    expect(upstreams).toHaveLength(2);
    expect(client.closed).toBeNull();
  });

  it('opens at most three replacements before giving up to the client', () => {
    const { client, upstreams } = makeBridge();
    completeSetup(upstreams[0]);

    // Three closes buy three replacements; the fourth is refused.
    upstreams[0].emit('close', 1006, Buffer.from(''));
    upstreams[1].emit('close', 1006, Buffer.from(''));
    upstreams[2].emit('close', 1006, Buffer.from(''));
    expect(upstreams).toHaveLength(4);
    expect(client.closed).toBeNull();

    upstreams[3].emit('close', 1006, Buffer.from(''));
    expect(upstreams).toHaveLength(4);
    expect(client.closed).not.toBeNull();
  });

  it('resets the swap budget after a replacement completes setup', () => {
    const { client, upstreams } = makeBridge();
    completeSetup(upstreams[0]);
    upstreams[0].emit('close', 1006, Buffer.from('')); // replacement 1 → [1]
    upstreams[1].emit('close', 1006, Buffer.from('')); // replacement 2 → [2]

    // A healthy handshake buys a full budget again, so the next three closes
    // each get a replacement rather than hitting the cap two short.
    completeSetup(upstreams[2]);
    upstreams[2].emit('close', 1006, Buffer.from('')); // → [3]
    upstreams[3].emit('close', 1006, Buffer.from('')); // → [4]
    upstreams[4].emit('close', 1006, Buffer.from('')); // → [5]
    expect(upstreams).toHaveLength(6);
    expect(client.closed).toBeNull();

    upstreams[5].emit('close', 1006, Buffer.from(''));
    expect(client.closed).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/geminiLiveBridge.test.ts -t "upstream swap"`
Expected: FAIL — only one upstream is ever created, and the client is closed on the first upstream close.

- [ ] **Step 3: Implement**

`upstream` must become reassignable and its handlers must be attachable to each new socket. Restructure the upstream half of `createLiveBridge`:

```ts
export const MAX_UPSTREAM_SWAPS_IN_A_ROW = 3;
```

```ts
  // Definite-assignment: attachUpstream sets this before any handler that
  // reads it can fire, but TypeScript cannot see that through the closures.
  let upstream!: SocketLike;
  let swapsSinceSetup = 0;
  let clientGone = false;

  const attachUpstream = (socket: SocketLike) => {
    upstream = socket;
    setupSent = false;
    upstreamReady = false;

    socket.on('open', () => {
      // A swap has its config already; only the very first connection waits
      // for the browser's glossary frame.
      if (configReceived || swapsSinceSetup > 0) sendSetup();
    });

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      // Frames from a socket that has already been replaced are ignored:
      // only the current upstream speaks for this client.
      if (socket !== upstream) return;

      let parsed: Record<string, any> | null = null;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        parsed = null;
      }

      if (!upstreamReady && parsed?.setupComplete) {
        upstreamReady = true;
        swapsSinceSetup = 0;
        for (const queued of pending.splice(0)) upstream.send(queued);
      }

      if (parsed?.sessionResumptionUpdate) {
        const update = parsed.sessionResumptionUpdate;
        resumeHandle = update.resumable === false ? null : (update.newHandle ?? resumeHandle);
        return;
      }
      // Gemini caps a connection at ten minutes and warns 60 s ahead. Swapping
      // here — rather than letting the client socket die and rebuild the whole
      // microphone pipeline — is what keeps a long meeting recording.
      if (parsed?.goAway) {
        swapUpstream();
        return;
      }

      const parts = parsed?.serverContent?.modelTurn?.parts;
      if (Array.isArray(parts) && parts.length > 0 && parts.every((p: any) => p?.inlineData && !p.text)) {
        return;
      }

      if (client.readyState === OPEN) client.send(data, { binary: isBinary });
    });

    socket.on('close', () => {
      if (socket !== upstream) return; // the one we deliberately replaced
      swapUpstream();
    });
    socket.on('error', () => {
      if (socket !== upstream) return;
      swapUpstream();
    });
  };

  // Sequential by design: close first, open second. One upstream at a time
  // means a given stretch of audio reaches exactly one Gemini session, so no
  // caption can ever be transcribed twice.
  //
  // The budget is three replacements without an intervening setupComplete —
  // the fourth attempt gives up to the client rather than looping forever
  // against an upstream that is simply down.
  const swapUpstream = () => {
    if (clientGone) return;
    if (swapsSinceSetup >= MAX_UPSTREAM_SWAPS_IN_A_ROW) {
      closeBoth(1011, 'upstream Gemini connection failed');
      return;
    }
    swapsSinceSetup += 1;
    const previous = upstream;
    if (previous.readyState === OPEN || previous.readyState === CONNECTING) previous.close();
    attachUpstream(opts.openUpstream());
  };
```

`closeBoth` no longer closes "the" upstream by capture — it closes the current one, and marks the client gone so a close cascade cannot re-enter `swapUpstream`:

```ts
  const closeBoth = (code?: number, reason?: string) => {
    clientGone = true;
    clearTimeout(glossaryTimer);
    if (client.readyState === OPEN || client.readyState === CONNECTING) client.close(code, reason);
    if (upstream.readyState === OPEN || upstream.readyState === CONNECTING) upstream.close();
  };
```

Replace the original `const upstream = opts.openUpstream();` and the four `upstream.on(...)` blocks with a single `attachUpstream(opts.openUpstream());` placed after `glossaryTimer` is declared. Keep the client-side handler exactly as it is — it already routes to `pending` whenever `upstreamReady` is false, which is precisely the swap window.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/geminiLiveBridge.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx vitest run && npm run lint`
Expected: all PASS, tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add server/geminiLiveBridge.ts server/geminiLiveBridge.test.ts
git commit -m "feat: swap the Gemini upstream in place instead of dropping the client"
```

---

## Task A4: Unbounded client reconnect with exponential backoff

Five consecutive failures at a flat 800 ms means roughly five seconds of Gemini trouble ends a session permanently, mid-conference. The operator decides when a session is over, so the client retries for as long as one is active.

**Files:**
- Create: `src/asr/audio/reconnectPolicy.ts`
- Create: `src/asr/audio/reconnectPolicy.test.ts`
- Modify: `src/asr/audio/useGeminiLiveCapture.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `reconnectDelayMs(consecutiveFailures: number): number`, `RECONNECT_BASE_DELAY_MS`, `RECONNECT_MAX_DELAY_MS`.

- [ ] **Step 1: Write the failing test**

Create `src/asr/audio/reconnectPolicy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS, reconnectDelayMs } from './reconnectPolicy';

describe('reconnectDelayMs', () => {
  it('waits the base delay after the first failure', () => {
    expect(reconnectDelayMs(1)).toBe(RECONNECT_BASE_DELAY_MS);
  });

  it('doubles with each consecutive failure', () => {
    expect(reconnectDelayMs(2)).toBe(1600);
    expect(reconnectDelayMs(3)).toBe(3200);
    expect(reconnectDelayMs(4)).toBe(6400);
  });

  it('stops growing at the ceiling', () => {
    expect(reconnectDelayMs(5)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(reconnectDelayMs(50)).toBe(RECONNECT_MAX_DELAY_MS);
  });

  it('never returns less than the base delay, whatever it is handed', () => {
    expect(reconnectDelayMs(0)).toBe(RECONNECT_BASE_DELAY_MS);
    expect(reconnectDelayMs(-3)).toBe(RECONNECT_BASE_DELAY_MS);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/asr/audio/reconnectPolicy.test.ts`
Expected: FAIL — `Failed to resolve import "./reconnectPolicy"`.

- [ ] **Step 3: Implement the policy**

Create `src/asr/audio/reconnectPolicy.ts`:

```ts
// How long to wait before the next attempt to reopen the capture socket.
//
// There is deliberately no attempt limit: a conference outlives any fixed
// budget, and the old flat 800 ms × 5 cap meant about five seconds of Gemini
// trouble ended a two-hour session for good. The operator decides when a
// session is over; until then this keeps trying, backing off so a dead
// server is not hammered.
export const RECONNECT_BASE_DELAY_MS = 800;
export const RECONNECT_MAX_DELAY_MS = 10000;

export function reconnectDelayMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** exponent, RECONNECT_MAX_DELAY_MS);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/asr/audio/reconnectPolicy.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Use it in the hook**

In `src/asr/audio/useGeminiLiveCapture.ts`:

Add the import beside the existing ones:

```ts
import { reconnectDelayMs } from './reconnectPolicy';
```

Delete the `RECONNECT_DELAY_MS` and `MAX_RECONNECTS` constants and rewrite the comment above them:

```ts
// A live session does not last forever — Gemini ends it on its own, and a
// conference outlives that easily. The proxy now swaps its own upstream
// (server/geminiLiveBridge.ts), so reaching this path means something else
// broke: the network, or the proxy itself. It retries for as long as the
// session is active, with backoff — see reconnectPolicy.ts.
```

Replace the body of `ws.onclose`:

```ts
    ws.onclose = () => {
      if (disposed) return;
      // Whatever was mid-sentence still belongs to the transcript — commit
      // it before the reconnect wipes this session's buffers.
      emit();
      retriesRef.current += 1;
      teardown();
      setState({ status: 'starting', error: null });
      reconnectTimer = setTimeout(() => setReconnectNonce((n) => n + 1), reconnectDelayMs(retriesRef.current));
    };
```

The `retriesRef.current = 0` reset on `setupComplete` stays exactly as it is — that is what returns the delay to 800 ms once a session is healthy again.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npx vitest run && npm run lint`
Expected: all PASS, tsc exits 0. `MAX_RECONNECTS` must have no remaining references — confirm with `grep -rn "MAX_RECONNECTS" src server`, expecting no output.

- [ ] **Step 7: Commit**

```bash
git add src/asr/audio/reconnectPolicy.ts src/asr/audio/reconnectPolicy.test.ts src/asr/audio/useGeminiLiveCapture.ts
git commit -m "feat: retry capture reconnects with backoff for as long as the session is active"
```

---

## Task A5: Prove the reconnect loop survives a meeting's worth of cycles

Reading the loop found no defect; that is not the same as knowing it survives a dozen cycles without leaking a microphone track or an `AudioContext`.

**Files:**
- Create: `src/asr/audio/useGeminiLiveCapture.test.ts`

**Interfaces:**
- Consumes: `useGeminiLiveCapture` from `./useGeminiLiveCapture`, `reconnectDelayMs` from Task A4.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Create `src/asr/audio/useGeminiLiveCapture.test.ts`:

```ts
// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGeminiLiveCapture } from './useGeminiLiveCapture';
import { emptyGlossary } from '../../glossary';
import { reconnectDelayMs } from './reconnectPolicy';

// jsdom has no WebSocket, no AudioContext and no getUserMedia, so the whole
// browser side is faked here. Each fake records the instances it created so a
// test can assert that a dozen reconnects leave nothing running.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  /** Simulates Gemini finishing its handshake, via the proxy. */
  setupComplete() {
    this.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
  }
  /** Simulates the socket dropping for a reason the proxy could not absorb. */
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const tracks: Array<{ stopped: boolean }> = [];
const contexts: Array<{ closed: boolean }> = [];

class FakeAudioContext {
  sampleRate = 16000;
  destination = {};
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  private record = { closed: false };
  constructor(_opts: unknown) {
    contexts.push(this.record);
  }
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockImplementation(async () => {
    this.record.closed = true;
  });
  createMediaStreamSource = () => ({ connect: () => {} });
  createGain = () => ({ gain: { value: 0 }, connect: () => ({ connect: () => {} }) });
}

class FakeAudioWorkletNode {
  port = { onmessage: null, close: () => {} };
  connect = () => ({ connect: () => {} });
  disconnect = () => {};
  constructor(_ctx: unknown, _name: string, _opts: unknown) {}
}

function makeStream() {
  const track = { stopped: false, addEventListener: () => {}, stop() { this.stopped = true; } };
  tracks.push(track as unknown as { stopped: boolean });
  return { getTracks: () => [track], getAudioTracks: () => [track] };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  tracks.length = 0;
  contexts.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  vi.stubGlobal('isSecureContext', true);
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn().mockImplementation(async () => makeStream()) },
    configurable: true
  });
  URL.createObjectURL = vi.fn().mockReturnValue('blob:fake');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderCapture() {
  return renderHook(() =>
    useGeminiLiveCapture({
      active: true,
      paused: false,
      sourceLang: 'th',
      targetLang: 'en',
      glossary: emptyGlossary(),
      onResult: () => {}
    })
  );
}

/** Lets the hook's queued microtasks and awaited startAudio steps settle. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useGeminiLiveCapture reconnect loop', () => {
  it('keeps reconnecting far past the old five-attempt budget', async () => {
    renderCapture();
    await settle();

    // Ten consecutive failures with no successful setup in between: the old
    // MAX_RECONNECTS of 5 would have stopped opening sockets at six.
    for (let failure = 1; failure <= 10; failure++) {
      const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      await act(async () => {
        socket.drop();
      });
      await act(async () => {
        vi.advanceTimersByTime(reconnectDelayMs(failure));
      });
      await settle();
    }

    expect(FakeWebSocket.instances.length).toBe(11);
  });

  it('returns to the base delay once a session completes setup again', async () => {
    renderCapture();
    await settle();

    const first = FakeWebSocket.instances[0];
    await act(async () => {
      first.drop();
    });
    await act(async () => {
      vi.advanceTimersByTime(reconnectDelayMs(1));
    });
    await settle();

    // A healthy handshake resets the failure count, so the next drop waits
    // the base delay again rather than 1600 ms.
    const second = FakeWebSocket.instances[1];
    await act(async () => {
      second.setupComplete();
    });
    await settle();
    await act(async () => {
      second.drop();
    });
    await act(async () => {
      vi.advanceTimersByTime(reconnectDelayMs(1));
    });
    await settle();

    expect(FakeWebSocket.instances.length).toBe(3);
  });

  it('leaves no microphone track or AudioContext running after a meeting of cycles', async () => {
    renderCapture();
    await settle();

    for (let cycle = 0; cycle < 12; cycle++) {
      const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      await act(async () => {
        socket.setupComplete();
      });
      await settle();
      await act(async () => {
        socket.drop();
      });
      await act(async () => {
        vi.advanceTimersByTime(reconnectDelayMs(1));
      });
      await settle();
    }

    // Every generation but the one currently listening must be torn down.
    expect(tracks.filter((t) => !t.stopped).length).toBeLessThanOrEqual(1);
    expect(contexts.filter((c) => !c.closed).length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/asr/audio/useGeminiLiveCapture.test.ts`
Expected: FAIL. If Task A4 is already committed the first test may pass; the third is the one that must fail before any leak fix, and any failure here is a real finding — investigate before adjusting the test.

- [ ] **Step 3: Fix whatever the leak test exposes**

If `tracks` or `contexts` show more than one live entry, the fault is in `teardown()` in `src/asr/audio/useGeminiLiveCapture.ts`: `void ctx?.close().catch(() => {})` is fire-and-forget and `stream` is nulled immediately after `getTracks().forEach(t => t.stop())`. Capture the locals before nulling them so a teardown racing an in-flight `startAudio` still stops the stream it created:

```ts
    const teardown = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      framerNode?.port.close();
      framerNode?.disconnect();
      framerNode = null;
      // Captured first: startAudio may still be awaiting a worklet load and
      // would otherwise assign over these after they were nulled, leaving a
      // live microphone track behind on every reconnect.
      const closingStream = stream;
      const closingCtx = ctx;
      stream = null;
      ctx = null;
      closingStream?.getTracks().forEach((t) => t.stop());
      void closingCtx?.close().catch(() => {});
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
      ws = null;
    };
```

If the third test passed at Step 2 without any change, do not apply this edit. Leave `teardown()` exactly as it is, and say so in the Step 6 commit message: the test is then a regression guard for a leak that does not currently exist, which is still worth keeping.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/asr/audio/useGeminiLiveCapture.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx vitest run && npm run lint`
Expected: all PASS, tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/asr/audio/useGeminiLiveCapture.test.ts src/asr/audio/useGeminiLiveCapture.ts
git commit -m "test: exercise the capture reconnect loop across a meeting's worth of cycles"
```

---

# Phase B — Summarising long transcripts

## Task B1: Chunk a transcript by character budget

**Files:**
- Create: `server/summaryChunks.ts`
- Create: `server/summaryChunks.test.ts`

**Interfaces:**
- Consumes: `TranscriptLine` from `./gemini`.
- Produces: `chunkTranscript(lines: TranscriptLine[], budget?: number): TranscriptLine[][]`, `SUMMARY_CHUNK_CHARS`.

- [ ] **Step 1: Write the failing test**

Create `server/summaryChunks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { chunkTranscript, SUMMARY_CHUNK_CHARS } from './summaryChunks';
import type { TranscriptLine } from './gemini';

const line = (n: number, chars = 10): TranscriptLine => ({
  sourceText: 'a'.repeat(chars),
  targetText: `t${n}`
});

describe('chunkTranscript', () => {
  it('returns no chunks for an empty transcript', () => {
    expect(chunkTranscript([])).toEqual([]);
  });

  it('keeps a short transcript in a single chunk', () => {
    const lines = [line(1), line(2), line(3)];
    expect(chunkTranscript(lines)).toEqual([lines]);
  });

  it('splits once the character budget is exceeded', () => {
    const lines = [line(1, 40), line(2, 40), line(3, 40)];
    const chunks = chunkTranscript(lines, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(lines);
  });

  it('never splits a single line across two chunks', () => {
    const chunks = chunkTranscript([line(1, 500), line(2, 10)], 100);
    expect(chunks[0]).toEqual([line(1, 500)]);
    expect(chunks[1]).toEqual([line(2, 10)]);
  });

  it('preserves order and loses nothing', () => {
    const lines = Array.from({ length: 50 }, (_, i) => line(i, 300));
    expect(chunkTranscript(lines, 1000).flat()).toEqual(lines);
  });

  it('defaults to the shared chunk budget', () => {
    const lines = Array.from({ length: 200 }, (_, i) => line(i, 200));
    const chunks = chunkTranscript(lines);
    for (const chunk of chunks) {
      const chars = chunk.reduce((n, l) => n + l.sourceText.length + l.targetText.length, 0);
      // A chunk may exceed the budget only when it holds a single oversized line.
      expect(chars <= SUMMARY_CHUNK_CHARS || chunk.length === 1).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/summaryChunks.test.ts`
Expected: FAIL — `Failed to resolve import "./summaryChunks"`.

- [ ] **Step 3: Implement**

Create `server/summaryChunks.ts`:

```ts
import type { TranscriptLine } from './gemini';

// Chunking is by character count, not line count: captions vary in length by
// an order of magnitude, so "N lines" is not a bound on prompt size and a
// two-hour meeting would still build a prompt no single call can answer.
export const SUMMARY_CHUNK_CHARS = 12000;

function lineChars(line: TranscriptLine): number {
  return line.sourceText.length + line.targetText.length;
}

export function chunkTranscript(lines: TranscriptLine[], budget = SUMMARY_CHUNK_CHARS): TranscriptLine[][] {
  const chunks: TranscriptLine[][] = [];
  let current: TranscriptLine[] = [];
  let used = 0;

  for (const line of lines) {
    const cost = lineChars(line);
    // A line longer than the whole budget becomes its own chunk rather than
    // being split — half a sentence summarises to nonsense.
    if (current.length > 0 && used + cost > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(line);
    used += cost;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/summaryChunks.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/summaryChunks.ts server/summaryChunks.test.ts
git commit -m "feat: chunk transcripts by character budget for summarisation"
```

---

## Task B2: Map-reduce summarisation

**Files:**
- Modify: `server/gemini.ts`
- Test: `server/gemini.test.ts`

**Interfaces:**
- Consumes: `chunkTranscript`, `SUMMARY_CHUNK_CHARS` from Task B1.
- Produces: `summarizeTranscript(client, transcript, model, opts?)` where `opts` is `{ concurrency?: number; callTimeoutMs?: number }`; exported constants `SUMMARY_MAP_CONCURRENCY`, `SUMMARY_CALL_TIMEOUT_MS`.

Signature and return type are unchanged for existing callers: `Promise<string>`, throwing only when every chunk fails.

- [ ] **Step 1: Write the failing tests**

Append to `server/gemini.test.ts`:

```ts
describe('summarizeTranscript over long transcripts', () => {
  const longLine = (n: number) => ({ sourceText: 'x'.repeat(6000), targetText: `t${n}` });

  it('summarises each chunk and reduces the partials into one summary', async () => {
    const prompts: string[] = [];
    const client = {
      generateContent: async ({ contents }: any) => {
        const text = contents[0].parts[0].text as string;
        prompts.push(text);
        return { text: text.includes('partial summaries') ? 'FINAL' : 'partial' };
      }
    };
    const transcript = [longLine(1), longLine(2), longLine(3)];

    const summary = await summarizeTranscript(client, transcript, 'm');

    expect(summary).toBe('FINAL');
    // Three 12k-char lines against a 12000-char budget: one map call each,
    // plus the reduce.
    expect(prompts).toHaveLength(4);
  });

  it('skips the reduce call when the transcript fits in one chunk', async () => {
    let calls = 0;
    const client = {
      generateContent: async () => {
        calls += 1;
        return { text: 'only summary' };
      }
    };
    const summary = await summarizeTranscript(client, [{ sourceText: 'hi', targetText: 'สวัสดี' }], 'm');
    expect(summary).toBe('only summary');
    expect(calls).toBe(1);
  });

  it('keeps partial summaries in transcript order however they resolve', async () => {
    const client = {
      generateContent: async ({ contents }: any) => {
        const text = contents[0].parts[0].text as string;
        if (text.includes('partial summaries')) return { text };
        // The second chunk resolves first.
        const delay = text.includes('t1') ? 20 : 0;
        await new Promise((r) => setTimeout(r, delay));
        return { text: text.includes('t1') ? 'FIRST' : 'SECOND' };
      }
    };
    const summary = await summarizeTranscript(client, [longLine(1), longLine(2)], 'm');
    expect(summary.indexOf('FIRST')).toBeLessThan(summary.indexOf('SECOND'));
  });

  it('marks a failed chunk as a gap and keeps the rest', async () => {
    const client = {
      generateContent: async ({ contents }: any) => {
        const text = contents[0].parts[0].text as string;
        if (text.includes('partial summaries')) return { text };
        if (text.includes('t2')) throw new Error('chunk exploded');
        return { text: 'GOOD' };
      }
    };
    const summary = await summarizeTranscript(client, [longLine(1), longLine(2)], 'm');
    expect(summary).toContain('GOOD');
    expect(summary).toMatch(/สรุปช่วงนี้ไม่สำเร็จ/);
  });

  it('throws when every chunk fails, so the route can fall back', async () => {
    const client = {
      generateContent: async () => {
        throw new Error('all down');
      }
    };
    await expect(summarizeTranscript(client, [longLine(1), longLine(2)], 'm')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/gemini.test.ts -t "long transcripts"`
Expected: FAIL — the current single-call implementation makes one call, never four, and never produces a gap marker.

- [ ] **Step 3: Implement**

Replace `summarizeTranscript` in `server/gemini.ts` (keep `GenerateContentClient` and `TranscriptLine` as they are):

```ts
import { chunkTranscript } from './summaryChunks';

// Map calls run in parallel, but not unboundedly: four keeps a twelve-chunk
// job's wall-clock reasonable without stampeding the API's rate limits.
export const SUMMARY_MAP_CONCURRENCY = 4;
export const SUMMARY_CALL_TIMEOUT_MS = 20000;

const GAP_MARKER = '[สรุปช่วงนี้ไม่สำเร็จ — บทสนทนายังถูกเก็บไว้ครบ]';

function renderLines(lines: TranscriptLine[], offset: number): string {
  return lines.map((line, i) => `[${offset + i + 1}] ${line.sourceText} => ${line.targetText}`).join('\n');
}

async function callWithTimeout(
  client: GenerateContentClient,
  model: string,
  prompt: string,
  timeoutMs: number
): Promise<string> {
  const response = await Promise.race([
    client.generateContent({ model, contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('generateContent timed out')), timeoutMs))
  ]);
  if (!response.text) {
    throw new Error('Gemini returned an empty response (possibly safety-blocked)');
  }
  return response.text.trim();
}

/** Runs `task` over `items`, at most `limit` at a time, results in input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function summarizeTranscript(
  client: GenerateContentClient,
  transcript: TranscriptLine[],
  model: string,
  opts: { concurrency?: number; callTimeoutMs?: number } = {}
): Promise<string> {
  const concurrency = opts.concurrency ?? SUMMARY_MAP_CONCURRENCY;
  const callTimeoutMs = opts.callTimeoutMs ?? SUMMARY_CALL_TIMEOUT_MS;
  const chunks = chunkTranscript(transcript);

  // A transcript that fits in one prompt keeps the old single-call shape —
  // a summary of one summary reads worse than the summary itself.
  if (chunks.length <= 1) {
    const prompt = [
      'Summarize the following conference transcript into a concise set of key points, in the language the transcript is mostly in.',
      'Transcript:',
      renderLines(transcript, 0)
    ].join('\n');
    return callWithTimeout(client, model, prompt, callTimeoutMs);
  }

  const offsets: number[] = [];
  let running = 0;
  for (const chunk of chunks) {
    offsets.push(running);
    running += chunk.length;
  }

  let anySucceeded = false;
  const partials = await mapWithConcurrency(chunks, concurrency, async (chunk, index) => {
    const prompt = [
      `Summarize part ${index + 1} of ${chunks.length} of a conference transcript into terse bullet points,`,
      'in the language the transcript is mostly in. Do not add a preamble.',
      'Transcript:',
      renderLines(chunk, offsets[index])
    ].join('\n');
    try {
      const text = await callWithTimeout(client, model, prompt, callTimeoutMs);
      anySucceeded = true;
      return text;
    } catch {
      // One bad chunk must not cost the operator the other eleven — the gap
      // is named so the summary does not silently misrepresent the meeting.
      return GAP_MARKER;
    }
  });

  if (!anySucceeded) {
    throw new Error('every transcript chunk failed to summarize');
  }

  const reducePrompt = [
    'The following are partial summaries of consecutive parts of one conference transcript, in order.',
    'Merge them into a single concise set of key points, in the language they are mostly in.',
    'Keep any line that reports a failed part as its own note.',
    '',
    partials.join('\n\n')
  ].join('\n');
  return callWithTimeout(client, model, reducePrompt, callTimeoutMs);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/gemini.test.ts`
Expected: PASS — the two original tests plus five new ones.

- [ ] **Step 5: Commit**

```bash
git add server/gemini.ts server/gemini.test.ts
git commit -m "feat: summarise long transcripts with map-reduce over chunks"
```

---

## Task B3: Raise the route and client budgets

**Files:**
- Modify: `server/geminiRoutes.ts`
- Modify: `src/pages/Admin.tsx` (line 45 constant, and the summary popup's props)
- Modify: `src/components/ProjectPanel.tsx` (`SessionSummaryModal` waiting copy)
- Test: `server/geminiRoutes.test.ts`

**Interfaces:**
- Consumes: `summarizeTranscript` from Task B2.
- Produces: `SessionSummaryModal` gains an optional prop `summarizingSince?: number | null` (epoch ms when the current request started, `null` when idle).

- [ ] **Step 1: Write the failing test**

`server/geminiRoutes.test.ts` builds a real server with `withServer` and calls it with `fetch` — there is no supertest in this repo, so reuse that harness. It currently mounts `express.json()` at its default 100 kb body limit, which a 5000-item payload exceeds; give the harness an optional limit.

Change `withServer`'s signature and body line:

```ts
async function withServer(
  deps: { client: GenerateContentClient; summaryModel: string },
  run: (baseUrl: string) => Promise<void>,
  bodyLimit = '100kb'
) {
  const app = express();
  app.use(express.json({ limit: bodyLimit }));
```

Then append the test:

```ts
it('accepts a transcript far larger than the old two-thousand item cap', async () => {
  const client = fakeClient('ok');
  const items = Array.from({ length: 5000 }, (_, i) => ({ source_text: `s${i}`, target_text: `t${i}` }));
  await withServer(
    { client, summaryModel: 'm' },
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/gemini/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items })
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.items).toBe(5000);
    },
    // Production mounts express.json({ limit: "5mb" }) in server.ts, so this
    // only lifts the test harness to match — no production change is needed.
    '5mb'
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/geminiRoutes.test.ts`
Expected: FAIL — 400 `Too many items (max 2000)`.

- [ ] **Step 3: Implement the server side**

In `server/geminiRoutes.ts`:

```ts
// The whole map-reduce job, not one model call — each individual call has its
// own SUMMARY_CALL_TIMEOUT_MS inside summarizeTranscript.
const SUMMARIZE_TIMEOUT_MS = 150000;

// Caps the summarize payload so one request can't build an unbounded prompt.
// Sized for a ~3 hour meeting; the prompt itself is bounded by chunking.
const MAX_SUMMARIZE_ITEMS = 6000;
```

Everything else in the route is unchanged: `withTimeout` now guards the whole job, and the `catch` still returns `{ summary: '', items }` so an AI failure never loses the transcript.

- [ ] **Step 4: Raise the client budget and say how long it may take**

In `src/pages/Admin.tsx`:

```ts
// Bounded wait for a summary before giving up and showing the "AI summary
// failed" state. A two-hour transcript is summarised chunk by chunk on the
// server, so this must stay comfortably above the server's own job budget
// (SUMMARIZE_TIMEOUT_MS, 150s) or the client abandons work about to succeed.
const REPORT_WAIT_TIMEOUT_MS = 180000;
```

Track when the request started, so the popup can show elapsed time. Beside the other `useState` declarations:

```ts
  const [summarizingSince, setSummarizingSince] = useState<number | null>(null);
```

In `summarizeSession`, set it next to `markSessionSummarizing` and clear it in a `finally`:

```ts
    setSummarySessionId(session.id);
    setSummarizingSince(Date.now());
    projects.markSessionSummarizing(session.asrSessionId);
```

```ts
    } catch {
      // An AI failure never loses the transcript — the session keeps it, and
      // the operator can ask again.
      projects.saveSessionSummary(session.asrSessionId, '', items.length);
    } finally {
      setSummarizingSince(null);
    }
```

Pass it where `SessionSummaryModal` is rendered: `summarizingSince={summarizingSince}`.

- [ ] **Step 5: Show elapsed time in the popup**

In `src/components/ProjectPanel.tsx`, add the prop to `SessionSummaryModal`'s signature (`summarizingSince?: number | null;` in the type, `summarizingSince` in the destructure) and a ticking elapsed counter above the `return`:

```ts
  // A one-to-two minute wait with a static spinner reads as a hang. No
  // progress protocol exists — elapsed time is the honest thing to show.
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (!isSummarizing || !summarizingSince) return;
    const tick = () => setElapsedSec(Math.floor((Date.now() - summarizingSince) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isSummarizing, summarizingSince]);
```

Replace the waiting copy inside the `isSummarizing` branch:

```tsx
              <span>
                กำลังสรุปผลการประชุมด้วย AI… ({elapsedSec} วินาที) — การประชุมยาวอาจใช้เวลาถึง 2-3 นาที
                หน้าต่างนี้จะแสดงผลเมื่อเสร็จ
              </span>
```

Add `useEffect` and `useState` to the file's `react` import if they are not already there.

- [ ] **Step 6: Run everything**

Run: `npx vitest run && npm run lint`
Expected: all PASS, tsc exits 0.

- [ ] **Step 7: Commit**

```bash
git add server/geminiRoutes.ts server/geminiRoutes.test.ts src/pages/Admin.tsx src/components/ProjectPanel.tsx
git commit -m "feat: raise summary budgets for long meetings and show elapsed time"
```

---

# Phase C — Persistence failure channel

## Task C1: A storage adapter that reports failure

**Files:**
- Create: `src/storage/projectStore.ts`
- Create: `src/storage/projectStore.test.ts`

**Interfaces:**
- Consumes: `Project` from `../types`.
- Produces:
  ```ts
  export type PersistFailureReason = 'quota' | 'unavailable' | 'unknown';
  export type PersistResult = { ok: true } | { ok: false; reason: PersistFailureReason; message: string };
  export interface ProjectStore {
    loadProjects(): Project[];
    saveProjects(projects: Project[]): PersistResult;
    loadSelectedId(): string | null;
    saveSelectedId(id: string | null): PersistResult;
  }
  export function createLocalStorageProjectStore(storage?: Storage): ProjectStore;
  export const localStorageProjectStore: ProjectStore;
  export const STORAGE_KEY = 'ai_translate_projects';
  export const SELECTED_KEY = 'ai_translate_selected_project';
  ```

- [ ] **Step 1: Write the failing test**

Create `src/storage/projectStore.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createLocalStorageProjectStore, STORAGE_KEY } from './projectStore';
import type { Project } from '../types';

class MemoryStorage implements Storage {
  store = new Map<string, string>();
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
    this.store.set(key, value);
  }
}

const project = (): Project => ({
  id: 'p1',
  name: 'Test',
  status: 'active',
  sessions: [],
  transcripts: [],
  createdAt: 1
});

describe('localStorage project store', () => {
  it('round-trips projects', () => {
    const store = createLocalStorageProjectStore(new MemoryStorage());
    expect(store.saveProjects([project()])).toEqual({ ok: true });
    expect(store.loadProjects()).toEqual([project()]);
  });

  it('reports a quota failure instead of swallowing it', () => {
    const storage = new MemoryStorage();
    storage.setItem = () => {
      const err = new Error('exceeded');
      err.name = 'QuotaExceededError';
      throw err;
    };
    const result = createLocalStorageProjectStore(storage).saveProjects([project()]);
    expect(result).toMatchObject({ ok: false, reason: 'quota' });
  });

  it('reports storage that is switched off entirely', () => {
    const storage = new MemoryStorage();
    storage.setItem = () => {
      throw new Error('access denied');
    };
    const result = createLocalStorageProjectStore(storage).saveProjects([project()]);
    expect(result).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('falls back to an empty list on corrupt stored JSON', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, '{not json');
    expect(createLocalStorageProjectStore(storage).loadProjects()).toEqual([]);
  });

  it('backfills fields that predate per-project transcripts', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify([{ id: 'p1', name: 'Old', status: 'active', sessions: [], createdAt: 1 }]));
    const [loaded] = createLocalStorageProjectStore(storage).loadProjects();
    expect(loaded.transcripts).toEqual([]);
    expect(loaded.asrSessionId).toBeNull();
  });

  it('reports unavailable when there is no storage at all', () => {
    const store = createLocalStorageProjectStore(undefined);
    expect(store.loadProjects()).toEqual([]);
    expect(store.saveProjects([project()])).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/storage/projectStore.test.ts`
Expected: FAIL — `Failed to resolve import "./projectStore"`.

- [ ] **Step 3: Implement**

Create `src/storage/projectStore.ts`:

```ts
import type { Project } from '../types';

// Every write to project storage goes through here, and every write reports
// whether it worked. The old code swallowed failures in a bare catch, so a
// full disk quota looked exactly like a successful recording.
//
// Nothing in this interface knows about localStorage. The database phase adds
// a second adapter and changes the default below; `PersistResult` gains
// reasons ('network', 'auth') and the banner's copy follows. Everything else
// — the hook, the banner, the backup button — is untouched by that change.

export const STORAGE_KEY = 'ai_translate_projects';
export const SELECTED_KEY = 'ai_translate_selected_project';

export type PersistFailureReason = 'quota' | 'unavailable' | 'unknown';

export type PersistResult = { ok: true } | { ok: false; reason: PersistFailureReason; message: string };

export interface ProjectStore {
  loadProjects(): Project[];
  saveProjects(projects: Project[]): PersistResult;
  loadSelectedId(): string | null;
  saveSelectedId(id: string | null): PersistResult;
}

function isQuotaError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Browsers disagree on the name, and Firefox historically used a code.
  return (
    error.name === 'QuotaExceededError' ||
    error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    (error as { code?: number }).code === 22
  );
}

function toFailure(error: unknown): PersistResult {
  const message = error instanceof Error ? error.message : String(error);
  if (isQuotaError(error)) {
    return { ok: false, reason: 'quota', message };
  }
  return { ok: false, reason: 'unknown', message };
}

export function createLocalStorageProjectStore(storage?: Storage): ProjectStore {
  const unavailable = (): PersistResult => ({
    ok: false,
    reason: 'unavailable',
    message: 'localStorage is not available in this browser context'
  });

  return {
    loadProjects() {
      if (!storage) return [];
      try {
        const stored = storage.getItem(STORAGE_KEY);
        const parsed: Project[] = stored ? JSON.parse(stored) : [];
        // Projects saved before per-project transcripts or ASR sessions
        // existed have neither field yet.
        return parsed.map((p) => ({ ...p, transcripts: p.transcripts || [], asrSessionId: p.asrSessionId ?? null }));
      } catch {
        return [];
      }
    },
    saveProjects(projects) {
      if (!storage) return unavailable();
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(projects));
        return { ok: true };
      } catch (error) {
        return toFailure(error);
      }
    },
    loadSelectedId() {
      if (!storage) return null;
      try {
        return storage.getItem(SELECTED_KEY);
      } catch {
        return null;
      }
    },
    saveSelectedId(id) {
      if (!storage) return unavailable();
      try {
        if (id) storage.setItem(SELECTED_KEY, id);
        else storage.removeItem(SELECTED_KEY);
        return { ok: true };
      } catch (error) {
        return toFailure(error);
      }
    }
  };
}

// Resolved lazily per call rather than captured at module load: the test
// suite replaces window.localStorage after this module is imported.
export const localStorageProjectStore: ProjectStore = {
  loadProjects: () => createLocalStorageProjectStore(safeStorage()).loadProjects(),
  saveProjects: (p) => createLocalStorageProjectStore(safeStorage()).saveProjects(p),
  loadSelectedId: () => createLocalStorageProjectStore(safeStorage()).loadSelectedId(),
  saveSelectedId: (id) => createLocalStorageProjectStore(safeStorage()).saveSelectedId(id)
};

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    // Some browsers throw on the accessor itself when site data is blocked.
    return undefined;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/storage/projectStore.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/projectStore.ts src/storage/projectStore.test.ts
git commit -m "feat: add a project store that reports persistence failures"
```

---

## Task C2: Surface persistence failures from useProjects

**Files:**
- Modify: `src/hooks/useProjects.ts`
- Test: `src/hooks/useProjects.test.ts`

**Interfaces:**
- Consumes: `ProjectStore`, `PersistFailureReason`, `localStorageProjectStore` from Task C1.
- Produces: `useProjects(store?: ProjectStore)`; the returned object gains `persistError: { reason: PersistFailureReason; message: string; at: number } | null`.

- [ ] **Step 1: Write the failing test**

Append to `src/hooks/useProjects.test.ts`:

```ts
describe('persistence failures', () => {
  function failingStore(fail: { value: boolean }) {
    return {
      loadProjects: () => [],
      saveProjects: () =>
        fail.value ? ({ ok: false, reason: 'quota', message: 'full' } as const) : ({ ok: true } as const),
      loadSelectedId: () => null,
      saveSelectedId: () => ({ ok: true } as const)
    };
  }

  it('exposes a failed write instead of swallowing it', () => {
    const fail = { value: true };
    const { result } = renderHook(() => useProjects(failingStore(fail)));

    act(() => {
      result.current.createProject('งานประชุม');
    });

    expect(result.current.persistError).toMatchObject({ reason: 'quota' });
  });

  it('clears the error once a write succeeds again', () => {
    const fail = { value: true };
    const { result } = renderHook(() => useProjects(failingStore(fail)));

    act(() => {
      result.current.createProject('งานประชุม');
    });
    expect(result.current.persistError).not.toBeNull();

    fail.value = false;
    act(() => {
      result.current.createProject('อีกงาน');
    });
    expect(result.current.persistError).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/hooks/useProjects.test.ts -t "persistence failures"`
Expected: FAIL — `useProjects` takes no argument and returns no `persistError`.

- [ ] **Step 3: Implement**

In `src/hooks/useProjects.ts`:

Replace the `STORAGE_KEY`/`SELECTED_KEY` constants and the `loadProjects`/`loadSelectedId` helpers with an import:

```ts
import {
  localStorageProjectStore,
  type PersistFailureReason,
  type ProjectStore
} from '../storage/projectStore';
```

Change the signature and initial state:

```ts
export function useProjects(store: ProjectStore = localStorageProjectStore) {
  const [projects, setProjects] = useState<Project[]>(() => store.loadProjects());
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => store.loadSelectedId());
  const [summarizingIds, setSummarizingIds] = useState<Set<string>>(() => new Set());
  // A write that fails is the operator's problem, not something to hide: with
  // no signal here a full quota looks exactly like a working recording.
  const [persistError, setPersistError] = useState<{
    reason: PersistFailureReason;
    message: string;
    at: number;
  } | null>(null);
```

Replace both persistence effects:

```ts
  useEffect(() => {
    const result = store.saveProjects(projects);
    setPersistError(result.ok ? null : { reason: result.reason, message: result.message, at: Date.now() });
  }, [projects, store]);

  useEffect(() => {
    const result = store.saveSelectedId(selectedProjectId);
    if (!result.ok) setPersistError({ reason: result.reason, message: result.message, at: Date.now() });
  }, [selectedProjectId, store]);
```

Add `persistError` to the returned object, after `summarizingIds`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/hooks/useProjects.test.ts`
Expected: PASS — the 8 existing tests plus 2 new ones. The existing tests drive the default localStorage store through their `FakeStorage` stub and must keep passing untouched; if one fails, `localStorageProjectStore` is resolving storage too early — check `safeStorage()` is called per operation, not at module load.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useProjects.ts src/hooks/useProjects.test.ts
git commit -m "feat: expose persistence failures from useProjects"
```

---

## Task C3: Warn the operator and offer a backup

**Files:**
- Modify: `src/pages/Admin.tsx`

**Interfaces:**
- Consumes: `projects.persistError` from Task C2.
- Produces: nothing.

- [ ] **Step 1: Add the banner and the backup download**

In `src/pages/Admin.tsx`, add a download helper beside the other caption actions:

```ts
  // The escape hatch when storage is refusing writes: whatever is still in
  // memory leaves the browser as a file the operator controls.
  const downloadProjectBackup = () => {
    const payload = JSON.stringify(
      { exportedAt: new Date().toISOString(), projects: [...projects.activeProjects, ...projects.endedProjects] },
      null,
      2
    );
    const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backup-projects-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
```

Render the banner as the first child inside `<main>`, above the subtitle box, so it cannot be scrolled past:

```tsx
          {projects.persistError && (
            <div className="shrink-0 flex items-start gap-2.5 m-3 p-3 bg-rose-50 border border-rose-300 rounded-xl text-rose-800 text-xs leading-relaxed">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-bold">บันทึกข้อมูลไม่สำเร็จ — การประชุมนี้อาจไม่ถูกเก็บไว้</p>
                <p className="mt-0.5">
                  {projects.persistError.reason === 'quota'
                    ? 'พื้นที่จัดเก็บในเบราว์เซอร์เต็ม กรุณาดาวน์โหลดสำรองไว้ แล้วจบโปรเจกต์เก่าที่ไม่ใช้แล้ว'
                    : projects.persistError.reason === 'unavailable'
                    ? 'เบราว์เซอร์นี้ปิดการจัดเก็บข้อมูลไว้ กรุณาดาวน์โหลดสำรองก่อนปิดหน้านี้'
                    : 'เกิดข้อผิดพลาดที่ไม่รู้จัก กรุณาดาวน์โหลดสำรองก่อนปิดหน้านี้'}
                </p>
              </div>
              <button
                onClick={downloadProjectBackup}
                className="shrink-0 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg font-semibold flex items-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                <span>ดาวน์โหลดสำรอง</span>
              </button>
            </div>
          )}
```

`ShieldAlert` and `Download` are already imported in this file — confirm rather than re-adding them.

There is deliberately no dismiss button: the condition does not resolve itself, and a dismissed banner would restore exactly the silence being fixed.

- [ ] **Step 2: Verify it builds and renders**

Run: `npx vitest run && npm run lint && npm run build`
Expected: all PASS, tsc exits 0, vite build succeeds.

- [ ] **Step 3: Verify by hand**

Run `npm run dev`, open the console, and fill storage to force the failure:

```js
try { for (let i = 0; i < 1e4; i++) localStorage.setItem('flood' + i, 'x'.repeat(100000)); } catch (e) { console.log('full:', e.name); }
```

Then create a project in the UI. Expected: the rose banner appears, and "ดาวน์โหลดสำรอง" saves a JSON file containing the projects. Clean up with `Object.keys(localStorage).filter(k => k.startsWith('flood')).forEach(k => localStorage.removeItem(k))`, then reload — the banner clears on the next successful write.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Admin.tsx
git commit -m "feat: warn when project storage fails and offer a backup download"
```

---

# Final verification

- [ ] **Run the whole suite, typecheck and build**

Run: `npx vitest run && npm run lint && npm run build`
Expected: every suite PASS, tsc exits 0, vite build succeeds.

- [ ] **Confirm nothing outside the store touches project storage**

Run: `grep -rn "ai_translate_projects\|ai_translate_selected_project" src`
Expected: matches only in `src/storage/projectStore.ts` and `src/storage/projectStore.test.ts`, plus the `STORAGE_KEY` constant in `src/hooks/useProjects.test.ts`.

- [ ] **Long-run check (the only thing that actually confirms Phase A)**

Nothing in this plan validates a real two-hour meeting; the 10-minute cadence and the 60-second `goAway` warning come from documentation. Run a session for at least 25 minutes with speech throughout, watching the server log. Expected: the browser WebSocket opens once, `capture.status` never shows "กำลังเริ่ม…" after the first start, and captions continue across the two upstream swaps that should occur. If the client status *does* flip, the proxy swap failed and fell back to the client reconnect — capture the server log before investigating.
