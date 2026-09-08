import type { Server as HttpServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';

// Relays microphone audio from the browser to Gemini's live translation
// model and streams the transcription/translation back. This is the
// console's caption pipeline (src/asr/audio/useGeminiLiveCapture.ts).
//
// Security model: the browser only ever talks to OUR WebSocket endpoint. It
// never sees GEMINI_API_KEY or the model name — this server is the only
// thing that holds the key and opens the real connection to Gemini.

const GEMINI_LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';
const PROXY_PATH = '/ws/gemini-live-transcribe';
const MAX_MESSAGE_BYTES = 1024 * 1024; // audio frames here are small (base64 PCM chunks)

// customVocabulary can only be set in the setup message, so setup waits for
// the client's glossary frame — but a client that never sends one must
// still get a working session.
const GLOSSARY_WAIT_MS = 1500;
const MAX_VOCABULARY_TERMS = 500;
const MAX_TERM_LENGTH = 100;
// Audio queued while the Gemini session is still opening. Bounded so a
// setup that never completes cannot grow this without limit — 20 ms per
// frame means this is a couple of seconds of speech, and the oldest frames
// are the ones worth dropping.
const MAX_PENDING_FRAMES = 150;

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

// The console lets an operator translate either direction, so the language
// pair has to come from the client — but it reaches a billed API, so only
// the pair this app actually offers is accepted.
const ALLOWED_TARGET_LANGS = ['en', 'th'];
const ALLOWED_SOURCE_LANGS = ['en-US', 'th-TH', 'en', 'th'];

function sanitizeLangs(value: unknown, allowed: string[]): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && allowed.includes(v));
}

// The vocabulary is the one client-supplied part of the setup message, and
// it reaches a billed API — so it is bounded and type-checked here rather
// than trusted.
function sanitizeVocabulary(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const term = item.trim().slice(0, MAX_TERM_LENGTH);
    if (term) seen.add(term);
    if (seen.size >= MAX_VOCABULARY_TERMS) break;
  }
  return [...seen];
}

export function registerGeminiLiveProxy(httpServer: HttpServer, opts: GeminiLiveProxyOptions): void {
  const wss = new WebSocketServer({ server: httpServer, path: PROXY_PATH, maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', (client) => {
    const upstream = new WebSocket(`${GEMINI_LIVE_WS_URL}?key=${opts.apiKey}`);

    // Audio arriving before Gemini's setupComplete would be dropped by
    // Gemini — queue it and flush once ready, so the client never has to
    // know about handshake timing.
    let upstreamReady = false;
    let setupSent = false;
    let configReceived = false;
    let vocabulary: string[] = [];
    let targetLanguageCode = opts.targetLanguageCode;
    let sourceLanguageCodes = opts.sourceLanguageCodes;
    const pending: Buffer[] = [];

    const closeBoth = (code?: number, reason?: string) => {
      clearTimeout(glossaryTimer);
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(code, reason);
      }
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    };

    const sendSetup = () => {
      if (setupSent || upstream.readyState !== WebSocket.OPEN) return;
      setupSent = true;
      clearTimeout(glossaryTimer);

      const inputAudioTranscription: Record<string, unknown> = { languageCodes: sourceLanguageCodes };
      // adaptationPhrases would do the same job but is marked deprecated in
      // the API's discovery document, so only customVocabulary is used.
      if (vocabulary.length > 0) inputAudioTranscription.customVocabulary = vocabulary;

      upstream.send(
        JSON.stringify({
          setup: {
            model: `models/${opts.model}`,
            generationConfig: {
              responseModalities: ['TEXT'],
              translationConfig: { targetLanguageCode }
            },
            // Without this, only the translation comes back; with it the
            // original speech arrives too, as serverContent.inputTranscription.
            inputAudioTranscription
          }
        })
      );
    };

    const glossaryTimer = setTimeout(sendSetup, GLOSSARY_WAIT_MS);

    upstream.on('open', () => {
      // If the client's config frame already arrived, start the session now;
      // otherwise the timer above starts it shortly.
      if (configReceived) sendSetup();
    });

    upstream.on('message', (data, isBinary) => {
      // Peek without assuming JSON — an unparseable frame is still relayed
      // below rather than silently dropped.
      let parsed: Record<string, any> | null = null;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        parsed = null;
      }

      if (!upstreamReady && parsed?.setupComplete) {
        upstreamReady = true;
        for (const queued of pending.splice(0)) upstream.send(queued);
      }

      // This model speaks its translation as well as writing it, so most
      // frames are base64 PCM in modelTurn.parts[].inlineData — tens of KB
      // each, useless to a text-only UI. Drop frames carrying nothing else;
      // anything with a transcription or other field still goes through.
      const parts = parsed?.serverContent?.modelTurn?.parts;
      if (Array.isArray(parts) && parts.length > 0 && parts.every((p: any) => p?.inlineData && !p.text)) {
        return;
      }

      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });

    upstream.on('close', (code, reason) => closeBoth(code, reason.toString()));
    upstream.on('error', () => closeBoth(1011, 'upstream Gemini connection failed'));

    client.on('message', (data, isBinary) => {
      // The client's opening frame carries its glossary; it is consumed
      // here rather than relayed, since Gemini has no such message.
      if (!setupSent) {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed?.customVocabulary !== undefined || parsed?.targetLanguageCode !== undefined) {
            configReceived = true;
            vocabulary = sanitizeVocabulary(parsed.customVocabulary);
            const target = sanitizeLangs([parsed.targetLanguageCode], ALLOWED_TARGET_LANGS);
            if (target.length > 0) targetLanguageCode = target[0];
            const sources = sanitizeLangs(parsed.sourceLanguageCodes, ALLOWED_SOURCE_LANGS);
            if (sources.length > 0) sourceLanguageCodes = sources;
            sendSetup();
            return;
          }
        } catch {
          // Not a config frame — fall through and treat as normal traffic.
        }
      }

      if (upstreamReady) {
        upstream.send(data, { binary: isBinary });
      } else {
        if (pending.length >= MAX_PENDING_FRAMES) pending.shift();
        pending.push(data as Buffer);
      }
    });

    client.on('close', () => closeBoth());
    client.on('error', () => closeBoth());
  });
}
