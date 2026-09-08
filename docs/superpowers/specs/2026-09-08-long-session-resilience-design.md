# Long-session resilience — design

> Status: approved by user, 2026-09-08. Target: a single session must survive
> a half-day conference (~2 hours of continuous speech, with headroom to ~3)
> without losing audio, without losing its summary, and without losing
> recorded transcripts silently.
>
> Note: §2 of `2026-09-07-gemini-transcription-migration-design.md` chose
> chunked `generateContent` calls over the Live API. The implementation went
> the other way — `server/geminiLiveProxy.ts` is a Live API proxy. This
> document builds on what was actually shipped, not on that superseded
> paragraph.

## 1. The three problems

All three were found by reading the shipped code, not by measurement in a
real 2-hour meeting. Each cites the file that establishes it.

**P1 — every Gemini session drop costs 1.5–2.5 seconds of speech.**
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

The reconnect *count* is not itself a limit: `MAX_RECONNECTS` is 5, but
`retriesRef.current = 0` on every `setupComplete`, so 5 means "5 consecutive
failures", not 5 per session. That part already works and is not changed here.

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

## 3. Session continuity

### 3.1 Approach

Three approaches were considered.

**A — the proxy reconnects to Gemini behind the browser's back. Chosen.**
The proxy owns the Gemini connection lifecycle. The browser↔proxy WebSocket
stays open for the whole meeting, so the mic, `AudioContext`, worklet and
React effect are never touched. Because `goAway` arrives 60 seconds early,
the replacement upstream can be opened, set up and proven healthy *while the
old one is still carrying audio* — a make-before-break handover with no gap
at all, rather than a faster recovery from a gap.

**B — the browser reconnects, with the proxy relaying the resumption handle.**
Rejected. It still tears down the browser socket, and with the current hook
that still tears down the mic, so it needs the audio effect split from the
socket effect *as well as* a make-before-break handover in the browser — more
work than A for a worse result. It also puts a token that can resume a billed
session into the browser.

**C — enable `contextWindowCompression` and nothing else.**
Rejected as insufficient. The 10-minute cap is a connection limit; the
documented way past it is reconnecting with session resumption. Compression
addresses context overflow, which is a different (and additional) failure.

Compression is still enabled alongside A, since a session that overflows its
context would otherwise die early, before `goAway` is even due.

### 3.2 Protocol fields

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
comfortably covers a 60-second handover.

`contextWindowCompression` is sent as `{ slidingWindow: {} }` — the API's own
defaults, rather than invented token counts. Tuning it is a follow-up with a
real measurement behind it, not part of this work.

### 3.3 Proxy state model

`registerGeminiLiveProxy` currently holds one `upstream` per client. It
becomes: one **active** upstream, plus zero-or-one **warming** upstream
during a handover.

Per client connection:

- `active: WebSocket | null` — receives audio, its output is relayed.
- `warming: WebSocket | null` — set up but not yet carrying audio.
- `resumeHandle: string | null` — latest `newHandle` seen.
- `draining: WebSocket | null` — the former active, still relayed, not fed.

Transitions:

1. **Steady state.** Client audio → `active`. `active` output → client.
   Every `sessionResumptionUpdate` stores `newHandle`; `resumable: false`
   clears `resumeHandle` to null, because a handle that the server has
   declared unusable must not be offered back to it.
2. **`goAway` received on `active`.** Open `warming` and send it the same
   setup as `active` had — same model, language pair, vocabulary and glossary
   instruction — plus `sessionResumption: { handle: resumeHandle }` when a
   handle exists. Audio keeps flowing to `active` unchanged.
3. **`warming` reaches `setupComplete`.** Promote: `draining = active`,
   `active = warming`, `warming = null`. Audio now flows to the new upstream.
4. **Drain.** `draining` is no longer fed but its output is still relayed for
   `UPSTREAM_DRAIN_MS` (2000 ms), then it is closed. This lets the old
   session finish transcribing the last audio it was given.
5. **`warming` fails or `active` closes first.** Close both and fall through
   to today's behaviour: the client socket closes and the browser reconnects
   on its own. This is strictly no worse than the current code.

`goAway` and `sessionResumptionUpdate` are consumed by the proxy and **not**
relayed — the browser has no use for either, and relaying `goAway` would
invite the client to react to something the proxy is already handling.

No duplicate captions can arise: a given stretch of audio is sent to exactly
one upstream, so exactly one upstream transcribes it. The drain window
overlaps two upstreams' *output* but never their *input*.

The setup payload must therefore be built once and reused, not rebuilt from
the client's config frame — extract the body of `sendSetup()` into a
`buildSetup({ resumeHandle })` helper that both the first connection and
every handover call.

### 3.4 Client changes

Deliberately minimal. The hook keeps its existing reconnect path as the
fallback for genuine network loss; it simply stops being the normal case.
The one change worth making is honesty in the status line: `capture.status
=== 'starting'` currently renders "กำลังเริ่ม…" whether this is the first
start or a mid-meeting recovery. Since recoveries should now be rare and mean
something has actually gone wrong, `GeminiCaptureState['status']` gains a
`'reconnecting'` case, set by the `ws.onclose` recovery path instead of
`'starting'`. `Admin` renders it as "กำลังเชื่อมต่อใหม่…", and every existing
comparison against `'starting'` — including the Session button's `disabled`
condition — must be reviewed to decide whether it means "not yet running" (add
`'reconnecting'`) or "first start only" (leave alone).

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

- `goAway` opens a second upstream and audio keeps going to the first until
  the second reports `setupComplete`.
- After promotion, audio goes only to the new upstream, and the old one's
  output is still relayed until the drain window closes.
- `sessionResumptionUpdate` stores `newHandle`; a later handover sends it in
  `sessionResumption.handle`.
- `resumable: false` clears the handle, and the next handover opens a fresh
  session instead of offering a rejected one.
- A warming upstream that errors leaves the active one untouched.
- The active upstream closing with no handover in flight still closes the
  client, as today.

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

- **The handover is the riskiest change.** It runs rarely (once per 10
  minutes), in production, against a preview model
  (`gemini-3.5-live-translate-preview`) whose `goAway` timing is not
  guaranteed. Every failure path is specified to fall back to today's
  client-side reconnect, so the worst case is the behaviour that ships now.
- **`goAway` may not arrive** before some closes. That path is unchanged from
  today and still works.
- **Map-reduce changes summary character**, not just its reliability: a
  summary of summaries reads differently from a summary of a transcript. This
  is accepted; the alternative was no summary at all.
- **Nothing here is validated against a real 2-hour meeting.** The 10-minute
  cadence and the 60-second warning come from documentation. A real long-run
  test is the only thing that confirms this work, and should follow it.
