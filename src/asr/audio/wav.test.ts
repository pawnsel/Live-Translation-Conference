import { describe, expect, it } from 'vitest';
import { encodeWavBuffer } from './wav';

function readString(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

describe('encodeWavBuffer', () => {
  it('writes a valid 16-bit mono PCM WAV header', () => {
    const samples = new Int16Array([0, 1000, -1000, 32767, -32768]);
    const buffer = encodeWavBuffer(samples, 16000);
    const view = new DataView(buffer);

    expect(readString(view, 0, 4)).toBe('RIFF');
    expect(readString(view, 8, 4)).toBe('WAVE');
    expect(readString(view, 12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(readString(view, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(buffer.byteLength).toBe(44 + samples.length * 2);
  });

  it('round-trips sample data unchanged', () => {
    const samples = new Int16Array([0, 1000, -1000, 32767, -32768]);
    const buffer = encodeWavBuffer(samples, 16000);
    const view = new DataView(buffer);
    for (let i = 0; i < samples.length; i++) {
      expect(view.getInt16(44 + i * 2, true)).toBe(samples[i]);
    }
  });

  it('handles an empty sample array', () => {
    const buffer = encodeWavBuffer(new Int16Array([]), 16000);
    expect(buffer.byteLength).toBe(44);
  });
});
