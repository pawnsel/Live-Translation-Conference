import { describe, expect, it } from 'vitest';
import { FRAME_BYTES, FRAME_SAMPLES, MAX_BUFFERED_BYTES, SAMPLE_RATE, WORKLET_SRC, floatToPcm16 } from './pcm';

describe('audio format constants', () => {
  it('matches what audio.hello is allowed to declare', () => {
    expect(SAMPLE_RATE).toBe(16000);
    expect(FRAME_SAMPLES).toBe(320);
    expect(FRAME_BYTES).toBe(640);
  });

  it('caps buffering at 8 frames, the server message ceiling', () => {
    expect(MAX_BUFFERED_BYTES).toBe(5120);
  });
});

describe('floatToPcm16', () => {
  it('maps silence to zero', () => {
    expect(floatToPcm16(0)).toBe(0);
  });

  it('maps full positive scale to 0x7fff', () => {
    expect(floatToPcm16(1)).toBe(0x7fff);
  });

  it('maps full negative scale to -0x8000', () => {
    expect(floatToPcm16(-1)).toBe(-0x8000);
  });

  it('clamps above full scale instead of wrapping the sign', () => {
    // Casting an out-of-range float straight to int16 wraps and inverts the
    // waveform mid-sample, which the recognizer hears as a consonant.
    expect(floatToPcm16(1.5)).toBe(0x7fff);
    expect(floatToPcm16(-1.5)).toBe(-0x8000);
  });
});

describe('WORKLET_SRC', () => {
  it('registers the processor the node constructs by name', () => {
    expect(WORKLET_SRC).toContain("registerProcessor('pcm-framer'");
  });
});
