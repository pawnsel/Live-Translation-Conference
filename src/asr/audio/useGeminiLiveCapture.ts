import { useEffect, useRef, useState } from 'react';
import { FRAME_SAMPLES, SAMPLE_RATE, WORKLET_SRC } from './pcm';
import {
  applyEnThCorrections,
  glossaryToPairs,
  glossaryToVocabulary,
  type GlossarySections
} from '../../glossary';

/** One finished utterance: what was said, and its translation. */
export interface CaptionResult {
  seq: number;
  sourceText: string;
  targetText: string;
  sourceLang: string;
  targetLang: string;
  latencyMs: number;
}

export interface GeminiCaptureState {
  status: 'idle' | 'starting' | 'listening' | 'error';
  /** Fatal — the session is over (mic denied, connection unrecoverable). */
  error: string | null;
}

// Streams microphone audio over a WebSocket to our own server, which
// relays it to Gemini's live translation model (see
// server/geminiLiveProxy.ts — the API key never reaches the browser).
//
// Translation arrives as a stream of small fragments with no end-of-utterance signal from the model
// (verified against the live API: no generationComplete, no voiceActivity).
// Fragments are therefore accumulated here and closed into one caption
// after a quiet gap, so the caption list keeps its "one row per utterance"
// shape.
const QUIET_MS = 1200;
// A speaker who never pauses would otherwise grow one caption forever.
const MAX_CAPTION_CHARS = 600;
// The model endpoints on trailing silence: cutting the audio off the
// instant a session ends leaves its last segment unspoken-for, losing the
// tail of the final sentence. Verified against the live API — feeding
// silence recovers it, an explicit audioStreamEnd does not.
const FLUSH_SILENCE_MS = 1500;
const FLUSH_TAIL_WAIT_MS = 2500;
// A live session does not last forever — Gemini ends it on its own (hence
// the sessionResumptionUpdate frames it sends), and a conference outlives
// that easily. Dropping the operator into an error state mid-meeting is not
// an option, so an unexpected close reconnects instead.
const RECONNECT_DELAY_MS = 800;
const MAX_RECONNECTS = 5;

const BCP47: Record<string, string> = { th: 'th-TH', en: 'en-US' };

export function useGeminiLiveCapture(opts: {
  active: boolean;
  paused: boolean;
  sourceLang: string;
  targetLang: string;
  glossary: GlossarySections;
  onResult: (result: CaptionResult) => void;
  deviceId?: string;
}): GeminiCaptureState & {
  flush: () => Promise<CaptionResult | null>;
  // Text accumulated so far for the caption that has not closed yet — the
  // model streams translation while the speaker is still talking, so this
  // is what makes the subtitle box move in real time instead of only
  // updating once a sentence ends.
  partialSource: string;
  partialTarget: string;
} {
  const { active, deviceId, sourceLang, targetLang } = opts;
  const [state, setState] = useState<GeminiCaptureState>({ status: 'idle', error: null });
  const [partial, setPartial] = useState({ source: '', target: '' });

  // Latest-value refs for things that must not tear down the session when
  // they change. Languages are deliberately NOT in here: translationConfig
  // is setup-only, so a language switch has to reopen the session.
  const pausedRef = useRef(opts.paused);
  pausedRef.current = opts.paused;
  const glossaryRef = useRef(opts.glossary);
  glossaryRef.current = opts.glossary;
  const onResultRef = useRef(opts.onResult);
  onResultRef.current = opts.onResult;

  // Caption sequence must keep increasing across reconnects (a language
  // switch reopens the socket) — restarting at 0 would overwrite earlier
  // captions in the reducer, which is keyed by seq.
  const seqRef = useRef(0);

  // Reconnect bookkeeping: the nonce re-runs the effect (a full, clean
  // reconnect), the counter stops a dead server from being retried forever.
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const retriesRef = useRef(0);

  const flushImplRef = useRef<() => Promise<CaptionResult | null>>(async () => null);

  useEffect(() => {
    if (!active) {
      setState({ status: 'idle', error: null });
      setPartial({ source: '', target: '' });
      flushImplRef.current = async () => null;
      retriesRef.current = 0;
      return;
    }

    let disposed = false;
    let ws: WebSocket | null = null;
    let ctx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let framerNode: AudioWorkletNode | null = null;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    let sourceBuf = '';
    let targetBuf = '';
    let startedAt = 0;
    let flushing = false;

    // The en_th_corrections glossary maps English terms onto Thai ones, so
    // it only makes sense on Thai output — applied while translating INTO
    // English it would drop Thai words into an English sentence. The source
    // side is never touched: "Kawin" is the correct English original.
    const correctTarget = (text: string) =>
      targetLang === 'th' ? applyEnThCorrections(text, glossaryRef.current) : text;

    const fail = (message: string) => {
      if (disposed) return;
      setState({ status: 'error', error: message });
      teardown();
    };

    const teardown = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      framerNode?.port.close();
      framerNode?.disconnect();
      framerNode = null;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      void ctx?.close().catch(() => {});
      ctx = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
      ws = null;
    };

    // Closes whatever has accumulated into one caption. Returns it so
    // session-end can fold in the final utterance directly, rather than
    // relying on a React re-render that has not happened yet.
    const emit = (): CaptionResult | null => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = null;
      const sourceText = sourceBuf.trim();
      const targetText = correctTarget(targetBuf.trim());
      sourceBuf = '';
      targetBuf = '';
      // The caption is about to become a committed row, so the live
      // preview of it must go — otherwise it would show twice.
      setPartial({ source: '', target: '' });
      if (!sourceText && !targetText) return null;
      const result: CaptionResult = {
        seq: seqRef.current++,
        sourceText,
        targetText,
        sourceLang,
        targetLang,
        latencyMs: startedAt ? Date.now() - startedAt : 0
      };
      startedAt = 0;
      onResultRef.current(result);
      return result;
    };

    const noteFragment = () => {
      if (!startedAt) startedAt = Date.now();
      if (quietTimer) clearTimeout(quietTimer);
      // While flushing, everything still arriving belongs to the one final
      // caption flush() returns — letting the timer close it early would
      // deliver it through onResult instead, where session-end's already
      // captured caption list would miss it.
      if (flushing) return;
      // Each new fragment postpones the close, so a caption ends only once
      // the model has stopped producing text — which also lets the
      // translation's tail catch up with the speech that triggered it.
      quietTimer = setTimeout(emit, QUIET_MS);
      if (sourceBuf.length > MAX_CAPTION_CHARS || targetBuf.length > MAX_CAPTION_CHARS) emit();
    };

    const handleFrame = (json: string) => {
      let data: any;
      try {
        data = JSON.parse(json);
      } catch {
        return;
      }
      if (data.setupComplete) {
        // A session that got this far is healthy, so the next unexpected
        // drop gets a full retry budget again.
        retriesRef.current = 0;
        void startAudio();
        return;
      }
      const source = data.serverContent?.inputTranscription?.text;
      const target = data.serverContent?.outputTranscription?.text;
      if (typeof source === 'string' && source) {
        sourceBuf += source;
        noteFragment();
      }
      if (typeof target === 'string' && target) {
        targetBuf += target;
        noteFragment();
      }
      // Corrected here too, so the live subtitle doesn't show "Kawin" and
      // then swap it for "กวิน" the moment the caption closes.
      if (source || target) setPartial({ source: sourceBuf.trim(), target: correctTarget(targetBuf.trim()) });
    };

    const startAudio = async () => {
      if (disposed) return;
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        fail('ต้องเปิดหน้านี้ผ่าน HTTPS หรือ localhost จึงจะใช้ไมโครโฟนได้ (microphone needs a secure context)');
        return;
      }
      const constraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      };
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { ...constraints, deviceId: { exact: deviceId } } : constraints
        });
      } catch {
        fail('เปิดไมโครโฟนไม่สำเร็จ — ตรวจสอบสิทธิ์และอุปกรณ์ (could not open the microphone)');
        return;
      }
      if (disposed) return teardown();

      stream.getAudioTracks()[0]?.addEventListener('ended', () => {
        fail(
          'ไมโครโฟนถูกตัดการเชื่อมต่อหรือถูกใช้งานโดยแอปพลิเคชันอื่น — ไม่มีเสียงถูกส่งเข้าเซสชันนี้แล้ว (the microphone was disconnected or taken by another application)'
        );
      });

      ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      if (ctx.sampleRate !== SAMPLE_RATE) {
        fail(`เบราว์เซอร์ใช้ sample rate ${ctx.sampleRate} Hz แทน 16000 Hz — ใช้ส่งเสียงไม่ได้`);
        return;
      }
      await ctx.resume();
      if (disposed) return teardown();

      const blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(blobUrl);
      } catch {
        fail('โหลดตัวประมวลผลเสียงไม่สำเร็จ (audio worklet failed to load)');
        return;
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      if (disposed) return teardown();

      framerNode = new AudioWorkletNode(ctx, 'pcm-framer', {
        numberOfOutputs: 1,
        channelCountMode: 'explicit',
        channelCount: 1,
        processorOptions: { frameSamples: FRAME_SAMPLES }
      });
      framerNode.port.onmessage = (event: MessageEvent<Int16Array>) => {
        if (pausedRef.current || ws?.readyState !== WebSocket.OPEN) return;
        ws.send(
          JSON.stringify({
            realtimeInput: {
              mediaChunks: [{ mimeType: `audio/pcm;rate=${SAMPLE_RATE}`, data: int16ToBase64(event.data) }]
            }
          })
        );
      };

      const mic = ctx.createMediaStreamSource(stream);
      mic.connect(framerNode);
      // A worklet that reaches no destination is not guaranteed to be pulled
      // by the rendering graph, so it needs a sink — at gain 0.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      framerNode.connect(sink).connect(ctx.destination);

      if (!disposed) setState({ status: 'listening', error: null });
    };

    setState({ status: 'starting', error: null });
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${window.location.host}/ws/gemini-live-transcribe`);

    ws.onopen = () => {
      // Sent before the server opens its Gemini session: translationConfig
      // and customVocabulary are both setup-only there.
      ws?.send(
        JSON.stringify({
          // Two different jobs: vocabulary sharpens what the recogniser
          // hears, pairs pin how those terms get translated. The server
          // turns the pairs into the instruction — the browser never sends
          // prompt text of its own.
          customVocabulary: glossaryToVocabulary(glossaryRef.current),
          glossaryPairs: glossaryToPairs(glossaryRef.current),
          targetLanguageCode: targetLang,
          sourceLanguageCodes: [BCP47[sourceLang] ?? sourceLang]
        })
      );
    };

    ws.onmessage = (event) => {
      // Gemini sends JSON in BINARY frames, so the browser hands us a Blob
      // rather than a string.
      if (typeof event.data === 'string') handleFrame(event.data);
      else if (event.data instanceof Blob) void event.data.text().then(handleFrame);
      else if (event.data instanceof ArrayBuffer) handleFrame(new TextDecoder().decode(event.data));
    };

    // An error is always followed by a close, so recovery is handled in one
    // place rather than racing two handlers.
    ws.onerror = () => {};
    ws.onclose = () => {
      if (disposed) return;
      // Whatever was mid-sentence still belongs to the transcript — commit
      // it before the reconnect wipes this session's buffers.
      emit();
      if (retriesRef.current >= MAX_RECONNECTS) {
        fail('เชื่อมต่อบริการแปลภาษาไม่ได้ — กรุณาเริ่ม Session ใหม่ (live translation connection lost)');
        return;
      }
      retriesRef.current += 1;
      teardown();
      setState({ status: 'starting', error: null });
      reconnectTimer = setTimeout(() => setReconnectNonce((n) => n + 1), RECONNECT_DELAY_MS);
    };

    flushImplRef.current = async () => {
      flushing = true;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = null;

      if (ws?.readyState === WebSocket.OPEN) {
        const silence = int16ToBase64(new Int16Array(FRAME_SAMPLES));
        const frames = Math.round(FLUSH_SILENCE_MS / (1000 * (FRAME_SAMPLES / SAMPLE_RATE)));
        for (let i = 0; i < frames; i++) {
          ws.send(
            JSON.stringify({
              realtimeInput: { mediaChunks: [{ mimeType: `audio/pcm;rate=${SAMPLE_RATE}`, data: silence }] }
            })
          );
        }
        await new Promise((resolve) => setTimeout(resolve, FLUSH_TAIL_WAIT_MS));
      }

      const result = emit();
      flushing = false;
      return result;
    };

    return () => {
      disposed = true;
      flushImplRef.current = async () => null;
      teardown();
    };
  }, [active, deviceId, sourceLang, targetLang, reconnectNonce]);

  return {
    ...state,
    flush: async () => flushImplRef.current(),
    partialSource: partial.source,
    partialTarget: partial.target
  };
}

function int16ToBase64(frame: Int16Array): string {
  const bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return window.btoa(binary);
}
