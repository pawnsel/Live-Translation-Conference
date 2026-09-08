// Per-client bridge between the browser and one Gemini live session.
//
// Split out of geminiLiveProxy.ts so the connection logic can be driven by
// fakes in tests: the upstream socket arrives as a factory rather than being
// constructed here, and both sides are typed structurally so `ws`'s
// WebSocket satisfies them without this module importing `ws` at all.

export const CONNECTING = 0;
export const OPEN = 1;

export interface SocketLike {
  readonly readyState: number;
  send(data: string | Buffer, opts?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(event: string, cb: (...args: any[]) => void): this;
}

export type OpenUpstream = () => SocketLike;

export interface BridgeOptions {
  model: string;
  targetLanguageCode: string;
  sourceLanguageCodes: string[];
  openUpstream: OpenUpstream;
}

// customVocabulary can only be set in the setup message, so setup waits for
// the client's glossary frame — but a client that never sends one must
// still get a working session.
export const GLOSSARY_WAIT_MS = 1500;
export const MAX_VOCABULARY_TERMS = 500;
export const MAX_TERM_LENGTH = 100;
// Audio queued while the Gemini session is still opening. Bounded so a
// setup that never completes cannot grow this without limit — 20 ms per
// frame means this is a couple of seconds of speech, and the oldest frames
// are the ones worth dropping.
export const MAX_PENDING_FRAMES = 150;
// Glossary pairs become a system instruction. The client sends the pairs,
// never the instruction text — that boundary is what stops a browser from
// running arbitrary prompts on our billed key.
export const MAX_GLOSSARY_PAIRS = 200;

// The console lets an operator translate either direction, so the language
// pair has to come from the client — but it reaches a billed API, so only
// the pair this app actually offers is accepted.
export const ALLOWED_TARGET_LANGS = ['en', 'th'];
export const ALLOWED_SOURCE_LANGS = ['en-US', 'th-TH', 'en', 'th'];

export function sanitizeLangs(value: unknown, allowed: string[]): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && allowed.includes(v));
}

// Client-supplied glossary text reaches a billed API, so it is bounded and
// type-checked rather than trusted. Quotes and newlines are stripped so a
// term cannot break out of the instruction template it is embedded in.
export function cleanTerm(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/["\r\n]/g, ' ').trim().slice(0, MAX_TERM_LENGTH);
}

export function buildGlossaryInstruction(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const lines: string[] = [];
  for (const pair of value.slice(0, MAX_GLOSSARY_PAIRS)) {
    const term = cleanTerm((pair as { term?: unknown })?.term);
    const translation = cleanTerm((pair as { translation?: unknown })?.translation);
    if (term && translation) lines.push(`"${term}" must always be translated as "${translation}".`);
  }
  if (lines.length === 0) return null;
  return `Glossary — use these exact translations, overriding your own wording:\n${lines.join('\n')}`;
}

export function sanitizeVocabulary(value: unknown): string[] {
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

export function createLiveBridge(client: SocketLike, opts: BridgeOptions): void {
  const upstream = opts.openUpstream();

  // Audio arriving before Gemini's setupComplete would be dropped by
  // Gemini — queue it and flush once ready, so the client never has to
  // know about handshake timing.
  let upstreamReady = false;
  let setupSent = false;
  let configReceived = false;
  let vocabulary: string[] = [];
  let glossaryInstruction: string | null = null;
  let targetLanguageCode = opts.targetLanguageCode;
  let sourceLanguageCodes = opts.sourceLanguageCodes;
  const pending: Buffer[] = [];

  const closeBoth = (code?: number, reason?: string) => {
    clearTimeout(glossaryTimer);
    if (client.readyState === OPEN || client.readyState === CONNECTING) {
      client.close(code, reason);
    }
    if (upstream.readyState === OPEN || upstream.readyState === CONNECTING) {
      upstream.close();
    }
  };

  const sendSetup = () => {
    if (setupSent || upstream.readyState !== OPEN) return;
    setupSent = true;
    clearTimeout(glossaryTimer);

    const inputAudioTranscription: Record<string, unknown> = { languageCodes: sourceLanguageCodes };
    // adaptationPhrases would do the same job but is marked deprecated in
    // the API's discovery document, so only customVocabulary is used.
    if (vocabulary.length > 0) inputAudioTranscription.customVocabulary = vocabulary;

    const setup: Record<string, unknown> = {
      model: `models/${opts.model}`,
      generationConfig: {
        responseModalities: ['TEXT'],
        translationConfig: { targetLanguageCode }
      },
      // Without this, only the translation comes back; with it the
      // original speech arrives too, as serverContent.inputTranscription.
      inputAudioTranscription
    };
    // customVocabulary only biases what the recogniser hears; pinning how
    // a term is TRANSLATED needs this instruction (verified: the live
    // translate model honours it, unlike the transcribe-only model).
    if (glossaryInstruction) setup.systemInstruction = { parts: [{ text: glossaryInstruction }] };

    upstream.send(JSON.stringify({ setup }));
  };

  const glossaryTimer = setTimeout(sendSetup, GLOSSARY_WAIT_MS);

  upstream.on('open', () => {
    // If the client's config frame already arrived, start the session now;
    // otherwise the timer above starts it shortly.
    if (configReceived) sendSetup();
  });

  upstream.on('message', (data: Buffer, isBinary: boolean) => {
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

    if (client.readyState === OPEN) client.send(data, { binary: isBinary });
  });

  upstream.on('close', (code: number, reason: Buffer) => closeBoth(code, reason?.toString()));
  upstream.on('error', () => closeBoth(1011, 'upstream Gemini connection failed'));

  client.on('message', (data: Buffer, isBinary: boolean) => {
    // The client's opening frame carries its glossary; it is consumed
    // here rather than relayed, since Gemini has no such message.
    if (!setupSent) {
      try {
        const parsed = JSON.parse(data.toString());
        if (
          parsed?.customVocabulary !== undefined ||
          parsed?.targetLanguageCode !== undefined ||
          parsed?.glossaryPairs !== undefined
        ) {
          configReceived = true;
          vocabulary = sanitizeVocabulary(parsed.customVocabulary);
          glossaryInstruction = buildGlossaryInstruction(parsed.glossaryPairs);
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
}
