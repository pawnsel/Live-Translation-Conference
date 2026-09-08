import { describe, expect, it } from 'vitest';
import { fitSubtitlePage, isContinuation, longestFittingLength } from './subtitleLines';

// A stand-in for the browser's layout: a fixed number of characters per
// line, wrapping on spaces, and hard-wrapping a run that is longer than a
// line all by itself — which is how the box treats Thai, a script that
// writes without spaces.
function measurerOf(charsPerLine: number) {
  return (text: string): number => {
    if (!text) return 0;
    let lines = 1;
    let used = 0;
    for (const word of text.split(' ')) {
      let rest = word;
      if (used > 0) {
        if (used + 1 + rest.length > charsPerLine) {
          lines++;
          used = 0;
        } else {
          used += 1;
        }
      }
      while (used + rest.length > charsPerLine) {
        rest = rest.slice(charsPerLine - used);
        lines++;
        used = 0;
      }
      used += rest.length;
    }
    return lines;
  };
}

describe('fitSubtitlePage', () => {
  const measure = measurerOf(20);

  it('leaves short text alone', () => {
    expect(fitSubtitlePage('hello there', 0, 2, measure)).toBe(0);
  });

  it('leaves text alone while it still fits in two lines', () => {
    const text = 'one two three four five six seven';
    expect(measure(text)).toBe(2);
    expect(fitSubtitlePage(text, 0, 2, measure)).toBe(0);
  });

  it('starts a new block once a third line would be needed', () => {
    const text = 'one two three four five six seven eight nine ten eleven';
    expect(measure(text)).toBeGreaterThan(2);
    const start = fitSubtitlePage(text, 0, 2, measure);
    expect(start).toBeGreaterThan(0);
    expect(measure(text.slice(start))).toBeLessThanOrEqual(2);
  });

  it('never shows more than two lines however long the speech runs', () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`);
    let start = 0;
    let text = '';
    for (const word of words) {
      text = text ? `${text} ${word}` : word;
      start = fitSubtitlePage(text, start, 2, measure);
      expect(measure(text.slice(start))).toBeLessThanOrEqual(2);
    }
  });

  it('pages on word boundaries, so a block never opens mid-word', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel india';
    const start = fitSubtitlePage(text, 0, 2, measure);
    expect(text[start - 1]).toBe(' ');
    expect(text.slice(start).startsWith(' ')).toBe(false);
  });

  it('pages Thai text, which has no spaces to break on', () => {
    const text = 'ทดสอบระบบแปลภาษาแบบเรียลไทม์สำหรับการประชุมทางการแพทย์ที่ยาวมากจนเกินสองบรรทัด';
    const start = fitSubtitlePage(text, 0, 2, measure);
    expect(start).toBeGreaterThan(0);
    expect(measure(text.slice(start))).toBeLessThanOrEqual(2);
  });

  it('gives up rather than looping when the box has no usable width', () => {
    const zeroWidth = () => 99;
    expect(fitSubtitlePage('anything at all', 0, 2, zeroWidth)).toBe(0);
  });
});

describe('longestFittingLength', () => {
  it('returns 0 when not even one character fits', () => {
    expect(longestFittingLength('abc', 0, 2, () => 99)).toBe(0);
  });
});

describe('isContinuation', () => {
  it('treats appended fragments of one utterance as the same block', () => {
    expect(isContinuation('สวัสดี', 'สวัสดีครับ')).toBe(true);
    expect(isContinuation('hello', 'hello')).toBe(true);
  });

  it('treats a fresh caption as a new block', () => {
    expect(isContinuation('สวัสดีครับ', 'ขอบคุณ')).toBe(false);
    expect(isContinuation('hello world', 'hello')).toBe(false);
  });
});
