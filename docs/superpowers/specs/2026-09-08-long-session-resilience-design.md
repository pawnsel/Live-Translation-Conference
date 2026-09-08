# Long-session resilience — design

> Status: approved by user, 2026-09-08. Target: a single session must **keep
> recording** through a half-day conference (~2 hours of continuous speech,
> with headroom to ~3) without an operator having to restart it, must still
> produce a summary at the end, and must never lose recorded transcripts
> silently. A gap of a few seconds where the session is handed over is
> explicitly acceptable; continuity of the *recording*, not of the *audio*,
> is what this document is about.
>
> Note: §2 of `2026-09-07-gemini-transcription-migration-design.md` chose
> chunked `generateContent` calls over the Live API. The implementation went
> the other way — `server/geminiLiveProxy.ts` is a Live API proxy. This
> document builds on what was actually shipped, not on that superseded
> paragraph.

## 1. The three problems

All three were found by reading the shipped code, not by measurement in a
real 2-hour meeting. Each cites the file that establishes it.

**P1 — a session can end permanently, mid-conference, after ~5 seconds of
trouble; and every routine seam costs 1.5–2.5 seconds of speech.**
Gemini's Live API caps a connection at 10 minutes by default and sends
`goAway` 60 seconds before it closes it. `sendSetup()`
(`server/geminiLiveProxy.ts`) sends neither `sessionResumption` nor
`contextWindowCompression`, so the session simply dies on schedule. The
browser reacts in `ws.onclose` (`src/asr/audio/useGeminiLiveCapture.ts`) by
tearing the whole pipeline down — `teardown()` stops the mic tracks and
closes the `AudioContext` — waiting `RECONNECT_DELAY_MS` (800 ms), opening a
new socket, waiting for Gemini's `setupComplete`, and only then re-running
`startAudio()`: `getUserMedia`, a new `AudioContext`, and a fresh
`audioWorklet.addModule`. Nothing is recording during any of that. At a
10-minute cadence a 2-hour meeting takes this hit roughly 12 times.

Across an untroubled meeting the reconnect *count* is not a limit:
`MAX_RECONNECTS` is 5, but `retriesRef.current = 0` on every `setupComplete`,
so 5 means "5 consecutive failures", not 5 per session. The danger is how
quickly those five are spent — `RECONNECT_DELAY_MS` is a flat 800 ms, so a
Gemini blip of roughly five seconds exhausts the budget and ends the session
for good, requiring the operator to notice and press start again. See §3.1.

**P2 — a 2-hour transcript cannot be summarised.**
`SUMMARIZE_TIMEOUT_MS` (server) and `REPORT_WAIT_TIMEOUT_MS` (client) are both
20 seconds, and `summarizeTranscript()` builds one prompt containing every
line. A 2-hour transcript is on the order of 10⁵ characters; one call is
unlikely to return inside 20 s. `MAX_SUMMARIZE_ITEMS` (2000) is a second,
harder ceiling a talkative long meeting can cross. Either way the route's
fallback returns `{ summary: '' }` and the operator sees "summary failed".

**P3 — a failed write to storage is invisible.**
`useProjects` persists the entire projects array on every change and both
writes sit inside `catch { /* ignore quota errors */ }`. If the write ever
fails, recording continues and appears normal while nothing is being kept.

P3 is worth fixing *before* the database phase rather than after, because the
defect is the swallowed error, not the storage medium. Moving to a database
replaces `QuotaExceededError` with network timeouts, 5xx responses and expired
auth — the same silence over a wider set of causes, and more dangerous, since
a database gives the operator more reason to believe the data is safe. The
work is therefore specified as a storage-agnostic failure channel (§4); only
the localStorage adapter behind it is throwaway.

## 2. Non-goals

- No change to caption logic, the glossary, or the history rendering.
- No incremental/during-session summarisation. Summarising stays on-demand at
  session end (it costs model calls, and that decision stands).
- No virtualised history list. ~200–1500 captions render acceptably; if that
  proves wrong it is a separate, measurable change.
- No multi-tab or server-side session sharing. Sessions remain per-tab.
- No zero-gap handover. A seam of a few seconds is acceptable (§3.1), so the
  complexity that would remove the last fraction of a second is not bought.

## 3. Session continuity

### 3.1 What is actually being fixed

The requirement is **continuous recording for ~2 hours**, not a seamless
one. A few seconds lost at each 10-minute seam is explicitly acceptable
(user, 2026-09-08). That rules out the obvious-looking goal — a zero-gap
handover — as over-engineering, and moves the target to the things that can
actually end a meeting early.

Today's client-side reconnect already survives an unbounded number of seams,
so the gap length is not the defect. Three things are:

- **The retry budget is exhaustible in about five seconds.** `MAX_RECONNECTS`
  is 5 consecutive failures and `RECONNECT_DELAY_MS` is a flat 800 ms, so a
  Gemini blip lasting a few seconds burns the whole budget and the session
  dies permanently, mid-conference, needing a manual restart. This is the
  single largest threat to a 2-hour meeting.
- **Sessions can die earlier than the 10-minute cap** if the context window
  overflows, making seams more frequent than necessary.
- **The reconnect loop has never been exercised more than once in a test.**
  Reading it found no defect; that is not the same as knowing it survives a
  dozen cycles without leaking an `AudioContext` or a microphone track.

### 3.2 Approach

**A — the proxy swaps its own Gemini connection, sequentially. Chosen.**
The proxy owns the Gemini connection lifecycle. The browser↔proxy WebSocket
stays open for the whole meeting, so the mic, `AudioContext`, worklet and
React effect are never touched — which is what makes a seam ~0.3 s (open a
socket, complete setup) rather than ~2 s (all of that *plus* `getUserMedia`,
a new `AudioContext` and a worklet reload). Frames arriving during the swap
land in the `pending` queue the proxy already keeps for the initial
handshake, so a swap that completes inside `MAX_PENDING_FRAMES` (150 frames,
~3 s of audio) loses nothing at all.

**B — make-before-break: open the replacement while the old one still runs.**
Rejected as over-engineering. `goAway`'s 60-second warning makes it possible,
and it would close the remaining ~0.3 s gap, but it costs two concurrent
upstreams, a drain window, and the only path in the system where two sessions
emit text at once — real complexity, running against a preview model whose
`goAway` timing is not guaranteed, to buy something the requirement says is
not needed.

**C — leave reconnection in the browser and only add backoff.**
Rejected, though it is close. It is the least work and fixes the largest
threat, but it keeps tearing the microphone down every ten minutes for two
hours — 12 `getUserMedia` calls, 12 `AudioContext` lifecycles — which is both
the longer gap and the larger unknown. A is not much more work, since the
proxy must be touched for `sessionResumption` regardless.

`contextWindowCompression` is enabled under any of these; it is a few lines
and prevents seams from arriving more often than the connection cap requires.

### 3.3 Protocol fields

Verified against the Live API WebSockets reference
(<https://ai.google.dev/api/live>) and the session-management guide
(<https://ai.google.dev/gemini-api/docs/live-api/session-management>):

| Direction | Message | Shape |
|---|---|---|
| → setup | `sessionResumption` | `{ handle?: string }` — omit `handle` to start fresh but still receive updates |
| → setup | `contextWindowCompression` | `{ slidingWindow: { targetTokens? }, triggerTokens? }` |
| ← server | `sessionResumptionUpdate` | `{ newHandle: string, resumable: bool }` |
| ← server | `goAway` | `{ timeLeft: Duration }` |

Handles remain valid for 2 hours after the session they came from ends, which
comfortably covers any swap this design performs.

`contextWindowCompression` is sent as `{ slidingWindow: {} }` — the API's own
defaults, rather than invented token counts. Tuning it is a follow-up with a
real measurement behind it, not part of this work.

### 3.4 Proxy connection swap

`registerGeminiLiveProxy` keeps exactly one upstream per client, as it does
today. What changes is that the upstream can be *replaced* without the client
socket closing.

Per client connection, added state:

- `resumeHandle: string | null` — the latest `newHandle` seen.
- `swapping: boolean` — a replacement is being opened.

Behaviour:

1. **Steady state.** Client audio → upstream. Upstream output → client. Every
   `sessionResumptionUpdate` stores `newHandle`; `resumable: false` clears
   `resumeHandle` to null, because a handle the server has declared unusable
   must not be offered back to it.
2. **`goAway` arrives.** Set `swapping`, close the current upstream, and open
   a replacement with `sessionResumption: { handle: resumeHandle }` when a
   handle exists. Closing first rather than last is what keeps this simple:
   there is never more than one upstream, so there is no window in which two
   sessions could emit text for the same audio.
3. **During the swap.** `upstreamReady` is false, so client audio takes the
   path that already exists for the initial handshake: it queues in `pending`
   (bounded by `MAX_PENDING_FRAMES`, ~3 s of audio, oldest dropped first) and
   is flushed when the replacement reports `setupComplete`. A swap that
   completes inside that window therefore loses no audio at all.
4. **Unexpected upstream close (no `goAway`).** Treated the same way — one
   replacement attempt with the handle. Gemini does not always get to send
   `goAway`, and a silent drop should not be worse than an announced one.
5. **The replacement fails to open or set up.** Fall through to today's
   behaviour: `closeBoth()`, the client socket closes, and the browser
   reconnects on its own with the backoff from §3.5. Strictly no worse than
   what ships now.

To avoid an infinite loop against a persistently failing upstream, the proxy
attempts at most `MAX_UPSTREAM_SWAPS_IN_A_ROW` (3) replacements without an
intervening `setupComplete`, then gives up to the client. A successful
`setupComplete` resets that counter — the same shape as the client's existing
retry accounting.

`goAway` and `sessionResumptionUpdate` are consumed by the proxy and **not**
relayed: the browser has no use for either, and relaying `goAway` would invite
the client to react to something the proxy is already handling.

The setup payload must be built once and reused rather than rebuilt from the
client's config frame, which is long gone by the time a swap happens. Extract
the body of `sendSetup()` into a `buildSetup({ resumeHandle })` helper that
both the first connection and every swap call.

### 3.5 Client changes

The hook keeps its reconnect path as the fallback for genuine network loss
and proxy restarts; the proxy swap simply means it is no longer the normal
case. One real defect there is fixed:

`MAX_RECONNECTS` (5) counts consecutive failures and `RECONNECT_DELAY_MS` is
a flat 800 ms, so roughly five seconds of upstream trouble ends the session
permanently. Since the operator decides when a session is over, the client
retries **for as long as the session is active**, with exponential backoff —
800 ms doubling to a ceiling of 10 s — instead of a hard cap. The existing
reset on `setupComplete` stays: a healthy session returns the delay to
800 ms.

The failure mode this removes (a permanent error banner mid-conference) is
replaced by one that is recoverable without operator action. The status line
is unchanged: it already shows "กำลังเริ่ม…" while a reconnect is in flight,
which remains accurate.

## 4. Summarising long transcripts

Map-reduce on the server. The client's contract (`POST
/api/gemini/summarize` with `{ items }` → `{ summary, items }`) does not
change shape; only its timing and limits do.

**Chunking** is by accumulated character count, not item count: captions vary
in length by an order of magnitude, so N items is not a bound on prompt size.
`SUMMARY_CHUNK_CHARS = 12000`, measured over the rendered
`[i] source => target` lines. A caption longer than one chunk becomes its own
chunk rather than being split mid-line.

**Map.** Each chunk is summarised into terse bullet points, run with a
concurrency of 4 — enough to keep a 12-chunk job inside a reasonable
wall-clock without stampeding rate limits. Results are reassembled in chunk
order regardless of completion order.

**Reduce.** One final call turns the ordered bullets into the summary the
operator sees, in the language the transcript is mostly in (matching the
existing prompt's behaviour).

**Partial failure.** A chunk that fails or times out contributes a marker
naming the range it covered rather than failing the request. A summary with a
gap is more useful than no summary. If *every* chunk fails, the route keeps
its existing `{ summary: '' }` fallback so the transcript is never lost.

**Limits.**

| Constant | From | To |
|---|---|---|
| `MAX_SUMMARIZE_ITEMS` | 2000 | 6000 |
| per-call timeout | 20 s (whole job) | 20 s (each map/reduce call) |
| overall job budget | — | 150 s |
| `REPORT_WAIT_TIMEOUT_MS` (client) | 20 s | 180 s |

The client budget must exceed the server's, or the client gives up on work
that was about to succeed.

**Feedback.** A 1–2 minute wait with a static spinner reads as a hang. The
summary popup shows elapsed time and states that a long meeting may take up
to two minutes. No progress protocol is added — a streaming progress channel
is not worth a new server-to-client message type for this.

## 5. Persistence failure channel

**`src/storage/projectStore.ts`** (new) owns all persistence:

```ts
export type PersistFailureReason = 'quota' | 'unavailable' | 'unknown';

export type PersistResult =
  | { ok: true }
  | { ok: false; reason: PersistFailureReason; message: string };

export interface ProjectStore {
  loadProjects(): Project[];
  saveProjects(projects: Project[]): PersistResult;
  loadSelectedId(): string | null;
  saveSelectedId(id: string | null): PersistResult;
}
```

`localStorageProjectStore` implements it, mapping `QuotaExceededError` (and
its legacy name/codes) to `reason: 'quota'` and a disabled/throwing
`localStorage` to `'unavailable'`. Nothing outside this file may reference
`localStorage` for project data.

**`useProjects(store = localStorageProjectStore)`** takes the store as an
argument — which also removes the need for the test suite's storage stubbing
to reach through `window`. It exposes:

```ts
persistError: { reason: PersistFailureReason; message: string; at: number } | null
```

set on any failed write and cleared on the next successful one.

**UI.** A persistent (non-dismissable) banner in `Admin` whenever
`persistError` is set: what failed, and a **"ดาวน์โหลดสำรอง"** button that
writes every project — transcripts included — to a JSON file named
`backup-projects-<YYYY-MM-DD>.json`. Non-dismissable is deliberate: the
condition does not resolve itself, and a dismissed banner would restore
exactly the silence being fixed.

**Why this survives the database phase.** `ProjectStore`, `PersistResult`,
`persistError`, the banner and the backup button contain no notion of
localStorage. The database phase writes a second adapter and changes the
default passed to `useProjects`; `reason` gains cases (`'network'`, `'auth'`)
and the banner's copy follows. The only file discarded is the localStorage
adapter.

## 6. Testing

Following the repo's existing vitest setup; no new test infrastructure.

**Proxy (`server/geminiLiveProxy.test.ts`, new).** Needs a fake upstream, so
the module must take its upstream factory as an injectable option, defaulting
to the real `WebSocket`. Cases:

- `goAway` closes the upstream and opens a replacement, while the client
  socket stays open throughout.
- Audio sent during the swap is queued and flushed to the replacement once it
  reports `setupComplete` — nothing is dropped inside the buffer's capacity.
- `sessionResumptionUpdate` stores `newHandle`; the next swap sends it as
  `sessionResumption.handle`.
- `resumable: false` clears the handle, and the next swap opens a fresh
  session rather than offering a handle the server rejected.
- An unexpected upstream close with no `goAway` also triggers one replacement.
- After `MAX_UPSTREAM_SWAPS_IN_A_ROW` failures with no `setupComplete`
  between them, the client socket is closed; one success in between resets
  the counter.

**Capture hook (`src/asr/audio/useGeminiLiveCapture.test.ts`, new).** The
reconnect loop has never been exercised repeatedly. With a fake WebSocket and
stubbed media APIs: consecutive drops back off 800 ms → 1.6 s → 3.2 s up to
the 10 s ceiling and never stop while the session is active; a `setupComplete`
returns the delay to 800 ms; twelve drop/recover cycles leave no microphone
track running and no `AudioContext` unclosed, and caption `seq` keeps
increasing across all of them.

**Summary (`server/gemini.test.ts`, extended).** Chunking splits on the
character budget and never mid-line; a caption larger than the budget becomes
its own chunk; map results reassemble in chunk order when they resolve out of
order; one failing chunk yields a gap marker while the rest survive; all
chunks failing yields the empty-summary fallback.

**Storage (`src/storage/projectStore.test.ts`, new).** A quota-throwing fake
yields `{ ok: false, reason: 'quota' }`; a `localStorage` whose accessor
throws yields `'unavailable'`; a successful write yields `{ ok: true }`.

**Hook (`src/hooks/useProjects.test.ts`, extended).** A failing store sets
`persistError`; a subsequent successful write clears it.

## 7. Risks

- **The proxy swap is the riskiest change.** It runs rarely (once per ten
  minutes), in production, against a preview model
  (`gemini-3.5-live-translate-preview`) whose `goAway` timing is not
  guaranteed. Every failure path falls back to today's client-side reconnect,
  so the worst case is the behaviour that ships now.
- **Unbounded client retries trade one failure mode for another.** A session
  that can no longer reach Gemini at all now retries quietly every 10 s
  instead of showing a permanent error. The status line says "กำลังเริ่ม…"
  throughout, which does not distinguish "reconnecting" from "wedged". If
  operators find that confusing in practice, surfacing the retry count is the
  follow-up — it was cut from this round deliberately.
- **Resumption carries context that a translator does not need.** Resuming
  keeps the model's accumulated history rather than starting clean; that is
  what `contextWindowCompression` bounds. If resumed sessions ever behave
  worse than fresh ones, dropping the handle is a one-line change, since every
  swap already handles the no-handle case.
- **Map-reduce changes summary character**, not just its reliability: a
  summary of summaries reads differently from a summary of a transcript. This
  is accepted; the alternative was no summary at all.
- **Nothing here is validated against a real 2-hour meeting.** The 10-minute
  cadence and the 60-second warning come from documentation. A real long-run
  test is the only thing that confirms this work, and should follow it.
