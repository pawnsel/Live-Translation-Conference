# Gemini-only transcription/translation/summarization migration — design

> Status: approved by user, 2026-09-07. Supersedes the `thai-realtime-asr-mt`
> backend integration, whose design and plan documents were removed once
> that backend was gone (they remain in git history before this commit).

## 1. Goal

Remove every connection to the separate Python ASR backend
(`../thai-realtime-asr-mt`) and do transcription, translation, and
end-of-session summarization entirely through the Gemini API instead. The
operator-facing UI and feature set stay the same wherever the backend removal
doesn't force a change (see §7 for the small set of things that must change
because they only ever meant something in terms of the old backend).

This repo goes back to being self-contained: browser mic → (new) Node proxy
→ Gemini → captions on screen. No Python process, no shared session
registry, no control WebSocket, no operator password.

## 2. Why chunked audio calls, not Gemini Live API

Considered both; chose **chunked audio calls to a standard Gemini model**
(one-shot `generateContent` per audio segment) over the Gemini Live API
(persistent bidirectional streaming session):

- Simpler to build, test, and retry — each chunk is an independent HTTP
  request/response with normal error handling, no persistent-connection
  lifecycle to manage on top of the mic lifecycle.
- Live API's turn-based VAD doesn't give word-by-word interim transcripts
  the way the old Web Speech API / backend did anyway, so it would not have
  preserved the exact old UX either — the honest tradeoff (see §7) is the
  same order of magnitude either way.
- A few hundred ms–2s of added latency per chunk is acceptable for a
  conference-caption use case built around a single "latest caption" box,
  not a word-by-word live typing effect.

## 3. Why single-tab-only sessions

The old backend was a shared, in-memory session registry: multiple browser
tabs could adopt and co-view the *same* live session, with health polling
and a `recognizer_alive` signal. Once transcription happens per-browser-tab
against Gemini directly (via our own Node proxy, not a shared server-side
session), that registry has nothing to synchronize. Rebuilding a
session-coordination layer ourselves was considered and rejected as
out-of-scope busywork — it would be re-building a piece of what the Python
backend did, for a feature nobody asked to keep. Each tab that presses
"เริ่ม Session" now runs its own independent capture+transcribe loop,
matching how the pre-backend version of this app worked.

## 4. Audio capture & chunking

Reuses `src/asr/audio/pcm.ts` (the AudioWorklet PCM framer: 16kHz mono
`pcm_s16le`, `FRAME_MS`/`FRAME_SAMPLES` constants) for capture — only the
destination of the framed audio changes.

New hook (replaces `src/asr/audio/useAudioCapture.ts`), tentatively
`src/asr/audio/useGeminiCapture.ts`:

- Opens the mic via `getUserMedia` with the same worklet pipeline.
- Accumulates incoming Int16 frames into a rolling buffer.
- **Chunk-cut rule**: cut and send a chunk when either
  - trailing silence ≥600ms follows ≥1s of buffered speech (simple
    RMS-based endpointing over the existing frames — no new native
    dependency), or
  - the buffer hits a hard cap of 8s (bounds worst-case delay during
    continuous, pause-free speech).
  - A minimum buffered length of ~0.6s avoids firing a request on pure
    noise/silence blips.
- Wraps the finished chunk's Int16 PCM as a WAV blob (add a 44-byte WAV
  header; no new dependency needed) and POSTs it to the server.
- Each outgoing chunk gets an incrementing local `seq`. Responses are
  applied to the caption list strictly in `seq` order via a small reorder
  buffer (hold a response that arrives out of order until its predecessor
  has been applied) — mirrors the ordering guarantee the old `rev` field
  gave us, just entirely client-local now.
- While capturing, exposes a `status` of `idle | starting | listening |
  error` (no more `sending`-with-backpressure — see §7 for what replaces the
  backpressure banner: nothing, since there is no server socket that can
  back up).

Browser-side audio constraints (`echoCancellation`/`noiseSuppression`/
`autoGainControl`) were previously forced off because they fought the
backend's own denoise chain. There is no backend chain anymore, so this
hook turns them back on (closer to how a browser mic normally behaves) —
called out explicitly since it's a small behavioral change, not because it
changes anything visible in the UI.

## 5. Server-side Gemini proxy (`server.ts`)

Uses the `@google/genai` SDK (new dependency), instantiated once with
`GEMINI_API_KEY` from `.env` (already present, injected by AI Studio — see
`metadata.json`'s `MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API`). The key never
reaches the browser; the browser only ever talks to our own Node server.

New routes, replacing `/api/asr/token` (removed) and the WebSocket the
Python backend used to serve:

### `POST /api/gemini/transcribe`
- Accepts `multipart/form-data`: an `audio` file field (the WAV chunk) plus
  a `meta` JSON field: `{ sourceLang, targetLang, glossary, context }`.
  - `glossary`: the three sections from `src/components/DictionaryManager.tsx`
    (`protected_terms`, `person_names`, `thai_corrections`), turned into
    plain-language biasing instructions in the prompt (e.g. "always
    transcribe/translate these terms exactly as given: …").
  - `context`: the source+target text of the last 1–2 finalized captions,
    included as "previous context, for coherence only — do not repeat it in
    your output" so a chunk boundary mid-sentence doesn't produce a
    disjointed translation.
- Calls Gemini once with the audio as inline data + the above prompt,
  requesting **structured JSON output** (`responseSchema`:
  `{ source_text: string, target_text: string }`) rather than freeform text
  parsing, for reliability.
- Responds `{ source_text, target_text, latencyMs }` (`latencyMs` = server
  time from request received to Gemini response returned — this becomes the
  caption's `latencyMs`, replacing the old "backend processing time"
  meaning with "this Gemini call's processing time").
- Errors (rate limit, network, malformed response) surface as a normal HTTP
  error the client renders in the existing error-banner slot.

### `POST /api/gemini/summarize`
- Accepts the full transcript (`{ source_text, target_text }[]`) for the
  session that just ended.
- One Gemini call producing the meeting summary text, replacing the old
  backend's Vertex AI call.
- Same fallback contract as today: if the Gemini call fails, respond with
  an empty summary and the item count preserved, so
  `report.summary === ''` still means "AI failed, transcript preserved" —
  `SessionHistoryModal`/the report panel already handle this distinction
  and need no changes.
- No 20-second client-side wait budget tuning is needed beyond what
  already exists in `Admin.tsx` (`REPORT_WAIT_TIMEOUT_MS`); the summarize
  call itself should carry a comparable server-side timeout (~20s) so a
  hung Gemini call can't stall session-ending indefinitely.

`GEMINI_MODEL` becomes a new `.env` var, defaulting to a current
multimodal, audio-capable Gemini model, so the exact model string is a
config change, not a code change, if/when a better one becomes available.
An optional `GEMINI_SUMMARY_MODEL` may reuse the same default.

`/api/health` stays as-is (already backend-agnostic).

## 6. Client state model

- **Session** becomes a purely local concept: `startSessionAndMic` in
  `Admin.tsx` generates a local id (`local_${Date.now()}`) instead of
  calling `createSession`/`listSessions`/`chooseSession` against a backend.
  No adopt-candidate picker, no re-listing race handling — those problems
  don't exist without a shared registry.
- `source_lang`/`target_lang`/`paused` move from server-broadcast state
  (`socket.welcome`) to plain local React state, since nothing server-side
  owns them anymore. Swapping languages just changes what the next chunk's
  prompt says — no "restart listening" delay, so that notice is removed
  (§7).
- The `Caption` shape in `src/asr/captions.ts` (`seq/sourceText/targetText/
  sourceLang/targetLang/ts/latencyMs/isEdited`) is kept exactly as-is; only
  how it's populated changes (chunk response → append, instead of
  frame → reducer). This is what keeps the entire render half of
  `Admin.tsx` (subtitle box, collapsible history, edit/hide/copy, TXT/SRT
  export) untouched.
- `src/types.ts` (`Project`, `ProjectSession`, `ProjectBill`,
  `DisplayConfig`) stays as-is. `ProjectSession.asrSessionId` keeps its
  field name (to minimize diff in `useProjects.ts`/`ProjectPanel.tsx`) but
  now just holds the local session id — the doc-comment calling it "the
  Python session, dies with the backend" gets corrected.
- `useProjects.ts`, `ProjectPanel.tsx` (`ProjectPicker`, `ProjectHeaderBar`,
  `BillModal`, `HistoryPanel`, `SessionHistoryModal`) need **no code
  changes** — they never referenced the backend directly.

## 7. UI-visible changes (called out explicitly; all approved)

These are the only user-visible departures from current behavior, all a
direct, unavoidable consequence of removing the backend:

1. Header subtitle "Google Chirp 3 + Google Translate" → reflects Gemini
   instead.
2. The "Ping" metric (previously literal control-socket round-trip time)
   is repurposed to the round-trip time of a lightweight periodic
   `/api/health` check, rather than removed — keeps the UI element
   meaningful.
3. The dictionary panel's "โหลดพจนานุกรมใหม่จากไฟล์บนเซิร์ฟเวอร์" reload
   button is dropped — there is no server file to reload from anymore
   (glossary lives in `localStorage`, see §8).
4. The "กำลังฟัง" live word-by-word interim transcript is replaced by a
   generic listening/buffering pulse (no partial text) until the current
   chunk resolves — inherent to one-shot chunked calls rather than a
   streaming ASR connection.
5. The "สลับภาษาต้นทางจะรีสตาร์ทการฟังเสียงราว 1 วินาที" notice is removed
   — language swap no longer restarts anything, it just changes the next
   chunk's prompt.
6. The multi-tab session picker/candidate list, health-poll-driven
   "session gone" recovery, and `recognizer_alive`/backpressure banners are
   removed (§3) — replaced by: each tab runs its own session, and errors
   surface through the existing `tokenError`/`socket.error`-style banner
   slots repurposed as a single `apiError` banner for capture/Gemini
   failures.

Everything else — subtitle box layout, font size settings, show
original/show latency toggles, edit/copy/hide per caption, TXT/SRT export,
project picker/history/bill modal, session history modal, dictionary
manager's search/paste-from-Excel/section tabs — is unchanged.

## 8. Glossary persistence

Moves from the backend's single shared file to a single `localStorage`
entry (e.g. `ai_translate_glossary`), holding the same three sections
`DictionaryManager` already knows about. This preserves the existing
"shared across every session" semantics (there's still only one glossary,
just locally stored instead of server-stored) with no `DictionaryManager`
UI changes — only its data source and the `onAdd`/`onRemove` handlers in
`Admin.tsx` change (local state mutation + persist, instead of sending a
`glossary.add`/`glossary.remove` command over the control socket).

## 9. Files removed entirely

`server/asrTokenBroker.ts` (+ `.test.ts`), `src/asr/useAsrSocket.ts` (+
`.test.ts`), `src/asr/protocol.ts`, `src/asr/sessions.ts` (+ `.test.ts`),
`src/asr/commands.ts` (+ `.test.ts`), `src/asr/tokens.ts` (+ `.test.ts`),
`src/asr/closeCodes.ts` (+ `.test.ts`), `src/asr/__tests__/drift.test.ts`,
`src/asr/__fixtures__/protocol/*`, `src/asr/audio/useAudioCapture.ts`.
`src/asr/captions.ts`'s frame-based reducer is replaced by a much smaller
local-append reducer (same `Caption` output shape, see §6).

`.env`: remove `ASR_BACKEND_URL`, `VITE_ASR_BACKEND_URL`,
`ASR_OPERATOR_PASSWORD`. Add `GEMINI_MODEL` (and optionally
`GEMINI_SUMMARY_MODEL`). Keep `GEMINI_API_KEY`, `APP_URL`.

`package.json`: add `@google/genai` (server-side Gemini SDK). No other
dependency changes are anticipated (chunk framing reuses existing
`pcm.ts`; WAV wrapping is a ~10-line header writer, no new package;
`multipart/form-data` parsing on the server needs `multer` as a new
dependency).

## 10. Testing

- Unit tests for the new chunk-cutting logic (silence/cap thresholds) and
  the reorder-buffer (out-of-order chunk responses applied in seq order),
  replacing the deleted `pcm.test.ts`-adjacent audio-capture tests where
  they tested backend-specific framing (`audio.hello`/`audio.ready`
  handshake) rather than pure PCM math.
- Unit tests for the new `/api/gemini/transcribe` and
  `/api/gemini/summarize` route handlers in `server.ts`, mocking the
  `@google/genai` client (request shaping, structured-output parsing,
  error → HTTP error mapping, summarize failure → empty-summary fallback).
- The existing `useProjects.test.ts` needs no behavioral changes (project
  persistence logic is backend-agnostic already).
- Manual verification (per this project's UI-testing norm): run the app,
  start a session, speak a sentence in Thai, confirm a translated caption
  appears in the subtitle box with plausible latency, swap languages,
  add a glossary term and confirm it's honored, end the session and
  confirm a summary appears.

## 11. Open items carried into implementation

- Exact default value for `GEMINI_MODEL` — pick a current
  multimodal/audio-capable Gemini model at implementation time (the user
  did not have a specific model id and asked for a sensible
  env-configurable default).
