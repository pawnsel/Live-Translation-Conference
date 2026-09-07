import { describe, expect, it, vi } from 'vitest';
import { summarizeTranscript, transcribeChunk, type GenerateContentClient } from './gemini';
import { emptyGlossary } from '../src/glossary';

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

describe('transcribeChunk', () => {
  it('sends the audio as inline base64 data and parses the structured JSON response', async () => {
    const { client, calls } = fakeClient(JSON.stringify({ source_text: 'สวัสดี', target_text: 'Hello' }));
    const result = await transcribeChunk(
      client,
      {
        audio: Buffer.from([1, 2, 3]),
        mimeType: 'audio/wav',
        sourceLang: 'th',
        targetLang: 'en',
        glossary: emptyGlossary(),
        context: ''
      },
      'gemini-test-model'
    );

    expect(result).toEqual({ sourceText: 'สวัสดี', targetText: 'Hello' });
    const args = calls[0] as { model: string; contents: Array<{ parts: Array<Record<string, unknown>> }> };
    expect(args.model).toBe('gemini-test-model');
    expect(args.contents[0].parts[0]).toEqual({
      inlineData: { mimeType: 'audio/wav', data: Buffer.from([1, 2, 3]).toString('base64') }
    });
  });

  it('requests structured JSON output via config.responseMimeType and responseSchema', async () => {
    // Pins the structured-output mechanism the spec specifically chose for
    // reliability (over asking for JSON in the prompt text alone) — nothing
    // else protected this before.
    const { client, calls } = fakeClient(JSON.stringify({ source_text: 'a', target_text: 'b' }));
    await transcribeChunk(
      client,
      { audio: Buffer.from([1]), mimeType: 'audio/wav', sourceLang: 'th', targetLang: 'en', glossary: emptyGlossary(), context: '' },
      'gemini-test-model'
    );
    const args = calls[0] as { config?: { responseMimeType?: string; responseSchema?: unknown } };
    expect(args.config?.responseMimeType).toBe('application/json');
    expect(args.config?.responseSchema).toBeDefined();
    expect(args.config?.responseSchema).toEqual(
      expect.objectContaining({
        type: 'object',
        required: expect.arrayContaining(['source_text', 'target_text'])
      })
    );
  });

  it('throws a clear error when Gemini returns an empty/safety-blocked response', async () => {
    const { client } = fakeClient(undefined as unknown as string);
    await expect(
      transcribeChunk(
        client,
        { audio: Buffer.from([1]), mimeType: 'audio/wav', sourceLang: 'th', targetLang: 'en', glossary: emptyGlossary(), context: '' },
        'model'
      )
    ).rejects.toThrow(/empty/i);
  });

  it('includes glossary terms and prior context in the prompt text', async () => {
    const { client, calls } = fakeClient(JSON.stringify({ source_text: 'a', target_text: 'b' }));
    await transcribeChunk(
      client,
      {
        audio: Buffer.from([1]),
        mimeType: 'audio/wav',
        sourceLang: 'th',
        targetLang: 'en',
        glossary: { protected_terms: { ความดันโลหิตสูง: 'hypertension' }, person_names: {}, thai_corrections: {} },
        context: 'previous sentence'
      },
      'gemini-test-model'
    );
    const args = calls[0] as { contents: Array<{ parts: Array<{ text?: string }> }> };
    const promptText = args.contents[0].parts[1].text ?? '';
    expect(promptText).toContain('ความดันโลหิตสูง');
    expect(promptText).toContain('hypertension');
    expect(promptText).toContain('previous sentence');
  });

  it('throws when Gemini returns malformed JSON', async () => {
    const { client } = fakeClient('not json');
    await expect(
      transcribeChunk(
        client,
        { audio: Buffer.from([1]), mimeType: 'audio/wav', sourceLang: 'th', targetLang: 'en', glossary: emptyGlossary(), context: '' },
        'model'
      )
    ).rejects.toThrow(/non-JSON/);
  });

  it('throws when a required field is missing from the response', async () => {
    const { client } = fakeClient(JSON.stringify({ source_text: 'only source' }));
    await expect(
      transcribeChunk(
        client,
        { audio: Buffer.from([1]), mimeType: 'audio/wav', sourceLang: 'th', targetLang: 'en', glossary: emptyGlossary(), context: '' },
        'model'
      )
    ).rejects.toThrow(/missing/);
  });
});

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
