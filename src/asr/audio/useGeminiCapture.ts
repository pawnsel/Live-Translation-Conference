import { useCallback, useEffect, useRef, useState } from 'react';
import type { GlossarySections } from '../../glossary';
import { createChunker, type Chunker } from './chunker';
import { encodeWavBuffer } from './wav';
import { createReorderQueue } from '../reorderQueue';
import { FRAME_SAMPLES, SAMPLE_RATE, WORKLET_SRC } from './pcm';

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
  /** Fatal, session-ending error (mic/device/permission). */
  error: string | null;
  /** Most recent non-fatal per-chunk send/response failure, or null. One
   *  failed chunk does not end the session — capture keeps listening. */
  lastChunkError: string | null;
}

interface TranscribeResponseBody {
  source_text?: string;
  target_text?: string;
  latencyMs?: number;
  error?: string;
}

export function useGeminiCapture(opts: {
  active: boolean;
  paused: boolean;
  sourceLang: string;
  targetLang: string;
  glossary: GlossarySections;
  context: string;
  onResult: (result: CaptionResult) => void;
  deviceId?: string;
}): GeminiCaptureState & { flush: () => Promise<void> } {
  const { active, deviceId } = opts;
  const [state, setState] = useState<GeminiCaptureState>({ status: 'idle', error: null, lastChunkError: null });

  // Latest-value refs for everything a chunk send needs but that must NOT
  // tear down and restart the mic when it changes — mirrors the onFrameRef
  // pattern the old control-socket hook (useAsrSocket.ts) used.
  const pausedRef = useRef(opts.paused);
  pausedRef.current = opts.paused;
  const sourceLangRef = useRef(opts.sourceLang);
  sourceLangRef.current = opts.sourceLang;
  const targetLangRef = useRef(opts.targetLang);
  targetLangRef.current = opts.targetLang;
  const glossaryRef = useRef(opts.glossary);
  glossaryRef.current = opts.glossary;
  const contextRef = useRef(opts.context);
  contextRef.current = opts.context;
  const onResultRef = useRef(opts.onResult);
  onResultRef.current = opts.onResult;

  // Set by the effect below to whatever function can force-flush the
  // in-progress chunk right now; read by the stable flush() this hook
  // returns, so callers get one stable identity across renders.
  const flushImplRef = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    if (!active) {
      setState({ status: 'idle', error: null, lastChunkError: null });
      flushImplRef.current = async () => undefined;
      return;
    }

    let disposed = false;
    let aborted = false;
    let stream: MediaStream | null = null;
    let track: MediaStreamTrack | null = null;
    let ctx: AudioContext | null = null;
    let framerNode: AudioWorkletNode | null = null;
    let micNode: MediaStreamAudioSourceNode | null = null;
    let sinkNode: GainNode | null = null;

    let seqCounter = 0;
    let chunker: Chunker | null = null;
    const reorder = createReorderQueue<CaptionResult | null>((result) => {
      if (result) onResultRef.current(result);
    });

    const teardown = () => {
      track?.removeEventListener('ended', onDeviceLost);
      if (framerNode) {
        framerNode.port.onmessage = null;
        framerNode.port.close();
        framerNode.disconnect();
      }
      micNode?.disconnect();
      sinkNode?.disconnect();
      stream?.getTracks().forEach((t) => t.stop());
      if (ctx && ctx.state !== 'closed') {
        void ctx.close();
      }
    };

    const fail = (message: string) => {
      teardown();
      if (disposed || aborted) return;
      aborted = true;
      setState((s) => ({ ...s, status: 'error', error: message }));
    };

    const onDeviceLost = () => {
      fail(
        'ไมโครโฟนถูกตัดการเชื่อมต่อหรือถูกใช้งานโดยแอปพลิเคชันอื่น — ไม่มีเสียงถูกส่งเข้าเซสชันนี้แล้ว (the microphone was disconnected or taken by another application)'
      );
    };

    const sendChunk = async (samples: Int16Array) => {
      const seq = seqCounter++;
      const sourceLang = sourceLangRef.current;
      const targetLang = targetLangRef.current;
      const startedAt = Date.now();
      try {
        const wav = encodeWavBuffer(samples, SAMPLE_RATE);
        const form = new FormData();
        form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav');
        form.append(
          'meta',
          JSON.stringify({
            sourceLang,
            targetLang,
            glossary: glossaryRef.current,
            context: contextRef.current
          })
        );
        const res = await fetch('/api/gemini/transcribe', { method: 'POST', body: form });
        const body = (await res.json()) as TranscribeResponseBody;
        if (!res.ok || !body.source_text || !body.target_text) {
          throw new Error(body.error || `Gemini transcription failed (HTTP ${res.status})`);
        }
        if (disposed) return;
        setState((s) => ({ ...s, lastChunkError: null }));
        reorder.push(seq, {
          seq,
          sourceText: body.source_text,
          targetText: body.target_text,
          sourceLang,
          targetLang,
          latencyMs: body.latencyMs ?? Date.now() - startedAt
        });
      } catch (err) {
        if (disposed) return;
        // One failed chunk does not end the session — drop it and keep
        // listening, the same philosophy the old backend's backpressure
        // handling used for a dropped audio frame.
        setState((s) => ({
          ...s,
          lastChunkError: err instanceof Error ? err.message : 'ส่งเสียงไปยัง Gemini ไม่สำเร็จ'
        }));
        reorder.push(seq, null);
      }
    };

    const start = async () => {
      setState({ status: 'starting', error: null, lastChunkError: null });

      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        fail('ต้องเปิดหน้านี้ผ่าน HTTPS หรือ localhost จึงจะใช้ไมโครโฟนได้ (microphone needs a secure context)');
        return;
      }

      // No backend audio-processing chain to fight anymore — unlike the old
      // useAudioCapture.ts, the browser's own echo/noise/gain cleanup stays
      // on.
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
      if (disposed || aborted) {
        teardown();
        return;
      }

      track = stream.getAudioTracks()[0] ?? null;
      track?.addEventListener('ended', onDeviceLost);

      ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      if (ctx.sampleRate !== SAMPLE_RATE) {
        fail(`เบราว์เซอร์ใช้ sample rate ${ctx.sampleRate} Hz แทน 16000 Hz — ใช้ส่งเสียงไม่ได้`);
        return;
      }
      await ctx.resume();
      if (disposed || aborted) {
        teardown();
        return;
      }

      const blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(blobUrl);
      } catch {
        fail('โหลดตัวประมวลผลเสียงไม่สำเร็จ (audio worklet failed to load)');
        return;
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      if (disposed || aborted) {
        teardown();
        return;
      }

      chunker = createChunker({ sampleRate: SAMPLE_RATE });

      framerNode = new AudioWorkletNode(ctx, 'pcm-framer', {
        numberOfOutputs: 1,
        channelCountMode: 'explicit',
        channelCount: 1,
        processorOptions: { frameSamples: FRAME_SAMPLES }
      });

      framerNode.port.onmessage = (event: MessageEvent<Int16Array>) => {
        if (pausedRef.current || !chunker) return;
        const finished = chunker.pushFrame(event.data);
        if (finished) void sendChunk(finished);
      };

      micNode = ctx.createMediaStreamSource(stream);
      micNode.connect(framerNode);
      // A worklet that reaches no destination is not guaranteed to be pulled
      // by the rendering graph, so it needs a sink — at gain 0.
      sinkNode = ctx.createGain();
      sinkNode.gain.value = 0;
      framerNode.connect(sinkNode).connect(ctx.destination);

      flushImplRef.current = async () => {
        const remaining = chunker?.flush();
        if (remaining) await sendChunk(remaining);
      };

      setState((s) => ({ ...s, status: 'listening' }));
    };

    start().catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      fail(`เกิดข้อผิดพลาดที่ไม่คาดคิดขณะเริ่มรับเสียง (unexpected error starting audio capture: ${detail})`);
    });

    return () => {
      disposed = true;
      flushImplRef.current = async () => undefined;
      teardown();
    };
  }, [active, deviceId]);

  const flush = useCallback(() => flushImplRef.current(), []);

  return { ...state, flush };
}
