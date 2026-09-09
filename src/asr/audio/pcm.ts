// The format, in one place. 16 kHz mono pcm_s16le is the only thing
// audio.hello accepts, and it is what the ASR engine already feeds Google
// Speech-to-Text — so ingest adds no resampling anywhere in the chain.
export const SAMPLE_RATE = 16000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 320
export const FRAME_BYTES = FRAME_SAMPLES * 2; // 640

// Above this much unsent data the socket is not keeping up, so frames are
// DROPPED rather than queued. Buffering grows latency without bound and puts
// a caption a minute behind the speaker. 8 frames is 160 ms, and is also the
// server's own max_pcm_message_bytes ceiling.
export const MAX_BUFFERED_BYTES = FRAME_BYTES * 8; // 5120

export function floatToPcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

// Registered from a Blob so no separate worklet file has to be served, which
// keeps this working identically under Vite dev and the production bundle.
// AudioWorkletProcessor runs at the context's own rate, and the context is
// pinned to 16 kHz, so no resampling happens in here.
export const WORKLET_SRC = `
class PcmFramer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buf = new Int16Array(options.processorOptions.frameSamples);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.slice());
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-framer', PcmFramer);
`;
