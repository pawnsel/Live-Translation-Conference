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

// A hung (not merely failed) transcribe call would otherwise leave that
// chunk's seq unresolved forever — and per reorderQueue.ts's strict-ordering
// contract, every later chunk queues up behind that gap forever too,
// silently freezing captions with no visible error.
const TRANSCRIBE_TIMEOUT_MS = 15000;

export function useGeminiCapture(opts: {
  active: boolean;
  paused: boolean;
  sourceLang: string;
  targetLang: string;
  glossary: GlossarySections;
  context: string;
  onResult: (result: CaptionResult) => void;
  deviceId?: string;
}): GeminiCaptureState & { flush: () => Promise<CaptionResult | null> } {
  const { active, deviceId } = opts;
  const [state, setState] = useState<GeminiCaptureState>({ status: 'idle', error: null, lastChunkError: null });

  // Latest-value refs for everything a chunk send needs but that must NOT
  // tear down and restart the mic when it changes — uses a stable ref pattern
  // to avoid tearing down and restarting the mic on option changes.
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

  // Survives effect re-runs (e.g. the mic being stopped and restarted after
  // a fatal-error retry), so seqs stay strictly increasing for the life of
  // the whole session instead of resetting to 0 every time the effect below
  // re-runs — a reset would overwrite earlier captions/edits that already
  // occupy those same seqs in the captions reducer.
  const seqBaseRef = useRef(0);

  // Set by the effect below to whatever function can force-flush the
  // in-progress chunk right now; read by the stable flush() this hook
  // returns, so callers get one stable identity across renders.
  const flushImplRef = useRef<() => Promise<CaptionResult | null>>(async () => null);

  useEffect(() => {
    if (!active) {
      setState({ status: 'idle', error: null, lastChunkError: null });
      flushImplRef.current = async () => null;
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

    // Local ordinal for THIS effect run's reorder queue, which always
    // expects sequences starting at 0 (see reorderQueue.ts) — kept separate
    // from the globally-increasing seq (seqBaseRef) exposed on CaptionResult
    // so a mic restart never hands the fresh queue instance a seq it will
    // wait forever for.
    let seqCounter = 0;
    const seqOffset = seqBaseRef.current;
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

    const sendChunk = async (samples: Int16Array): Promise<CaptionResult | null> => {
      const localSeq = seqCounter++;
      const seq = seqOffset + localSeq;
      seqBaseRef.current = seqOffset + seqCounter;
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
        const res = await fetch('/api/gemini/transcribe', {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)
        });
        const body = (await res.json()) as TranscribeResponseBody;
        if (!res.ok || !body.source_text || !body.target_text) {
          throw new Error(body.error || `Gemini transcription failed (HTTP ${res.status})`);
        }
        const result: CaptionResult = {
          seq,
          sourceText: body.source_text,
          targetText: body.target_text,
          sourceLang,
          targetLang,
          latencyMs: body.latencyMs ?? Date.now() - startedAt
        };
        // The reorder queue must receive every completed chunk's result
        // even if this effect/session has since been disposed (e.g. the
        // session ended while this chunk's Gemini call was still in
        // flight) — skipping it here would drop the chunk entirely, not
        // just exclude it from flush()'s return value. Only the local hook
        // state update below (which assumes a live session) is guarded.
        reorder.push(localSeq, result);
        if (!disposed) {
          setState((s) => ({ ...s, lastChunkError: null }));
        }
        return result;
      } catch (err) {
        // One failed chunk does not end the session — drop it and keep
        // listening, the same philosophy the old backend's backpressure
        // handling used for a dropped audio frame.
        reorder.push(localSeq, null);
        if (!disposed) {
          setState((s) => ({
            ...s,
            lastChunkError: err instanceof Error ? err.message : 'ส่งเสียงไปยัง Gemini ไม่สำเร็จ'
          }));
        }
        return null;
      }
    };

    const start = async () => {
      setState({ status: 'starting', error: null, lastChunkError: null });

      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        fail('ต้องเปิดหน้านี้ผ่าน HTTPS หรือ localhost จึงจะใช้ไมโครโฟนได้ (microphone needs a secure context)');
        return;
      }

      // The browser's own echo/noise/gain cleanup is enabled; no need for
      // additional backend audio processing.
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
        if (!remaining) return null;
        return sendChunk(remaining);
      };

      setState((s) => ({ ...s, status: 'listening' }));
    };

    start().catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      fail(`เกิดข้อผิดพลาดที่ไม่คาดคิดขณะเริ่มรับเสียง (unexpected error starting audio capture: ${detail})`);
    });

    return () => {
      disposed = true;
      flushImplRef.current = async () => null;
      teardown();
    };
  }, [active, deviceId]);

  // Cut off whatever's buffered right at the moment pause begins, instead of
  // letting it silently carry across the pause boundary and concatenate with
  // post-resume audio into one chunk with no silence gap (which can garble
  // the transcription at that boundary). Any resulting chunk is sent through
  // the normal flush path, which forwards it to sendChunk like any other
  // completed chunk.
  const wasPausedRef = useRef(false);
  useEffect(() => {
    if (opts.paused && !wasPausedRef.current) {
      void flushImplRef.current();
    }
    wasPausedRef.current = opts.paused;
  }, [opts.paused]);

  const flush = useCallback(() => flushImplRef.current(), []);

  return { ...state, flush };
}
