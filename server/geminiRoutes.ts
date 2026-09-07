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
      const result = await transcribeChunk(
        deps.client,
        {
          audio: req.file.buffer,
          mimeType: req.file.mimetype || 'audio/wav',
          sourceLang: meta.sourceLang,
          targetLang: meta.targetLang,
          glossary: meta.glossary ?? { protected_terms: {}, person_names: {}, thai_corrections: {} },
          context: meta.context ?? ''
        },
        deps.model
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
    const transcript: TranscriptLine[] = items.map((item) => ({
      sourceText: item.source_text ?? '',
      targetText: item.target_text ?? ''
    }));
    try {
      const summary = await summarizeTranscript(deps.client, transcript, deps.summaryModel);
      res.json({ summary, items: items.length });
    } catch {
      // Fallback contract: an AI failure never loses the transcript —
      // respond with an empty summary and the item count, same as the old
      // backend's Vertex-failure fallback.
      res.json({ summary: '', items: items.length });
    }
  });
}
