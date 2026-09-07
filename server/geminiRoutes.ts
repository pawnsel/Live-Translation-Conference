import type { Express, Request, Response } from 'express';
import multer from 'multer';
import { summarizeTranscript, transcribeChunk, type GenerateContentClient, type TranscriptLine } from './gemini';
import type { GlossarySections } from '../src/glossary';

export interface GeminiRouteDeps {
  client: GenerateContentClient;
  model: string;
  summaryModel: string;
}

interface TranscribeMeta {
  sourceLang?: string;
  targetLang?: string;
  glossary?: GlossarySections;
  context?: string;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// Deadlines so a hung Gemini SDK call can't hold a request open indefinitely
// — a hang (not an error) would otherwise stall the caller forever with no
// visible failure.
const TRANSCRIBE_TIMEOUT_MS = 15000;
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
  app.post('/api/gemini/transcribe', upload.single('audio'), async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'Missing audio file' });
      return;
    }
    let meta: TranscribeMeta;
    try {
      meta = JSON.parse((req.body?.meta as string) ?? '{}');
    } catch {
      res.status(400).json({ error: 'Invalid meta JSON' });
      return;
    }
    if (!meta.sourceLang || !meta.targetLang) {
      res.status(400).json({ error: 'meta.sourceLang and meta.targetLang are required' });
      return;
    }

    const startedAt = Date.now();
    try {
      const result = await withTimeout(
        transcribeChunk(
          deps.client,
          {
            audio: req.file.buffer,
            // The client always sends WAV; the upload's declared mimetype is
            // attacker-controlled multipart header data, not something to
            // trust and forward to Gemini verbatim.
            mimeType: 'audio/wav',
            sourceLang: meta.sourceLang,
            targetLang: meta.targetLang,
            glossary: meta.glossary ?? { protected_terms: {}, person_names: {}, thai_corrections: {} },
            context: meta.context ?? ''
          },
          deps.model
        ),
        TRANSCRIBE_TIMEOUT_MS,
        'transcribe'
      );
      res.json({ source_text: result.sourceText, target_text: result.targetText, latencyMs: Date.now() - startedAt });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Gemini transcription failed' });
    }
  });

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
