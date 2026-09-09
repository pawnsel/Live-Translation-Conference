// What this project actually costs to run, priced off Google's published
// Gemini API rates rather than a per-word placeholder.
//
// The rule this module is built to: **the number it returns is never less
// than the real bill.** Every judgement call below rounds against us — audio
// is billed for the whole session wall-clock, the model is assumed to be
// speaking throughout, and text is tokenised pessimistically. Real spend
// lands under this, not over it.
//
// Rates (ai.google.dev/gemini-api/docs/pricing, read 2026-09-08):
//
//   gemini-3.5-live-translate  in  $3.50 /1M   ($0.0053/min audio)
//                              out $21.00 /1M  ($0.0315/min audio)
//     "Billing is based on total input and output audio token consumption,
//      calculated at a rate of 25 tokens per second of audio, equating to an
//      effective price of approximately $0.0368 per minute."
//
//   gemini-3.6-flash           in  $0.75 /1M   → $1.50  from 2027-01-01
//                              out $3.75 /1M   → $7.50  from 2027-01-01
//                              (output price includes thinking tokens)
//
// Those are the two models server.ts defaults to (GEMINI_LIVE_MODEL and
// GEMINI_SUMMARY_MODEL). Point either env var at a different model and these
// rates stop describing it — this file is the only place to change.

import type { TranscriptItem } from '../types';
import { SUMMARY_CHUNK_CHARS } from '../../server/summaryChunks';

// ── Rates ──────────────────────────────────────────────────────────────────

/** Audio is metered as tokens at a fixed rate, both directions. */
export const LIVE_AUDIO_TOKENS_PER_SECOND = 25;
export const LIVE_INPUT_USD_PER_MTOK = 3.5;
export const LIVE_OUTPUT_USD_PER_MTOK = 21.0;

export interface FlashRates {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

/** Google publishes a dated price rise for 3.6 Flash. Reading the rate by
 *  date keeps the estimate honest on both sides of it instead of being
 *  quietly low for four months. */
const FLASH_RATE_SCHEDULE: { from: number; rates: FlashRates }[] = [
  { from: Date.UTC(2027, 0, 1), rates: { inputUsdPerMTok: 1.5, outputUsdPerMTok: 7.5 } },
  { from: 0, rates: { inputUsdPerMTok: 0.75, outputUsdPerMTok: 3.75 } }
];

export function flashRatesAt(at: number): FlashRates {
  return FLASH_RATE_SCHEDULE.find((entry) => at >= entry.from)!.rates;
}

// ── Tokenising text without a tokeniser ────────────────────────────────────

// Shipping Gemini's tokeniser to the browser to price a badge is not worth
// it, so text is counted per character at a rate calibrated against the real
// thing. Measured with models/gemini-3.6-flash:countTokens on 2026-09-08:
//
//   Thai meeting prose   122 chars →  40 tokens   (0.32 / char)
//   Thai clinical prose  103 chars →  34 tokens   (0.32 / char)
//   Short Thai greeting   30 chars →  11 tokens   (0.35 / char)
//   English prose        135 chars →  28 tokens   (4.8 chars / token)
//
// The constants below sit well above the worst of those, leaving room for
// punctuation-heavy or rare text without going three times over the way a
// flat "one token per Thai character" did.

/** Measured 4.8 ASCII characters per token; 3 leaves ~60% headroom. */
export const ASCII_CHARS_PER_TOKEN = 3;
/** Measured at most 0.35 tokens per Thai character; 0.5 leaves ~45%. */
export const TOKENS_PER_NON_ASCII_CHAR = 0.5;

export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const char of text) {
    if (char.codePointAt(0)! < 128) ascii++;
    else wide++;
  }
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN + wide * TOKENS_PER_NON_ASCII_CHAR);
}

function transcriptTokens(transcripts: TranscriptItem[]): number {
  return transcripts.reduce((sum, t) => sum + estimateTextTokens(t.sourceText) + estimateTextTokens(t.targetText), 0);
}

function transcriptChars(transcripts: TranscriptItem[]): number {
  return transcripts.reduce((sum, t) => sum + t.sourceText.length + t.targetText.length, 0);
}

// ── Summarisation shape ────────────────────────────────────────────────────
//
// server/gemini.ts maps one call per chunk over the transcript, then reduces
// the partial summaries with one more call when there was more than one
// chunk. Cost follows that same shape.

/** Prompt scaffolding wrapped around each chunk (instructions, line markers). */
export const SUMMARY_PROMPT_OVERHEAD_TOKENS = 200;
/** A summary is never more than a quarter of what it summarises. */
export const SUMMARY_OUTPUT_RATIO = 0.25;
/** …but even a two-line transcript comes back with a few hundred tokens. */
export const SUMMARY_MIN_OUTPUT_TOKENS = 512;
/** 3.6 Flash is a thinking model and thinking tokens bill as output, unseen.
 *  Three times the visible answer is the allowance for them. */
export const SUMMARY_THINKING_MULTIPLIER = 3;

// ── Breakdown ──────────────────────────────────────────────────────────────

export interface CostBreakdown {
  /** Wall-clock minutes of live session, the basis of the audio charge. */
  liveMinutes: number;
  /** Audio in + audio out on the live translate model. */
  liveAudioCost: number;
  /** The transcription text the live model writes back, billed as output. */
  liveTextCost: number;
  /** Every summarise run the operator asked for, successful or not. */
  summaryCost: number;
  summaryRuns: number;
  /** liveAudioCost + liveTextCost + summaryCost, unrounded. */
  total: number;
}

export const ZERO_COST: CostBreakdown = {
  liveMinutes: 0,
  liveAudioCost: 0,
  liveTextCost: 0,
  summaryCost: 0,
  summaryRuns: 0,
  total: 0
};

export function addCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  return {
    liveMinutes: a.liveMinutes + b.liveMinutes,
    liveAudioCost: a.liveAudioCost + b.liveAudioCost,
    liveTextCost: a.liveTextCost + b.liveTextCost,
    summaryCost: a.summaryCost + b.summaryCost,
    summaryRuns: a.summaryRuns + b.summaryRuns,
    total: a.total + b.total
  };
}

/** Cents, always rounded up: a half-cent of real spend must not display as
 *  free. */
export function ceilCents(usd: number): number {
  // The epsilon keeps a figure that is already an exact cent from being
  // pushed up a cent by floating-point noise; the clamp keeps it from
  // turning zero into -0.
  const cents = Math.ceil(usd * 100 - 1e-9);
  return cents > 0 ? cents / 100 : 0;
}

// ── The live session ───────────────────────────────────────────────────────

/**
 * One recording session.
 *
 * Audio is charged for the full wall-clock span. That is deliberately more
 * than Gemini bills: nothing is sent while the operator has the session
 * paused, and a stretch of silence still costs input tokens but produces no
 * output audio. Both errors point the same way — over, never under.
 *
 * Output audio is the expensive half ($0.0315/min against $0.0053/min in),
 * and it is counted at full duration because this model speaks its
 * translation as well as writing it (see geminiLiveBridge.ts, which drops
 * those PCM frames before the browser ever sees them — dropping them saves
 * bandwidth, not money).
 */
export function liveSessionCost(durationMs: number, transcripts: TranscriptItem[]): CostBreakdown {
  const seconds = Math.max(0, durationMs) / 1000;
  const audioTokens = seconds * LIVE_AUDIO_TOKENS_PER_SECOND;
  const liveAudioCost =
    (audioTokens / 1e6) * LIVE_INPUT_USD_PER_MTOK + (audioTokens / 1e6) * LIVE_OUTPUT_USD_PER_MTOK;
  const liveTextCost = (transcriptTokens(transcripts) / 1e6) * LIVE_OUTPUT_USD_PER_MTOK;
  return {
    ...ZERO_COST,
    liveMinutes: seconds / 60,
    liveAudioCost,
    liveTextCost,
    total: liveAudioCost + liveTextCost
  };
}

// ── Summaries ──────────────────────────────────────────────────────────────

/** What one summarise run over this transcript costs, map calls plus the
 *  reduce call. A run that failed still burned tokens, so callers pass the
 *  number of runs *attempted*, not the number that produced a summary. */
export function summaryCost(transcripts: TranscriptItem[], runs: number, at: number): CostBreakdown {
  if (runs <= 0 || transcripts.length === 0) return ZERO_COST;
  const rates = flashRatesAt(at);

  // chunkTranscript packs greedily and never splits a line, so it produces at
  // least this many chunks — and each chunk is a billed call.
  const chunks = Math.max(1, Math.ceil(transcriptChars(transcripts) / SUMMARY_CHUNK_CHARS));
  const bodyTokens = transcriptTokens(transcripts);

  const mapInput = bodyTokens + chunks * SUMMARY_PROMPT_OVERHEAD_TOKENS;
  const mapOutput = Math.max(
    chunks * SUMMARY_MIN_OUTPUT_TOKENS,
    bodyTokens * SUMMARY_OUTPUT_RATIO
  );

  // One chunk means one call and no merge pass (server/gemini.ts short-circuits
  // there — "a summary of one summary reads worse than the summary itself").
  const reduceInput = chunks > 1 ? mapOutput + SUMMARY_PROMPT_OVERHEAD_TOKENS : 0;
  const reduceOutput =
    chunks > 1 ? Math.max(SUMMARY_MIN_OUTPUT_TOKENS, reduceInput * SUMMARY_OUTPUT_RATIO) : 0;

  const inputTokens = mapInput + reduceInput;
  const outputTokens = (mapOutput + reduceOutput) * SUMMARY_THINKING_MULTIPLIER;
  const perRun =
    (inputTokens / 1e6) * rates.inputUsdPerMTok + (outputTokens / 1e6) * rates.outputUsdPerMTok;

  return { ...ZERO_COST, summaryCost: perRun * runs, summaryRuns: runs, total: perRun * runs };
}
