import type { Server as HttpServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { createLiveBridge } from './geminiLiveBridge';

// Relays microphone audio from the browser to Gemini's live translation
// model and streams the transcription/translation back. This is the
// console's caption pipeline (src/asr/audio/useGeminiLiveCapture.ts).
//
// Security model: the browser only ever talks to OUR WebSocket endpoint. It
// never sees GEMINI_API_KEY or the model name — this server is the only
// thing that holds the key and opens the real connection to Gemini. The
// per-connection logic lives in geminiLiveBridge.ts so it can be tested
// without sockets; this file owns only the endpoint and the API key.

const GEMINI_LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';
const PROXY_PATH = '/ws/gemini-live-transcribe';
const MAX_MESSAGE_BYTES = 1024 * 1024; // audio frames here are small (base64 PCM chunks)

export interface GeminiLiveProxyOptions {
  apiKey: string;
  model: string;
  // BCP-47 code the model translates INTO. Source language is
  // auto-detected — TranslationConfig has no source field (verified
  // against the API's own discovery document).
  targetLanguageCode: string;
  // Hints for the source-audio transcription, which is what surfaces the
  // original speech alongside the translation.
  sourceLanguageCodes: string[];
}

export function registerGeminiLiveProxy(httpServer: HttpServer, opts: GeminiLiveProxyOptions): void {
  const wss = new WebSocketServer({ server: httpServer, path: PROXY_PATH, maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', (client) => {
    createLiveBridge(client, {
      model: opts.model,
      targetLanguageCode: opts.targetLanguageCode,
      sourceLanguageCodes: opts.sourceLanguageCodes,
      openUpstream: () => new WebSocket(`${GEMINI_LIVE_WS_URL}?key=${opts.apiKey}`)
    });
  });
}
