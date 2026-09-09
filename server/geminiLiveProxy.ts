import type { IncomingMessage, Server as HttpServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { createLiveBridge } from './geminiLiveBridge';
import { bearerFromWebSocketProtocol, type ApprovedUser, type Verifier } from './auth';

// Relays microphone audio from the browser to Gemini's live translation
// model and streams the transcription/translation back. This is the
// console's caption pipeline (src/asr/audio/useGeminiLiveCapture.ts).
//
// Security model: the browser only ever talks to OUR WebSocket endpoint. It
// never sees GEMINI_API_KEY or the model name — this server is the only
// thing that holds the key and opens the real connection to Gemini. The
// per-connection logic lives in geminiLiveBridge.ts so it can be tested
// without sockets; this file owns only the endpoint and the API key.
//
// This is the most expensive path in the system (live audio, billed by the
// minute), so the handshake is refused outright unless the caller presents an
// approved account's access token — see server/auth.ts. Nothing upstream is
// opened, and no audio is read, before that check passes.

const GEMINI_LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';
const PROXY_PATH = '/ws/gemini-live-transcribe';
const MAX_MESSAGE_BYTES = 1024 * 1024; // audio frames here are small (base64 PCM chunks)

export interface GeminiLiveProxyOptions {
  apiKey: string;
  model: string;
  /** Checks the caller's access token against the approval table. Required:
   *  there is no unauthenticated mode for this endpoint. */
  verify: Verifier;
  // BCP-47 code the model translates INTO. Source language is
  // auto-detected — TranslationConfig has no source field (verified
  // against the API's own discovery document).
  targetLanguageCode: string;
  // Hints for the source-audio transcription, which is what surfaces the
  // original speech alongside the translation.
  sourceLanguageCodes: string[];
}

// Who was let in, keyed by the handshake request. A WeakMap rather than a
// property on the request so nothing has to lie to the type system, and the
// entry disappears with the request itself.
const approvedByRequest = new WeakMap<IncomingMessage, ApprovedUser>();

export function registerGeminiLiveProxy(httpServer: HttpServer, opts: GeminiLiveProxyOptions): void {
  const wss = new WebSocketServer({
    server: httpServer,
    path: PROXY_PATH,
    maxPayload: MAX_MESSAGE_BYTES,
    // Runs during the HTTP upgrade, before any WebSocket exists. An
    // unapproved caller is answered with a plain 401 and never reaches
    // 'connection', so no Gemini session is ever opened for them.
    verifyClient: ({ req }, done) => {
      const token = bearerFromWebSocketProtocol(req.headers['sec-websocket-protocol']);
      opts
        .verify(token)
        .then((result) => {
          if (result.kind === 'allow') {
            approvedByRequest.set(req, result.user);
            done(true);
          } else {
            done(false, result.status, result.reason);
          }
        })
        .catch(() => done(false, 503, 'authorization failed'));
    },
    // The token arrives as the second subprotocol; echo back the marker so
    // the browser sees a subprotocol it offered and completes the handshake.
    handleProtocols: (protocols) => (protocols.has('bearer') ? 'bearer' : false)
  });

  wss.on('connection', (client, req) => {
    const user = approvedByRequest.get(req);
    approvedByRequest.delete(req);
    if (!user) {
      // Unreachable while verifyClient is in place — but if it ever is,
      // refuse rather than open a billable session on an unknown caller.
      client.close(1011, 'unauthorized');
      return;
    }

    createLiveBridge(client, {
      model: opts.model,
      targetLanguageCode: opts.targetLanguageCode,
      sourceLanguageCodes: opts.sourceLanguageCodes,
      openUpstream: () => new WebSocket(`${GEMINI_LIVE_WS_URL}?key=${opts.apiKey}`)
    });
  });
}
