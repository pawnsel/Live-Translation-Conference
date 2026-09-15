import { describe, expect, it } from 'vitest';
import {
  activeUtteranceSeq,
  buildCaptionRows,
  rowShiftDistance,
  type CaptionRow,
  type StackLine
} from './captionStack';

/** Replays a session the way the page does: each step is one paint. */
function stack() {
  const lines: StackLine[] = [];
  let rows: CaptionRow[] = [];

  const paint = (hasPartial: boolean, liveText: string) => {
    const newestSeq = lines.length > 0 ? lines[lines.length - 1].seq : -1;
    const before = rows;
    rows = buildCaptionRows({
      lines,
      activeSeq: activeUtteranceSeq(newestSeq, hasPartial),
      liveText,
      hasPartial
    });
    return before.length === 0 ? 0 : rowShiftDistance(before, rows);
  };

  return {
    /** A fragment of the sentence being spoken arrives. */
    speak: (text: string) => paint(true, text),
    /** The utterance closes into a caption. */
    commit: (seq: number, targetText: string) => {
      lines.push({ seq, targetText });
      return paint(false, '');
    },
    /** The 600-char cap: a caption closes while the next fragment is already in. */
    commitMidStream: (seq: number, targetText: string, nextLive: string) => {
      lines.push({ seq, targetText });
      return paint(true, nextLive);
    },
    idle: () => paint(false, ''),
    texts: () => rows.map((row) => row.text)
  };
}

describe('buildCaptionRows', () => {
  it('is three rows tall before a word has been said', () => {
    const rows = buildCaptionRows({ lines: [], activeSeq: -1, liveText: '', hasPartial: false });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.text)).toEqual(['', '', '']);
  });

  it('puts the sentence being spoken on the bottom row', () => {
    const rows = buildCaptionRows({
      lines: [{ seq: 1, targetText: 'one' }],
      activeSeq: 2,
      liveText: 'two…',
      hasPartial: true
    });
    expect(rows.map((r) => r.text)).toEqual(['', 'one', 'two…']);
  });

  it('keeps the live row key across the commit that fills it', () => {
    const speaking = buildCaptionRows({ lines: [], activeSeq: 0, liveText: 'hel', hasPartial: true });
    const committed = buildCaptionRows({
      lines: [{ seq: 0, targetText: 'hello' }],
      activeSeq: 0,
      liveText: '',
      hasPartial: false
    });
    expect(committed[2].key).toBe(speaking[2].key);
  });

  it('drops the oldest line once the stack is full', () => {
    const lines = [1, 2, 3, 4].map((seq) => ({ seq, targetText: `line ${seq}` }));
    const rows = buildCaptionRows({ lines, activeSeq: 5, liveText: 'five…', hasPartial: true });
    expect(rows.map((r) => r.text)).toEqual(['line 3', 'line 4', 'five…']);
  });

  it('leaves an utterance with no translation out of history', () => {
    const lines = [
      { seq: 1, targetText: 'one' },
      { seq: 2, targetText: '   ' },
      { seq: 3, targetText: 'three' }
    ];
    const rows = buildCaptionRows({ lines, activeSeq: 4, liveText: 'four…', hasPartial: true });
    expect(rows.map((r) => r.text)).toEqual(['one', 'three', 'four…']);
  });
});

describe('the stack while somebody is speaking', () => {
  it('does not move while a sentence is being spoken', () => {
    const s = stack();
    expect(s.speak('สวัสดี')).toBe(0);
    expect(s.speak('สวัสดีครับ')).toBe(0);
    expect(s.speak('สวัสดีครับทุกท่าน')).toBe(0);
  });

  it('does not move when that sentence closes into a caption', () => {
    const s = stack();
    s.speak('hello');
    expect(s.commit(0, 'hello there')).toBe(0);
    expect(s.texts()).toEqual(['', '', 'hello there']);
  });

  it('climbs one row when the next sentence starts', () => {
    const s = stack();
    s.speak('one');
    s.commit(0, 'one');
    expect(s.speak('tw')).toBe(1);
    expect(s.texts()).toEqual(['', 'one', 'tw']);
  });

  it('climbs once per sentence, never twice for the same one', () => {
    const s = stack();
    s.speak('one');
    s.commit(0, 'one');
    expect(s.speak('two')).toBe(1);
    expect(s.commit(1, 'two')).toBe(0);
    expect(s.speak('three')).toBe(1);
    expect(s.commit(2, 'three')).toBe(0);
    expect(s.texts()).toEqual(['one', 'two', 'three']);
  });

  it('climbs when a caption closes with the next fragment already in flight', () => {
    // The 600-character cap closes a caption mid-speech, so the commit and the
    // next partial land in one paint. That is still exactly one shift.
    const s = stack();
    s.speak('one');
    s.commit(0, 'one');
    s.speak('two');
    expect(s.commitMidStream(1, 'two', 'three…')).toBe(1);
    expect(s.texts()).toEqual(['one', 'two', 'three…']);
  });

  it('stays put when an utterance closes with no translation', () => {
    const s = stack();
    s.speak('one');
    s.commit(0, 'one');
    s.speak('two');
    s.commit(1, 'two');
    // Heard, transcribed, never translated. Starting it climbed the stack
    // like any other utterance…
    expect(s.speak('…')).toBe(1);
    expect(s.texts()).toEqual(['one', 'two', '…']);
    // …but closing it with nothing to show moves nothing, and the sentence
    // after it takes over the same row rather than costing a second shift.
    expect(s.commit(2, '')).toBe(0);
    expect(s.texts()).toEqual(['one', 'two', '']);
    expect(s.speak('four')).toBe(0);
    expect(s.texts()).toEqual(['one', 'two', 'four']);
  });

  it('never pulls an older line back down', () => {
    const s = stack();
    s.speak('one');
    s.commit(0, 'one');
    s.speak('two');
    s.commit(1, 'two');
    const before = s.texts();
    s.idle();
    expect(s.texts()).toEqual(before);
  });

  it('slides two rows when two sentences land in one paint', () => {
    // Two captions arrive between paints: the stack really did move twice.
    const lines = [
      { seq: 0, targetText: 'one' },
      { seq: 1, targetText: 'two' },
      { seq: 2, targetText: 'three' }
    ];
    const before = buildCaptionRows({ lines: lines.slice(0, 1), activeSeq: 1, liveText: 'two…', hasPartial: true });
    const after = buildCaptionRows({ lines, activeSeq: 3, liveText: 'four…', hasPartial: true });
    expect(rowShiftDistance(before, after)).toBe(2);
  });

  it('keeps climbing for as long as somebody keeps talking', () => {
    // The stack filling up is not a stopping point: line 4 and everything
    // after it has to move exactly as far as line 2 did.
    const s = stack();
    for (let seq = 0; seq < 8; seq++) {
      expect(s.speak(`sentence ${seq}`)).toBe(seq === 0 ? 0 : 1);
      expect(s.commit(seq, `sentence ${seq}`)).toBe(0);
    }
    expect(s.texts()).toEqual(['sentence 5', 'sentence 6', 'sentence 7']);
  });
});
