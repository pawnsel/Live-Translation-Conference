import type { Express, Request, Response } from 'express';
import { summarizeTranscript, type GenerateContentClient, type TranscriptLine } from './gemini';

export interface GeminiRouteDeps {
  client: GenerateContentClient;
  summaryModel: string;
}


// Deadlines so a hung Gemini SDK call can't hold a request open indefinitely
// — a hang (not an error) would otherwise stall the caller forever with no
// visible failure.
const SUMMARIZE_TIMEOUT_MS = 20000;

// Caps the summarize payload so one request can't build an unbounded prompt.
const MAX_SUMMARIZE_ITEMS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

export function registerGeminiRoutes(app: Express, deps: GeminiRouteDeps): void {
  app.post('/api/gemini/summarize', async (req: Request, res: Response) => {
    const items = Array.isArray(req.body?.items)
      ? (req.body.items as Array<{ source_text?: string; target_text?: string }>)
      : null;
    if (!items) {
      res.status(400).json({ error: 'Missing items array' });
      return;
    }
    if (items.length > MAX_SUMMARIZE_ITEMS) {
      res.status(400).json({ error: `Too many items (max ${MAX_SUMMARIZE_ITEMS})` });
      return;
    }
    const transcript: TranscriptLine[] = items.map((item) => ({
      sourceText: item.source_text ?? '',
      targetText: item.target_text ?? ''
    }));
    try {
      const summary = await withTimeout(
        summarizeTranscript(deps.client, transcript, deps.summaryModel),
        SUMMARIZE_TIMEOUT_MS,
        'summarize'
      );
      res.json({ summary, items: items.length });
    } catch {
      // Fallback contract: an AI failure never loses the transcript —
      // respond with an empty summary and the item count, same as the old
      // backend's Vertex-failure fallback.
      res.json({ summary: '', items: items.length });
    }
  });
}
