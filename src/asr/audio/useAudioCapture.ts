import { useEffect, useRef, useState } from 'react';
import { describeCloseCode } from '../closeCodes';
import { FRAME_MS, FRAME_SAMPLES, MAX_BUFFERED_BYTES, SAMPLE_RATE, WORKLET_SRC } from './pcm';

export interface AudioCaptureState {
  status: 'idle' | 'starting' | 'sending' | 'error';
  backpressure: boolean;
  droppedFrames: number;
  error: string | null;
}

function toWsUrl(backendUrl: string, path: string): string {
  const url = new URL(backendUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = path;
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
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let framerNode: AudioWorkletNode | null = null;
    let micNode: MediaStreamAudioSourceNode | null = null;
    let sinkNode: GainNode | null = null;
    let socket: WebSocket | null = null;
    let ready = false;

    const fail = (message: string) => {
      if (disposed) return;
      setState((s) => ({ ...s, status: 'error', error: message }));
    };

    const start = async () => {
      setState({ status: 'starting', backpressure: false, droppedFrames: 0, error: null });

      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        fail('ต้องเปิดหน้านี้ผ่าน HTTPS หรือ localhost จึงจะใช้ไมโครโฟนได้ (microphone needs a secure context)');
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        });
      } catch {
        fail('เปิดไมโครโฟนไม่สำเร็จ — ตรวจสอบสิทธิ์และอุปกรณ์ (could not open the microphone)');
        return;
      }
      if (disposed) return;

      ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      if (ctx.sampleRate !== SAMPLE_RATE) {
        // A browser may ignore the rate hint. audio.hello pins 16000, so
        // declaring a rate we are not sending would make every caption come
        // out at the wrong speed with nothing on screen to explain it.
        fail(`เบราว์เซอร์ใช้ sample rate ${ctx.sampleRate} Hz แทน 16000 Hz — ใช้ส่งเสียงไม่ได้`);
        return;
      }
      await ctx.resume();

      const blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(blobUrl);
      } catch {
        fail('โหลดตัวประมวลผลเสียงไม่สำเร็จ (audio worklet failed to load)');
        return;
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      if (disposed) return;

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

      socket = new WebSocket(toWsUrl(backendUrl, `/ws/${sessionId}/audio`), ['bearer', sourceToken]);
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
      };

      socket.onclose = (event) => {
        ready = false;
        if (disposed || event.code === 1000) return;
        fail(describeCloseCode(event.code).message);
      };
    };

    void start();

    return () => {
      disposed = true;
      ready = false;
      socket?.close();
      framerNode?.port.close();
      micNode?.disconnect();
      framerNode?.disconnect();
      sinkNode?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      void ctx?.close();
    };
  }, [active, backendUrl, sessionId, sourceToken, deviceId]);

  return state;
}
