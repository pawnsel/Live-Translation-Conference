import { createServer } from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerGeminiRoutes } from './geminiRoutes';
import type { GenerateContentClient } from './gemini';

async function withServer(
  deps: { client: GenerateContentClient; summaryModel: string },
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

describe('POST /api/gemini/summarize', () => {
  it('returns the summary and item count on success', async () => {
    const client = fakeClient('Meeting went well.');
    await withServer({ client, summaryModel: 'test-model' }, async (baseUrl) => {
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
    await withServer({ client, summaryModel: 'm' }, async (baseUrl) => {
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
