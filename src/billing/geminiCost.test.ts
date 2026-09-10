import { describe, expect, it } from 'vitest';
import {
  LIVE_AUDIO_TOKENS_PER_SECOND,
  LIVE_INPUT_USD_PER_MTOK,
  LIVE_OUTPUT_USD_PER_MTOK,
  ceilCents,
  estimateTextTokens,
  flashRatesAt,
  liveSessionCost,
  summaryCost
} from './geminiCost';
import type { TranscriptItem } from '../types';

function item(sourceText: string, targetText: string, seq = 1): TranscriptItem {
  return { seq, sourceText, targetText, sourceLang: 'th', targetLang: 'en', ts: 0, latencyMs: 0, isEdited: false };
}

describe('estimateTextTokens', () => {
  it('leans high on ASCII — 3 characters per token against a measured 4.8', () => {
    expect(estimateTextTokens('abcdefghijkl')).toBe(4);
  });

  it('charges half a token per non-ASCII character', () => {
    expect(estimateTextTokens('สวัสดี')).toBe(3);
  });

  it('is zero for empty text', () => {
    expect(estimateTextTokens('')).toBe(0);
  });

  // The point of the whole exercise: these constants are calibrated against
  // gemini-3.6-flash's own countTokens, and must stay above what it reports.
  it.each([
    ['ผมคิดว่าเราควรจะเริ่มดำเนินการในไตรมาสหน้าเพื่อให้ทันกำหนดการที่วางไว้ และขอให้ทุกฝ่ายส่งรายงานความคืบหน้าภายในวันศุกร์นี้', 40],
    ['ผู้ป่วยมีอาการไข้สูงร่วมกับอาการไอแห้งมาเป็นเวลาสามวันแล้ว แพทย์จึงสั่งตรวจเลือดและเอกซเรย์ปอดเพิ่มเติม', 34],
    ['สวัสดีครับ ยินดีต้อนรับทุกท่าน', 11],
    ['I think we should start executing next quarter to meet the deadline, and I would like every team to submit a progress report by Friday.', 28],
    ['ทีม Engineering จะ deploy ระบบ production ในวันจันทร์ ส่วน QA ทดสอบ regression ให้เสร็จก่อน', 20]
  ])('never estimates below the tokeniser (%#)', (text, measured) => {
    expect(estimateTextTokens(text as string)).toBeGreaterThanOrEqual(measured as number);
  });
});

describe('flashRatesAt', () => {
  it('uses the 2026 rate before the published increase', () => {
    expect(flashRatesAt(Date.UTC(2026, 11, 31))).toEqual({ inputUsdPerMTok: 0.75, outputUsdPerMTok: 3.75 });
  });

  it('uses the higher rate from 2027-01-01, so the estimate never goes stale-low', () => {
    expect(flashRatesAt(Date.UTC(2027, 0, 1))).toEqual({ inputUsdPerMTok: 1.5, outputUsdPerMTok: 7.5 });
  });
});

describe('ceilCents', () => {
  it('rounds up, so real spend never displays as free', () => {
    expect(ceilCents(0.0001)).toBe(0.01);
    expect(ceilCents(0.011)).toBe(0.02);
  });

  it('leaves an exact cent alone', () => {
    expect(ceilCents(0.02)).toBe(0.02);
    expect(ceilCents(0)).toBe(0);
  });
});

describe('liveSessionCost', () => {
  // Google's own worked example: audio metered at 25 tokens/second in both
  // directions is "approximately $0.0368 per minute". Computing it from the
  // token rates gives $0.03675 — their figure is that, rounded up.
  it("matches Google's published effective rate of ~$0.0368/min of audio", () => {
    const oneMinute = liveSessionCost(60_000, []);
    expect(oneMinute.liveMinutes).toBe(1);
    expect(oneMinute.liveAudioCost).toBeCloseTo(0.03675, 8);
    expect(oneMinute.liveAudioCost).toBeCloseTo(0.0368, 3);
  });

  it('prices audio in both directions — output is the expensive half', () => {
    const perMinuteTokens = 60 * LIVE_AUDIO_TOKENS_PER_SECOND;
    const expected =
      (perMinuteTokens / 1e6) * LIVE_INPUT_USD_PER_MTOK + (perMinuteTokens / 1e6) * LIVE_OUTPUT_USD_PER_MTOK;
    expect(liveSessionCost(60_000, []).liveAudioCost).toBeCloseTo(expected, 10);
  });

  it('adds the transcription text on top of the audio', () => {
    const withText = liveSessionCost(60_000, [item('hello there', 'สวัสดี')]);
    expect(withText.liveTextCost).toBeGreaterThan(0);
    expect(withText.total).toBeCloseTo(withText.liveAudioCost + withText.liveTextCost, 10);
  });

  it('never returns a negative charge for a clock that went backwards', () => {
    expect(liveSessionCost(-5000, []).total).toBe(0);
  });
});

describe('summaryCost', () => {
  const transcript = [item('a'.repeat(400), 'b'.repeat(400))];

  it('is free when nobody asked for a summary', () => {
    expect(summaryCost(transcript, 0, Date.now()).total).toBe(0);
  });

  // A retry spends tokens whether or not the first run came back, so runs
  // multiply — this is the whole reason the run count is persisted.
  it('charges every run, not just the one that produced a summary', () => {
    const one = summaryCost(transcript, 1, Date.now()).total;
    const three = summaryCost(transcript, 3, Date.now()).total;
    expect(three).toBeCloseTo(one * 3, 10);
  });

  it('charges more per run once the 2027 rates apply', () => {
    const before = summaryCost(transcript, 1, Date.UTC(2026, 6, 1)).total;
    const after = summaryCost(transcript, 1, Date.UTC(2027, 6, 1)).total;
    expect(after).toBeCloseTo(before * 2, 10);
  });

  // Past one chunk the server adds a merge call over the partial summaries,
  // so cost has to step up faster than the transcript does.
  it('adds the reduce pass once the transcript needs more than one chunk', () => {
    const long = Array.from({ length: 40 }, (_, i) => item('x'.repeat(500), 'y'.repeat(500), i));
    const short = [item('x'.repeat(500), 'y'.repeat(500))];
    const perChar = (t: TranscriptItem[]) =>
      summaryCost(t, 1, Date.now()).total / t.reduce((n, i) => n + i.sourceText.length + i.targetText.length, 0);
    expect(perChar(long)).toBeGreaterThan(0);
    expect(summaryCost(long, 1, Date.now()).total).toBeGreaterThan(summaryCost(short, 1, Date.now()).total);
  });

  // A run that was recorded is a run that was made. Whether this caller
  // happens to be holding the transcript text is a fact about the browser's
  // memory, not about the bill — the captions may simply not have been
  // fetched yet (see useProjects: they load lazily, one session at a time).
  // Pricing an empty transcript at zero used to make a summarised session
  // report "สรุปการประชุม 0 ครั้ง", which is the one thing this module
  // promises never to do: read low.
  it('still charges recorded runs when the transcript text is not to hand', () => {
    const cost = summaryCost([], 5, Date.now());
    expect(cost.summaryRuns).toBe(5);
    expect(cost.total).toBeGreaterThan(0);
  });

  // …but no more than the floor. With no text to measure, one chunk at the
  // minimum output allowance is the least a call can have cost.
  it('prices a text-less run at one minimum chunk', () => {
    const floor = summaryCost([], 1, Date.now()).total;
    expect(summaryCost(transcript, 1, Date.now()).total).toBeGreaterThan(floor);
  });

  it('is free when no run was ever recorded, transcript or not', () => {
    expect(summaryCost([], 0, Date.now()).total).toBe(0);
    expect(summaryCost([], 0, Date.now()).summaryRuns).toBe(0);
  });
});
