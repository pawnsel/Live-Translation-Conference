import { useEffect, useRef, useState } from 'react';
import { describeCloseCode } from '../closeCodes';
import { FRAME_MS, FRAME_SAMPLES, MAX_BUFFERED_BYTES, SAMPLE_RATE, WORKLET_SRC } from './pcm';

export interface AudioCaptureState {
  status: 'idle' | 'starting' | 'sending' | 'error';
  backpressure: boolean;
  droppedFrames: number;
  error: string | null;
}

function toWsUrl(backendUrl: string, sessionId: string): string {
  const url = new URL(backendUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  // encodeURIComponent, not a raw template slot: a literal "/" inside
  // sessionId would otherwise be read as an extra path segment.
  url.pathname = `/ws/${encodeURIComponent(sessionId)}/audio`;
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

export function useAudioCapture(opts: {
  backendUrl: string;
  sessionId: string | null;
  sourceToken: string | null;
  active: boolean;
  deviceId?: string;
}): AudioCaptureState {
  const { backendUrl, sessionId, sourceToken, active, deviceId } = opts;
  const [state, setState] = useState<AudioCaptureState>({
    status: 'idle',
    backpressure: false,
    droppedFrames: 0,
    error: null,
  });
  const droppedRef = useRef(0);

  useEffect(() => {
    if (!active || !sessionId || !sourceToken) {
      setState((s) => ({ ...s, status: 'idle', backpressure: false }));
      return;
    }

    let disposed = false;
    // Set the moment a terminal failure has already run teardown() once.
    // `disposed` only ever means "the component unmounted" — it says nothing
    // about a failure (mic lost, socket closed non-1000, ...) that tore
    // everything down while the startup continuation was still mid-`await`.
    // Every post-await guard below has to stop for EITHER reason, or it runs
    // its next step against resources fail() already released.
    let aborted = false;
    let stream: MediaStream | null = null;
    let track: MediaStreamTrack | null = null;
    let ctx: AudioContext | null = null;
    let framerNode: AudioWorkletNode | null = null;
    let micNode: MediaStreamAudioSourceNode | null = null;
    let sinkNode: GainNode | null = null;
    let socket: WebSocket | null = null;
    let ready = false;

    // The one place every resource this effect can have acquired gets
    // released. Safe to call more than once — every step below is a no-op on
    // something already stopped/closed/disconnected — because it runs from
    // several places that can overlap: the effect cleanup, every failure
    // path, and a disposed-check straight after an `await` that may have
    // raced the cleanup and picked up a resource after teardown already ran
    // once with that variable still unset.
    const teardown = () => {
      ready = false;
      track?.removeEventListener('ended', onDeviceLost);
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      }
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
      // Release first, in every case: a message on screen with a hot mic or
      // an open socket behind it is a lie about the session's state.
      teardown();
      // Whichever reason gets here FIRST is the true cause — a device-loss
      // during, say, addModule() must not be overwritten by the artifact of
      // that same teardown (a closed AudioContext rejecting the pending
      // addModule) reaching its own catch a moment later.
      if (disposed || aborted) return;
      aborted = true;
      setState((s) => ({ ...s, status: 'error', error: message }));
    };

    // Unplugged, switched off, or grabbed by another application mid-session.
    // Silent otherwise: frames stop, but nothing about `status` on its own
    // says why — the meter (a later task) would just flatline.
    const onDeviceLost = () => {
      fail(
        'ไมโครโฟนถูกตัดการเชื่อมต่อหรือถูกใช้งานโดยแอปพลิเคชันอื่น — ไม่มีเสียงถูกส่งเข้าเซสชันนี้แล้ว (the microphone was disconnected or taken by another application)',
      );
    };

    const start = async () => {
      setState({ status: 'starting', backpressure: false, droppedFrames: 0, error: null });

      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        fail('ต้องเปิดหน้านี้ผ่าน HTTPS หรือ localhost จึงจะใช้ไมโครโฟนได้ (microphone needs a secure context)');
        return;
      }

      // Browser-side cleanup is OFF on purpose: the backend runs its own
      // preprocessing chain (denoise, pre-emphasis, RMS normalize) tuned for
      // the room, and two normalizers in series fight each other — the
      // browser's AGC pumps the noise floor up between sentences and the
      // server's then squashes the sentences.
      const constraints: MediaTrackConstraints = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      };

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { ...constraints, deviceId: { exact: deviceId } } : constraints,
        });
      } catch {
        fail('เปิดไมโครโฟนไม่สำเร็จ — ตรวจสอบสิทธิ์และอุปกรณ์ (could not open the microphone)');
        return;
      }
      // The effect can have been cleaned up while getUserMedia was pending —
      // the cleanup's own teardown() ran with `stream` still null and so
      // stopped nothing. This is the only place that stream is reachable
      // again, so it is the only place that can still stop it.
      if (disposed || aborted) {
        teardown();
        return;
      }

      track = stream.getAudioTracks()[0] ?? null;
      track?.addEventListener('ended', onDeviceLost);

      ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      if (ctx.sampleRate !== SAMPLE_RATE) {
        // A browser may ignore the rate hint. audio.hello pins 16000, so
        // declaring a rate we are not sending would make every caption come
        // out at the wrong speed with nothing on screen to explain it.
        fail(`เบราว์เซอร์ใช้ sample rate ${ctx.sampleRate} Hz แทน 16000 Hz — ใช้ส่งเสียงไม่ได้`);
        return;
      }
      await ctx.resume();
      // Between here and the getUserMedia guard above, `onDeviceLost` is
      // armed and can fire at any point — including during this very await —
      // and already ran fail()/teardown() by the time control returns here.
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
      // Same race as above: a device loss during addModule() itself tore
      // everything down (including closing `ctx`), which is what would make
      // the addModule() call above reject in the first place — so the catch
      // just above can also reach here having already reported the WRONG
      // reason if this guard did not stop it. It is the aborted flag, not
      // this guard, that keeps the operator-facing message correct; this
      // guard's job is only to stop the continuation from touching resources
      // that no longer exist.
      if (disposed || aborted) {
        teardown();
        return;
      }

      framerNode = new AudioWorkletNode(ctx, 'pcm-framer', {
        numberOfOutputs: 1,
        // Without an explicit single channel, a stereo microphone reaches the
        // worklet as two channels and only the left is read — so a lectern
        // feed landing on the right leg uploads near-silence while every
        // health indicator still reads healthy.
        channelCountMode: 'explicit',
        channelCount: 1,
        processorOptions: { frameSamples: FRAME_SAMPLES },
      });

      framerNode.port.onmessage = (event: MessageEvent<Int16Array>) => {
        if (!socket || socket.readyState !== WebSocket.OPEN || !ready) return;
        if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
          droppedRef.current += 1;
          setState((s) => ({ ...s, droppedFrames: droppedRef.current }));
          return;
        }
        socket.send(event.data.buffer);
      };

      micNode = ctx.createMediaStreamSource(stream);
      micNode.connect(framerNode);
      // A worklet that reaches no destination is not guaranteed to be pulled
      // by the rendering graph, so it needs a sink — at gain 0, because
      // connecting to the speakers would feed a podium mic into the PA.
      sinkNode = ctx.createGain();
      sinkNode.gain.value = 0;
      framerNode.connect(sinkNode).connect(ctx.destination);

      socket = new WebSocket(toWsUrl(backendUrl, sessionId), ['bearer', sourceToken]);
      socket.binaryType = 'arraybuffer';

      socket.onopen = () => {
        // audio.hello is the ONLY text frame this socket ever carries; a text
        // frame after the handshake closes it with 4403.
        socket?.send(
          JSON.stringify({
            v: 1,
            type: 'audio.hello',
            session: sessionId,
            ts: Date.now() / 1000,
            id: `hello-${Math.random().toString(16).slice(2, 10)}`,
            data: { sample_rate: SAMPLE_RATE, channels: 1, encoding: 'pcm_s16le', frame_ms: FRAME_MS },
          }),
        );
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        let msg: { type?: string; data?: { level?: string } };
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === 'audio.ready') {
          // Binary frames start only now. Sending earlier makes the server's
          // receive_text fail and closes the socket with 4403.
          ready = true;
          setState((s) => ({ ...s, status: 'sending', error: null }));
        } else if (msg.type === 'audio.backpressure') {
          setState((s) => ({ ...s, backpressure: msg.data?.level === 'high' }));
        }
        // Unknown frame type — ignored, so the server can add frames later
        // without breaking this hook.
      };

      socket.onclose = (event) => {
        if (disposed || event.code === 1000) return;
        fail(describeCloseCode(event.code).message);
      };
    };

    // A synchronous throw from a step this file does not explicitly guard
    // (the AudioContext / AudioWorkletNode constructors, for instance) would
    // otherwise escape as an unhandled rejection with no `.catch` anywhere on
    // `start()`. Routed through fail() so it is still subject to the
    // first-reason-wins rule above — this only ever becomes the reported
    // message when nothing more specific got there first.
    start().catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      fail(`เกิดข้อผิดพลาดที่ไม่คาดคิดขณะเริ่มรับเสียง (unexpected error starting audio capture: ${detail})`);
    });

    return () => {
      disposed = true;
      teardown();
    };
  }, [active, backendUrl, sessionId, sourceToken, deviceId]);

  return state;
}
