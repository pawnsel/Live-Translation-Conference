export interface ChunkerOptions {
  sampleRate: number;
  /** Trailing silence, after enough speech, that ends a chunk. Default 600ms. */
  silenceMs?: number;
  /** Minimum buffered duration before trailing silence is allowed to cut it. Default 1000ms. */
  minSpeechMs?: number;
  /** Hard cap so continuous, pause-free speech still gets sent periodically. Default 8000ms. */
  maxChunkMs?: number;
  /** Below this, a cut is discarded instead of sent (avoids near-silence chunks). Default 600ms. */
  minChunkMs?: number;
  /** Int16 RMS below this counts as silence for endpointing. Default 500. */
  silenceRmsThreshold?: number;
}

export interface Chunker {
  /** Feed one PCM frame. Returns a completed chunk when a cut fires, else null. */
  pushFrame(frame: Int16Array): Int16Array | null;
  /** Force-cut whatever is currently buffered (e.g. on pause/stop). */
  flush(): Int16Array | null;
}

function rms(frame: Int16Array): number {
  let sumSquares = 0;
  for (let i = 0; i < frame.length; i++) sumSquares += frame[i] * frame[i];
  return Math.sqrt(sumSquares / frame.length);
}

function concat(frames: Int16Array[]): Int16Array {
  const total = frames.reduce((sum, f) => sum + f.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

export function createChunker(opts: ChunkerOptions): Chunker {
  const silenceSamples = ((opts.silenceMs ?? 600) / 1000) * opts.sampleRate;
  const minSpeechSamples = ((opts.minSpeechMs ?? 1000) / 1000) * opts.sampleRate;
  const maxChunkSamples = ((opts.maxChunkMs ?? 8000) / 1000) * opts.sampleRate;
  const minChunkSamples = ((opts.minChunkMs ?? 600) / 1000) * opts.sampleRate;
  const silenceRmsThreshold = opts.silenceRmsThreshold ?? 500;

  let frames: Int16Array[] = [];
  let bufferedSamples = 0;
  let trailingSilenceSamples = 0;

  const cut = (): Int16Array | null => {
    const tooShort = bufferedSamples < minChunkSamples;
    const result = tooShort ? null : concat(frames);
    frames = [];
    bufferedSamples = 0;
    trailingSilenceSamples = 0;
    return result;
  };

  return {
    pushFrame(frame: Int16Array): Int16Array | null {
      frames.push(frame);
      bufferedSamples += frame.length;
      trailingSilenceSamples = rms(frame) < silenceRmsThreshold ? trailingSilenceSamples + frame.length : 0;

      if (bufferedSamples >= maxChunkSamples) return cut();
      if (bufferedSamples >= minSpeechSamples && trailingSilenceSamples >= silenceSamples) return cut();
      return null;
    },
    flush(): Int16Array | null {
      return cut();
    }
  };
}
