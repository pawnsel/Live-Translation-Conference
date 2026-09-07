import { createServer } from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerGeminiRoutes } from './geminiRoutes';
import type { GenerateContentClient } from './gemini';

async function withServer(
  deps: { client: GenerateContentClient; model: string; summaryModel: string },
  run: (baseUrl: string) => Promise<void>
) {
  const app = express();
  app.use(express.json());
  registerGeminiRoutes(app, deps);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function fakeClient(text: string): GenerateContentClient {
  return { generateContent: vi.fn(async () => ({ text })) };
}

describe('POST /api/gemini/transcribe', () => {
  it('transcribes an uploaded audio chunk and returns source/target text', async () => {
    const client = fakeClient(JSON.stringify({ source_text: 'สวัสดี', target_text: 'Hello' }));
    await withServer({ client, model: 'test-model', summaryModel: 'test-model' }, async (baseUrl) => {
      const form = new FormData();
      form.append('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }), 'chunk.wav');
      form.append(
        'meta',
        JSON.stringify({
          sourceLang: 'th',
          targetLang: 'en',
          glossary: { protected_terms: {}, person_names: {}, thai_corrections: {} },
          context: ''
        })
      );

      const res = await fetch(`${baseUrl}/api/gemini/transcribe`, { method: 'POST', body: form });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.source_text).toBe('สวัสดี');
      expect(body.target_text).toBe('Hello');
      expect(typeof body.latencyMs).toBe('number');
    });
  });

  it('rejects a request with no audio file', async () => {
    const client = fakeClient('{}');
    await withServer({ client, model: 'm', summaryModel: 'm' }, async (baseUrl) => {
      const form = new FormData();
      form.append('meta', JSON.stringify({ sourceLang: 'th', targetLang: 'en' }));
      const res = await fetch(`${baseUrl}/api/gemini/transcribe`, { method: 'POST', body: form });
      expect(res.status).toBe(400);
    });
  });

  it('rejects a request missing meta.sourceLang', async () => {
    const client = fakeClient(JSON.stringify({ source_text: 'a', target_text: 'b' }));
    await withServer({ client, model: 'm', summaryModel: 'm' }, async (baseUrl) => {
      const form = new FormData();
      form.append('audio', new Blob([new Uint8Array([1])], { type: 'audio/wav' }), 'chunk.wav');
      form.append('meta', JSON.stringify({ targetLang: 'en' }));
      const res = await fetch(`${baseUrl}/api/gemini/transcribe`, { method: 'POST', body: form });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/sourceLang/);
    });
  });

  it('rejects a request with malformed meta JSON', async () => {
    const client = fakeClient(JSON.stringify({ source_text: 'a', target_text: 'b' }));
    await withServer({ client, model: 'm', summaryModel: 'm' }, async (baseUrl) => {
      const form = new FormData();
      form.append('audio', new Blob([new Uint8Array([1])], { type: 'audio/wav' }), 'chunk.wav');
      form.append('meta', '{not valid json');
      const res = await fetch(`${baseUrl}/api/gemini/transcribe`, { method: 'POST', body: form });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid meta JSON/);
    });
  });

  it('always sends audio/wav as the inlineData mimeType regardless of the upload part mimetype', async () => {
    const client = fakeClient(JSON.stringify({ source_text: 'a', target_text: 'b' }));
    await withServer({ client, model: 'm', summaryModel: 'm' }, async (baseUrl) => {
      const form = new FormData();
      // Deliberately lie about the content type — the server must not
      // forward this client-controlled value to Gemini verbatim.
      form.append('audio', new Blob([new Uint8Array([1])], { type: 'application/octet-stream' }), 'chunk.bin');
      form.append('meta', JSON.stringify({ sourceLang: 'th', targetLang: 'en' }));
      const res = await fetch(`${baseUrl}/api/gemini/transcribe`, { method: 'POST', body: form });
      expect(res.status).toBe(200);
      const generateContent = client.generateContent as ReturnType<typeof vi.fn>;
      const args = generateContent.mock.calls[0][0] as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
      expect(args.contents[0].parts[0]).toMatchObject({ inlineData: { mimeType: 'audio/wav' } });
    });
  });

  it('returns 502 when the Gemini call fails', async () => {
    const client: GenerateContentClient = {
      generateContent: vi.fn(async () => {
        throw new Error('quota exceeded');
      })
    };
    await withServer({ client, model: 'm', summaryModel: 'm' }, async (baseUrl) => {
      const form = new FormData();
      form.append('audio', new Blob([new Uint8Array([1])], { type: 'audio/wav' }), 'chunk.wav');
      form.append('meta', JSON.stringify({ sourceLang: 'th', targetLang: 'en' }));
      const res = await fetch(`${baseUrl}/api/gemini/transcribe`, { method: 'POST', body: form });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toContain('quota exceeded');
    });
  });
});

describe('POST /api/gemini/summarize', () => {
  it('returns the summary and item count on success', async () => {
    const client = fakeClient('Meeting went well.');
    await withServer({ client, model: 'm', summaryModel: 'test-model' }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/gemini/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ source_text: 'a', target_text: 'b' }] })
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.summary).toBe('Meeting went well.');
      expect(body.items).toBe(1);
    });
  });

  it('falls back to an empty summary, never losing the item count, when Gemini fails', async () => {
    const client: GenerateContentClient = {
      generateContent: vi.fn(async () => {
        throw new Error('down');
      })
    };
    await withServer({ client, model: 'm', summaryModel: 'm' }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/gemini/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            { source_text: 'a', target_text: 'b' },
            { source_text: 'c', target_text: 'd' }
          ]
        })
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.summary).toBe('');
      expect(body.items).toBe(2);
    });
  });
});
