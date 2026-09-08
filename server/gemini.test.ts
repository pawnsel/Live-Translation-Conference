import { describe, expect, it, vi } from 'vitest';
import { summarizeTranscript, type GenerateContentClient } from './gemini';

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

  it('throws a clear error when Gemini returns an empty/safety-blocked response', async () => {
    const { client } = fakeClient(undefined as unknown as string);
    await expect(summarizeTranscript(client, [{ sourceText: 'a', targetText: 'b' }], 'model')).rejects.toThrow(/empty/i);
  });
});

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
