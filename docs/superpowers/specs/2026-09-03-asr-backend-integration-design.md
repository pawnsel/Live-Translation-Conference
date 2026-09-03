# P0 — ASR Backend Integration (Design)

**Date:** 2026-09-03
**Status:** Approved for planning
**Scope:** Sub-project P0 of five. See [Roadmap](#12-roadmap-context).

---

## 1. Goal

Make the React app an operator console for the `thai-realtime-asr-mt` FastAPI
backend, replacing the Gemini translation path and the browser Web Speech API.

After P0, speech recognition, translation, session management, language
selection and the glossary all live in the Python backend. The React app
captures audio, renders captions, and issues control commands over the
documented [v1 wire protocol](../../../../thai-realtime-asr-mt/docs/protocol-v1.md).

**Non-goals**, each its own later sub-project: user accounts (P1), Postgres
persistence (P2), per-session glossary ownership (P3), usage metering and
billing (P4). Projects remain in `localStorage` throughout P0.

---

## 2. Architecture

Three processes:

```
[Browser — React operator console]
   │
   ├── POST /api/asr/token ─────────► [Node :3000] ──/auth/login (shared pw)──► [Python :8765]
   │       operator JWT back              Vite + static
   │
   ├── HTTP  /sessions, /sessions/{id}/capture-link ─────────────────────────► [Python :8765]
   ├── WS    /ws/{sid}        subprotocol ["bearer", operatorToken] ─────────► captions + control.*
   └── WS    /ws/{sid}/audio  subprotocol ["bearer", sourceToken]   ─────────► 16 kHz PCM
```

**Node's only new responsibility is minting the operator token.** Everything
else the browser calls directly on Python.

This is deliberate. Control commands (`control.set_languages`,
`control.glossary_add`, `control.report_start`) travel over the WebSocket, so
the browser must hold a genuine operator token regardless. Proxying the HTTP
half through Node would add a hop while protecting nothing. The one secret
Node does protect is the **shared operator password**, which never reaches a
browser.

`POST /api/asr/token` is therefore the seam for P1: it later gains a Supabase
JWT check and passes `subject=<user-id>` to Python, and no other module
changes.

### 2.1 Trust boundaries

| Boundary | Enforced by | P0 behaviour |
|---|---|---|
| Who may mint an operator token | Node | Anyone who can reach `:3000`. Acceptable for local testing; closed in P1. |
| What an operator token permits | Python | Full operator role: create/delete sessions, all control commands, mint viewer and capture links. |
| What a source token permits | Python | Push audio to one session. Cannot read captions or send control commands. |

The React app holds an operator token for the control socket and a **separate
source token** for the audio socket. They are different roles by design — the
Python repo splits `/invite` from `/capture-link` specifically so an audience
member cannot be handed a microphone.

---

## 3. Sessions

### 3.1 Lifecycle

Sessions are explicit; there is no implicit default. On load the console calls
`GET /sessions` and applies the documented adoption rule:

- **none live** → create one
- **exactly one live** → adopt it silently
- **several live** → present the list and ask the operator to pick

Sessions are created with `POST /sessions` and body `{"ingest": "remote"}`.
This is required: a `local` session opens the *server's* microphone, while
`remote` gives the session its own audio source fed by the browser. A remote
session is also exempt from the `DUAL_ASR` stream doubling.

`MAX_SESSIONS` defaults to 3. A create attempt beyond the cap returns a
conflict, which the console surfaces as a specific message ("the server is
already running 3 sessions"), not a generic failure.

### 3.2 Sessions do not survive a Python restart

The registry is in memory. After a backend restart every session id is gone
and previously minted links are refused with close code `4404`.

The console must treat this as a normal condition, not a crash:

- On `4404`, clear the stored session id, tell the operator the session ended,
  and offer to create a new one.
- Never auto-reconnect to a `4404` session id in a loop.

In P0 the active session id is stored on the localStorage `Project` as
`asrSessionId`, alongside the existing `sessions: ProjectSession[]` array,
which is repurposed to record ASR session ids with their start and end times.
P2 promotes both to columns.

### 3.3 Health is a reading, not a verdict

`GET /sessions` reports `recognizer_alive`, `helper_alive` (null when
`DUAL_ASR` is off) and `audio_alive` (null for a local session). The Python
backend opens the microphone on a worker thread, so a recognizer can die
*after* startup reported success.

The console polls `GET /sessions/{id}` on a timer and renders these three
fields distinctly. A green "connected" dot on the WebSocket is **not**
evidence that captions are flowing, and the UI must not imply that it is.

---

## 4. Tokens

| Token | Minted by | Role | TTL | Used for |
|---|---|---|---|---|
| Operator | `POST /api/asr/token` (Node → Python `/auth/login`) | `operator` | 12 h | `/ws/{sid}`, all HTTP session endpoints |
| Source | `POST /sessions/{id}/capture-link` | `source` | 12 h | `/ws/{sid}/audio` |

Both travel in `Sec-WebSocket-Protocol` as `["bearer", token]`, never in the
URL.

**Refresh:** the operator token is refreshed via `POST /auth/refresh` before
expiry, not after a failure. Expiry is re-checked on every audio frame, so a
capture client that outlives its token is closed with `4401` mid-stream — an
event day longer than 12 hours is realistic, and discovering this at hour 12
of a conference is unacceptable. The console refreshes at 80% of TTL and
re-mints the source token on the same schedule.

`WS_MAX_PER_SUBJECT` (default 8) caps simultaneous connections per token
subject. In P0 every operator token shares the subject `"operator"`, so the
budget is shared building-wide. P1 fixes this by passing a per-user subject.

---

## 5. Captions

### 5.1 Frame handling

| Frame | Effect |
|---|---|
| `session.welcome` | Replace all session state: languages, paused, mode, gate, glossary, report. |
| `caption.partial` | Render as the live interim line. Not appended to history. |
| `caption.final` | Append a caption keyed by `seq`, with `target_text` empty. |
| `caption.target_partial` | Update the interim translation for `seq`, subject to the `rev` rule. |
| `caption.target_update` | Update the settled translation for `seq`, subject to the `rev` rule. |

### 5.2 The `rev` rule

`seq` identifies which caption a frame belongs to; it does **not** order
frames within that caption. `caption.target_partial` and
`caption.target_update` carry `data.rev`.

> Apply a target frame only when its `rev` exceeds the highest `rev` already
> applied for that `seq`. Otherwise discard it.

This is the single most failure-prone rule in the client and gets dedicated
tests (§10).

### 5.3 Two-stage display

`caption.final` arrives at ASR latency with an empty translation;
`caption.target_update` follows. The UI must render a final caption
immediately with a pending-translation affordance rather than waiting for the
target — that staging is why source captions appear fast, and buffering them
would discard the backend's main latency win.

### 5.4 Envelope rules

Both are required by the protocol, not optional hardening:

- **Ignore unknown fields and unknown `type` values.** This is what lets the
  backend ship new frames without breaking this client.
- **Optional envelope fields are serialised as `null`, never omitted.** Test
  for `null`, not for key absence.

Outbound commands are strict in the other direction: an unknown field in a
command payload is a `bad_request`, not an ignored extra.

---

## 6. Audio capture

Ported from the working `display/capture.html` (1057 lines) rather than
written fresh.

1. `getUserMedia` with the selected device, guarded by `window.isSecureContext`.
2. `new AudioContext({ sampleRate: 16000 })`, then **verify** `ctx.sampleRate === 16000`. A browser may ignore the hint; `audio.hello` pins 16000, so a mismatch is a hard error with a clear message, not a silent resample.
3. `pcm-framer` AudioWorklet emits 20 ms `Int16Array` frames (320 samples).
4. Open `/ws/{sid}/audio`, send `audio.hello` as the socket's **only** text frame: `{sample_rate: 16000, channels: 1, encoding: "pcm_s16le", frame_ms: 20}`.
5. On `audio.ready`, send binary frames only — raw little-endian s16, no per-frame header.
6. On `audio.backpressure` with `level: "high"`, **drop frames**. Do not buffer: buffering grows latency without bound, which is worse than a gap for live captioning.

**Message ceiling:** at most 8 frames of the negotiated format per binary
message — 5120 bytes for 20 ms at 16 kHz. `frame_ms` is clamped server-side at
`MAX_FRAME_MS` (200 ms) before that ceiling is computed, and the server does
not report the negotiated ceiling back. An empty message, an odd byte count,
or anything above the ceiling closes the socket with `4403`. Send exactly what
was negotiated.

**One audio writer per session.** A second is closed with `4408`, surfaced as
"another device is already sending audio to this session".

---

## 7. Control mapping

`AppConfig` splits three ways.

| Current field | Fate |
|---|---|
| `fontSize`, `fontFamily`, `showOriginal`, `showLatency` | Client-only. Unchanged. |
| `sourceLang`, `targetLang` | **Server-owned.** Read from `session.languages`; written only via `control.set_languages`. |
| `chunkSilenceMs` and the three speed presets | Deleted. Replaced by `control.set_gate` (`min_words`, `min_interval_ms`). |
| `aiModel`, `speechEngine` | Deleted. Python owns these via its own env. |
| `dictionaryJson` | Deleted. Replaced by the glossary (§8). |

### 7.1 No optimistic local writes for server-owned state

Language state becomes a projection of `session.languages`. The current code
applies config changes to local state immediately and emits in parallel. That
pattern must go.

The Python repo removed `POST /languages` precisely because it was "a second
writer of the same state that did not observe the first". An optimistic React
setState would reintroduce that bug on the client. Send the command, wait for
the broadcast, render the broadcast.

Changing the **source** language restarts the recognition stream with a ~1 s
gap; the UI should say so rather than appear frozen.

### 7.2 Commands wired in P0

`control.set_paused`, `control.set_languages`, `control.set_mode`,
`control.set_gate`, `control.glossary_add`, `control.glossary_remove`,
`control.glossary_reload`, `control.report_start`, `control.report_stop`,
`control.ping`.

Each carries a client-generated `id`; the answering `control.ack` or
`control.error` echoes it, so the console distinguishes its own command's
outcome from another operator's.

`control.error` codes to handle: `unauthenticated`, `forbidden`,
`bad_request`, `not_found`, `conflict`, `rate_limited`, `internal`.

Rate limits are per connection: `WS_RATE_BURST` 20, `WS_RATE_PER_SEC` 5, and
`WS_RATE_STRIKES` 20 consecutive throttled commands before the socket is
closed. The console must not poll over the WebSocket; health polling uses HTTP.

### 7.3 Section report

`control.report_start` / `control.report_stop` produce `report.done` with an
LLM `summary`, the collected `items` (`{ts, source_text, target_text}`) and
`started`. This is new capability the current app lacks, and it partly
overlaps the existing TXT export. Both are kept: the report is a
backend-generated summary, the export is the raw local caption list.

---

## 8. Glossary

The Python glossary is **process-wide** — one file, three typed sections,
shared by every live session. A `glossary.state` frame is broadcast to all
sessions after any edit or reload.

| Section | Direction | Purpose |
|---|---|---|
| `thai_corrections` | Thai → Thai | Fix misheard Thai |
| `protected_terms` | Thai → English | Pin clinical English, masked from Google Translate |
| `person_names` | Thai → English | Romanized speaker names |

`DictionaryManager.tsx` (846 lines) is reworked from a per-project
two-column dictionary into a **three-section global glossary editor** driven
by `glossary.state`, with edits sent as `control.glossary_add` /
`control.glossary_remove` / `control.glossary_reload`.

**Presets survive, with changed meaning.** Today a preset *is* the active
dictionary. In P0 a preset becomes a client-side **template** the operator
pushes into the global glossary before an event. The authoritative state is
always `glossary.state` from the server. The UI must make this visible —
editing the glossary affects every running session, and a console that
implies otherwise would let one operator silently change another's event.

P3 makes the glossary per-session and restores true per-project scoping.

---

## 9. Deletions

### 9.1 `server.ts` — 359 lines to roughly 80

Removed: `performTranslation`, `buildTranslationPrompt`, `QUICK_PHRASES`,
`getAiClient`, `withTimeout`, `GEMINI_TIMEOUT_MS`, and the entire Socket.IO
layer — `currentConfig`, `transcripts`, `isMeetingActive`, `meetingVersion`,
every `io.emit`, and all ten socket handlers.

Kept: Vite middleware mode, static serving, `/api/health`.
Added: `POST /api/asr/token`.

Dependencies dropped: `@google/genai`, `socket.io`, `socket.io-client`,
`uuid`.

### 9.2 `Admin.tsx`

Removed: the Web Speech block (lines 299–410), `isListening`,
`interimSpeechText`, `micPermissionError` in its current form, every
`socket.emit`, `lastAiLatencyMs` and `socketPingMs` as Gemini/Socket.IO
telemetry, and the test-input bar.

**The test-input bar is dropped**, not ported. Protocol v1 has no way to
inject text into the ASR pipeline, and a client-side-only version would look
like a pipeline test while testing nothing.

### 9.3 A stale claim in SYSTEM_OVERVIEW, corrected

SYSTEM_OVERVIEW §4.5.8 states that `start-meeting` clears transcripts on every
press, destroying data across a pause. **This is not true of the current
code.** `server.ts:215-219` only toggles a flag, and the sole
`transcripts = []` is inside the explicit `clear-transcripts` handler at
`server.ts:273`, reached only from "finish project" or a confirmed "clear
history" dialog.

No fix is needed. The claim should be removed from SYSTEM_OVERVIEW §4.5.8 so a
later reader does not implement a fix for a bug that is not there. Recorded
here because the roadmap that fed this spec listed it as required work.

Pause semantics are correct after P0 regardless: `control.set_paused` is a real
pause, and captions accumulate in client state across pauses.

### 9.4 Caption editing

Captions are server-authored and v1 has no amend command, so inline edits
become **client-side only**: they change the operator's view and the TXT/SRT
export, and are marked `isEdited`. Audience displays continue to show the
server's text. P2 persists edits; a server-side amend command is out of scope.

"AI retranslate" is removed — there is no per-caption retranslate in v1.

---

## 10. Testing

**Caption reducer (highest value).** A pure function, so it gets direct
Vitest coverage: out-of-order `target_update`s, duplicate and stale `rev`s,
interleaved `seq`s, a `target_partial` arriving after its `target_update`, and
unknown frame types being ignored.

**Golden fixtures.** The Python repo ships one example frame per type in
`tests/golden/protocol/*.json`. The React reducer tests consume those files
directly, so client and server are verified against identical data.

**Drift test.** `src/asr/protocol.ts` is generated from `server/protocol.py`
via `scripts/gen_protocol_ts.py`. A test fails the build when the copy
diverges from the Python repo's generated file.

**Audio capture** is verified manually — worklet behaviour is not meaningfully
unit-testable. The venue checklist:

1. Mic starts, `audio.ready` received, captions appear on screen
2. Language swap mid-session; recognition resumes after the ~1 s gap
3. Pause and resume; no captions lost
4. Backpressure: frames dropped, no unbounded latency growth
5. Operator token refresh at 80% of 12 h; audio socket survives
6. Python restarted mid-session → `4404` handled with a clear message, no reconnect loop
7. Second audio writer refused with `4408`
8. Fourth session refused at `MAX_SESSIONS`

---

## 11. Configuration

**Node `.env`** (new):

```
ASR_BACKEND_URL=http://localhost:8765
ASR_OPERATOR_PASSWORD=<the shared operator password>
```

`GEMINI_API_KEY` is removed from this project entirely.

**Python `.env`** (one change): `CORS_ORIGINS` must include the app origin,
e.g. `http://localhost:3000`. Note the backend rejects a literal `*` at
startup by design.

**Branch:** `feat/asr-backend-integration`, cut from `feat/new_ui`.

---

## 12. Roadmap context

| | Sub-project | Depends on |
|---|---|---|
| **P0** | ASR backend integration — this spec | — |
| P1 | Auth & identity: Supabase login, Node BFF, per-user token subjects | P0's token endpoint |
| P2 | Persistence: Postgres + Drizzle, projects ↔ sessions, caption recorder | P1 |
| P3 | Glossary ownership: per-session in Python, per-project in Postgres | P2 |
| P4 | Usage metering and PDF billing | P2 |

`TranscriptItem` is reshaped in P0 to `{ seq, sourceText, targetText,
sourceLang, targetLang, ts, rev, isEdited }` so that P2's `transcript_items`
table is a direct mapping rather than a migration.

---

## 13. Done criteria

1. An operator opens the React app, which obtains an operator token from `/api/asr/token` with no login prompt (P0 has no user accounts), then adopts or creates a remote-ingest session.
2. Speaking into the browser's microphone produces Thai and English captions in the console within the backend's stated latency.
3. Language swap, pause/resume, gate tuning, glossary edits and section reports all work from the React UI.
4. TXT and SRT export produce correct output from the caption list, including client-side edits.
5. No Gemini call, no Web Speech API call, and no Socket.IO connection remains in this repo.
6. Reducer tests pass against the Python repo's golden frames, and the protocol drift test passes.
7. The venue checklist in §10 passes end to end.
