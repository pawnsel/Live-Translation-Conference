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
